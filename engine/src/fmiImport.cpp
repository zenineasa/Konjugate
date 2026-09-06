/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "fmiImport.hpp"
#include "fmi2/fmi2Functions.h"
#include "konjugate/fmiDynamicLoad.hpp"

#include <cmath>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace konjugate {
namespace {

using konjugate::fmi::Fmi2Api;
using konjugate::fmi::LoadedLibrary;

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
