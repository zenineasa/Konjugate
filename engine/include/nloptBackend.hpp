/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include "optimizerBackend.hpp"
#include <memory>
#include <string>
#include <vector>

namespace konjugate {

// The curated subset of NLopt's algorithms this engine exposes, in the order a UI should offer
// them: derivative-free first (cheaper per iteration -- one loss evaluation each, no
// finite-difference probing), then gradient-based.
std::vector<std::string> nloptAlgorithmIds();

// Throws std::invalid_argument if algorithmId isn't one of nloptAlgorithmIds().
std::unique_ptr<OptimizerBackend> createNloptBackend(const std::string& algorithmId);

}
