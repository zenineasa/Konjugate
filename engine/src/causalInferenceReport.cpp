/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "causalInferenceReport.hpp"
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

// Binary protobuf, not JSON -- see protocol/engineProtocol.proto's InferenceReport message.
// Doubles here (coefficient, intercept, score, rate) natively represent Infinity/-Infinity/NaN,
// unlike JSON (see the identical rationale, and the actual defect it fixed, in
// parameterFittingReport.cpp). InferredEdgeReport.interaction is a message-typed field, which
// protobuf already treats as inherently optional/presence-tracked -- unlike the old JSON writer,
// no manual has_value() branch is needed to get the same "field present only when the interaction
// term itself is present" behavior.
void writeInferenceReport(const std::filesystem::path& path, const InferenceResult& result) {
    protocol::InferenceReport message;
    message.set_report_version(1);
    message.set_engine_version("0.2.0");
    for (const auto& edge : result.edges) {
        auto* entry = message.add_edges();
        entry->set_source_column(edge.sourceColumn);
        entry->set_target_column(edge.targetColumn);
        entry->set_lag(edge.lag);
        for (const auto& term : edge.terms) {
            auto* termEntry = entry->add_terms();
            termEntry->set_degree(term.degree);
            termEntry->set_coefficient(term.coefficient);
        }
        if (edge.interaction.has_value()) {
            entry->mutable_interaction()->set_coefficient(edge.interaction->coefficient);
        }
        entry->set_intercept(edge.intercept);
        entry->set_score(edge.score);
        entry->set_provenance(edge.provenance);
    }
    for (const auto& term : result.selfTerms) {
        auto* entry = message.add_self_terms();
        entry->set_target_column(term.targetColumn);
        entry->set_rate(term.rate);
    }
    atomicWrite(path, message.SerializeAsString());
}

}
