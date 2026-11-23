/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include "../fmi2/fmi2Functions.h"
#include "../fmi3/fmi3Functions.h"

#include <filesystem>
#include <stdexcept>
#include <string>
#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace konjugate::fmi {

// Cross-platform dlopen()/LoadLibrary() wrapper for loading a compiled FMU's own shared library
// at runtime -- the same pattern already proven in engine/src/providerRuntime.cpp's
// InProcessProviderBackend, generalized here for a THIRD-PARTY binary's exported symbols rather
// than Konjugate's own in-process provider ABI. Shared by engine/src/fmiImport.cpp's
// dependency-free FMU export round-trip validator and by the C++ source generated for general
// FMI import (see src/fmiResolver.mjs) -- both need to dlopen an FMI-compliant shared library and
// drive it through the real FMI2 C API, so this boilerplate is written once, not regenerated as
// text on every codegen call.
class LoadedLibrary {
public:
    explicit LoadedLibrary(const std::filesystem::path& path) {
#ifdef _WIN32
        handle_ = ::LoadLibraryA(path.string().c_str());
        if (!handle_) throw std::runtime_error("Failed to load FMU shared library '" + path.string() + "'.");
#else
        handle_ = ::dlopen(path.string().c_str(), RTLD_LOCAL | RTLD_NOW);
        if (!handle_) throw std::runtime_error("Failed to load FMU shared library '" + path.string() + "': " + std::string(::dlerror()));
#endif
    }

    ~LoadedLibrary() {
#ifdef _WIN32
        if (handle_) ::FreeLibrary(handle_);
#else
        if (handle_) ::dlclose(handle_);
#endif
    }

    LoadedLibrary(const LoadedLibrary&) = delete;
    LoadedLibrary& operator=(const LoadedLibrary&) = delete;

    template <typename FunctionPointer>
    FunctionPointer resolve(const char* symbolName) const {
#ifdef _WIN32
        auto* address = ::GetProcAddress(handle_, symbolName);
#else
        auto* address = ::dlsym(handle_, symbolName);
#endif
        if (!address) throw std::runtime_error(std::string("The FMU shared library is missing the symbol '") + symbolName + "'.");
        return reinterpret_cast<FunctionPointer>(address);
    }

    // Null when the library does not export symbolName: for the functions an importer needs only for some FMUs (an
    // integer or Boolean variable's getter, say), so an FMU that never needs one still loads without it.
    template <typename FunctionPointer>
    FunctionPointer resolveOptional(const char* symbolName) const noexcept {
#ifdef _WIN32
        auto* address = ::GetProcAddress(handle_, symbolName);
#else
        auto* address = ::dlsym(handle_, symbolName);
#endif
        return reinterpret_cast<FunctionPointer>(address);
    }

private:
#ifdef _WIN32
    HMODULE handle_ = nullptr;
#else
    void* handle_ = nullptr;
#endif
};

// Resolves every FMI2 Co-Simulation function pointer this codebase needs -- both the standalone
// round-trip driver and FMI-import's generated node-provider glue. Deliberately not the complete
// FMI2 API surface (no Integer/Boolean/String get/set, no directional derivatives): neither
// caller needs them, matching the same "declined, not faked" scoping already used on the export
// side (engine/src/fmiGlue.cpp). Every function here is part of the mandatory FMI2
// Co-Simulation export set, so dlsym()/GetProcAddress() resolving all of them eagerly is safe for
// any spec-compliant FMU, even one that declines state capture at runtime (it still exports
// fmi2Get/SetFMUstate etc., just returns fmi2Error/fmi2Discard when called).
struct Fmi2Api {
    fmi2InstantiateTYPE instantiate;
    fmi2SetupExperimentTYPE setupExperiment;
    fmi2EnterInitializationModeTYPE enterInitializationMode;
    fmi2ExitInitializationModeTYPE exitInitializationMode;
    fmi2DoStepTYPE doStep;
    fmi2GetRealTYPE getReal;
    fmi2SetRealTYPE setReal;
    fmi2GetFMUstateTYPE getFMUstate;
    fmi2SetFMUstateTYPE setFMUstate;
    fmi2FreeFMUstateTYPE freeFMUstate;
    fmi2SerializedFMUstateSizeTYPE serializedFMUstateSize;
    fmi2SerializeFMUstateTYPE serializeFMUstate;
    fmi2DeSerializeFMUstateTYPE deSerializeFMUstate;
    fmi2TerminateTYPE terminate;
    fmi2FreeInstanceTYPE freeInstance;
    // Resolved only if exported (see LoadedLibrary::resolveOptional): FMI import reads and sets Integer, Boolean and
    // Enumeration variables through these, and asks whether a step the FMU discarded was its request to terminate.
    fmi2GetIntegerTYPE getInteger;
    fmi2SetIntegerTYPE setInteger;
    fmi2GetBooleanTYPE getBoolean;
    fmi2SetBooleanTYPE setBoolean;
    fmi2GetBooleanStatusTYPE getBooleanStatus;

