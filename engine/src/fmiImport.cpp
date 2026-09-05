/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "fmiImport.hpp"
#include "fmi2/fmi2Functions.h"

#include <cmath>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace konjugate {
namespace {

// Mirrors providerRuntime.cpp's InProcessProviderBackend::loadLibrary exactly -- the same
// cross-platform dlopen()/LoadLibrary() pattern already proven there, just resolving a different
// set of symbols (the FMI2 C API instead of the in-process provider ABI's single vtable entry
// point).
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

struct Fmi2Api {
    fmi2InstantiateTYPE instantiate;
    fmi2SetupExperimentTYPE setupExperiment;
    fmi2EnterInitializationModeTYPE enterInitializationMode;
    fmi2ExitInitializationModeTYPE exitInitializationMode;
    fmi2DoStepTYPE doStep;
    fmi2GetRealTYPE getReal;
    fmi2GetFMUstateTYPE getFMUstate;
    fmi2SetFMUstateTYPE setFMUstate;
    fmi2FreeFMUstateTYPE freeFMUstate;
    fmi2TerminateTYPE terminate;
    fmi2FreeInstanceTYPE freeInstance;

    explicit Fmi2Api(const LoadedLibrary& library)
        : instantiate(library.resolve<fmi2InstantiateTYPE>("fmi2Instantiate")),
          setupExperiment(library.resolve<fmi2SetupExperimentTYPE>("fmi2SetupExperiment")),
          enterInitializationMode(library.resolve<fmi2EnterInitializationModeTYPE>("fmi2EnterInitializationMode")),
          exitInitializationMode(library.resolve<fmi2ExitInitializationModeTYPE>("fmi2ExitInitializationMode")),
          doStep(library.resolve<fmi2DoStepTYPE>("fmi2DoStep")),
          getReal(library.resolve<fmi2GetRealTYPE>("fmi2GetReal")),
          getFMUstate(library.resolve<fmi2GetFMUstateTYPE>("fmi2GetFMUstate")),
          setFMUstate(library.resolve<fmi2SetFMUstateTYPE>("fmi2SetFMUstate")),
          freeFMUstate(library.resolve<fmi2FreeFMUstateTYPE>("fmi2FreeFMUstate")),
          terminate(library.resolve<fmi2TerminateTYPE>("fmi2Terminate")),
          freeInstance(library.resolve<fmi2FreeInstanceTYPE>("fmi2FreeInstance")) {}
};

std::vector<double> readState(const Fmi2Api& api, fmi2Component instance, int stateCount) {
    std::vector<fmi2ValueReference> valueReferences(static_cast<std::size_t>(stateCount));
    for (int index = 0; index < stateCount; ++index) valueReferences[static_cast<std::size_t>(index)] = static_cast<fmi2ValueReference>(index);
    std::vector<double> values(static_cast<std::size_t>(stateCount));
    if (api.getReal(instance, valueReferences.data(), valueReferences.size(), values.data()) != fmi2OK) {
        throw std::runtime_error("fmi2GetReal failed while reading the FMU's state.");
    }
    return values;
}

} // namespace

void runFmu(const std::filesystem::path& sharedLibraryPath, int stateCount,
            double targetTime, double globalTimeStep, double outputInterval,
            const std::filesystem::path& outputCsvPath, bool verifyRollback) {
    LoadedLibrary library(sharedLibraryPath);
    Fmi2Api api(library);

    fmi2Component instance = api.instantiate("konjugateFmiImport", fmi2CoSimulation, "guid", "", nullptr, fmi2False, fmi2False);
    if (!instance) throw std::runtime_error("fmi2Instantiate failed for the FMU.");
    if (api.setupExperiment(instance, fmi2False, 0, 0.0, fmi2False, 0) != fmi2OK) throw std::runtime_error("fmi2SetupExperiment failed.");
    if (api.enterInitializationMode(instance) != fmi2OK) throw std::runtime_error("fmi2EnterInitializationMode failed.");
    if (api.exitInitializationMode(instance) != fmi2OK) throw std::runtime_error("fmi2ExitInitializationMode failed.");

    std::ofstream output(outputCsvPath);
    if (!output) throw std::runtime_error("Failed to open '" + outputCsvPath.string() + "' for the round-trip CSV output.");
    output.precision(15);
    const auto writeRow = [&](double time, const std::vector<double>& values) {
        output << time;
        for (double value : values) output << ',' << value;
        output << '\n';
    };
    writeRow(0.0, readState(api, instance, stateCount));

    const auto steps = static_cast<long long>(std::llround(targetTime / outputInterval));
    const long long rollbackStep = verifyRollback ? steps / 2 : -1;
    fmi2FMUstate rollbackSnapshot = nullptr;
    std::vector<double> rollbackCapturedState;
    bool rollbackSupported = false;

    for (long long step = 0; step < steps; ++step) {
        if (api.doStep(instance, static_cast<double>(step) * outputInterval, outputInterval, fmi2False) != fmi2OK) {
            throw std::runtime_error("fmi2DoStep failed during the FMU round-trip check.");
        }
        writeRow(static_cast<double>(step + 1) * outputInterval, readState(api, instance, stateCount));

        if (step == rollbackStep) {
            rollbackSupported = api.getFMUstate(instance, &rollbackSnapshot) == fmi2OK;
            if (rollbackSupported) rollbackCapturedState = readState(api, instance, stateCount);
        }
    }

    if (verifyRollback) {
        if (!rollbackSupported) {
            std::cerr << "Rollback check skipped: this FMU declines fmi2Get/SetFMUstate (e.g. a model using a provider).\n";
        } else {
            if (api.setFMUstate(instance, rollbackSnapshot) != fmi2OK) throw std::runtime_error("fmi2SetFMUstate failed.");
            const auto restored = readState(api, instance, stateCount);
            for (std::size_t index = 0; index < restored.size(); ++index) {
                if (std::abs(restored[index] - rollbackCapturedState[index]) > 1e-9) {
                    throw std::runtime_error("Rollback check failed: state index " + std::to_string(index) +
                        " did not match the captured snapshot after fmi2SetFMUstate.");
                }
            }
            std::cerr << "Rollback check passed: fmi2Get/SetFMUstate round-tripped correctly.\n";
        }
    }
    if (rollbackSnapshot) api.freeFMUstate(instance, &rollbackSnapshot);

    api.terminate(instance);
    api.freeInstance(instance);
}

} // namespace konjugate
