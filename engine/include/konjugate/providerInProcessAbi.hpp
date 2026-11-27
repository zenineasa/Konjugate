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

// Optional, beside the node vtable (a library without it is used as before): an instance's outputs at the start of a fresh run,
// before its first step, given its inputs there (NodeProvider::initialOutputs). *given is 0 when it has none. Returns false and
// sets lastError() on failure.
using KonjugateInProcessNodeInitialOutputsV1Fn = bool (*)(void* self, std::uint64_t instanceId, double simulationTime,
    const double* inputs, std::uint32_t inputCount, double* outValues, std::uint32_t outValueCount, std::int32_t* given);

// Version 2 of the program SDK (konjugate/sdk/v2/program.hpp, docs/proposals/programSdkV2.md): one table for both kinds of program,
// beginning with its own size and ABI version so later fields are appended and an engine reads only the part it knows; an optional
// method (a Jacobian) is a capability, answered by status 3 when the program gives none. One object per instance; the engine owns
// each instance's memory (memorySize bytes, 8-byte aligned, zeroed before createInstance) and passes it to every call, so it saves and
// restores memory without asking. Status codes: 0 done, 1 failed (lastError, lastErrorLine), 2 out of domain (the program refused
// these inputs; lastError says why), 3 not provided.
struct KonjugateInProcessProgramV2 {
    std::uint32_t size;
    std::uint32_t abiVersion;
    // The artifact: a probe instance read for the description. Returns nullptr on failure (lastError(nullptr) says why).
    void* (*create)();
    void (*destroy)(void* self);
    // The program's description, as JSON owned by the library: name, kind (relationship or node), inputs (key, kind, unit, default),
    // outputs (key, unit, dependsOn), memory (name, type, count, offset, unit), memorySize, clockPeriod, clockConstant.
    const char* (*description)(void* self);
    // A new instance: constructed, its memory set to the declared starting values (each Random seeded from ownerId, programSeed and the
    // field's name), then initialize() called with `values` (every input in declaration order, at the start) and `bound` (one flag per
    // input). *clockPeriod is its clock's period after initialize(), 0 for none.
    std::int32_t (*createInstance)(void* self, std::uint64_t instanceId, const char* owner, double startTime, const double* values,
                                   const unsigned char* bound, std::uint32_t valueCount, std::uint64_t ownerId, std::uint64_t programSeed,
                                   std::uint8_t* memory, double* clockPeriod);
    // outputs: one per declared output, in declaration order.
    std::int32_t (*evaluate)(void* self, std::uint64_t instanceId, double time, const double* values, std::uint32_t valueCount,
                             const std::uint8_t* memory, double* outputs, std::uint32_t outputCount);
    std::int32_t (*advance)(void* self, std::uint64_t instanceId, double time, double size, std::int32_t first, const double* values,
                            std::uint32_t valueCount, std::uint8_t* memory);
    // entries: outputCount x valueCount, row by output; status 3 when the program gives no Jacobian.
    std::int32_t (*jacobian)(void* self, std::uint64_t instanceId, double time, const double* values, std::uint32_t valueCount,
                             const std::uint8_t* memory, double* entries, std::uint32_t entryCount);
    const char* (*lastError)(void* self);
    std::uint32_t (*lastErrorLine)(void* self);
    void (*shutdownProgram)(void* self);
};

using KonjugateInProcessProgramV2Fn = const KonjugateInProcessProgramV2* (*)();

} // extern "C"

// The symbol names the engine dlsym()s/GetProcAddress()s for; kept as named constants so the
// shims that export them and the engine that looks them up cannot drift independently.
inline constexpr const char* kKonjugateInProcessProviderEntryPoint = "konjugate_in_process_provider_v1";
inline constexpr const char* kKonjugateInProcessNodeProviderEntryPoint = "konjugate_in_process_node_provider_v1";
inline constexpr const char* kKonjugateInProcessNodeInitialOutputsEntryPoint = "konjugate_in_process_node_initial_outputs_v1";
inline constexpr const char* kKonjugateInProcessProgramEntryPoint = "konjugate_in_process_program_v2";
inline constexpr std::uint32_t kKonjugateInProcessProgramAbiVersion = 1;
