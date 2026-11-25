/* Copyright © 2026 Zenin Easa Panthakkalakath */

// fmi3Glue.cpp (the FMI 3.0 Co-Simulation C API of an exported FMU) driven directly, over a hand-written model, as
// fmiGlueTests.cpp drives fmiGlue.cpp: the lifecycle, fmi3DoStep's outputs, the "time" variable, what a host may not set,
// the instantiation token, the logger, and the FMU state with its serialization.

#include "fmi3/fmi3Functions.h"
#include "konjugate/simulationModel.hpp"

#include <cmath>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

extern "C" FMI3_Export const char* fmi3GetVersion(void);
extern "C" FMI3_Export fmi3Status fmi3EnterEventMode(fmi3Instance instance);
extern "C" FMI3_Export fmi3Instance fmi3InstantiateModelExchange(fmi3String, fmi3String, fmi3String, fmi3Boolean, fmi3Boolean,
    fmi3InstanceEnvironment, fmi3LogMessageCallback);

// What an FMI 3.0 export appends to the model's source (src/fmiExport.mjs): value references 0 (x, an output) and 1 (k, a
// parameter), then time.
namespace konjugate::sdk::v1 {
extern const char* const fmi3InstantiationToken = "{decay-token}";
extern const unsigned int fmi3TimeValueReference = 2;
extern const unsigned int fmi3OutputCount = 1;
}

namespace {

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

bool gSupportsStateCapture = false;

// dx/dt = -k*x with x (valueReference 0) the output and k (valueReference 1) a parameter, as in fmiGlueTests.cpp.
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

struct LoggedMessages {
    std::vector<std::string> errors;
};

void logMessage(fmi3InstanceEnvironment environment, fmi3Status status, fmi3String category, fmi3String message) {
    if (status == fmi3Error && std::string(category) == "logStatusError") static_cast<LoggedMessages*>(environment)->errors.push_back(message);
}

fmi3Instance instantiate(LoggedMessages* log = nullptr, const char* token = "{decay-token}") {
    return fmi3InstantiateCoSimulation("test", token, nullptr, fmi3False, fmi3False, fmi3False, fmi3False, nullptr, 0,
        log, log ? logMessage : nullptr, nullptr);
}

double get(fmi3Instance instance, fmi3ValueReference valueReference) {
    double value = 0;
    require(fmi3GetFloat64(instance, &valueReference, 1, &value, 1) == fmi3OK, "fmi3GetFloat64 failed.");
    return value;
}

} // namespace

std::unique_ptr<konjugate::sdk::v1::SimulationModel> konjugate::sdk::v1::createSimulationModel() {
    return std::make_unique<DecayModel>();
}

