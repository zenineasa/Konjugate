/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <memory>

namespace konjugate::sdk::v1 {

// The contract a generated FMU model source implements (src/fmiCodeGen.mjs, mirroring the same
// contribution-graph/expression-transpiling code src/codeExport.mjs's C++ export already uses and
// is fidelity-tested against the real engine). fmiGlue.cpp drives this interface behind the FMI
// 2.0 Co-Simulation C API -- see docs/codeExport.md for exactly what a model exported this way
// does and does not reproduce.
class SimulationModel {
public:
    virtual ~SimulationModel() = default;

    // Sets a live-parameter input by its value reference (see modelDescription.xml's matching
    // ScalarVariable causality="input" valueReference) -- called from fmi2SetReal.
    virtual void setInput(int valueReference, double value) = 0;

    // Reads a state's current value by its value reference (causality="output") -- called from
    // fmi2GetReal.
    virtual double getOutput(int valueReference) const = 0;

    // Advances the model by exactly one Konjugate global step (globalTimeStep, baked in at
    // generation time). fmi2DoStep calls this in a loop to cover a host-requested
    // communicationStepSize that is a whole multiple of globalTimeStep -- the model itself always
    // runs its own fixed-step Explicit Euler integration, never the host's.
    virtual void doStep(double currentTime, double globalTimeStep) = 0;

    // The model's own baked-in global step -- fmi2DoStep uses this to compute how many internal
    // steps a host-requested communicationStepSize covers.
    virtual double globalTimeStep() const = 0;
};

std::unique_ptr<SimulationModel> createSimulationModel();

} // namespace konjugate::sdk::v1
