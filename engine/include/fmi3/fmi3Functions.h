#ifndef fmi3Functions_h
#define fmi3Functions_h

#include "fmi3FunctionTypes.h"
#include "fmi3PlatformTypes.h"

/* Co-Simulation function prototypes for FMI 3.0, per the FMI Standard (fmi-standard.org),
   reproduced here (BSD-2-Clause) for the same reason as engine/include/fmi2/fmi2Functions.h: it
   lets a real, spec-compliant fmi3* shared library (an imported third-party FMU, or a
   hand-authored test fixture standing in for one) be declared against the real ABI, catching a
   signature mismatch at compile time rather than exporting a subtly wrong one. Konjugate does not
   export FMI 3.0 FMUs (export stays FMI 2.0 only, see docs/codeExport.md) -- this header exists
   for the IMPORT side (src/fmiResolver.mjs's generated glue dlopen()s a real vendor FMU and
   resolves these symbols by name) and for engine/tests fixtures standing in for one. Only the
   subset this codebase actually drives is declared -- no Model Exchange, no Scheduled Execution,
   no clocks, no array/binary/string get-set. */

#if defined(_WIN32)
#define FMI3_Export __declspec(dllexport)
#else
#define FMI3_Export __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* Creation and destruction of Co-Simulation FMU instances */
FMI3_Export fmi3Instance fmi3InstantiateCoSimulation(
    fmi3String instanceName, fmi3String instantiationToken, fmi3String resourcePath,
    fmi3Boolean visible, fmi3Boolean loggingOn, fmi3Boolean eventModeUsed, fmi3Boolean earlyReturnAllowed,
    const fmi3ValueReference requiredIntermediateVariables[], size_t nRequiredIntermediateVariables,
    fmi3InstanceEnvironment instanceEnvironment, fmi3LogMessageCallback logMessage,
    fmi3IntermediateUpdateCallback intermediateUpdate);
FMI3_Export void fmi3FreeInstance(fmi3Instance instance);

/* Enter/exit initialization, terminate, reset */
FMI3_Export fmi3Status fmi3EnterInitializationMode(fmi3Instance instance,
    fmi3Boolean toleranceDefined, fmi3Float64 tolerance,
    fmi3Float64 startTime, fmi3Boolean stopTimeDefined, fmi3Float64 stopTime);
FMI3_Export fmi3Status fmi3ExitInitializationMode(fmi3Instance instance);
FMI3_Export fmi3Status fmi3Terminate(fmi3Instance instance);
FMI3_Export fmi3Status fmi3Reset(fmi3Instance instance);

/* Getting and setting Float64 variable values (the only variable type Konjugate import drives) */
FMI3_Export fmi3Status fmi3GetFloat64(fmi3Instance instance,
    const fmi3ValueReference valueReferences[], size_t nValueReferences, fmi3Float64 values[], size_t nValues);
FMI3_Export fmi3Status fmi3SetFloat64(fmi3Instance instance,
    const fmi3ValueReference valueReferences[], size_t nValueReferences, const fmi3Float64 values[], size_t nValues);

/* Getting and setting the internal FMU state */
FMI3_Export fmi3Status fmi3GetFMUState(fmi3Instance instance, fmi3FMUState* FMUState);
FMI3_Export fmi3Status fmi3SetFMUState(fmi3Instance instance, fmi3FMUState FMUState);
FMI3_Export fmi3Status fmi3FreeFMUState(fmi3Instance instance, fmi3FMUState* FMUState);
FMI3_Export fmi3Status fmi3SerializedFMUStateSize(fmi3Instance instance, fmi3FMUState FMUState, size_t* size);
FMI3_Export fmi3Status fmi3SerializeFMUState(fmi3Instance instance, fmi3FMUState FMUState, fmi3Byte serializedState[], size_t size);
FMI3_Export fmi3Status fmi3DeserializeFMUState(fmi3Instance instance, const fmi3Byte serializedState[], size_t size, fmi3FMUState* FMUState);

/* Co-Simulation stepping */
FMI3_Export fmi3Status fmi3DoStep(fmi3Instance instance,
    fmi3Float64 currentCommunicationPoint, fmi3Float64 communicationStepSize, fmi3Boolean noSetFMUStatePriorToCurrentPoint,
    fmi3Boolean* eventEncountered, fmi3Boolean* terminateSimulation, fmi3Boolean* earlyReturn, fmi3Float64* lastSuccessfulTime);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* fmi3Functions_h */
