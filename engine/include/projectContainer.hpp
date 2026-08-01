/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>

namespace konjugate {

class ContainerError : public std::runtime_error {
public:
    ContainerError(std::string code, const std::string& message);
    std::string code;
};

struct ProjectPayload {
    std::string json;
    std::string format;
    std::uint8_t version;
    bool encrypted;
};

struct ProjectInspection {
    std::string format;
    std::uint8_t version;
    bool encrypted;
};

ProjectInspection inspectProject(const std::filesystem::path& path);
ProjectPayload readProject(const std::filesystem::path& path, const std::string& password = {});

}
