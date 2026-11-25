/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Implements the FMI 3.0 Co-Simulation C API over a generated model's konjugate::sdk::v1::SimulationModel
// (konjugate/simulationModel.hpp) -- the FMI 3.0 sibling of fmiGlue.cpp, compiled and linked together with the same generated
// model source into one shared library by the engine's buildSharedLibrary command (src/fmiExport.mjs). An FMI 3.0 export appends
// two constants to that source (its instantiationToken and the value reference of its "time" variable, declared below), so the
// model itself, its value references and its numbers are exactly those of the FMI 2.0 export. See docs/codeExport.md.
//
// Co-Simulation only, as FMI 3.0 section 4 has it, with no Event Mode, no early return and no intermediate update
// (modelDescription.xml declares hasEventMode, mightReturnEarlyFromDoStep, canReturnEarlyAfterIntermediateUpdate and
// providesIntermediateUpdate all false): fmi3DoStep always completes the whole communication step. Every other function of the
// standard is exported too (a host such as FMPy binds them all by name when it loads the library) and refuses with fmi3Error,
// saying so through the logger, since modelDescription.xml declares none of the capabilities they belong to. No C++ exception
// ever crosses the extern "C" boundary.

#include "fmi3/fmi3Functions.h"
#include "konjugate/simulationModel.hpp"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <exception>
#include <memory>
#include <string>
#include <vector>

// Written by the FMI 3.0 export into the model's source (src/fmiExport.mjs, fmi3IdentitySource).
namespace konjugate::sdk::v1 {
extern const char* const fmi3InstantiationToken;
// The value reference of the independent variable "time": one past the model's last variable, so every other value reference is
// the FMI 2.0 export's.
extern const unsigned int fmi3TimeValueReference;
// The states (value references 0 to this - 1) are outputs, which a host reads and never sets.
extern const unsigned int fmi3OutputCount;
}

// The parts of the standard's fmi3PlatformTypes.h/fmi3FunctionTypes.h the import-side headers (engine/include/fmi3) leave out,
// as the standard defines them, for the refusing functions below.
typedef bool fmi3Clock;
typedef enum { fmi3IntervalNotYetKnown, fmi3IntervalUnchanged, fmi3IntervalChanged } fmi3IntervalQualifier;
typedef enum { fmi3Independent, fmi3Constant, fmi3Fixed, fmi3Tunable, fmi3Discrete, fmi3Dependent } fmi3DependencyKind;
typedef void (*fmi3ClockUpdateCallback)(fmi3InstanceEnvironment instanceEnvironment);
typedef void (*fmi3LockPreemptionCallback)(void);
typedef void (*fmi3UnlockPreemptionCallback)(void);

namespace {

using konjugate::sdk::v1::fmi3InstantiationToken;
using konjugate::sdk::v1::fmi3OutputCount;
using konjugate::sdk::v1::fmi3TimeValueReference;

struct FmuInstance {
    std::unique_ptr<konjugate::sdk::v1::SimulationModel> model;
    std::string instanceName;
    fmi3InstanceEnvironment environment = nullptr;
    fmi3LogMessageCallback logMessage = nullptr;
    double currentTime = 0.0;
};

// An FMU state: the time it was taken at and the model's own captured values (states, parameters, programs' memory).
struct Snapshot {
    double time = 0.0;
    std::vector<double> values;
};

FmuInstance* asInstance(fmi3Instance instance) {
    return static_cast<FmuInstance*>(instance);
}

// Errors are always reported through the host's logger (FMI 3.0 section 2.4.5, Log Categories: "logStatusError"), whether or not debug logging
// is on: a refused call is never silent.
fmi3Status fail(FmuInstance* instance, const std::string& message) {
    if (instance && instance->logMessage) instance->logMessage(instance->environment, fmi3Error, "logStatusError", message.c_str());
    return fmi3Error;
}

fmi3Status unsupported(fmi3Instance instance, const char* function) {
    return fail(asInstance(instance), std::string(function) + " is not supported: this FMU declares no such capability in its modelDescription.xml.");
}

std::string describe(const std::exception& error) {
    return error.what();
}

std::string number(double value) {
    char text[32];
    std::snprintf(text, sizeof text, "%.15g", value);
    return text;
}

} // namespace

