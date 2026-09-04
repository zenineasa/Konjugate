/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "fmi2/fmi2Functions.h"
#include "konjugate/simulationModel.hpp"

#include <cmath>
#include <memory>
#include <stdexcept>
#include <string>

namespace {

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

// A minimal decay model: dx/dt = -k*x, k a live-parameter input (valueReference 1), x the sole
// output state (valueReference 0). Exercises the whole SimulationModel contract fmiGlue.cpp
// drives, independent of any generated codegen -- confirms the glue file itself is correct.
class DecayModel : public konjugate::sdk::v1::SimulationModel {
public:
    void setInput(int valueReference, double value) override {
        if (valueReference == 1) k_ = value;
    }
    double getOutput(int valueReference) const override {
        return valueReference == 0 ? x_ : 0.0;
    }
    void doStep(double, double stepSize) override {
        x_ += stepSize * (-k_ * x_);
    }
    double globalTimeStep() const override { return 0.1; }

private:
    double x_ = 10.0;
    double k_ = 0.5;
};

} // namespace

std::unique_ptr<konjugate::sdk::v1::SimulationModel> konjugate::sdk::v1::createSimulationModel() {
    return std::make_unique<DecayModel>();
}

namespace {

void instantiateRejectsModelExchange() {
    fmi2Component c = fmi2Instantiate("test", fmi2ModelExchange, "guid", "", nullptr, fmi2False, fmi2False);
    require(c == nullptr, "fmi2Instantiate must reject fmi2ModelExchange -- this FMU is Co-Simulation only.");
}

void fullLifecycleMatchesHandComputedEuler() {
    fmi2Component c = fmi2Instantiate("test", fmi2CoSimulation, "guid", "", nullptr, fmi2False, fmi2False);
    require(c != nullptr, "fmi2Instantiate failed for fmi2CoSimulation.");
    require(fmi2SetupExperiment(c, fmi2False, 0, 0.0, fmi2False, 0) == fmi2OK, "fmi2SetupExperiment failed.");
    require(fmi2EnterInitializationMode(c) == fmi2OK, "fmi2EnterInitializationMode failed.");
    require(fmi2ExitInitializationMode(c) == fmi2OK, "fmi2ExitInitializationMode failed.");

    const fmi2ValueReference kVr = 1;
    const fmi2Real kValue = 0.5;
    require(fmi2SetReal(c, &kVr, 1, &kValue) == fmi2OK, "fmi2SetReal (live parameter) failed.");

    // communicationStepSize=0.2 is 2x the model's own 0.1 globalTimeStep -- confirms fmi2DoStep
    // correctly sub-loops internal steps rather than treating the communication step as one tick.
    double reference = 10.0;
    for (int internalStep = 0; internalStep < 10; ++internalStep) reference += 0.1 * (-0.5 * reference);

    for (int commStep = 0; commStep < 5; ++commStep) {
        require(fmi2DoStep(c, commStep * 0.2, 0.2, fmi2False) == fmi2OK, "fmi2DoStep failed.");
    }

    const fmi2ValueReference xVr = 0;
    fmi2Real xValue = 0;
    require(fmi2GetReal(c, &xVr, 1, &xValue) == fmi2OK, "fmi2GetReal failed.");
    require(std::abs(xValue - reference) < 1e-9,
        "fmi2DoStep result diverged from a hand-computed Euler reference: got " + std::to_string(xValue) +
        ", expected " + std::to_string(reference));

    require(fmi2Terminate(c) == fmi2OK, "fmi2Terminate failed.");
    fmi2FreeInstance(c);
}

void doStepRejectsANonIntegerMultipleCommunicationStep() {
    fmi2Component c = fmi2Instantiate("test", fmi2CoSimulation, "guid", "", nullptr, fmi2False, fmi2False);
    require(c != nullptr, "fmi2Instantiate failed.");
    require(fmi2SetupExperiment(c, fmi2False, 0, 0.0, fmi2False, 0) == fmi2OK, "fmi2SetupExperiment failed.");
    // 0.15 is not a whole multiple of the model's 0.1 globalTimeStep.
    require(fmi2DoStep(c, 0.0, 0.15, fmi2False) == fmi2Error,
        "fmi2DoStep should reject a communicationStepSize that is not a whole multiple of globalTimeStep.");
    fmi2FreeInstance(c);
}

void resetReturnsTheModelToItsInitialState() {
    fmi2Component c = fmi2Instantiate("test", fmi2CoSimulation, "guid", "", nullptr, fmi2False, fmi2False);
    require(c != nullptr, "fmi2Instantiate failed.");
    require(fmi2SetupExperiment(c, fmi2False, 0, 0.0, fmi2False, 0) == fmi2OK, "fmi2SetupExperiment failed.");
    require(fmi2DoStep(c, 0.0, 0.5, fmi2False) == fmi2OK, "fmi2DoStep failed.");

    const fmi2ValueReference xVr = 0;
    fmi2Real beforeReset = 0;
    require(fmi2GetReal(c, &xVr, 1, &beforeReset) == fmi2OK, "fmi2GetReal failed.");
    require(std::abs(beforeReset - 10.0) > 1e-9, "The model should have moved away from its initial state before reset.");

    require(fmi2Reset(c) == fmi2OK, "fmi2Reset failed.");
    fmi2Real afterReset = 0;
    require(fmi2GetReal(c, &xVr, 1, &afterReset) == fmi2OK, "fmi2GetReal after reset failed.");
    require(std::abs(afterReset - 10.0) < 1e-12, "fmi2Reset should return the model to its initial state.");

    fmi2FreeInstance(c);
}

void declinedCapabilitiesFailCleanlyRatherThanCrashing() {
    fmi2Component c = fmi2Instantiate("test", fmi2CoSimulation, "guid", "", nullptr, fmi2False, fmi2False);
    require(c != nullptr, "fmi2Instantiate failed.");
    fmi2FMUstate state = nullptr;
    require(fmi2GetFMUstate(c, &state) == fmi2Error, "fmi2GetFMUstate should decline (canGetAndSetFMUstate=false).");
    require(fmi2GetStatus(c, 0, nullptr) == fmi2Discard, "fmi2GetStatus should return fmi2Discard.");
    // Zero-length Integer/Boolean/String get/set trivially succeed -- a host asking for zero
    // variables of an unsupported type has a well-defined, harmless answer.
    require(fmi2GetInteger(c, nullptr, 0, nullptr) == fmi2OK, "A zero-length fmi2GetInteger call should succeed.");
    fmi2FreeInstance(c);
}

} // namespace

int main() {
    instantiateRejectsModelExchange();
    fullLifecycleMatchesHandComputedEuler();
    doStepRejectsANonIntegerMultipleCommunicationStep();
    resetReturnsTheModelToItsInitialState();
    declinedCapabilitiesFailCleanlyRatherThanCrashing();
}