    explicit Fmi2Api(const LoadedLibrary& library)
        : instantiate(library.resolve<fmi2InstantiateTYPE>("fmi2Instantiate")),
          setupExperiment(library.resolve<fmi2SetupExperimentTYPE>("fmi2SetupExperiment")),
          enterInitializationMode(library.resolve<fmi2EnterInitializationModeTYPE>("fmi2EnterInitializationMode")),
          exitInitializationMode(library.resolve<fmi2ExitInitializationModeTYPE>("fmi2ExitInitializationMode")),
          doStep(library.resolve<fmi2DoStepTYPE>("fmi2DoStep")),
          getReal(library.resolve<fmi2GetRealTYPE>("fmi2GetReal")),
          setReal(library.resolve<fmi2SetRealTYPE>("fmi2SetReal")),
          getFMUstate(library.resolve<fmi2GetFMUstateTYPE>("fmi2GetFMUstate")),
          setFMUstate(library.resolve<fmi2SetFMUstateTYPE>("fmi2SetFMUstate")),
          freeFMUstate(library.resolve<fmi2FreeFMUstateTYPE>("fmi2FreeFMUstate")),
          serializedFMUstateSize(library.resolve<fmi2SerializedFMUstateSizeTYPE>("fmi2SerializedFMUstateSize")),
          serializeFMUstate(library.resolve<fmi2SerializeFMUstateTYPE>("fmi2SerializeFMUstate")),
          deSerializeFMUstate(library.resolve<fmi2DeSerializeFMUstateTYPE>("fmi2DeSerializeFMUstate")),
          terminate(library.resolve<fmi2TerminateTYPE>("fmi2Terminate")),
          freeInstance(library.resolve<fmi2FreeInstanceTYPE>("fmi2FreeInstance")),
          getInteger(library.resolveOptional<fmi2GetIntegerTYPE>("fmi2GetInteger")),
          setInteger(library.resolveOptional<fmi2SetIntegerTYPE>("fmi2SetInteger")),
          getBoolean(library.resolveOptional<fmi2GetBooleanTYPE>("fmi2GetBoolean")),
          setBoolean(library.resolveOptional<fmi2SetBooleanTYPE>("fmi2SetBoolean")),
          getBooleanStatus(library.resolveOptional<fmi2GetBooleanStatusTYPE>("fmi2GetBooleanStatus")) {}
};

// The FMI 3.0 counterpart to Fmi2Api above -- same scope discipline (Co-Simulation only, Float64
// and integer/Boolean scalar get/set only, no clocks/arrays/binary/strings), same eager-resolve-everything-up-front shape.
// FMI 3.0 combines FMI2's fmi2SetupExperiment+fmi2EnterInitializationMode into one call
// (enterInitializationMode below), replaces the "GUID" match string with "instantiationToken",
// and fmi3DoStep gains extra out-params (event/terminate/early-return/last-successful-time) that
// Konjugate's synchronous, non-early-returning driver always passes as non-null but ignores.
struct Fmi3Api {
    fmi3InstantiateCoSimulationTYPE instantiateCoSimulation;
    fmi3FreeInstanceTYPE freeInstance;
    fmi3EnterInitializationModeTYPE enterInitializationMode;
    fmi3ExitInitializationModeTYPE exitInitializationMode;
    fmi3TerminateTYPE terminate;
    fmi3GetFloat64TYPE getFloat64;
    fmi3SetFloat64TYPE setFloat64;
    fmi3GetFMUStateTYPE getFMUState;
    fmi3SetFMUStateTYPE setFMUState;
    fmi3FreeFMUStateTYPE freeFMUState;
    fmi3SerializedFMUStateSizeTYPE serializedFMUStateSize;
    fmi3SerializeFMUStateTYPE serializeFMUState;
    fmi3DeserializeFMUStateTYPE deserializeFMUState;
    fmi3DoStepTYPE doStep;
    // Resolved only if exported (see LoadedLibrary::resolveOptional): FMI import reads and sets variables of these
    // types through them.
    fmi3GetFloat32TYPE getFloat32;
    fmi3SetFloat32TYPE setFloat32;
    fmi3GetInt8TYPE getInt8;
    fmi3SetInt8TYPE setInt8;
    fmi3GetUInt8TYPE getUInt8;
    fmi3SetUInt8TYPE setUInt8;
    fmi3GetInt16TYPE getInt16;
    fmi3SetInt16TYPE setInt16;
    fmi3GetUInt16TYPE getUInt16;
    fmi3SetUInt16TYPE setUInt16;
    fmi3GetInt32TYPE getInt32;
    fmi3SetInt32TYPE setInt32;
    fmi3GetUInt32TYPE getUInt32;
    fmi3SetUInt32TYPE setUInt32;
    fmi3GetInt64TYPE getInt64;
    fmi3SetInt64TYPE setInt64;
    fmi3GetUInt64TYPE getUInt64;
    fmi3SetUInt64TYPE setUInt64;
    fmi3GetBooleanTYPE getBoolean;
    fmi3SetBooleanTYPE setBoolean;

