/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "konjugate/relationshipProvider.hpp"
#include "konjugate/providerInProcessAbi.hpp"

#include <algorithm>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

// No C++ exception is ever allowed to cross the C ABI boundary in providerInProcessAbi.hpp
// (the engine that dlopen()s this library may not share this library's C++ ABI), so every
// entry point below catches internally and reports failure through the vtable's return
// values/lastError() instead.

// Kept outside ShimState (which does not exist until create() succeeds) so a failure inside
// create() itself still has somewhere to report to.
thread_local std::string g_createError;

struct InstanceBinding {
    std::vector<std::size_t> keyIndexes;
};

struct ShimState {
    std::unique_ptr<konjugate::sdk::v1::RelationshipProvider> provider;
    konjugate::sdk::v1::RelationshipDescription description;
    std::map<std::uint64_t, InstanceBinding> instanceBindings;
    std::string lastError;
};

ShimState& state(void* self) { return *static_cast<ShimState*>(self); }

void* create() {
    try {
        auto shimState = std::make_unique<ShimState>();
        shimState->provider = createRelationshipProvider();
        if (!shimState->provider) {
            g_createError = "createRelationshipProvider returned null.";
            return nullptr;
        }
        shimState->description = shimState->provider->describe();
        return shimState.release();
    } catch (const std::exception& error) {
        g_createError = error.what();
        return nullptr;
    } catch (...) {
        g_createError = "createRelationshipProvider threw a non-standard exception.";
        return nullptr;
    }
}

void destroy(void* self) { delete static_cast<ShimState*>(self); }

std::uint32_t inputCount(void* self) {
    return static_cast<std::uint32_t>(state(self).description.inputs.size());
}

const char* inputKey(void* self, std::uint32_t index) {
    return state(self).description.inputs.at(index).key.c_str();
}

bool initializeInstance(void* self, std::uint64_t instanceId,
                        const char* const* inputKeys, std::uint32_t inputKeyCount) {
    auto& shimState = state(self);
    try {
        InstanceBinding binding;
        for (std::uint32_t index = 0; index < inputKeyCount; ++index) {
            const std::string_view key = inputKeys[index];
            const auto& inputs = shimState.description.inputs;
            const auto found = std::find_if(inputs.begin(), inputs.end(),
                [&](const auto& port) { return port.key == key; });
            if (found == inputs.end()) {
                throw std::runtime_error("In-process instance binding references an unknown input key: " + std::string(key));
            }
            binding.keyIndexes.push_back(static_cast<std::size_t>(found - inputs.begin()));
        }
        shimState.instanceBindings[instanceId] = std::move(binding);
        shimState.provider->initialize({instanceId});
        return true;
    } catch (const std::exception& error) {
        shimState.lastError = error.what();
        return false;
    } catch (...) {
        shimState.lastError = "initializeInstance threw a non-standard exception.";
        return false;
    }
}

bool evaluateInstance(void* self, std::uint64_t instanceId, double simulationTime, double stepSize,
                      const double* inputs, std::uint32_t inputCountArg, double* outValue) {
    auto& shimState = state(self);
    try {
        const auto found = shimState.instanceBindings.find(instanceId);
        if (found == shimState.instanceBindings.end()) {
            throw std::runtime_error("In-process evaluation references an uninitialized instance.");
        }
        const auto& binding = found->second;
        std::vector<double> orderedValues(shimState.description.inputs.size(), 0);
        for (std::size_t index = 0; index < binding.keyIndexes.size() && index < inputCountArg; ++index) {
            orderedValues[binding.keyIndexes[index]] = inputs[index];
        }
        std::vector<std::string_view> keys;
        keys.reserve(shimState.description.inputs.size());
        for (const auto& input : shimState.description.inputs) keys.push_back(input.key);

        konjugate::sdk::v1::OutputCollector output;
        shimState.provider->evaluate({simulationTime, stepSize, {orderedValues, keys}}, output);
        *outValue = output.gradient();
        return true;
    } catch (const std::exception& error) {
        shimState.lastError = error.what();
        return false;
    } catch (...) {
        shimState.lastError = "evaluateInstance threw a non-standard exception.";
        return false;
    }
}

const char* lastError(void* self) {
    if (!self) return g_createError.c_str();
    return state(self).lastError.c_str();
}

void shutdownProvider(void* self) {
    // Matches the pipe worker's tolerant shutdown: a provider that throws while shutting down
    // must not prevent unloading the library.
    try {
        state(self).provider->shutdown();
    } catch (...) {}
}

constexpr KonjugateInProcessProviderV1 kVtable{
    &create,
    &destroy,
    &inputCount,
    &inputKey,
    &initializeInstance,
    &evaluateInstance,
    &lastError,
    &shutdownProvider,
};

} // anonymous namespace

extern "C" const KonjugateInProcessProviderV1* konjugate_in_process_provider_v1() {
    return &kVtable;
}
