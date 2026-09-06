/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "konjugate/relationshipProvider.hpp"
#include "konjugate/providerInProcessAbi.hpp"

#include <algorithm>
#include <cstring>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

// Mirrors providerInProcessShim.cpp exactly (see that file's comments for the full rationale):
// no C++ exception is ever allowed to cross the C ABI boundary, so every entry point below
// catches internally and reports failure through the vtable's return values/lastError() instead.
//
// Unlike the relationship shim, a NodeProvider is explicitly stateful (it declares checkpoint()/
// restore()), and one compiled artifact can back MULTIPLE bound Konjugate node instances sharing
// the same source/provider process key (e.g. two different nodes importing the identical FMU) --
// so, unlike RelationshipProvider (stateless by design, one shared object is safe), each instance
// here gets its OWN freshly constructed NodeProvider object rather than sharing one.

thread_local std::string g_createError;

struct InstanceBinding {
    std::vector<std::size_t> keyIndexes;
    std::unique_ptr<konjugate::sdk::v1::NodeProvider> provider;
    // Filled by requestCheckpoint()'s "query" call and read back by its matching "fill" half --
    // per-instance (not shared) so two instances' in-flight checkpoint sequences on the same
    // artifact can never cross-contaminate, even though the engine serializes calls with a mutex.
    std::vector<std::byte> pendingCheckpoint;
};

struct ShimState {
    // Fixed per artifact, exactly like inputCount()/inputKey() already are: populated once from a
    // throwaway probe instance in create() (constructed and immediately discarded -- describe()
    // must not depend on initialize() having run), never from any bound instance's own object.
    konjugate::sdk::v1::NodeProviderDescription description;
    std::map<std::uint64_t, InstanceBinding> instanceBindings;
    std::string lastError;
    std::vector<std::string_view> inputKeys;
    std::vector<double> scratchValues;
};

ShimState& state(void* self) { return *static_cast<ShimState*>(self); }

void* create() {
    try {
        auto shimState = std::make_unique<ShimState>();
        const auto probe = createNodeProvider();
        if (!probe) {
            g_createError = "createNodeProvider returned null.";
            return nullptr;
        }
        shimState->description = probe->describe();
        shimState->inputKeys.reserve(shimState->description.inputs.size());
        for (const auto& input : shimState->description.inputs) shimState->inputKeys.push_back(input.key);
        shimState->scratchValues.assign(shimState->description.inputs.size(), 0.0);
        return shimState.release();
    } catch (const std::exception& error) {
        g_createError = error.what();
        return nullptr;
    } catch (...) {
        g_createError = "createNodeProvider threw a non-standard exception.";
        return nullptr;
    }
}

void destroy(void* self) { delete static_cast<ShimState*>(self); } // NOLINT(cppcoreguidelines-owning-memory)

std::uint32_t inputCount(void* self) {
    return static_cast<std::uint32_t>(state(self).description.inputs.size());
}

const char* inputKey(void* self, std::uint32_t index) {
    return state(self).description.inputs.at(index).key.c_str();
}

std::uint32_t outputCount(void* self) {
    return static_cast<std::uint32_t>(state(self).description.outputs.size());
}

