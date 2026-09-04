#ifndef fmi2FunctionTypes_h
#define fmi2FunctionTypes_h

#include "fmi2TypesPlatform.h"
#include <stdlib.h>

/* Function pointer types and enums for FMI 2.0, per the FMI Standard (fmi-standard.org),
   reproduced here (BSD-2-Clause) so a generated FMU can be built without an external FMI SDK
   dependency. Only the Co-Simulation subset is declared -- Konjugate never exports a Model
   Exchange FMU (see docs/codeExport.md for why: Model Exchange hands the integrator to the host
   tool, which would break the exact numerical-fidelity guarantee the export feature is built on).
*/

typedef enum {
    fmi2OK,
    fmi2Warning,
    fmi2Discard,
    fmi2Error,
    fmi2Fatal,
    fmi2Pending
} fmi2Status;

typedef void* fmi2Component;
typedef void* fmi2ComponentEnvironment;
typedef void* fmi2FMUstate;
typedef unsigned int fmi2ValueReference;

typedef enum {
    fmi2ModelExchange,
    fmi2CoSimulation
} fmi2Type;

typedef void (*fmi2CallbackLogger)(fmi2ComponentEnvironment componentEnvironment, fmi2String instanceName,
    fmi2Status status, fmi2String category, fmi2String message, ...);
typedef void* (*fmi2CallbackAllocateMemory)(size_t nobj, size_t size);
typedef void (*fmi2CallbackFreeMemory)(void* obj);
typedef void (*fmi2StepFinished)(fmi2ComponentEnvironment componentEnvironment, fmi2Status status);

typedef struct {
    const fmi2CallbackLogger logger;
    const fmi2CallbackAllocateMemory allocateMemory;
    const fmi2CallbackFreeMemory freeMemory;
    const fmi2StepFinished stepFinished;
    const fmi2ComponentEnvironment componentEnvironment;
} fmi2CallbackFunctions;

typedef struct {
    fmi2Boolean visible;
    fmi2Boolean loggingOn;
} fmi2EventInfoUnused; /* Model Exchange only; Konjugate never emits fmi2EventInfo. */

/* --- Function-pointer typedefs, one per fmi2*() entry point, matching the standard's own naming
       (Xxx -> fmi2XxxTYPE). A host loads the real shared library and resolves each of these by
       name (GetProcAddress/dlsym) into a pointer of the matching type -- our glue file's actual
       exported symbols (see fmiGlue.cpp) are what gets bound. */

typedef const char* (*fmi2GetTypesPlatformTYPE)(void);
typedef const char* (*fmi2GetVersionTYPE)(void);
typedef fmi2Status (*fmi2SetDebugLoggingTYPE)(fmi2Component c, fmi2Boolean loggingOn, size_t nCategories, const fmi2String categories[]);
typedef fmi2Component (*fmi2InstantiateTYPE)(fmi2String instanceName, fmi2Type fmuType, fmi2String fmuGUID,
    fmi2String fmuResourceLocation, const fmi2CallbackFunctions* functions, fmi2Boolean visible, fmi2Boolean loggingOn);
typedef void (*fmi2FreeInstanceTYPE)(fmi2Component c);
typedef fmi2Status (*fmi2SetupExperimentTYPE)(fmi2Component c, fmi2Boolean toleranceDefined, fmi2Real tolerance,
    fmi2Real startTime, fmi2Boolean stopTimeDefined, fmi2Real stopTime);
typedef fmi2Status (*fmi2EnterInitializationModeTYPE)(fmi2Component c);
typedef fmi2Status (*fmi2ExitInitializationModeTYPE)(fmi2Component c);
typedef fmi2Status (*fmi2TerminateTYPE)(fmi2Component c);
typedef fmi2Status (*fmi2ResetTYPE)(fmi2Component c);
typedef fmi2Status (*fmi2GetRealTYPE)(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, fmi2Real value[]);
typedef fmi2Status (*fmi2GetIntegerTYPE)(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, fmi2Integer value[]);
typedef fmi2Status (*fmi2GetBooleanTYPE)(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, fmi2Boolean value[]);
typedef fmi2Status (*fmi2GetStringTYPE)(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, fmi2String value[]);
typedef fmi2Status (*fmi2SetRealTYPE)(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, const fmi2Real value[]);
typedef fmi2Status (*fmi2SetIntegerTYPE)(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, const fmi2Integer value[]);
typedef fmi2Status (*fmi2SetBooleanTYPE)(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, const fmi2Boolean value[]);
typedef fmi2Status (*fmi2SetStringTYPE)(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, const fmi2String value[]);
typedef fmi2Status (*fmi2GetFMUstateTYPE)(fmi2Component c, fmi2FMUstate* FMUstate);
typedef fmi2Status (*fmi2SetFMUstateTYPE)(fmi2Component c, fmi2FMUstate FMUstate);
typedef fmi2Status (*fmi2FreeFMUstateTYPE)(fmi2Component c, fmi2FMUstate* FMUstate);
typedef fmi2Status (*fmi2SerializedFMUstateSizeTYPE)(fmi2Component c, fmi2FMUstate FMUstate, size_t* size);
typedef fmi2Status (*fmi2SerializeFMUstateTYPE)(fmi2Component c, fmi2FMUstate FMUstate, fmi2Byte serializedState[], size_t size);
typedef fmi2Status (*fmi2DeSerializeFMUstateTYPE)(fmi2Component c, const fmi2Byte serializedState[], size_t size, fmi2FMUstate* FMUstate);
typedef fmi2Status (*fmi2GetDirectionalDerivativeTYPE)(fmi2Component c, const fmi2ValueReference vUnknown_ref[], size_t nUnknown,
    const fmi2ValueReference vKnown_ref[], size_t nKnown, const fmi2Real dvKnown[], fmi2Real dvUnknown[]);
typedef fmi2Status (*fmi2SetRealInputDerivativesTYPE)(fmi2Component c, const fmi2ValueReference vr[], size_t nvr,
    const fmi2Integer order[], const fmi2Real value[]);
typedef fmi2Status (*fmi2GetRealOutputDerivativesTYPE)(fmi2Component c, const fmi2ValueReference vr[], size_t nvr,
    const fmi2Integer order[], fmi2Real value[]);
typedef fmi2Status (*fmi2DoStepTYPE)(fmi2Component c, fmi2Real currentCommunicationPoint, fmi2Real communicationStepSize,
    fmi2Boolean noSetFMUStatePriorToCurrentPoint);
typedef fmi2Status (*fmi2CancelStepTYPE)(fmi2Component c);
typedef fmi2Status (*fmi2GetStatusTYPE)(fmi2Component c, const int s, fmi2Status* value);
typedef fmi2Status (*fmi2GetRealStatusTYPE)(fmi2Component c, const int s, fmi2Real* value);
typedef fmi2Status (*fmi2GetIntegerStatusTYPE)(fmi2Component c, const int s, fmi2Integer* value);
typedef fmi2Status (*fmi2GetBooleanStatusTYPE)(fmi2Component c, const int s, fmi2Boolean* value);
typedef fmi2Status (*fmi2GetStringStatusTYPE)(fmi2Component c, const int s, fmi2String* value);

#endif /* fmi2FunctionTypes_h */
