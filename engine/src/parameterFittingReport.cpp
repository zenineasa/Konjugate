/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "parameterFittingReport.hpp"
#include <fstream>
#include <sstream>

namespace konjugate {
namespace {
std::string escape(const std::string& value) {
    std::ostringstream output;
    for (const unsigned char character : value) {
        switch (character) {
        case '\\': output << "\\\\"; break;
        case '"': output << "\\\""; break;
        case '\n': output << "\\n"; break;
        case '\r': output << "\\r"; break;
        case '\t': output << "\\t"; break;
        default: output << character;
        }
    }
    return output.str();
}

void atomicWrite(const std::filesystem::path& path, const std::string& content) {
    const auto temporary = path.string() + ".tmp";
    std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
    if (!stream) throw std::runtime_error("The report file could not be created.");
    stream << content;
    stream.close();
    std::error_code error;
    std::filesystem::rename(temporary, path, error);
    if (error) {
        std::filesystem::remove(path, error);
        std::filesystem::rename(temporary, path);
    }
}
}

void writeFittingReport(const std::filesystem::path& path, const FittingReport& report) {
    std::ostringstream json;
    json << "{\"reportVersion\":1,\"engineVersion\":\"0.2.0\",\"backend\":\"" << escape(report.backend)
         << "\",\"converged\":" << (report.converged ? "true" : "false")
         << ",\"terminationReason\":\"" << escape(report.terminationReason) << "\",\"finalLoss\":" << report.finalLoss
         << ",\"iterations\":[";
    for (std::size_t index = 0; index < report.iterations.size(); ++index) {
        if (index) json << ',';
        const auto& update = report.iterations[index];
        json << "{\"iteration\":" << update.iteration << ",\"loss\":" << update.loss << ",\"parameterValues\":[";
        for (std::size_t valueIndex = 0; valueIndex < update.parameterValues.size(); ++valueIndex) {
            if (valueIndex) json << ',';
            json << update.parameterValues[valueIndex];
        }
        json << "]}";
    }
    json << "],\"finalParameters\":[";
    for (std::size_t index = 0; index < report.finalParameters.size(); ++index) {
        if (index) json << ',';
        const auto& [parameterId, value] = report.finalParameters[index];
        json << "{\"parameterId\":" << parameterId << ",\"value\":" << value << "}";
    }
    json << "]}";
    atomicWrite(path, json.str());
}

}
