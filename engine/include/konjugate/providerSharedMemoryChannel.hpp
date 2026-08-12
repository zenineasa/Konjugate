/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// Internal engine <-> provider-worker transport detail, not part of the public
// provider-authoring SDK (that's relationshipProvider.hpp). It lives under include/konjugate/
// only because that is the one directory a packaged build installs alongside
// providerWorker.cpp, so it must be resolvable via the same -I the worker's own build uses.

#include <cstddef>
#include <cstdint>

namespace konjugate::provider::sharedmem {

inline constexpr std::size_t kMaxSlots = 64;
inline constexpr std::size_t kMaxInputsPerSlot = 16;
inline constexpr std::size_t kMaxErrorMessageLength = 256;

inline constexpr const char* kSharedMemoryEnvVar = "KONJUGATE_PROVIDER_SHM";
inline constexpr const char* kRequestSemaphoreEnvVar = "KONJUGATE_PROVIDER_REQ_SEM";
inline constexpr const char* kResponseSemaphoreEnvVar = "KONJUGATE_PROVIDER_RESP_SEM";

struct EvaluationSlot {
    std::uint64_t instanceId = 0;
    std::uint32_t inputCount = 0;
    double inputs[kMaxInputsPerSlot] = {};
    double output = 0;
};

// A single fixed-size mailbox exchanged between the engine and one provider worker over shared
// memory: the engine fills it and posts the request semaphore, the worker fills each slot's
// output (or sets failed/errorMessage) and posts the response semaphore. Exactly one round trip
// is ever in flight at a time on each side, so no field here needs to be atomic or otherwise
// synchronized on its own — the semaphore pair is the sole synchronization primitive, which is
// the ordinary way to pair shared memory with cross-process signaling.
struct Channel {
    std::uint32_t slotCount = 0;
    bool failed = false;
    double simulationTime = 0;
    double stepSize = 0;
    EvaluationSlot slots[kMaxSlots];
    char errorMessage[kMaxErrorMessageLength] = {};
};

} // namespace konjugate::provider::sharedmem
