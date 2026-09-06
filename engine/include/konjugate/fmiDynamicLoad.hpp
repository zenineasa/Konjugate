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
          freeInstance(library.resolve<fmi2FreeInstanceTYPE>("fmi2FreeInstance")) {}
};

// The FMI 3.0 counterpart to Fmi2Api above -- same scope discipline (Co-Simulation only, Float64
// scalar get/set only, no clocks/arrays/binary), same eager-resolve-everything-up-front shape.
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
          doStep(library.resolve<fmi3DoStepTYPE>("fmi3DoStep")) {}
};

} // namespace konjugate::fmi
