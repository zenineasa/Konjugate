#ifndef fmi3FunctionTypes_h
#define fmi3FunctionTypes_h

#include "fmi3PlatformTypes.h"
#include <stdlib.h>

/* Function pointer types and enums for FMI 3.0, per the FMI Standard (fmi-standard.org),
   reproduced here (BSD-2-Clause) so an imported FMU can be driven without an external FMI SDK
   dependency. Only the Co-Simulation subset Konjugate's importer actually drives is declared --
   no Model Exchange, no Scheduled Execution, and only the Float64 scalar get/set entry points
   (Konjugate's FMI 3.0 import scope for this version; see docs/projectSchema.md). Konjugate never
   uses FMI 3.0's clock/intermediate-update/early-return machinery -- those callback types are
   still declared, matching the standard's own fmi3InstantiateCoSimulation signature exactly, but
   Konjugate always passes null for them (a purely synchronous, non-early-returning driver). */

typedef enum {
    fmi3OK,
    fmi3Warning,
    fmi3Discard,
    fmi3Error,
    fmi3Fatal
} fmi3Status;

typedef void (*fmi3LogMessageCallback)(fmi3InstanceEnvironment instanceEnvironment,
    fmi3Status status, fmi3String category, fmi3String message);

typedef void (*fmi3IntermediateUpdateCallback)(fmi3InstanceEnvironment instanceEnvironment,
    fmi3Float64 intermediateUpdateTime, fmi3Boolean intermediateVariableSetRequested,
    fmi3Boolean intermediateVariableGetAllowed, fmi3Boolean intermediateStepFinished,
    fmi3Boolean canReturnEarly, fmi3Boolean* earlyReturnRequested, fmi3Float64* earlyReturnTime);

/* --- Function-pointer typedefs, one per fmi3*() entry point this codebase drives, matching the
       standard's own naming (Xxx -> fmi3XxxTYPE). A host loads the real shared library and
       resolves each of these by name (GetProcAddress/dlsym) into a pointer of the matching type. */

typedef fmi3Instance (*fmi3InstantiateCoSimulationTYPE)(
    fmi3String instanceName, fmi3String instantiationToken, fmi3String resourcePath,
    fmi3Boolean visible, fmi3Boolean loggingOn, fmi3Boolean eventModeUsed, fmi3Boolean earlyReturnAllowed,
    const fmi3ValueReference requiredIntermediateVariables[], size_t nRequiredIntermediateVariables,
    fmi3InstanceEnvironment instanceEnvironment, fmi3LogMessageCallback logMessage,
    fmi3IntermediateUpdateCallback intermediateUpdate);
typedef void (*fmi3FreeInstanceTYPE)(fmi3Instance instance);

typedef fmi3Status (*fmi3EnterInitializationModeTYPE)(fmi3Instance instance,
    fmi3Boolean toleranceDefined, fmi3Float64 tolerance,
    fmi3Float64 startTime, fmi3Boolean stopTimeDefined, fmi3Float64 stopTime);
typedef fmi3Status (*fmi3ExitInitializationModeTYPE)(fmi3Instance instance);
typedef fmi3Status (*fmi3TerminateTYPE)(fmi3Instance instance);
typedef fmi3Status (*fmi3ResetTYPE)(fmi3Instance instance);

typedef fmi3Status (*fmi3GetFloat64TYPE)(fmi3Instance instance,
    const fmi3ValueReference valueReferences[], size_t nValueReferences, fmi3Float64 values[], size_t nValues);
typedef fmi3Status (*fmi3SetFloat64TYPE)(fmi3Instance instance,
    const fmi3ValueReference valueReferences[], size_t nValueReferences, const fmi3Float64 values[], size_t nValues);

typedef fmi3Status (*fmi3GetFMUStateTYPE)(fmi3Instance instance, fmi3FMUState* FMUState);
typedef fmi3Status (*fmi3SetFMUStateTYPE)(fmi3Instance instance, fmi3FMUState FMUState);
typedef fmi3Status (*fmi3FreeFMUStateTYPE)(fmi3Instance instance, fmi3FMUState* FMUState);
typedef fmi3Status (*fmi3SerializedFMUStateSizeTYPE)(fmi3Instance instance, fmi3FMUState FMUState, size_t* size);
typedef fmi3Status (*fmi3SerializeFMUStateTYPE)(fmi3Instance instance, fmi3FMUState FMUState, fmi3Byte serializedState[], size_t size);
typedef fmi3Status (*fmi3DeserializeFMUStateTYPE)(fmi3Instance instance, const fmi3Byte serializedState[], size_t size, fmi3FMUState* FMUState);

typedef fmi3Status (*fmi3DoStepTYPE)(fmi3Instance instance,
    fmi3Float64 currentCommunicationPoint, fmi3Float64 communicationStepSize, fmi3Boolean noSetFMUStatePriorToCurrentPoint,
    fmi3Boolean* eventEncountered, fmi3Boolean* terminateSimulation, fmi3Boolean* earlyReturn, fmi3Float64* lastSuccessfulTime);

#endif /* fmi3FunctionTypes_h */
