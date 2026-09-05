/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "fmi2/fmi2Functions.h"
#include "konjugate/simulationModel.hpp"

#include <cmath>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

// Toggled by rollback/serialization tests before fmi2Instantiate; a real generated model's
// supportsStateCapture() is a fixed, compile-time decision (see src/fmiCodeGen.mjs) -- this is
// purely a test-only shim so one hand-written model can exercise both the "declined" path
// (already covered by declinedCapabilitiesFailCleanlyRatherThanCrashing, default false) and the
// "supported" path without a second CTest target.
bool gSupportsStateCapture = false;

// A minimal decay model: dx/dt = -k*x, k a live-parameter input (valueReference 1), x the sole
// output state (valueReference 0). Exercises the whole SimulationModel contract fmiGlue.cpp
// drives, independent of any generated codegen -- confirms the glue file itself is correct.
class DecayModel : public konjugate::sdk::v1::SimulationModel {
public:
    void setInput(int valueReference, double value) override {
        if (valueReference == 1) k_ = value;
    }
    double getOutput(int valueReference) const override {
        if (valueReference == 0) return x_;
        if (valueReference == 1) return k_;
        return 0.0;
    }
    void doStep(double, double stepSize) override {
        x_ += stepSize * (-k_ * x_);
    }
    double globalTimeStep() const override { return 0.1; }
    bool supportsStateCapture() const override { return gSupportsStateCapture; }
    std::vector<double> captureState() const override { return { x_, k_ }; }
    void restoreState(const std::vector<double>& snapshot) override {
        x_ = snapshot[0];
        k_ = snapshot[1];
    }

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

void getRealReadsBackAParameterValueJustSet() {
    fmi2Component c = fmi2Instantiate("test", fmi2CoSimulation, "guid", "", nullptr, fmi2False, fmi2False);
    require(c != nullptr, "fmi2Instantiate failed.");
    const fmi2ValueReference kVr = 1;
    const fmi2Real kValue = 0.75;
    require(fmi2SetReal(c, &kVr, 1, &kValue) == fmi2OK, "fmi2SetReal failed.");
    fmi2Real readback = 0;
    require(fmi2GetReal(c, &kVr, 1, &readback) == fmi2OK, "fmi2GetReal failed.");
    require(readback == 0.75, "fmi2GetReal should read back the value just set via fmi2SetReal, not a hardcoded default.");
    fmi2FreeInstance(c);
}

void rollbackRoundTripsThroughGetSetFMUstate() {
    gSupportsStateCapture = true;
    fmi2Component c = fmi2Instantiate("test", fmi2CoSimulation, "guid", "", nullptr, fmi2False, fmi2False);
    require(c != nullptr, "fmi2Instantiate failed.");
    require(fmi2SetupExperiment(c, fmi2False, 0, 0.0, fmi2False, 0) == fmi2OK, "fmi2SetupExperiment failed.");
    require(fmi2DoStep(c, 0.0, 0.5, fmi2False) == fmi2OK, "fmi2DoStep failed.");

    fmi2FMUstate snapshot = nullptr;
    require(fmi2GetFMUstate(c, &snapshot) == fmi2OK, "fmi2GetFMUstate should succeed once supportsStateCapture() is true.");

    const fmi2ValueReference xVr = 0;
    fmi2Real capturedValue = 0;
    require(fmi2GetReal(c, &xVr, 1, &capturedValue) == fmi2OK, "fmi2GetReal failed.");

    require(fmi2DoStep(c, 0.5, 0.5, fmi2False) == fmi2OK, "fmi2DoStep failed.");
    fmi2Real movedValue = 0;
    require(fmi2GetReal(c, &xVr, 1, &movedValue) == fmi2OK, "fmi2GetReal failed.");
    require(std::abs(movedValue - capturedValue) > 1e-9, "Sanity check: state should have moved further before rollback.");

    require(fmi2SetFMUstate(c, snapshot) == fmi2OK, "fmi2SetFMUstate failed.");
    fmi2Real afterRollback = 0;
    require(fmi2GetReal(c, &xVr, 1, &afterRollback) == fmi2OK, "fmi2GetReal after rollback failed.");
    require(std::abs(afterRollback - capturedValue) < 1e-12, "Rollback should restore the exact captured state.");

    require(fmi2FreeFMUstate(c, &snapshot) == fmi2OK, "fmi2FreeFMUstate failed.");
    require(snapshot == nullptr, "fmi2FreeFMUstate should null out the handle.");
    fmi2FreeInstance(c);
    gSupportsStateCapture = false;
}

void serializeAndDeserializeFMUstateRoundTrips() {
    gSupportsStateCapture = true;
    fmi2Component c = fmi2Instantiate("test", fmi2CoSimulation, "guid", "", nullptr, fmi2False, fmi2False);
    require(c != nullptr, "fmi2Instantiate failed.");
    require(fmi2SetupExperiment(c, fmi2False, 0, 0.0, fmi2False, 0) == fmi2OK, "fmi2SetupExperiment failed.");
    require(fmi2DoStep(c, 0.0, 0.3, fmi2False) == fmi2OK, "fmi2DoStep failed.");

    fmi2FMUstate snapshot = nullptr;
    require(fmi2GetFMUstate(c, &snapshot) == fmi2OK, "fmi2GetFMUstate failed.");
    size_t size = 0;
    require(fmi2SerializedFMUstateSize(c, snapshot, &size) == fmi2OK, "fmi2SerializedFMUstateSize failed.");
    require(size == 2 * sizeof(double), "Expected exactly 2 doubles (x_ and k_) in the serialized snapshot.");
    std::vector<fmi2Byte> bytes(size);
    require(fmi2SerializeFMUstate(c, snapshot, bytes.data(), bytes.size()) == fmi2OK, "fmi2SerializeFMUstate failed.");

    fmi2FMUstate restored = nullptr;
    require(fmi2DeSerializeFMUstate(c, bytes.data(), bytes.size(), &restored) == fmi2OK, "fmi2DeSerializeFMUstate failed.");

    require(fmi2DoStep(c, 0.3, 0.3, fmi2False) == fmi2OK, "fmi2DoStep failed."); // move state away
    const fmi2ValueReference xVr = 0;
    fmi2Real beforeRestore = 0;
    require(fmi2GetReal(c, &xVr, 1, &beforeRestore) == fmi2OK, "fmi2GetReal failed.");

    require(fmi2SetFMUstate(c, restored) == fmi2OK, "fmi2SetFMUstate (deserialized) failed.");
    fmi2Real afterRestore = 0;
    require(fmi2GetReal(c, &xVr, 1, &afterRestore) == fmi2OK, "fmi2GetReal failed.");
    require(std::abs(afterRestore - beforeRestore) > 1e-9, "Restoring the deserialized snapshot should have moved the state back.");

    require(fmi2FreeFMUstate(c, &snapshot) == fmi2OK, "fmi2FreeFMUstate (snapshot) failed.");
    require(fmi2FreeFMUstate(c, &restored) == fmi2OK, "fmi2FreeFMUstate (restored) failed.");
    fmi2FreeInstance(c);
    gSupportsStateCapture = false;
}

} // namespace

int main() {
    instantiateRejectsModelExchange();
    fullLifecycleMatchesHandComputedEuler();
    doStepRejectsANonIntegerMultipleCommunicationStep();
    resetReturnsTheModelToItsInitialState();
    declinedCapabilitiesFailCleanlyRatherThanCrashing();
    getRealReadsBackAParameterValueJustSet();
    rollbackRoundTripsThroughGetSetFMUstate();
    serializeAndDeserializeFMUstateRoundTrips();
}
