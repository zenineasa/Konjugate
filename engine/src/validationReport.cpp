/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "validationReport.hpp"
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

void writeValidationReport(const std::filesystem::path& path, const ValidationResult& result) {
    std::ostringstream json;
    json << "{\"reportVersion\":1,\"engineVersion\":\"0.1.0\",\"valid\":" << (result.valid ? "true" : "false")
         << ",\"summary\":{\"nodes\":" << result.nodeCount << ",\"edges\":" << result.edgeCount << "},\"issues\":[";
    for (std::size_t index = 0; index < result.issues.size(); ++index) {
        if (index) json << ',';
        const auto& item = result.issues[index];
        json << "{\"code\":\"" << escape(item.code) << "\",\"severity\":\"" << escape(item.severity)
             << "\",\"message\":\"" << escape(item.message) << "\",\"location\":{\"kind\":\"" << escape(item.location.kind)
             << "\",\"entityId\":\"" << escape(item.location.entityId) << "\",\"field\":\"" << escape(item.location.field) << "\"}}";
    }
    json << "]}";
    atomicWrite(path, json.str());
}

void writeInspectionReport(const std::filesystem::path& path, const std::string& format, unsigned version, bool encrypted) {
    std::ostringstream json;
    json << "{\"reportVersion\":1,\"format\":\"" << escape(format) << "\",\"containerVersion\":" << version
         << ",\"encrypted\":" << (encrypted ? "true" : "false") << '}';
    atomicWrite(path, json.str());
}

}