extern "C" {

FMI3_Export const char* fmi3GetVersion(void) {
    return "3.0";
}

FMI3_Export fmi3Status fmi3SetDebugLogging(fmi3Instance instance, fmi3Boolean, size_t, const fmi3String[]) {
    // Errors are always logged; there are no debug messages to turn on or off.
    return asInstance(instance) ? fmi3OK : fmi3Error;
}

FMI3_Export fmi3Instance fmi3InstantiateCoSimulation(fmi3String instanceName, fmi3String instantiationToken, fmi3String,
    fmi3Boolean, fmi3Boolean, fmi3Boolean, fmi3Boolean, const fmi3ValueReference[], size_t,
    fmi3InstanceEnvironment instanceEnvironment, fmi3LogMessageCallback logMessage, fmi3IntermediateUpdateCallback) {
    // The token ties the binary to its modelDescription.xml (FMI 3.0 section 2.4.1): a different one means a different model.
    if (instantiationToken && std::strcmp(instantiationToken, fmi3InstantiationToken) != 0) {
        if (logMessage) {
            const std::string message = std::string("The instantiationToken '") + instantiationToken + "' is not this FMU's ('" + fmi3InstantiationToken + "'): its modelDescription.xml belongs to another model.";
            logMessage(instanceEnvironment, fmi3Error, "logStatusError", message.c_str());
        }
        return nullptr;
    }
    try {
        auto instance = std::make_unique<FmuInstance>();
        instance->instanceName = instanceName ? instanceName : "";
        instance->environment = instanceEnvironment;
        instance->logMessage = logMessage;
        instance->model = konjugate::sdk::v1::createSimulationModel();
        return instance.release();
    } catch (const std::exception& error) {
        if (logMessage) logMessage(instanceEnvironment, fmi3Error, "logStatusError", error.what());
        return nullptr;
    } catch (...) {
        return nullptr;
    }
}

FMI3_Export fmi3Instance fmi3InstantiateModelExchange(fmi3String, fmi3String, fmi3String, fmi3Boolean, fmi3Boolean,
    fmi3InstanceEnvironment instanceEnvironment, fmi3LogMessageCallback logMessage) {
    if (logMessage) logMessage(instanceEnvironment, fmi3Error, "logStatusError", "This FMU is Co-Simulation only: it offers no Model Exchange.");
    return nullptr;
}

FMI3_Export fmi3Instance fmi3InstantiateScheduledExecution(fmi3String, fmi3String, fmi3String, fmi3Boolean, fmi3Boolean,
    fmi3InstanceEnvironment instanceEnvironment, fmi3LogMessageCallback logMessage, fmi3ClockUpdateCallback,
    fmi3LockPreemptionCallback, fmi3UnlockPreemptionCallback) {
    if (logMessage) logMessage(instanceEnvironment, fmi3Error, "logStatusError", "This FMU is Co-Simulation only: it offers no Scheduled Execution.");
    return nullptr;
}

FMI3_Export void fmi3FreeInstance(fmi3Instance instance) {
    delete asInstance(instance);
}

FMI3_Export fmi3Status fmi3EnterInitializationMode(fmi3Instance instance, fmi3Boolean, fmi3Float64, fmi3Float64 startTime, fmi3Boolean, fmi3Float64) {
    auto* fmu = asInstance(instance);
    if (!fmu) return fmi3Error;
    fmu->currentTime = startTime;
    return fmi3OK;
}

FMI3_Export fmi3Status fmi3ExitInitializationMode(fmi3Instance instance) {
    // Without Event Mode, a Co-Simulation FMU goes straight to Step Mode (FMI 3.0 section 4.2.1).
    return asInstance(instance) ? fmi3OK : fmi3Error;
}

FMI3_Export fmi3Status fmi3Terminate(fmi3Instance instance) {
    return asInstance(instance) ? fmi3OK : fmi3Error;
}

FMI3_Export fmi3Status fmi3Reset(fmi3Instance instance) {
    auto* fmu = asInstance(instance);
    if (!fmu) return fmi3Error;
    try {
        fmu->model = konjugate::sdk::v1::createSimulationModel();
        fmu->currentTime = 0.0;
        return fmi3OK;
    } catch (const std::exception& error) {
        return fail(fmu, "fmi3Reset: " + describe(error));
    } catch (...) {
        return fmi3Error;
    }
}

FMI3_Export fmi3Status fmi3GetFloat64(fmi3Instance instance, const fmi3ValueReference valueReferences[], size_t nValueReferences, fmi3Float64 values[], size_t nValues) {
    auto* fmu = asInstance(instance);
    if (!fmu) return fmi3Error;
    // Every variable is a scalar, so there is one value per value reference.
    if (nValues != nValueReferences) return fail(fmu, "fmi3GetFloat64: " + std::to_string(nValues) + " values asked for " + std::to_string(nValueReferences) + " scalar variables.");
    try {
        for (size_t index = 0; index < nValueReferences; ++index) {
            const fmi3ValueReference valueReference = valueReferences[index];
            if (valueReference == fmi3TimeValueReference) values[index] = fmu->currentTime;
            else if (valueReference < fmi3TimeValueReference) values[index] = fmu->model->getOutput(static_cast<int>(valueReference));
            else return fail(fmu, "fmi3GetFloat64: there is no Float64 variable with value reference " + std::to_string(valueReference) + ".");
        }
        return fmi3OK;
    } catch (const std::exception& error) {
        return fail(fmu, "fmi3GetFloat64: " + describe(error));
    } catch (...) {
        return fmi3Error;
    }
}

FMI3_Export fmi3Status fmi3SetFloat64(fmi3Instance instance, const fmi3ValueReference valueReferences[], size_t nValueReferences, const fmi3Float64 values[], size_t nValues) {
    auto* fmu = asInstance(instance);
    if (!fmu) return fmi3Error;
    if (nValues != nValueReferences) return fail(fmu, "fmi3SetFloat64: " + std::to_string(nValues) + " values given for " + std::to_string(nValueReferences) + " scalar variables.");
    try {
        for (size_t index = 0; index < nValueReferences; ++index) {
            const fmi3ValueReference valueReference = valueReferences[index];
            if (valueReference == fmi3TimeValueReference) return fail(fmu, "fmi3SetFloat64: time is the independent variable; it cannot be set.");
            if (valueReference > fmi3TimeValueReference) return fail(fmu, "fmi3SetFloat64: there is no Float64 variable with value reference " + std::to_string(valueReference) + ".");
            if (valueReference < fmi3OutputCount) return fail(fmu, "fmi3SetFloat64: value reference " + std::to_string(valueReference) + " is an output, which cannot be set.");
            fmu->model->setInput(static_cast<int>(valueReference), values[index]);
        }
        return fmi3OK;
    } catch (const std::exception& error) {
        return fail(fmu, "fmi3SetFloat64: " + describe(error));
    } catch (...) {
        return fmi3Error;
    }
}

FMI3_Export fmi3Status fmi3DoStep(fmi3Instance instance, fmi3Float64 currentCommunicationPoint, fmi3Float64 communicationStepSize, fmi3Boolean,
    fmi3Boolean* eventHandlingNeeded, fmi3Boolean* terminateSimulation, fmi3Boolean* earlyReturn, fmi3Float64* lastSuccessfulTime) {
    auto* fmu = asInstance(instance);
    if (!fmu) return fmi3Error;
    // No Event Mode and no early return (FMI 3.0 section 4.2.1, Step Mode): the step is always taken whole, or refused.
    if (eventHandlingNeeded) *eventHandlingNeeded = fmi3False;
    if (terminateSimulation) *terminateSimulation = fmi3False;
    if (earlyReturn) *earlyReturn = fmi3False;
    if (lastSuccessfulTime) *lastSuccessfulTime = fmu->currentTime;
    try {
        const double globalTimeStep = fmu->model->globalTimeStep();
        const double stepsExact = communicationStepSize / globalTimeStep;
        const auto steps = static_cast<long long>(std::llround(stepsExact));
        // As fmiGlue.cpp's fmi2DoStep: Konjugate always advances in whole global steps (modelDescription.xml's
        // fixedInternalStepSize), so a communication step must be a whole number of them.
        if (steps < 1 || std::abs(stepsExact - static_cast<double>(steps)) > 1e-6) {
            return fail(fmu, "fmi3DoStep: the communication step size " + number(communicationStepSize) + " is not a whole number of this FMU's fixed internal step " + number(globalTimeStep) + ".");
        }
        double time = currentCommunicationPoint;
        for (long long step = 0; step < steps; ++step) {
            fmu->model->doStep(time, globalTimeStep);
            time += globalTimeStep;
        }
        fmu->currentTime = time;
        if (lastSuccessfulTime) *lastSuccessfulTime = time;
        return fmi3OK;
    } catch (const std::exception& error) {
        return fail(fmu, "fmi3DoStep at t = " + number(currentCommunicationPoint) + ": " + describe(error));
    } catch (...) {
        return fmi3Error;
    }
}

// --- FMU state (FMI 3.0 section 2.2.7.4): offered when the model reports supportsStateCapture() (modelDescription.xml's
// canGetAndSetFMUState and canSerializeFMUState). The state also holds the time, so "time" reads back as it was. Serialized as
// that time followed by the captured values, raw doubles: a serialized state is only ever read back by the same binary. ---

FMI3_Export fmi3Status fmi3GetFMUState(fmi3Instance instance, fmi3FMUState* FMUState) {
    auto* fmu = asInstance(instance);
    if (!fmu || !FMUState) return fmi3Error;
    if (!fmu->model->supportsStateCapture()) return unsupported(instance, "fmi3GetFMUState");
    try {
        // A state given back is overwritten in place, as the standard allows.
        auto* snapshot = *FMUState ? static_cast<Snapshot*>(*FMUState) : new Snapshot();
        snapshot->time = fmu->currentTime;
        snapshot->values = fmu->model->captureState();
        *FMUState = snapshot;
        return fmi3OK;
    } catch (const std::exception& error) {
        return fail(fmu, "fmi3GetFMUState: " + describe(error));
    } catch (...) {
        return fmi3Error;
    }
}

FMI3_Export fmi3Status fmi3SetFMUState(fmi3Instance instance, fmi3FMUState FMUState) {
    auto* fmu = asInstance(instance);
    if (!fmu || !FMUState) return fmi3Error;
    if (!fmu->model->supportsStateCapture()) return unsupported(instance, "fmi3SetFMUState");
    try {
        const auto* snapshot = static_cast<const Snapshot*>(FMUState);
        fmu->model->restoreState(snapshot->values);
        fmu->currentTime = snapshot->time;
        return fmi3OK;
    } catch (const std::exception& error) {
        return fail(fmu, "fmi3SetFMUState: " + describe(error));
    } catch (...) {
        return fmi3Error;
    }
}

FMI3_Export fmi3Status fmi3FreeFMUState(fmi3Instance, fmi3FMUState* FMUState) {
    if (!FMUState) return fmi3Error;
    delete static_cast<Snapshot*>(*FMUState);
    *FMUState = nullptr;
    return fmi3OK;
}

FMI3_Export fmi3Status fmi3SerializedFMUStateSize(fmi3Instance instance, fmi3FMUState FMUState, size_t* size) {
    if (!FMUState || !size) return fail(asInstance(instance), "fmi3SerializedFMUStateSize: no FMU state given.");
    *size = (1 + static_cast<const Snapshot*>(FMUState)->values.size()) * sizeof(double);
    return fmi3OK;
}

FMI3_Export fmi3Status fmi3SerializeFMUState(fmi3Instance instance, fmi3FMUState FMUState, fmi3Byte serializedState[], size_t size) {
    if (!FMUState || !serializedState) return fail(asInstance(instance), "fmi3SerializeFMUState: no FMU state given.");
    const auto* snapshot = static_cast<const Snapshot*>(FMUState);
    const size_t needed = (1 + snapshot->values.size()) * sizeof(double);
    if (size < needed) return fail(asInstance(instance), "fmi3SerializeFMUState: " + std::to_string(size) + " bytes given, " + std::to_string(needed) + " needed.");
    std::memcpy(serializedState, &snapshot->time, sizeof(double));
    if (!snapshot->values.empty()) std::memcpy(serializedState + sizeof(double), snapshot->values.data(), snapshot->values.size() * sizeof(double));
    return fmi3OK;
}

FMI3_Export fmi3Status fmi3DeserializeFMUState(fmi3Instance instance, const fmi3Byte serializedState[], size_t size, fmi3FMUState* FMUState) {
    if (!serializedState || !FMUState || size < sizeof(double) || size % sizeof(double) != 0) {
        return fail(asInstance(instance), "fmi3DeserializeFMUState: " + std::to_string(size) + " bytes are not a state serialized by this FMU.");
    }
    try {
        auto* snapshot = new Snapshot();
        std::memcpy(&snapshot->time, serializedState, sizeof(double));
        snapshot->values.resize(size / sizeof(double) - 1);
        if (!snapshot->values.empty()) std::memcpy(snapshot->values.data(), serializedState + sizeof(double), snapshot->values.size() * sizeof(double));
        *FMUState = snapshot;
        return fmi3OK;
    } catch (...) {
        return fmi3Error;
    }
}

// --- Declined: modelDescription.xml declares no variable of these types and none of these capabilities, so a compliant host
// never calls them. They are exported, and refuse, rather than left unresolved. ---

#define KONJUGATE_FMI3_REFUSE_GET_SET(Type) \
    FMI3_Export fmi3Status fmi3Get##Type(fmi3Instance instance, const fmi3ValueReference[], size_t nValueReferences, fmi3##Type[], size_t) { \
        return nValueReferences == 0 ? fmi3OK : fail(asInstance(instance), "fmi3Get" #Type ": this FMU has no " #Type " variables."); } \
    FMI3_Export fmi3Status fmi3Set##Type(fmi3Instance instance, const fmi3ValueReference[], size_t nValueReferences, const fmi3##Type[], size_t) { \
        return nValueReferences == 0 ? fmi3OK : fail(asInstance(instance), "fmi3Set" #Type ": this FMU has no " #Type " variables."); }

KONJUGATE_FMI3_REFUSE_GET_SET(Float32)
KONJUGATE_FMI3_REFUSE_GET_SET(Int8)
KONJUGATE_FMI3_REFUSE_GET_SET(UInt8)
KONJUGATE_FMI3_REFUSE_GET_SET(Int16)
KONJUGATE_FMI3_REFUSE_GET_SET(UInt16)
KONJUGATE_FMI3_REFUSE_GET_SET(Int32)
KONJUGATE_FMI3_REFUSE_GET_SET(UInt32)
KONJUGATE_FMI3_REFUSE_GET_SET(Int64)
KONJUGATE_FMI3_REFUSE_GET_SET(UInt64)
KONJUGATE_FMI3_REFUSE_GET_SET(Boolean)
KONJUGATE_FMI3_REFUSE_GET_SET(String)

#undef KONJUGATE_FMI3_REFUSE_GET_SET

FMI3_Export fmi3Status fmi3GetBinary(fmi3Instance instance, const fmi3ValueReference[], size_t nValueReferences, size_t[], fmi3Binary[], size_t) {
    return nValueReferences == 0 ? fmi3OK : fail(asInstance(instance), "fmi3GetBinary: this FMU has no Binary variables.");
}
FMI3_Export fmi3Status fmi3SetBinary(fmi3Instance instance, const fmi3ValueReference[], size_t nValueReferences, const size_t[], const fmi3Binary[], size_t) {
    return nValueReferences == 0 ? fmi3OK : fail(asInstance(instance), "fmi3SetBinary: this FMU has no Binary variables.");
}
FMI3_Export fmi3Status fmi3GetClock(fmi3Instance instance, const fmi3ValueReference[], size_t nValueReferences, fmi3Clock[]) {
    return nValueReferences == 0 ? fmi3OK : fail(asInstance(instance), "fmi3GetClock: this FMU has no clocks.");
}
FMI3_Export fmi3Status fmi3SetClock(fmi3Instance instance, const fmi3ValueReference[], size_t nValueReferences, const fmi3Clock[]) {
    return nValueReferences == 0 ? fmi3OK : fail(asInstance(instance), "fmi3SetClock: this FMU has no clocks.");
}

FMI3_Export fmi3Status fmi3EnterEventMode(fmi3Instance instance) { return unsupported(instance, "fmi3EnterEventMode"); }
FMI3_Export fmi3Status fmi3EnterStepMode(fmi3Instance instance) { return unsupported(instance, "fmi3EnterStepMode"); }
FMI3_Export fmi3Status fmi3EnterConfigurationMode(fmi3Instance instance) { return unsupported(instance, "fmi3EnterConfigurationMode"); }
FMI3_Export fmi3Status fmi3ExitConfigurationMode(fmi3Instance instance) { return unsupported(instance, "fmi3ExitConfigurationMode"); }
FMI3_Export fmi3Status fmi3EvaluateDiscreteStates(fmi3Instance instance) { return unsupported(instance, "fmi3EvaluateDiscreteStates"); }
FMI3_Export fmi3Status fmi3UpdateDiscreteStates(fmi3Instance instance, fmi3Boolean*, fmi3Boolean*, fmi3Boolean*, fmi3Boolean*, fmi3Boolean*, fmi3Float64*) {
    return unsupported(instance, "fmi3UpdateDiscreteStates");
}

FMI3_Export fmi3Status fmi3GetNumberOfVariableDependencies(fmi3Instance instance, fmi3ValueReference, size_t*) {
    return unsupported(instance, "fmi3GetNumberOfVariableDependencies");
}
FMI3_Export fmi3Status fmi3GetVariableDependencies(fmi3Instance instance, fmi3ValueReference, size_t[], fmi3ValueReference[], size_t[], fmi3DependencyKind[], size_t) {
    return unsupported(instance, "fmi3GetVariableDependencies");
}
FMI3_Export fmi3Status fmi3GetDirectionalDerivative(fmi3Instance instance, const fmi3ValueReference[], size_t, const fmi3ValueReference[], size_t, const fmi3Float64[], size_t, fmi3Float64[], size_t) {
    return unsupported(instance, "fmi3GetDirectionalDerivative");
}
FMI3_Export fmi3Status fmi3GetAdjointDerivative(fmi3Instance instance, const fmi3ValueReference[], size_t, const fmi3ValueReference[], size_t, const fmi3Float64[], size_t, fmi3Float64[], size_t) {
    return unsupported(instance, "fmi3GetAdjointDerivative");
}
FMI3_Export fmi3Status fmi3GetOutputDerivatives(fmi3Instance instance, const fmi3ValueReference[], size_t, const fmi3Int32[], fmi3Float64[], size_t) {
    return unsupported(instance, "fmi3GetOutputDerivatives");
}

FMI3_Export fmi3Status fmi3GetIntervalDecimal(fmi3Instance instance, const fmi3ValueReference[], size_t, fmi3Float64[], fmi3IntervalQualifier[]) { return unsupported(instance, "fmi3GetIntervalDecimal"); }
FMI3_Export fmi3Status fmi3GetIntervalFraction(fmi3Instance instance, const fmi3ValueReference[], size_t, fmi3UInt64[], fmi3UInt64[], fmi3IntervalQualifier[]) { return unsupported(instance, "fmi3GetIntervalFraction"); }
FMI3_Export fmi3Status fmi3GetShiftDecimal(fmi3Instance instance, const fmi3ValueReference[], size_t, fmi3Float64[]) { return unsupported(instance, "fmi3GetShiftDecimal"); }
FMI3_Export fmi3Status fmi3GetShiftFraction(fmi3Instance instance, const fmi3ValueReference[], size_t, fmi3UInt64[], fmi3UInt64[]) { return unsupported(instance, "fmi3GetShiftFraction"); }
FMI3_Export fmi3Status fmi3SetIntervalDecimal(fmi3Instance instance, const fmi3ValueReference[], size_t, const fmi3Float64[]) { return unsupported(instance, "fmi3SetIntervalDecimal"); }
FMI3_Export fmi3Status fmi3SetIntervalFraction(fmi3Instance instance, const fmi3ValueReference[], size_t, const fmi3UInt64[], const fmi3UInt64[]) { return unsupported(instance, "fmi3SetIntervalFraction"); }
FMI3_Export fmi3Status fmi3SetShiftDecimal(fmi3Instance instance, const fmi3ValueReference[], size_t, const fmi3Float64[]) { return unsupported(instance, "fmi3SetShiftDecimal"); }
FMI3_Export fmi3Status fmi3SetShiftFraction(fmi3Instance instance, const fmi3ValueReference[], size_t, const fmi3UInt64[], const fmi3UInt64[]) { return unsupported(instance, "fmi3SetShiftFraction"); }
FMI3_Export fmi3Status fmi3ActivateModelPartition(fmi3Instance instance, fmi3ValueReference, fmi3Float64) { return unsupported(instance, "fmi3ActivateModelPartition"); }

// Model Exchange's functions (no instance can be made for it, see fmi3InstantiateModelExchange).
FMI3_Export fmi3Status fmi3EnterContinuousTimeMode(fmi3Instance instance) { return unsupported(instance, "fmi3EnterContinuousTimeMode"); }
FMI3_Export fmi3Status fmi3CompletedIntegratorStep(fmi3Instance instance, fmi3Boolean, fmi3Boolean*, fmi3Boolean*) { return unsupported(instance, "fmi3CompletedIntegratorStep"); }
FMI3_Export fmi3Status fmi3SetTime(fmi3Instance instance, fmi3Float64) { return unsupported(instance, "fmi3SetTime"); }
FMI3_Export fmi3Status fmi3SetContinuousStates(fmi3Instance instance, const fmi3Float64[], size_t) { return unsupported(instance, "fmi3SetContinuousStates"); }
FMI3_Export fmi3Status fmi3GetContinuousStateDerivatives(fmi3Instance instance, fmi3Float64[], size_t) { return unsupported(instance, "fmi3GetContinuousStateDerivatives"); }
FMI3_Export fmi3Status fmi3GetEventIndicators(fmi3Instance instance, fmi3Float64[], size_t) { return unsupported(instance, "fmi3GetEventIndicators"); }
FMI3_Export fmi3Status fmi3GetContinuousStates(fmi3Instance instance, fmi3Float64[], size_t) { return unsupported(instance, "fmi3GetContinuousStates"); }
FMI3_Export fmi3Status fmi3GetNominalsOfContinuousStates(fmi3Instance instance, fmi3Float64[], size_t) { return unsupported(instance, "fmi3GetNominalsOfContinuousStates"); }
FMI3_Export fmi3Status fmi3GetNumberOfEventIndicators(fmi3Instance instance, size_t*) { return unsupported(instance, "fmi3GetNumberOfEventIndicators"); }
FMI3_Export fmi3Status fmi3GetNumberOfContinuousStates(fmi3Instance instance, size_t*) { return unsupported(instance, "fmi3GetNumberOfContinuousStates"); }

} // extern "C"
