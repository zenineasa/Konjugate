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
#include <memory>
#include <string>

namespace {

struct FmuInstance {
    std::unique_ptr<konjugate::sdk::v1::SimulationModel> model;
    double currentTime = 0.0;
    std::string lastError;
};

FmuInstance* asInstance(fmi2Component c) {
    return static_cast<FmuInstance*>(c);
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
    return fmi2OK; // Konjugate-exported FMUs don't route through the host's logger callback.
}

fmi2Component fmi2Instantiate(fmi2String, fmi2Type fmuType, fmi2String, fmi2String, const fmi2CallbackFunctions*, fmi2Boolean, fmi2Boolean) {
    if (fmuType != fmi2CoSimulation) return nullptr; // this FMU is Co-Simulation only.
    try {
        auto* instance = new FmuInstance();
        instance->model = konjugate::sdk::v1::createSimulationModel();
        return instance;
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
    } catch (...) {
        return fmi2Error;
    }
}

fmi2Status fmi2GetReal(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, fmi2Real value[]) {
    auto* instance = asInstance(c);
    if (!instance) return fmi2Error;
    try {
        for (size_t index = 0; index < nvr; ++index) value[index] = instance->model->getOutput(static_cast<int>(vr[index]));
        return fmi2OK;
    } catch (...) {
        return fmi2Error;
    }
}

fmi2Status fmi2SetReal(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, const fmi2Real value[]) {
    auto* instance = asInstance(c);
    if (!instance) return fmi2Error;
    try {
        for (size_t index = 0; index < nvr; ++index) instance->model->setInput(static_cast<int>(vr[index]), value[index]);
        return fmi2OK;
    } catch (...) {
        return fmi2Error;
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
        if (steps < 1 || std::abs(stepsExact - static_cast<double>(steps)) > 1e-6) return fmi2Error;
        double time = currentCommunicationPoint;
        for (long long step = 0; step < steps; ++step) {
            instance->model->doStep(time, globalTimeStep);
            time += globalTimeStep;
        }
        instance->currentTime = time;
        return fmi2OK;
    } catch (...) {
        return fmi2Error;
    }
}

fmi2Status fmi2CancelStep(fmi2Component c) {
    return asInstance(c) ? fmi2OK : fmi2Error;
}

// --- Declined/unsupported: modelDescription.xml declares no matching capability, so a compliant
// host never calls these. Implemented defensively rather than left unresolved. ---

fmi2Status fmi2GetInteger(fmi2Component, const fmi2ValueReference[], size_t nvr, fmi2Integer[]) { return nvr == 0 ? fmi2OK : fmi2Error; }
fmi2Status fmi2GetBoolean(fmi2Component, const fmi2ValueReference[], size_t nvr, fmi2Boolean[]) { return nvr == 0 ? fmi2OK : fmi2Error; }
fmi2Status fmi2GetString(fmi2Component, const fmi2ValueReference[], size_t nvr, fmi2String[]) { return nvr == 0 ? fmi2OK : fmi2Error; }
fmi2Status fmi2SetInteger(fmi2Component, const fmi2ValueReference[], size_t nvr, const fmi2Integer[]) { return nvr == 0 ? fmi2OK : fmi2Error; }
fmi2Status fmi2SetBoolean(fmi2Component, const fmi2ValueReference[], size_t nvr, const fmi2Boolean[]) { return nvr == 0 ? fmi2OK : fmi2Error; }
fmi2Status fmi2SetString(fmi2Component, const fmi2ValueReference[], size_t nvr, const fmi2String[]) { return nvr == 0 ? fmi2OK : fmi2Error; }

fmi2Status fmi2GetFMUstate(fmi2Component, fmi2FMUstate*) { return fmi2Error; }
fmi2Status fmi2SetFMUstate(fmi2Component, fmi2FMUstate) { return fmi2Error; }
fmi2Status fmi2FreeFMUstate(fmi2Component, fmi2FMUstate*) { return fmi2Error; }
fmi2Status fmi2SerializedFMUstateSize(fmi2Component, fmi2FMUstate, size_t*) { return fmi2Error; }
fmi2Status fmi2SerializeFMUstate(fmi2Component, fmi2FMUstate, fmi2Byte[], size_t) { return fmi2Error; }
fmi2Status fmi2DeSerializeFMUstate(fmi2Component, const fmi2Byte[], size_t, fmi2FMUstate*) { return fmi2Error; }

fmi2Status fmi2GetDirectionalDerivative(fmi2Component, const fmi2ValueReference[], size_t, const fmi2ValueReference[], size_t, const fmi2Real[], fmi2Real[]) { return fmi2Error; }
fmi2Status fmi2SetRealInputDerivatives(fmi2Component, const fmi2ValueReference[], size_t, const fmi2Integer[], const fmi2Real[]) { return fmi2Error; }
fmi2Status fmi2GetRealOutputDerivatives(fmi2Component, const fmi2ValueReference[], size_t, const fmi2Integer[], fmi2Real[]) { return fmi2Error; }

fmi2Status fmi2GetStatus(fmi2Component, const int, fmi2Status*) { return fmi2Discard; }
fmi2Status fmi2GetRealStatus(fmi2Component, const int, fmi2Real*) { return fmi2Discard; }
fmi2Status fmi2GetIntegerStatus(fmi2Component, const int, fmi2Integer*) { return fmi2Discard; }
fmi2Status fmi2GetBooleanStatus(fmi2Component, const int, fmi2Boolean*) { return fmi2Discard; }
fmi2Status fmi2GetStringStatus(fmi2Component, const int, fmi2String*) { return fmi2Discard; }

} // extern "C"
