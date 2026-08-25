/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include "causalInference.hpp"
#include <filesystem>

namespace konjugate {

void writeInferenceReport(const std::filesystem::path& path, const InferenceResult& result);

}
