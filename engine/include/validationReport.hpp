/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include "modelValidator.hpp"
#include <filesystem>
#include <string>

namespace konjugate {

void writeValidationReport(const std::filesystem::path& path, const ValidationResult& result);
void writeInspectionReport(const std::filesystem::path& path, const std::string& format, unsigned version, bool encrypted);

}
