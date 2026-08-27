/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include "parameterFitting.hpp"
#include <filesystem>

namespace konjugate {

void writeFittingReport(const std::filesystem::path& path, const FittingReport& report);

}
