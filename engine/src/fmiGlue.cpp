/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Implements the FMI 2.0 Co-Simulation C API (fmi2/fmi2Functions.h) over a generated model's
// konjugate::sdk::v1::SimulationModel (konjugate/simulationModel.hpp) -- the "glue" compiled and
// linked together with generated model source into one shared library, exactly the same pattern
// providerInProcessShim.cpp already uses for the in-process provider ABI (one factory symbol the
// other translation unit defines; see docs/codeExport.md for the design). No C++ exception is
// ever allowed to cross the extern "C" boundary, since a host may load this with a different
// compiler/STL.

#include "fmi2/fmi2Functions.h"
#include "konjugate/simulationModel.hpp"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

// The model's GUID, appended to the generated source by src/fmiExport.mjs (fmi2IdentitySource), as fmi3Glue.cpp's token is.
namespace konjugate::sdk::v1 {
extern const char* const fmi2Guid;
}

namespace {

struct FmuInstance {
    std::unique_ptr<konjugate::sdk::v1::SimulationModel> model;
    double currentTime = 0.0;
    std::string lastError;
    std::string instanceName;
    fmi2CallbackLogger logger = nullptr;
    fmi2ComponentEnvironment environment = nullptr;
};

FmuInstance* asInstance(fmi2Component c) {
    return static_cast<FmuInstance*>(c);
}

// Every refusal says why through the host's logger (FMI 2.0.4 section 2.1.5, category "logStatusError"), whether or not debug logging
// is on, as the FMI 3.0 glue does: a refused call is never silent (FMI review #4).
fmi2Status fail(FmuInstance* instance, const std::string& message) {
    if (instance) instance->lastError = message;
    if (instance && instance->logger) instance->logger(instance->environment, instance->instanceName.c_str(), fmi2Error, "logStatusError", "%s", message.c_str());
    return fmi2Error;
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

const char* fmi2GetTypesPlatform(void) {
    return fmi2TypesPlatform;
}

const char* fmi2GetVersion(void) {
    return "2.0";
}

fmi2Status fmi2SetDebugLogging(fmi2Component, fmi2Boolean, size_t, const fmi2String[]) {
    return fmi2OK; // Errors are always logged (fail() above); there are no debug messages to turn on or off.
}

fmi2Component fmi2Instantiate(fmi2String instanceName, fmi2Type fmuType, fmi2String fmuGUID, fmi2String, const fmi2CallbackFunctions* functions, fmi2Boolean, fmi2Boolean) {
    if (fmuType != fmi2CoSimulation) return nullptr; // this FMU is Co-Simulation only.
    // The GUID ties the binary to its modelDescription.xml (FMI 2.0.4 section 2.1.5): another one means another model's description.
    if (fmuGUID && std::strcmp(fmuGUID, konjugate::sdk::v1::fmi2Guid) != 0) {
        if (functions && functions->logger) {
            const std::string message = std::string("The GUID '") + fmuGUID + "' is not this FMU's ('" + konjugate::sdk::v1::fmi2Guid + "'): its modelDescription.xml belongs to another model.";
            functions->logger(functions->componentEnvironment, instanceName ? instanceName : "", fmi2Error, "logStatusError", "%s", message.c_str());
        }
        return nullptr;
    }
    try {
        auto instance = std::make_unique<FmuInstance>();
        instance->instanceName = instanceName ? instanceName : "";
        if (functions) {
            instance->logger = functions->logger;
            instance->environment = functions->componentEnvironment;
        }
        instance->model = konjugate::sdk::v1::createSimulationModel();
        return instance.release();
    } catch (const std::exception& error) {
        if (functions && functions->logger) functions->logger(functions->componentEnvironment, instanceName ? instanceName : "", fmi2Error, "logStatusError", "%s", error.what());
        return nullptr;
    } catch (...) {
        return nullptr;
    }
}

void fmi2FreeInstance(fmi2Component c) {
    delete asInstance(c);
}

fmi2Status fmi2SetupExperiment(fmi2Component c, fmi2Boolean, fmi2Real, fmi2Real startTime, fmi2Boolean, fmi2Real) {
    auto* instance = asInstance(c);
    if (!instance) return fmi2Error;
    instance->currentTime = startTime;
    return fmi2OK;
}

fmi2Status fmi2EnterInitializationMode(fmi2Component c) {
    return asInstance(c) ? fmi2OK : fmi2Error;
}

fmi2Status fmi2ExitInitializationMode(fmi2Component c) {
    return asInstance(c) ? fmi2OK : fmi2Error;
}

fmi2Status fmi2Terminate(fmi2Component c) {
    return asInstance(c) ? fmi2OK : fmi2Error;
}

fmi2Status fmi2Reset(fmi2Component c) {
    auto* instance = asInstance(c);
    if (!instance) return fmi2Error;
    try {
        instance->model = konjugate::sdk::v1::createSimulationModel();
        instance->currentTime = 0.0;
        return fmi2OK;
    } catch (const std::exception& error) {
        return fail(instance, "fmi2Reset: " + describe(error));
    } catch (...) {
        return fail(instance, "fmi2Reset failed.");
    }
}

fmi2Status fmi2GetReal(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, fmi2Real value[]) {
    auto* instance = asInstance(c);
    if (!instance) return fmi2Error;
    try {
        for (size_t index = 0; index < nvr; ++index) value[index] = instance->model->getOutput(static_cast<int>(vr[index]));
        return fmi2OK;
    } catch (const std::exception& error) {
        return fail(instance, "fmi2GetReal: " + describe(error));
    } catch (...) {
        return fail(instance, "fmi2GetReal failed.");
    }
}

fmi2Status fmi2SetReal(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, const fmi2Real value[]) {
    auto* instance = asInstance(c);
    if (!instance) return fmi2Error;
    try {
        for (size_t index = 0; index < nvr; ++index) instance->model->setInput(static_cast<int>(vr[index]), value[index]);
        return fmi2OK;
    } catch (const std::exception& error) {
        return fail(instance, "fmi2SetReal: " + describe(error));
    } catch (...) {
        return fail(instance, "fmi2SetReal failed.");
    }
}

fmi2Status fmi2DoStep(fmi2Component c, fmi2Real currentCommunicationPoint, fmi2Real communicationStepSize, fmi2Boolean) {
    auto* instance = asInstance(c);
    if (!instance) return fmi2Error;
    try {
        const double globalTimeStep = instance->model->globalTimeStep();
        const double stepsExact = communicationStepSize / globalTimeStep;
        const auto steps = static_cast<long long>(std::llround(stepsExact));
        // Mirrors the same "outputInterval must be an integer multiple of globalTimeStep"
        // tolerance the project schema already enforces elsewhere -- a host requesting a
        // communication step that isn't a whole multiple of the model's own fixed step has no
        // well-defined answer here, since Konjugate always advances in whole globalTimeStep ticks.
        if (steps < 1 || std::abs(stepsExact - static_cast<double>(steps)) > 1e-6) {
            return fail(instance, "fmi2DoStep: the communication step size " + number(communicationStepSize) + " is not a whole number of this FMU's fixed internal step " + number(globalTimeStep) + ".");
        }
        double time = currentCommunicationPoint;
        for (long long step = 0; step < steps; ++step) {
            instance->model->doStep(time, globalTimeStep);
            time += globalTimeStep;
        }
        instance->currentTime = time;
        return fmi2OK;
    } catch (const std::exception& error) {
        return fail(instance, "fmi2DoStep at t = " + number(currentCommunicationPoint) + ": " + describe(error));
    } catch (...) {
        return fail(instance, "fmi2DoStep at t = " + number(currentCommunicationPoint) + " failed.");
    }
}

fmi2Status fmi2CancelStep(fmi2Component c) {
    return asInstance(c) ? fmi2OK : fmi2Error;
}

// --- Rollback: only supported when the model itself reports supportsStateCapture() (a model with
// no embedded C++ provider -- see konjugate/simulationModel.hpp). A captured snapshot is a plain
// heap-allocated std::vector<double> behind the opaque fmi2FMUstate handle; serializing it is
// always reloaded against the same compiled .fmu, never cross-platform/cross-ABI, so a raw memcpy
// of the doubles is safe. ---

fmi2Status fmi2GetFMUstate(fmi2Component c, fmi2FMUstate* FMUstate) {
    auto* instance = asInstance(c);
    if (!instance) return fmi2Error;
    if (!FMUstate) return fail(instance, "fmi2GetFMUstate: no place for the FMU state given.");
    if (!instance->model->supportsStateCapture()) return fail(instance, "fmi2GetFMUstate is not supported: this FMU declares canGetAndSetFMUstate=\"false\" in its modelDescription.xml.");
    try {
        *FMUstate = new std::vector<double>(instance->model->captureState());
        return fmi2OK;
    } catch (const std::exception& error) {
        return fail(instance, "fmi2GetFMUstate: " + describe(error));
    } catch (...) {
        return fail(instance, "fmi2GetFMUstate failed.");
    }
}

fmi2Status fmi2SetFMUstate(fmi2Component c, fmi2FMUstate FMUstate) {
    auto* instance = asInstance(c);
    if (!instance) return fmi2Error;
    if (!FMUstate) return fail(instance, "fmi2SetFMUstate: no FMU state given.");
    try {
        instance->model->restoreState(*static_cast<const std::vector<double>*>(FMUstate));
        return fmi2OK;
    } catch (const std::exception& error) {
        return fail(instance, "fmi2SetFMUstate: " + describe(error));
    } catch (...) {
        return fail(instance, "fmi2SetFMUstate failed.");
    }
}

fmi2Status fmi2FreeFMUstate(fmi2Component, fmi2FMUstate* FMUstate) {
    if (!FMUstate) return fmi2Error;
    delete static_cast<std::vector<double>*>(*FMUstate);
    *FMUstate = nullptr;
    return fmi2OK;
}

fmi2Status fmi2SerializedFMUstateSize(fmi2Component c, fmi2FMUstate FMUstate, size_t* size) {
    if (!FMUstate || !size) return fail(asInstance(c), "fmi2SerializedFMUstateSize: no FMU state given.");
    *size = static_cast<const std::vector<double>*>(FMUstate)->size() * sizeof(double);
    return fmi2OK;
}

fmi2Status fmi2SerializeFMUstate(fmi2Component c, fmi2FMUstate FMUstate, fmi2Byte serializedState[], size_t size) {
    if (!FMUstate || !serializedState) return fail(asInstance(c), "fmi2SerializeFMUstate: no FMU state given.");
    const auto* snapshot = static_cast<const std::vector<double>*>(FMUstate);
    const size_t needed = snapshot->size() * sizeof(double);
    if (size < needed) return fail(asInstance(c), "fmi2SerializeFMUstate: " + std::to_string(size) + " bytes given, " + std::to_string(needed) + " needed.");
    std::memcpy(serializedState, snapshot->data(), needed);
    return fmi2OK;
}

fmi2Status fmi2DeSerializeFMUstate(fmi2Component c, const fmi2Byte serializedState[], size_t size, fmi2FMUstate* FMUstate) {
    if (!serializedState || !FMUstate || size % sizeof(double) != 0) return fail(asInstance(c), "fmi2DeSerializeFMUstate: " + std::to_string(size) + " bytes are not a state serialized by this FMU.");
    auto* snapshot = new std::vector<double>(size / sizeof(double));
    std::memcpy(snapshot->data(), serializedState, size);
    *FMUstate = snapshot;
    return fmi2OK;
}

// --- Declined/unsupported: modelDescription.xml declares no matching capability, so a compliant
// host never calls these. Implemented defensively rather than left unresolved. ---

fmi2Status fmi2GetInteger(fmi2Component, const fmi2ValueReference[], size_t nvr, fmi2Integer[]) { return nvr == 0 ? fmi2OK : fmi2Error; }
fmi2Status fmi2GetBoolean(fmi2Component, const fmi2ValueReference[], size_t nvr, fmi2Boolean[]) { return nvr == 0 ? fmi2OK : fmi2Error; }
fmi2Status fmi2GetString(fmi2Component, const fmi2ValueReference[], size_t nvr, fmi2String[]) { return nvr == 0 ? fmi2OK : fmi2Error; }
fmi2Status fmi2SetInteger(fmi2Component, const fmi2ValueReference[], size_t nvr, const fmi2Integer[]) { return nvr == 0 ? fmi2OK : fmi2Error; }
fmi2Status fmi2SetBoolean(fmi2Component, const fmi2ValueReference[], size_t nvr, const fmi2Boolean[]) { return nvr == 0 ? fmi2OK : fmi2Error; }
fmi2Status fmi2SetString(fmi2Component, const fmi2ValueReference[], size_t nvr, const fmi2String[]) { return nvr == 0 ? fmi2OK : fmi2Error; }

fmi2Status fmi2GetDirectionalDerivative(fmi2Component c, const fmi2ValueReference[], size_t, const fmi2ValueReference[], size_t, const fmi2Real[], fmi2Real[]) { return fail(asInstance(c), "fmi2GetDirectionalDerivative is not supported: this FMU declares no such capability in its modelDescription.xml."); }
fmi2Status fmi2SetRealInputDerivatives(fmi2Component c, const fmi2ValueReference[], size_t, const fmi2Integer[], const fmi2Real[]) { return fail(asInstance(c), "fmi2SetRealInputDerivatives is not supported: this FMU declares no such capability in its modelDescription.xml."); }
fmi2Status fmi2GetRealOutputDerivatives(fmi2Component c, const fmi2ValueReference[], size_t, const fmi2Integer[], fmi2Real[]) { return fail(asInstance(c), "fmi2GetRealOutputDerivatives is not supported: this FMU declares no such capability in its modelDescription.xml."); }

fmi2Status fmi2GetStatus(fmi2Component, const int, fmi2Status*) { return fmi2Discard; }
fmi2Status fmi2GetRealStatus(fmi2Component, const int, fmi2Real*) { return fmi2Discard; }
fmi2Status fmi2GetIntegerStatus(fmi2Component, const int, fmi2Integer*) { return fmi2Discard; }
fmi2Status fmi2GetBooleanStatus(fmi2Component, const int, fmi2Boolean*) { return fmi2Discard; }
fmi2Status fmi2GetStringStatus(fmi2Component, const int, fmi2String*) { return fmi2Discard; }

} // extern "C"
