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

// The node-provider-shaped counterpart to KonjugateInProcessProviderV1 above: N named inputs (same
// shape) but N named OUTPUTS (not one unnamed gradient), plus optional checkpoint/restore -- the
// two things a relationship provider's stateless-by-design contract has no use for. A distinct
// struct and a distinct entry-point symbol (rather than widening V1) so a given compiled artifact
// unambiguously declares which shape it implements: the engine looks up one symbol or the other
// depending on whether it is loading a ContributionTask or a NodeProviderTask, and a mismatched
// artifact fails fast at dlsym() rather than being called through the wrong vtable shape.
struct KonjugateInProcessNodeProviderV1 {
    void* (*create)();
    void (*destroy)(void* self);

    std::uint32_t (*inputCount)(void* self);
    const char* (*inputKey)(void* self, std::uint32_t index);
    // Fixed per artifact (populated once in create(), like inputCount/inputKey above) -- an
    // instance's actual output set never varies per instanceId, only per compiled artifact.
    std::uint32_t (*outputCount)(void* self);
    const char* (*outputKey)(void* self, std::uint32_t index);

    bool (*initializeInstance)(void* self, std::uint64_t instanceId,
                               const char* const* inputKeys, std::uint32_t inputKeyCount);

    // outValues is a CALLER-OWNED buffer of exactly outputCount() doubles, written in the same
    // order as outputKey(0..outputCount()-1) -- no allocation crosses the boundary on the hot
    // path, mirroring how inputs already cross as a plain caller-owned array.
    bool (*evaluateInstance)(void* self, std::uint64_t instanceId, double simulationTime, double stepSize,
                             const double* inputs, std::uint32_t inputCount,
                             double* outValues, std::uint32_t outValueCount);

    // Two-call query-then-fill pattern, the same shape POSIX/Win32 APIs conventionally use to
    // hand back variable-length data without a cross-runtime free(): call once with
    // buffer=nullptr/bufferCapacity=0 to learn the required size via *outSize (still returns true
    // on success), then again with a caller-allocated buffer of that size to actually fill it.
    // A provider that declines checkpointing (an FMU that never reports canGetAndSetFMUstate, say)
    // returns false with lastError() set, exactly like an unsupported input/output would.
    bool (*requestCheckpoint)(void* self, std::uint64_t instanceId,
                              std::uint8_t* buffer, std::uint32_t bufferCapacity, std::uint32_t* outSize);
    bool (*requestRestore)(void* self, std::uint64_t instanceId,
                           const std::uint8_t* payload, std::uint32_t payloadSize);

    const char* (*lastError)(void* self);
    void (*shutdownProvider)(void* self);
};

using KonjugateInProcessNodeProviderV1Fn = const KonjugateInProcessNodeProviderV1* (*)();

} // extern "C"

// The symbol names the engine dlsym()s/GetProcAddress()s for; kept as named constants so the
// shims that export them and the engine that looks them up cannot drift independently.
inline constexpr const char* kKonjugateInProcessProviderEntryPoint = "konjugate_in_process_provider_v1";
inline constexpr const char* kKonjugateInProcessNodeProviderEntryPoint = "konjugate_in_process_node_provider_v1";
