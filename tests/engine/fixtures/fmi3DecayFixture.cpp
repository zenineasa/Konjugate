/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A hand-authored, real FMI 3.0 Co-Simulation shared library standing in for a third-party vendor
// FMU -- Konjugate cannot export FMI 3.0 itself (export stays FMI 2.0 only, see
// docs/codeExport.md), so unlike the FMI 2.0 import fidelity test (which reuses Konjugate's own
// exporter as the "known good" fixture), this is authored directly against the real fmi3*
// Co-Simulation C API, exactly like engine/tests/fmiGlueTests.cpp's DecayModel stands in for a
// generated SimulationModel. Same dynamics as that FMI2 test fixture (x' = -k*x, explicit Euler),
// so tests/engine/fmi3ImportFidelity.mjs can assert against the identical hand-computed
// trajectory: value reference 0 is "level" (output, x), value reference 1 is "k" (input).
//
// Compiled directly with a plain compiler invocation by the test script (not through Konjugate's
// own buildCppProvider/buildSharedLibrary machinery) -- this file plays the role of a vendor's own
// build output, which Konjugate never builds in production.

#include "fmi3/fmi3Functions.h"

#include <cstring>
#include <new>

namespace {

struct DecayInstance {
    double x = 10.0;
    double k = 0.3;
    bool initialized = false;
};

} // namespace

extern "C" {

FMI3_Export fmi3Instance fmi3InstantiateCoSimulation(
    fmi3String, fmi3String instantiationToken, fmi3String,
    fmi3Boolean, fmi3Boolean, fmi3Boolean, fmi3Boolean,
    const fmi3ValueReference[], size_t,
    fmi3InstanceEnvironment, fmi3LogMessageCallback, fmi3IntermediateUpdateCallback) {
    if (!instantiationToken || std::strcmp(instantiationToken, "fmi3-decay-fixture-token") != 0) return nullptr;
    return new (std::nothrow) DecayInstance();
}

FMI3_Export void fmi3FreeInstance(fmi3Instance instance) {
    delete static_cast<DecayInstance*>(instance);
}

FMI3_Export fmi3Status fmi3EnterInitializationMode(fmi3Instance instance, fmi3Boolean, fmi3Float64, fmi3Float64, fmi3Boolean, fmi3Float64) {
    return instance ? fmi3OK : fmi3Error;
}

FMI3_Export fmi3Status fmi3ExitInitializationMode(fmi3Instance instance) {
    if (!instance) return fmi3Error;
    static_cast<DecayInstance*>(instance)->initialized = true;
    return fmi3OK;
}

FMI3_Export fmi3Status fmi3Terminate(fmi3Instance instance) { return instance ? fmi3OK : fmi3Error; }

FMI3_Export fmi3Status fmi3Reset(fmi3Instance instance) {
    if (!instance) return fmi3Error;
    auto* self = static_cast<DecayInstance*>(instance);
    self->x = 10.0;
    self->k = 0.3;
    return fmi3OK;
}

FMI3_Export fmi3Status fmi3GetFloat64(fmi3Instance instance, const fmi3ValueReference vr[], size_t nvr, fmi3Float64 values[], size_t nValues) {
    if (!instance || nvr != nValues) return fmi3Error;
    auto* self = static_cast<DecayInstance*>(instance);
    for (size_t index = 0; index < nvr; ++index) {
        if (vr[index] == 0) values[index] = self->x;
        else if (vr[index] == 1) values[index] = self->k;
        else return fmi3Error;
    }
    return fmi3OK;
}

FMI3_Export fmi3Status fmi3SetFloat64(fmi3Instance instance, const fmi3ValueReference vr[], size_t nvr, const fmi3Float64 values[], size_t nValues) {
    if (!instance || nvr != nValues) return fmi3Error;
    auto* self = static_cast<DecayInstance*>(instance);
    for (size_t index = 0; index < nvr; ++index) {
        if (vr[index] == 0) self->x = values[index];
        else if (vr[index] == 1) self->k = values[index];
        else return fmi3Error;
    }
    return fmi3OK;
}

FMI3_Export fmi3Status fmi3GetFMUState(fmi3Instance instance, fmi3FMUState* FMUState) {
    if (!instance || !FMUState) return fmi3Error;
    auto* snapshot = new (std::nothrow) DecayInstance(*static_cast<DecayInstance*>(instance));
    if (!snapshot) return fmi3Error;
    *FMUState = snapshot;
    return fmi3OK;
}

FMI3_Export fmi3Status fmi3SetFMUState(fmi3Instance instance, fmi3FMUState FMUState) {
    if (!instance || !FMUState) return fmi3Error;
    *static_cast<DecayInstance*>(instance) = *static_cast<DecayInstance*>(FMUState);
    return fmi3OK;
}

FMI3_Export fmi3Status fmi3FreeFMUState(fmi3Instance, fmi3FMUState* FMUState) {
    if (!FMUState) return fmi3Error;
    delete static_cast<DecayInstance*>(*FMUState);
    *FMUState = nullptr;
    return fmi3OK;
}

FMI3_Export fmi3Status fmi3SerializedFMUStateSize(fmi3Instance, fmi3FMUState, size_t* size) {
    if (!size) return fmi3Error;
    *size = sizeof(DecayInstance);
    return fmi3OK;
}

FMI3_Export fmi3Status fmi3SerializeFMUState(fmi3Instance, fmi3FMUState FMUState, fmi3Byte serializedState[], size_t size) {
    if (!FMUState || size != sizeof(DecayInstance)) return fmi3Error;
    std::memcpy(serializedState, FMUState, sizeof(DecayInstance));
    return fmi3OK;
}

FMI3_Export fmi3Status fmi3DeserializeFMUState(fmi3Instance, const fmi3Byte serializedState[], size_t size, fmi3FMUState* FMUState) {
    if (!FMUState || size != sizeof(DecayInstance)) return fmi3Error;
    auto* restored = new (std::nothrow) DecayInstance();
    if (!restored) return fmi3Error;
    std::memcpy(restored, serializedState, sizeof(DecayInstance));
    *FMUState = restored;
    return fmi3OK;
}

FMI3_Export fmi3Status fmi3DoStep(fmi3Instance instance,
    fmi3Float64, fmi3Float64 communicationStepSize, fmi3Boolean,
    fmi3Boolean* eventEncountered, fmi3Boolean* terminateSimulation, fmi3Boolean* earlyReturn, fmi3Float64* lastSuccessfulTime) {
    if (!instance) return fmi3Error;
    auto* self = static_cast<DecayInstance*>(instance);
    self->x += (-self->k * self->x) * communicationStepSize;
    if (eventEncountered) *eventEncountered = fmi3False;
    if (terminateSimulation) *terminateSimulation = fmi3False;
    if (earlyReturn) *earlyReturn = fmi3False;
    if (lastSuccessfulTime) *lastSuccessfulTime = communicationStepSize;
    return fmi3OK;
}

} // extern "C"
