/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "causalInferenceReport.hpp"
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

void writeInferenceReport(const std::filesystem::path& path, const InferenceResult& result) {
    std::ostringstream json;
    json << "{\"reportVersion\":1,\"engineVersion\":\"0.2.0\",\"edges\":[";
    for (std::size_t index = 0; index < result.edges.size(); ++index) {
        if (index) json << ',';
        const auto& edge = result.edges[index];
        json << "{\"sourceColumn\":\"" << escape(edge.sourceColumn) << "\",\"targetColumn\":\"" << escape(edge.targetColumn)
             << "\",\"lag\":" << edge.lag << ",\"terms\":[";
        for (std::size_t termIndex = 0; termIndex < edge.terms.size(); ++termIndex) {
            if (termIndex) json << ',';
            const auto& term = edge.terms[termIndex];
            json << "{\"degree\":" << term.degree << ",\"coefficient\":" << term.coefficient << "}";
        }
        json << "],\"intercept\":" << edge.intercept << ",\"score\":" << edge.score
             << ",\"provenance\":\"" << escape(edge.provenance) << "\"}";
    }
    json << "]}";
    atomicWrite(path, json.str());
}

}
