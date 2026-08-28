/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "validationReport.hpp"
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

// Binary protobuf, not JSON -- see protocol/engineProtocol.proto's ValidationReport message.
void writeValidationReport(const std::filesystem::path& path, const ValidationResult& result) {
    protocol::ValidationReport message;
    message.set_report_version(1);
    message.set_engine_version("0.2.0");
    message.set_valid(result.valid);
    message.mutable_summary()->set_nodes(result.nodeCount);
    message.mutable_summary()->set_edges(result.edgeCount);
    for (const auto& item : result.issues) {
        auto* entry = message.add_issues();
        entry->set_code(item.code);
        entry->set_severity(item.severity);
        entry->set_message(item.message);
        entry->mutable_location()->set_kind(item.location.kind);
        entry->mutable_location()->set_entity_id(item.location.entityId);
        entry->mutable_location()->set_field(item.location.field);
    }
    atomicWrite(path, message.SerializeAsString());
}

void writeInspectionReport(const std::filesystem::path& path, const std::string& format, unsigned version, bool encrypted) {
    protocol::InspectionReport message;
    message.set_report_version(1);
    message.set_format(format);
    message.set_container_version(version);
    message.set_encrypted(encrypted);
    atomicWrite(path, message.SerializeAsString());
}

}
