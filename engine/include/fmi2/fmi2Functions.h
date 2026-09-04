#ifndef fmi2Functions_h
#define fmi2Functions_h

#include "fmi2FunctionTypes.h"
#include "fmi2TypesPlatform.h"

/* Co-Simulation function prototypes for FMI 2.0, per the FMI Standard (fmi-standard.org),
   reproduced here (BSD-2-Clause) so a generated FMU can be built without an external FMI SDK
   dependency. Model Exchange-only entry points (fmi2SetTime, fmi2GetDerivatives,
   fmi2CompletedIntegratorStep, etc.) are intentionally omitted -- Konjugate only ever exports
   Co-Simulation FMUs (see docs/codeExport.md).

   Including this header from fmiGlue.cpp (rather than only fmi2FunctionTypes.h) is deliberate: it
   lets the compiler catch a signature mismatch between these declarations and fmiGlue.cpp's
   definitions, rather than silently exporting a subtly wrong ABI. */

#if defined(_WIN32)
#define FMI2_Export __declspec(dllexport)
#else
#define FMI2_Export __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* Inquire version numbers and setup logging */
FMI2_Export const char* fmi2GetTypesPlatform(void);
FMI2_Export const char* fmi2GetVersion(void);
FMI2_Export fmi2Status fmi2SetDebugLogging(fmi2Component c, fmi2Boolean loggingOn, size_t nCategories, const fmi2String categories[]);

/* Creation and destruction of FMU instances */
FMI2_Export fmi2Component fmi2Instantiate(fmi2String instanceName, fmi2Type fmuType, fmi2String fmuGUID,
    fmi2String fmuResourceLocation, const fmi2CallbackFunctions* functions, fmi2Boolean visible, fmi2Boolean loggingOn);
FMI2_Export void fmi2FreeInstance(fmi2Component c);

/* Enter and exit initialization mode, terminate and reset */
FMI2_Export fmi2Status fmi2SetupExperiment(fmi2Component c, fmi2Boolean toleranceDefined, fmi2Real tolerance,
    fmi2Real startTime, fmi2Boolean stopTimeDefined, fmi2Real stopTime);
FMI2_Export fmi2Status fmi2EnterInitializationMode(fmi2Component c);
FMI2_Export fmi2Status fmi2ExitInitializationMode(fmi2Component c);
FMI2_Export fmi2Status fmi2Terminate(fmi2Component c);
FMI2_Export fmi2Status fmi2Reset(fmi2Component c);

/* Getting and setting variable values */
FMI2_Export fmi2Status fmi2GetReal(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, fmi2Real value[]);
FMI2_Export fmi2Status fmi2GetInteger(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, fmi2Integer value[]);
FMI2_Export fmi2Status fmi2GetBoolean(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, fmi2Boolean value[]);
FMI2_Export fmi2Status fmi2GetString(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, fmi2String value[]);
FMI2_Export fmi2Status fmi2SetReal(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, const fmi2Real value[]);
FMI2_Export fmi2Status fmi2SetInteger(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, const fmi2Integer value[]);
FMI2_Export fmi2Status fmi2SetBoolean(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, const fmi2Boolean value[]);
FMI2_Export fmi2Status fmi2SetString(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, const fmi2String value[]);

/* Getting and setting the internal FMU state */
FMI2_Export fmi2Status fmi2GetFMUstate(fmi2Component c, fmi2FMUstate* FMUstate);
FMI2_Export fmi2Status fmi2SetFMUstate(fmi2Component c, fmi2FMUstate FMUstate);
FMI2_Export fmi2Status fmi2FreeFMUstate(fmi2Component c, fmi2FMUstate* FMUstate);
FMI2_Export fmi2Status fmi2SerializedFMUstateSize(fmi2Component c, fmi2FMUstate FMUstate, size_t* size);
FMI2_Export fmi2Status fmi2SerializeFMUstate(fmi2Component c, fmi2FMUstate FMUstate, fmi2Byte serializedState[], size_t size);
FMI2_Export fmi2Status fmi2DeSerializeFMUstate(fmi2Component c, const fmi2Byte serializedState[], size_t size, fmi2FMUstate* FMUstate);

/* Getting partial derivatives (not used by Co-Simulation masters in practice; declined) */
FMI2_Export fmi2Status fmi2GetDirectionalDerivative(fmi2Component c, const fmi2ValueReference vUnknown_ref[], size_t nUnknown,
    const fmi2ValueReference vKnown_ref[], size_t nKnown, const fmi2Real dvKnown[], fmi2Real dvUnknown[]);

/* Co-Simulation specific functions */
FMI2_Export fmi2Status fmi2SetRealInputDerivatives(fmi2Component c, const fmi2ValueReference vr[], size_t nvr,
    const fmi2Integer order[], const fmi2Real value[]);
FMI2_Export fmi2Status fmi2GetRealOutputDerivatives(fmi2Component c, const fmi2ValueReference vr[], size_t nvr,
    const fmi2Integer order[], fmi2Real value[]);
FMI2_Export fmi2Status fmi2DoStep(fmi2Component c, fmi2Real currentCommunicationPoint, fmi2Real communicationStepSize,
    fmi2Boolean noSetFMUStatePriorToCurrentPoint);
FMI2_Export fmi2Status fmi2CancelStep(fmi2Component c);
FMI2_Export fmi2Status fmi2GetStatus(fmi2Component c, const int s, fmi2Status* value);
FMI2_Export fmi2Status fmi2GetRealStatus(fmi2Component c, const int s, fmi2Real* value);
FMI2_Export fmi2Status fmi2GetIntegerStatus(fmi2Component c, const int s, fmi2Integer* value);
FMI2_Export fmi2Status fmi2GetBooleanStatus(fmi2Component c, const int s, fmi2Boolean* value);
FMI2_Export fmi2Status fmi2GetStringStatus(fmi2Component c, const int s, fmi2String* value);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* fmi2Functions_h */
