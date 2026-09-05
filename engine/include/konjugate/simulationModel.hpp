/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <memory>
#include <stdexcept>
#include <vector>

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

    // Optional: backs fmi2Get/SetFMUstate (rollback). A model with any embedded C++ provider can
    // carry arbitrary internal state across evaluate() calls with no generic way to serialize it,
    // so only a provider-free generated model overrides these -- the default here is "unsupported",
    // matching modelDescription.xml's canGetAndSetFMUstate="false" for such a model.
    virtual bool supportsStateCapture() const { return false; }
    virtual std::vector<double> captureState() const { throw std::logic_error("State capture is not supported by this model."); }
    virtual void restoreState(const std::vector<double>&) { throw std::logic_error("State restore is not supported by this model."); }
};

std::unique_ptr<SimulationModel> createSimulationModel();

} // namespace konjugate::sdk::v1
