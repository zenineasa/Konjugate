/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <filesystem>
#include <string>

namespace konjugate {

// The complementary half of fmiGlue.cpp: where that file makes a Konjugate-exported artifact
// *answer* FMI2 calls (the export/server side), this is the host/import side -- it *places* those
// calls into an FMI 2.0 Co-Simulation shared library, loaded via dlopen()/LoadLibrary() (the same
// cross-platform pattern already proven in providerRuntime.cpp's InProcessProviderBackend).
//
// Scoped narrowly, not a general-purpose FMI import feature: it only ever drives a library
// Konjugate's own exporter just built (a known state count, no arbitrary vendor FMU support, no
// variable types beyond Real) -- used today as a dependency-free round-trip validator for FMU
// export (see docs/codeExport.md and tests/engine/fmiRoundTrip.mjs), though the same dlopen/FMI2
// mechanism here is what a future general import-as-provider feature would also build on.
//
// Drives the library through the real FMI2 C API and writes a plain CSV (time,var0,var1,...)
// reading value references 0..stateCount-1 at each communication point (outputInterval, used
// directly as the communication step size).
//
// When verifyRollback is true, also exercises fmi2Get/SetFMUstate around the run's midpoint and
// throws if the restored state doesn't match what was captured. If the library declines rollback
// (fmi2GetFMUstate returns fmi2Error, e.g. a model using a provider), this is skipped silently
// rather than treated as a failure -- declining rollback is a valid, documented FMU shape.
void runFmu(const std::filesystem::path& sharedLibraryPath, int stateCount,
    double targetTime, double globalTimeStep, double outputInterval,
    const std::filesystem::path& outputCsvPath, bool verifyRollback);

} // namespace konjugate
