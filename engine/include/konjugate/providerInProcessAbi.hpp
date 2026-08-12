/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <cstdint>

// Internal engine <-> in-process-provider-library ABI, not part of the public
// provider-authoring SDK (that's relationshipProvider.hpp). The provider library is
// dlopen()'d/LoadLibrary()'d directly into the engine process (no IPC, no process isolation —
// see ProviderExecutionMode::inProcess), so this boundary cannot assume the provider was built
// with the same C++ ABI/STL as the engine: everything crossing it is POD, and no C++ exception
// is ever allowed to cross it (every function that can fail reports failure through a return
// value/out-parameter instead, with lastError() carrying the message).

extern "C" {

struct KonjugateInProcessProviderV1 {
    // Returns nullptr on failure; pass self=nullptr to lastError() below for why.
    void* (*create)();
    void (*destroy)(void* self);

    std::uint32_t (*inputCount)(void* self);
    // Returned pointer is owned by the provider library and remains valid for the provider's
    // lifetime (backed by the same RelationshipDescription populated once in describe()).
    const char* (*inputKey)(void* self, std::uint32_t index);

    // inputKeys/inputKeyCount is this instance's own binding order, exactly like the
    // input_keys sent in the pipe/shared-memory protocol's InitializeRequest; the library maps
    // them against inputKey()/inputCount() itself. Returns false and sets lastError() on
    // failure (e.g. an unknown input key).
    bool (*initializeInstance)(void* self, std::uint64_t instanceId,
                               const char* const* inputKeys, std::uint32_t inputKeyCount);

    // inputs/inputCount are this call's actual values, ordered to match the inputKeys this
    // instance was initialized with. Returns false and sets lastError() on failure
    // (unregistered instance, or the provider's own evaluate() throwing); *outValue is only
    // meaningful when this returns true.
    bool (*evaluateInstance)(void* self, std::uint64_t instanceId, double simulationTime, double stepSize,
                             const double* inputs, std::uint32_t inputCount, double* outValue);

    // Valid only immediately after initializeInstance/evaluateInstance returned false on the
    // same object, or after create() returned nullptr (pass self=nullptr in that case — there
    // is no instance yet, but the library still remembers why construction failed).
    const char* (*lastError)(void* self);

    void (*shutdownProvider)(void* self);
};

using KonjugateInProcessProviderV1Fn = const KonjugateInProcessProviderV1* (*)();

} // extern "C"

// The symbol name the engine dlsym()s/GetProcAddress()s for; kept as a named constant so the
// shim that exports it and the engine that looks it up cannot drift independently.
inline constexpr const char* kKonjugateInProcessProviderEntryPoint = "konjugate_in_process_provider_v1";