const char* outputKey(void* self, std::uint32_t index) {
    return state(self).description.outputs.at(index).key.c_str();
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
                throw std::runtime_error("In-process node instance binding references an unknown input key: " + std::string(key));
            }
            binding.keyIndexes.push_back(static_cast<std::size_t>(found - inputs.begin()));
        }
        binding.provider = createNodeProvider();
        if (!binding.provider) throw std::runtime_error("createNodeProvider returned null for a new instance.");
        binding.provider->initialize({instanceId});
        shimState.instanceBindings[instanceId] = std::move(binding);
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
                      const double* inputs, std::uint32_t inputCountArg,
                      double* outValues, std::uint32_t outValueCount) {
    auto& shimState = state(self);
    try {
        const auto found = shimState.instanceBindings.find(instanceId);
        if (found == shimState.instanceBindings.end()) {
            throw std::runtime_error("In-process node evaluation references an uninitialized instance.");
        }
        if (outValueCount != shimState.description.outputs.size()) {
            throw std::runtime_error("In-process node evaluation was given a mismatched output buffer size.");
        }
        auto& binding = found->second;
        std::fill(shimState.scratchValues.begin(), shimState.scratchValues.end(), 0.0);
        for (std::size_t index = 0; index < binding.keyIndexes.size() && index < inputCountArg; ++index) {
            shimState.scratchValues[binding.keyIndexes[index]] = inputs[index];
        }

        konjugate::sdk::v1::NodeOutputCollector output;
        binding.provider->evaluate(
            {simulationTime, stepSize, {shimState.scratchValues, shimState.inputKeys}}, output);

        // The provider is free to name gradients in any order (and to omit an output it did not
        // contribute to this step, defaulting it to 0), so results are placed by matching key
        // against description.outputs rather than assumed positional.
        std::fill(outValues, outValues + outValueCount, 0.0);
        for (const auto& [key, value] : output.gradients()) {
            const auto& outputs = shimState.description.outputs;
            const auto matched = std::find_if(outputs.begin(), outputs.end(),
                [&](const auto& port) { return port.key == key; });
            if (matched == outputs.end()) {
                throw std::runtime_error("Node provider produced an undeclared output key: " + key);
            }
            outValues[matched - outputs.begin()] += value;
        }
        return true;
    } catch (const std::exception& error) {
        shimState.lastError = error.what();
        return false;
    } catch (...) {
        shimState.lastError = "evaluateInstance threw a non-standard exception.";
        return false;
    }
}

bool requestCheckpoint(void* self, std::uint64_t instanceId,
                      std::uint8_t* buffer, std::uint32_t bufferCapacity, std::uint32_t* outSize) {
    auto& shimState = state(self);
    try {
        const auto found = shimState.instanceBindings.find(instanceId);
        if (found == shimState.instanceBindings.end()) {
            throw std::runtime_error("In-process node checkpoint references an uninitialized instance.");
        }
        auto& binding = found->second;
        if (buffer == nullptr) {
            // Query call: (re)compute the checkpoint now and cache it for the matching fill call,
            // rather than computing it twice -- checkpoint() may not be cheap or side-effect-free
            // to call repeatedly (an FMU's fmi2GetFMUstate, say, allocates on the vendor side).
            binding.pendingCheckpoint = binding.provider->checkpoint();
            *outSize = static_cast<std::uint32_t>(binding.pendingCheckpoint.size());
            return true;
        }
        if (bufferCapacity < binding.pendingCheckpoint.size()) {
            throw std::runtime_error("In-process node checkpoint buffer is smaller than the queried size.");
        }
        std::memcpy(buffer, binding.pendingCheckpoint.data(), binding.pendingCheckpoint.size());
        *outSize = static_cast<std::uint32_t>(binding.pendingCheckpoint.size());
        return true;
    } catch (const std::exception& error) {
        shimState.lastError = error.what();
        return false;
    } catch (...) {
        shimState.lastError = "requestCheckpoint threw a non-standard exception.";
        return false;
    }
}

bool requestRestore(void* self, std::uint64_t instanceId, const std::uint8_t* payload, std::uint32_t payloadSize) {
    auto& shimState = state(self);
    try {
        const auto found = shimState.instanceBindings.find(instanceId);
        if (found == shimState.instanceBindings.end()) {
            throw std::runtime_error("In-process node restore references an uninitialized instance.");
        }
        std::vector<std::byte> bytes(payloadSize);
        std::memcpy(bytes.data(), payload, payloadSize);
        found->second.provider->restore(bytes);
        return true;
    } catch (const std::exception& error) {
        shimState.lastError = error.what();
        return false;
    } catch (...) {
        shimState.lastError = "requestRestore threw a non-standard exception.";
        return false;
    }
}

const char* lastError(void* self) {
    if (!self) return g_createError.c_str();
    return state(self).lastError.c_str();
}

void shutdownProvider(void* self) {
    auto& shimState = state(self);
    for (auto& [instanceId, binding] : shimState.instanceBindings) {
        try {
            binding.provider->shutdown();
        } catch (...) {} // NOLINT(bugprone-empty-catch)
    }
}

constexpr KonjugateInProcessNodeProviderV1 kVtable{
    &create,
    &destroy,
    &inputCount,
    &inputKey,
    &outputCount,
    &outputKey,
    &initializeInstance,
    &evaluateInstance,
    &requestCheckpoint,
    &requestRestore,
    &lastError,
    &shutdownProvider,
};

} // anonymous namespace

extern "C" const KonjugateInProcessNodeProviderV1* konjugate_in_process_node_provider_v1() {
    return &kVtable;
}