namespace {

void instantiationChecksTheTokenAndOffersCoSimulationOnly() {
    LoggedMessages log;
    require(instantiate(&log, "{another-model}") == nullptr, "fmi3InstantiateCoSimulation must refuse another model's instantiationToken.");
    require(log.errors.size() == 1 && log.errors[0].find("{another-model}") != std::string::npos, "The refused token must be logged.");
    require(fmi3InstantiateModelExchange("test", "{decay-token}", nullptr, fmi3False, fmi3False, nullptr, nullptr) == nullptr,
        "This FMU is Co-Simulation only.");
    require(std::string(fmi3GetVersion()) == "3.0", "fmi3GetVersion must answer 3.0.");
}

void fullLifecycleMatchesHandComputedEuler() {
    fmi3Instance instance = instantiate();
    require(instance != nullptr, "fmi3InstantiateCoSimulation failed.");
    require(fmi3EnterInitializationMode(instance, fmi3False, 0, 0.0, fmi3False, 0) == fmi3OK, "fmi3EnterInitializationMode failed.");
    const fmi3ValueReference kVr = 1;
    const fmi3Float64 kValue = 0.5;
    require(fmi3SetFloat64(instance, &kVr, 1, &kValue, 1) == fmi3OK, "fmi3SetFloat64 (parameter) failed.");
    require(fmi3ExitInitializationMode(instance) == fmi3OK, "fmi3ExitInitializationMode failed.");

    double reference = 10.0;
    for (int internalStep = 0; internalStep < 10; ++internalStep) reference += 0.1 * (-0.5 * reference);

    double time = 0.0;
    for (int communicationStep = 0; communicationStep < 5; ++communicationStep) {
        fmi3Boolean eventHandlingNeeded = fmi3True, terminateSimulation = fmi3True, earlyReturn = fmi3True;
        fmi3Float64 lastSuccessfulTime = -1;
        require(fmi3DoStep(instance, time, 0.2, fmi3False, &eventHandlingNeeded, &terminateSimulation, &earlyReturn, &lastSuccessfulTime) == fmi3OK,
            "fmi3DoStep failed.");
        require(!eventHandlingNeeded && !terminateSimulation && !earlyReturn, "fmi3DoStep has no events, no termination and no early return.");
        require(std::abs(lastSuccessfulTime - (time + 0.2)) < 1e-12, "lastSuccessfulTime must be the end of the whole step.");
        time = lastSuccessfulTime;
    }
    require(std::abs(get(instance, 0) - reference) < 1e-9, "fmi3DoStep diverged from a hand-computed Euler reference.");
    require(std::abs(get(instance, 2) - 1.0) < 1e-12, "time must read the end of the last step.");

    require(fmi3Terminate(instance) == fmi3OK, "fmi3Terminate failed.");
    fmi3FreeInstance(instance);
}

void refusalsAreLogged() {
    LoggedMessages log;
    fmi3Instance instance = instantiate(&log);
    require(instance != nullptr, "fmi3InstantiateCoSimulation failed.");
    require(fmi3EnterInitializationMode(instance, fmi3False, 0, 0.0, fmi3False, 0) == fmi3OK, "fmi3EnterInitializationMode failed.");
    require(fmi3ExitInitializationMode(instance) == fmi3OK, "fmi3ExitInitializationMode failed.");
    fmi3Boolean flag = fmi3False;
    fmi3Float64 last = 0;
    require(fmi3DoStep(instance, 0.0, 0.15, fmi3False, &flag, &flag, &flag, &last) == fmi3Error, "A step of 0.15 is not a whole number of 0.1 steps.");
    const fmi3ValueReference xVr = 0, timeVr = 2, unknownVr = 3;
    const fmi3Float64 value = 1.0;
    require(fmi3SetFloat64(instance, &xVr, 1, &value, 1) == fmi3Error, "An output cannot be set.");
    require(fmi3SetFloat64(instance, &timeVr, 1, &value, 1) == fmi3Error, "time cannot be set.");
    fmi3Float64 read = 0;
    require(fmi3GetFloat64(instance, &unknownVr, 1, &read, 1) == fmi3Error, "There is no value reference 3.");
    require(fmi3EnterEventMode(instance) == fmi3Error, "This FMU has no Event Mode.");
    fmi3FMUState state = nullptr;
    require(fmi3GetFMUState(instance, &state) == fmi3Error, "fmi3GetFMUState is declined when the model cannot capture its state.");
    require(fmi3GetInt32(instance, nullptr, 0, nullptr, 0) == fmi3OK, "Asking for no Int32 variables is harmless.");
    require(log.errors.size() == 6, "Every refusal is logged: " + std::to_string(log.errors.size()) + " were.");
    fmi3FreeInstance(instance);
}

void resetReturnsTheModelToItsInitialState() {
    fmi3Instance instance = instantiate();
    require(fmi3EnterInitializationMode(instance, fmi3False, 0, 0.0, fmi3False, 0) == fmi3OK, "fmi3EnterInitializationMode failed.");
    require(fmi3ExitInitializationMode(instance) == fmi3OK, "fmi3ExitInitializationMode failed.");
    fmi3Boolean flag = fmi3False;
    fmi3Float64 last = 0;
    require(fmi3DoStep(instance, 0.0, 0.5, fmi3False, &flag, &flag, &flag, &last) == fmi3OK, "fmi3DoStep failed.");
    require(std::abs(get(instance, 0) - 10.0) > 1e-9, "The model should have moved before the reset.");
    require(fmi3Reset(instance) == fmi3OK, "fmi3Reset failed.");
    require(get(instance, 0) == 10.0 && get(instance, 2) == 0.0, "fmi3Reset returns the model and its time to the start.");
    fmi3FreeInstance(instance);
}

void stateAndItsSerializationRoundTrip() {
    gSupportsStateCapture = true;
    fmi3Instance instance = instantiate();
    require(fmi3EnterInitializationMode(instance, fmi3False, 0, 0.0, fmi3False, 0) == fmi3OK, "fmi3EnterInitializationMode failed.");
    require(fmi3ExitInitializationMode(instance) == fmi3OK, "fmi3ExitInitializationMode failed.");
    fmi3Boolean flag = fmi3False;
    fmi3Float64 last = 0;
    require(fmi3DoStep(instance, 0.0, 0.3, fmi3False, &flag, &flag, &flag, &last) == fmi3OK, "fmi3DoStep failed.");

    fmi3FMUState state = nullptr;
    require(fmi3GetFMUState(instance, &state) == fmi3OK, "fmi3GetFMUState failed.");
    const double capturedX = get(instance, 0), capturedTime = get(instance, 2);
    size_t size = 0;
    require(fmi3SerializedFMUStateSize(instance, state, &size) == fmi3OK, "fmi3SerializedFMUStateSize failed.");
    require(size == 3 * sizeof(double), "The serialized state is the time, x and k.");
    std::vector<fmi3Byte> bytes(size);
    require(fmi3SerializeFMUState(instance, state, bytes.data(), bytes.size()) == fmi3OK, "fmi3SerializeFMUState failed.");
    fmi3FMUState restored = nullptr;
    require(fmi3DeserializeFMUState(instance, bytes.data(), bytes.size(), &restored) == fmi3OK, "fmi3DeserializeFMUState failed.");

    require(fmi3DoStep(instance, last, 0.3, fmi3False, &flag, &flag, &flag, &last) == fmi3OK, "fmi3DoStep failed.");
    const double movedX = get(instance, 0);
    require(movedX != capturedX, "The model should have moved before the restore.");

    require(fmi3SetFMUState(instance, restored) == fmi3OK, "fmi3SetFMUState (deserialized) failed.");
    require(get(instance, 0) == capturedX && get(instance, 2) == capturedTime, "A restored state gives back the value and the time exactly.");
    require(fmi3DoStep(instance, capturedTime, 0.3, fmi3False, &flag, &flag, &flag, &last) == fmi3OK, "fmi3DoStep failed.");
    require(get(instance, 0) == movedX, "Stepping again from the restored state repeats the same numbers.");

    // A state given back to fmi3GetFMUState is overwritten in place.
    fmi3FMUState reused = state;
    require(fmi3GetFMUState(instance, &reused) == fmi3OK && reused == state, "fmi3GetFMUState overwrites a state it is given.");

    require(fmi3FreeFMUState(instance, &state) == fmi3OK && state == nullptr, "fmi3FreeFMUState failed.");
    require(fmi3FreeFMUState(instance, &restored) == fmi3OK, "fmi3FreeFMUState failed.");
    fmi3FreeInstance(instance);
    gSupportsStateCapture = false;
}

} // namespace

int main() {
    instantiationChecksTheTokenAndOffersCoSimulationOnly();
    fullLifecycleMatchesHandComputedEuler();
    refusalsAreLogged();
    resetReturnsTheModelToItsInitialState();
    stateAndItsSerializationRoundTrip();
}