    explicit Fmi3Api(const LoadedLibrary& library)
        : instantiateCoSimulation(library.resolve<fmi3InstantiateCoSimulationTYPE>("fmi3InstantiateCoSimulation")),
          freeInstance(library.resolve<fmi3FreeInstanceTYPE>("fmi3FreeInstance")),
          enterInitializationMode(library.resolve<fmi3EnterInitializationModeTYPE>("fmi3EnterInitializationMode")),
          exitInitializationMode(library.resolve<fmi3ExitInitializationModeTYPE>("fmi3ExitInitializationMode")),
          terminate(library.resolve<fmi3TerminateTYPE>("fmi3Terminate")),
          getFloat64(library.resolve<fmi3GetFloat64TYPE>("fmi3GetFloat64")),
          setFloat64(library.resolve<fmi3SetFloat64TYPE>("fmi3SetFloat64")),
          getFMUState(library.resolve<fmi3GetFMUStateTYPE>("fmi3GetFMUState")),
          setFMUState(library.resolve<fmi3SetFMUStateTYPE>("fmi3SetFMUState")),
          freeFMUState(library.resolve<fmi3FreeFMUStateTYPE>("fmi3FreeFMUState")),
          serializedFMUStateSize(library.resolve<fmi3SerializedFMUStateSizeTYPE>("fmi3SerializedFMUStateSize")),
          serializeFMUState(library.resolve<fmi3SerializeFMUStateTYPE>("fmi3SerializeFMUState")),
          deserializeFMUState(library.resolve<fmi3DeserializeFMUStateTYPE>("fmi3DeserializeFMUState")),
          doStep(library.resolve<fmi3DoStepTYPE>("fmi3DoStep")),
          getFloat32(library.resolveOptional<fmi3GetFloat32TYPE>("fmi3GetFloat32")),
          setFloat32(library.resolveOptional<fmi3SetFloat32TYPE>("fmi3SetFloat32")),
          getInt8(library.resolveOptional<fmi3GetInt8TYPE>("fmi3GetInt8")),
          setInt8(library.resolveOptional<fmi3SetInt8TYPE>("fmi3SetInt8")),
          getUInt8(library.resolveOptional<fmi3GetUInt8TYPE>("fmi3GetUInt8")),
          setUInt8(library.resolveOptional<fmi3SetUInt8TYPE>("fmi3SetUInt8")),
          getInt16(library.resolveOptional<fmi3GetInt16TYPE>("fmi3GetInt16")),
          setInt16(library.resolveOptional<fmi3SetInt16TYPE>("fmi3SetInt16")),
          getUInt16(library.resolveOptional<fmi3GetUInt16TYPE>("fmi3GetUInt16")),
          setUInt16(library.resolveOptional<fmi3SetUInt16TYPE>("fmi3SetUInt16")),
          getInt32(library.resolveOptional<fmi3GetInt32TYPE>("fmi3GetInt32")),
          setInt32(library.resolveOptional<fmi3SetInt32TYPE>("fmi3SetInt32")),
          getUInt32(library.resolveOptional<fmi3GetUInt32TYPE>("fmi3GetUInt32")),
          setUInt32(library.resolveOptional<fmi3SetUInt32TYPE>("fmi3SetUInt32")),
          getInt64(library.resolveOptional<fmi3GetInt64TYPE>("fmi3GetInt64")),
          setInt64(library.resolveOptional<fmi3SetInt64TYPE>("fmi3SetInt64")),
          getUInt64(library.resolveOptional<fmi3GetUInt64TYPE>("fmi3GetUInt64")),
          setUInt64(library.resolveOptional<fmi3SetUInt64TYPE>("fmi3SetUInt64")),
          getBoolean(library.resolveOptional<fmi3GetBooleanTYPE>("fmi3GetBoolean")),
          setBoolean(library.resolveOptional<fmi3SetBooleanTYPE>("fmi3SetBoolean")) {}
};

} // namespace konjugate::fmi
