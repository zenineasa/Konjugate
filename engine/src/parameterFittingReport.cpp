/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "parameterFittingReport.hpp"
#include "engineProtocol.pb.h"
#include <fstream>

namespace konjugate {
namespace {
void atomicWrite(const std::filesystem::path& path, const std::string& bytes) {
    const auto temporary = path.string() + ".tmp";
    std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
    if (!stream) throw std::runtime_error("The report file could not be created.");
    stream << bytes;
    stream.close();
    std::error_code error;
    std::filesystem::rename(temporary, path, error);
    if (error) {
        std::filesystem::remove(path, error);
        std::filesystem::rename(temporary, path);
    }
}
}

// Binary protobuf, not JSON -- see protocol/engineProtocol.proto's FittingReport message. Doubles
// here (finalLoss, loss, value) natively represent Infinity/-Infinity/NaN, unlike JSON, which has
// no token for them; a diverging fit producing a non-finite loss used to write JSON.parse()
// couldn't read at all (C++'s default ostream formatting prints the literal words "inf"/"nan").
void writeFittingReport(const std::filesystem::path& path, const FittingReport& report) {
    protocol::FittingReport message;
    message.set_report_version(1);
    message.set_engine_version("0.2.0");
    message.set_backend(report.backend);
    message.set_converged(report.converged);
    message.set_termination_reason(report.terminationReason);
    message.set_final_loss(report.finalLoss);
    for (const auto& update : report.iterations) {
        auto* entry = message.add_iterations();
        entry->set_iteration(update.iteration);
        entry->set_loss(update.loss);
        for (const auto& value : update.parameterValues) entry->add_parameter_values(value);
    }
    for (const auto& [parameterId, value] : report.finalParameters) {
        auto* entry = message.add_final_parameters();
        entry->set_parameter_id(parameterId);
        entry->set_value(value);
    }
    atomicWrite(path, message.SerializeAsString());
}

}
