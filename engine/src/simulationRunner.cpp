/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "simulationRunner.hpp"
#include "engineProtocol.pb.h"
#include "dependencyGraph.hpp"
#include "duringRunStabilityMonitor.hpp"
#include "executionBackend.hpp"
#include "executionPlan.hpp"
#include "partitionPlan.hpp"
#include "partitionRuntime.hpp"
#include "providerRuntime.hpp"
#include "taskExecutor.hpp"
#include "wholeModelIntegration.hpp"
#include "eventLocation.hpp"
#include "jacobianAssembly.hpp"
#include "konjugate/integrators/dormandPrince54.hpp"
#include "konjugate/integrators/tsit5.hpp"
#include "konjugate/integrators/events.hpp"
#include "konjugate/integrators/rodas4.hpp"
#include "konjugate/integrators/rodas5p.hpp"
#include "konjugate/integrators/rungeKutta4.hpp"
#include <algorithm>
#include <bit>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <future>
#include <memory>
#include <mutex>
#include <numeric>
#include <functional>
#include <limits>
#include <optional>
#include <openssl/evp.h>
#include <random>
#include <set>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

namespace konjugate {
namespace {
void writeFramedEvent(std::ostream& output, const protocol::EngineEvent& event) {
    const auto size = event.ByteSizeLong();
    if (size > 0xffffffffu) throw std::runtime_error("The protocol event is too large.");
    const unsigned char header[4] = {
        static_cast<unsigned char>((size >> 24) & 0xff), static_cast<unsigned char>((size >> 16) & 0xff),
        static_cast<unsigned char>((size >> 8) & 0xff), static_cast<unsigned char>(size & 0xff)
    };
    output.write(reinterpret_cast<const char*>(header), sizeof(header));
    if (!event.SerializeToOstream(&output)) throw std::runtime_error("Could not serialize the protocol event.");
    output.flush();
}
using Values = StateValues;
// `parts`: each recorded part's value at the sample (recordedParts), empty where none were worked out.
struct Sample { double time; Values states; Values parts; };
// Each entry pairs a computational-node-provider-owning node's id with that provider instance's
// opaque checkpoint() payload. Empty for a plan with no computational-node providers.
using ProviderCheckpointStates = std::vector<std::pair<EntityId, std::vector<std::byte>>>;
// The events an adaptive or stiff step is given when version 2 programs remember something from step to step: the switching conditions'
// (or none), and after each step the method accepts, the programs advanced (docs/proposals/programSdkV2.md, How the engine calls a
// program): whether their memory changed, so the next step's first stage is evaluated again rather than reused. A step rejected, or
// taken again to land on an event, never reaches accepted().
template <typename Inner, typename Accepted>
struct ProgramStepEvents {
    Inner& inner;
    Accepted onAccepted;
    // The inner events' latches, which BDF reads (latchesOf); none for an inner that has none.
    const std::vector<double>& latches = latchesFor(inner);
    static const std::vector<double>& latchesFor(const Inner& events) {
        if constexpr (requires { events.latches; }) return events.latches;
        else {
            static const std::vector<double> none;
            return none;
        }
    }
    bool active() const { return inner.active(); }
    void beginStep(double time, const std::vector<double>& states) { inner.beginStep(time, states); }
    template <typename At>
    bool locate(double from, double to, At&& at, double& when) { return inner.locate(from, to, std::forward<At>(at), when); }
    void fire(double time) { inner.fire(time); }
    bool accepted(double time, double step, const std::vector<double>& states) { return onAccepted(time, step, states); }
};

// A version 2 program's memory in a result's checkpoint (protocol ProgramMemory), and back: reals as doubles, integers and flags as
// integers, a random stream's seed and counter as words.
void encodeProgramMemory(const ProgramMemoryState& memory, protocol::ProgramMemory& encoded) {
    encoded.set_owner_id(memory.owner);
    encoded.set_owner_kind(static_cast<protocol::ProgramMemory::OwnerKind>(memory.ownerKind));
    encoded.set_layout(memory.layout);
    for (const auto& field : memory.fields) {
        auto* item = encoded.add_fields();
        item->set_name(field.name);
        item->set_type(static_cast<protocol::ProgramMemoryField::Type>(field.type));
        for (const auto word : field.words) {
            if (field.type == 0 || field.type == 3) item->add_reals(std::bit_cast<double>(word));
            else if (field.type == 1 || field.type == 2) item->add_integers(std::bit_cast<std::int64_t>(word));
            else item->add_words(word);
        }
    }
}

ProgramMemoryState decodeProgramMemory(const protocol::ProgramMemory& encoded) {
    ProgramMemoryState memory;
    memory.owner = encoded.owner_id();
    memory.ownerKind = static_cast<std::uint8_t>(encoded.owner_kind());
    memory.layout = encoded.layout();
    for (const auto& item : encoded.fields()) {
        ProgramMemoryField field;
        field.name = std::string(item.name());
        field.type = static_cast<std::uint8_t>(item.type());
        for (const auto value : item.reals()) field.words.push_back(std::bit_cast<std::uint64_t>(value));
        for (const auto value : item.integers()) field.words.push_back(std::bit_cast<std::uint64_t>(value));
        for (const auto value : item.words()) field.words.push_back(value);
        memory.fields.push_back(std::move(field));
    }
    return memory;
}

// startCheckpoint.programMemory: the same shape as JSON ({ ownerId, ownerKind, layout, fields: [{ name, type, reals, integers, words }] }),
// 64-bit integers and words as decimal strings so no digit is lost.
std::vector<ProgramMemoryState> programMemoryFromJson(const boost::property_tree::ptree& tree) {
    std::vector<ProgramMemoryState> memories;
    for (const auto& [unused, entry] : tree) {
        static_cast<void>(unused);
        ProgramMemoryState memory;
        memory.owner = entry.get<EntityId>("ownerId");
        memory.ownerKind = static_cast<std::uint8_t>(entry.get<unsigned>("ownerKind", 0));
        memory.layout = std::stoull(entry.get<std::string>("layout", "0"));
        if (const auto fields = entry.get_child_optional("fields")) for (const auto& [unusedField, item] : *fields) {
            static_cast<void>(unusedField);
            ProgramMemoryField field;
            field.name = item.get<std::string>("name");
            field.type = static_cast<std::uint8_t>(item.get<unsigned>("type", 0));
            if (const auto reals = item.get_child_optional("reals")) for (const auto& value : *reals) field.words.push_back(std::bit_cast<std::uint64_t>(value.second.get_value<double>()));
            if (const auto integers = item.get_child_optional("integers")) for (const auto& value : *integers) field.words.push_back(std::bit_cast<std::uint64_t>(std::stoll(value.second.get_value<std::string>())));
            if (const auto words = item.get_child_optional("words")) for (const auto& value : *words) field.words.push_back(std::stoull(value.second.get_value<std::string>()));
            memory.fields.push_back(std::move(field));
        }
        memories.push_back(std::move(memory));
    }
    return memories;
}

// `solverKind` is the method that made it, empty for this run's own; `solverState` its hidden state (solver_state), empty for none.
// `programMemory`: every version 2 program's memory, kept by the engine (docs/proposals/programSdkV2.md, Automatic memory checkpoints).
struct Checkpoint {
    std::string uuid;
    double time;
    Values states;
    ProviderCheckpointStates providerStates;
    std::string solverState;
    std::string solverKind;
    std::vector<ProgramMemoryState> programMemory;
};
enum class PacingMode { fastest, realTime, limitedRatio };
enum class RunState { running, paused, stopped };
struct Pacing { PacingMode mode = PacingMode::fastest; double ratio = 1; };
struct RunControl {
    Pacing pacing;
    RunState executionState = RunState::running;
    EntityValues parameterValues;
    // Appended to, never overwritten -- see ParameterSchedule's own doc comment for why more than
    // one schedule per parameter is expected (a later intervention layered onto an earlier one).
    std::vector<ParameterSchedule> activeSchedules;
    // Every parameter change applied so far, in order, with the simulation time of the step it took effect at; written into the
    // result (protocol::Intervention) so the record of how the controls were moved is kept with it.
    std::vector<std::pair<double, protocol::EngineCommand>> interventions;
    // Commands held until the run reaches their apply_at time, in the order they are to be carried out (by time, then arrival).
    std::vector<protocol::EngineCommand> held;
};
struct ControlInbox {
    std::mutex mutex;
    std::vector<protocol::EngineCommand> commands;
    std::string error;
    // A session waits on this for its next command (a run polls instead); `ended` is set when the stream closes.
    std::condition_variable ready;
    bool ended = false;
};
struct ExecutionSettings {
    ExecutionBackend requestedBackend = ExecutionBackend::automatic;
    ExecutionBackend backend = ExecutionBackend::serial;
    std::size_t workerThreads = 1;
    std::size_t estimatedOperationsPerSynchronization = 0;
    std::size_t automaticParallelThreshold = 128;
};
struct NodeRuntimeMetrics {
    std::uint64_t invocations = 0;
    std::uint64_t executedSubsteps = 0;
    std::uint64_t evaluatedContributions = 0;
    std::uint64_t computeNanoseconds = 0;
};

EntityId entityIdValue(const boost::property_tree::ptree& tree, const std::string& key) {
    const auto text = tree.get<std::string>(key, "");
    std::size_t consumed = 0;
    const auto result = std::stoull(text, &consumed);
    if (!result || result > 9007199254740991ULL || consumed != text.size()) {
        throw std::runtime_error("Model ids must be positive safe integers.");
    }
    return result;
}

// A restart checkpoint is plain JSON, which has no native bytes type, so a computational-node
// provider's opaque checkpoint payload travels as base64 text -- same convention already used for
// the encrypted-project container header in projectContainer.cpp, though that helper is
// fixed-size-only and local to a different translation unit, hence this small counterpart.
std::vector<std::byte> decodeBase64Bytes(const std::string& encoded) {
    if (encoded.empty()) return {};
    if (encoded.size() % 4) {
        throw std::runtime_error("A computational-node provider checkpoint payload is not valid base64.");
    }
    std::vector<unsigned char> decoded(encoded.size() / 4 * 3);
    const auto size = EVP_DecodeBlock(decoded.data(), reinterpret_cast<const unsigned char*>(encoded.data()),
        static_cast<int>(encoded.size()));
    if (size < 0) throw std::runtime_error("A computational-node provider checkpoint payload is not valid base64.");
    std::size_t actual = static_cast<std::size_t>(size);
    if (encoded.ends_with("==")) actual -= 2;
    else if (encoded.ends_with("=")) actual -= 1;
    decoded.resize(actual);
    std::vector<std::byte> bytes(decoded.size());
    std::transform(decoded.begin(), decoded.end(), bytes.begin(),
        [](unsigned char byte) { return static_cast<std::byte>(byte); });
    return bytes;
}

// The same, for a method's solver_state, which the engine keeps as a byte string.
std::string decodeBase64Text(const std::string& encoded) {
    const auto bytes = decodeBase64Bytes(encoded);
    return std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size());
}

PacingMode pacingModeFromString(const std::string& value) {
    if (value == "fastest") return PacingMode::fastest;
    if (value == "realTime") return PacingMode::realTime;
    if (value == "limitedRatio") return PacingMode::limitedRatio;
    throw std::runtime_error("Pacing mode must be fastest, realTime, or limitedRatio.");
}

std::string_view pacingModeName(PacingMode value) noexcept {
    switch (value) {
        case PacingMode::fastest: return "fastest";
        case PacingMode::realTime: return "realTime";
        case PacingMode::limitedRatio: return "limitedRatio";
    }
    return "fastest";
}

std::string createUuid() {
    static thread_local std::mt19937_64 generator(std::random_device{}());
    std::uniform_int_distribution<unsigned int> octet(0, 255);
    unsigned int bytes[16];
    for (auto& byte : bytes) byte = octet(generator);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    std::ostringstream value;
    value << std::hex << std::setfill('0');
    for (std::size_t index = 0; index < 16; ++index) {
        if (index == 4 || index == 6 || index == 8 || index == 10) value << '-';
        value << std::setw(2) << bytes[index];
    }
    return value.str();
}

std::string escape(const std::string& input) {
    std::string output;
    for (const char character : input) {
        if (character == '\\' || character == '"') output += '\\';
        output += character;
    }
    return output;
}

void atomicWrite(const std::filesystem::path& path, const std::string& content) {
    const auto temporary = path.string() + ".tmp";
    std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
    if (!stream) throw std::runtime_error("The simulation result could not be created.");
    stream << content;
    stream.close();
    std::error_code error;
    std::filesystem::rename(temporary, path, error);
    if (error) {
        std::filesystem::remove(path, error);
        std::filesystem::rename(temporary, path);
    }
}

// A result file this engine wrote (docs/resultFileFormat.md), read whole: its header (state table, checkpoints, interventions) and
// every sample, for a run that continues it (Simulation::prependContinuedResult).
struct StoredResult {
    protocol::ResultFile header;
    std::vector<double> times;
    std::vector<std::vector<double>> values;
    // Each sample's recorded parts, in header.part_table()'s order; empty rows when the result recorded none.
    std::vector<std::vector<double>> parts;
};

std::uint32_t storedResultLength(const std::string& content, std::size_t offset) {
    if (offset + 4 > content.size()) throw std::runtime_error("The result of the run to continue is truncated.");
    return (static_cast<std::uint32_t>(static_cast<unsigned char>(content[offset])) << 24) |
        (static_cast<std::uint32_t>(static_cast<unsigned char>(content[offset + 1])) << 16) |
        (static_cast<std::uint32_t>(static_cast<unsigned char>(content[offset + 2])) << 8) |
        static_cast<std::uint32_t>(static_cast<unsigned char>(content[offset + 3]));
}

StoredResult readStoredResult(const std::filesystem::path& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) throw std::runtime_error("The result of the run to continue could not be opened.");
    std::ostringstream buffer;
    buffer << stream.rdbuf();
    const std::string content = buffer.str();
    if (content.size() < 12 || content.compare(0, 4, "KJR\x02", 4) != 0 || content.compare(content.size() - 4, 4, "KJIX") != 0) {
        throw std::runtime_error("The result of the run to continue is not a result file.");
    }
    StoredResult result;
    const auto headerLength = storedResultLength(content, 4);
    if (8 + static_cast<std::size_t>(headerLength) > content.size() || !result.header.ParseFromArray(content.data() + 8, static_cast<int>(headerLength))) {
        throw std::runtime_error("The result of the run to continue has a header that cannot be read.");
    }
    const auto indexLengthOffset = content.size() - 8;
    const auto indexLength = storedResultLength(content, indexLengthOffset);
    if (indexLength > indexLengthOffset) throw std::runtime_error("The result of the run to continue has an index that cannot be read.");
    protocol::ResultIndex index;
    if (!index.ParseFromArray(content.data() + indexLengthOffset - indexLength, static_cast<int>(indexLength))) {
        throw std::runtime_error("The result of the run to continue has an index that cannot be read.");
    }
    for (const auto& entry : index.batches()) {
        // The offset is where the batch's 4-byte length begins; its payload follows (see writeResult).
        const auto payloadOffset = entry.offset() + 4;
        protocol::SampleBatch batch;
        if (payloadOffset + entry.length() > content.size() || !batch.ParseFromArray(content.data() + payloadOffset, static_cast<int>(entry.length()))) {
            throw std::runtime_error("The result of the run to continue has samples that cannot be read.");
        }
        const auto stateCount = static_cast<std::size_t>(batch.state_count());
        const auto partCount = static_cast<std::size_t>(batch.part_count());
        const auto hasParts = partCount > 0 && static_cast<std::size_t>(batch.part_values_size()) == partCount * static_cast<std::size_t>(batch.times_size());
        for (int sample = 0; sample < batch.times_size(); ++sample) {
            result.times.push_back(batch.times(sample));
            std::vector<double> row(stateCount);
            for (std::size_t state = 0; state < stateCount; ++state) row[state] = batch.values(static_cast<int>(static_cast<std::size_t>(sample) * stateCount + state));
            result.values.push_back(std::move(row));
            std::vector<double> parts;
            if (hasParts) {
                parts.resize(partCount);
                for (std::size_t part = 0; part < partCount; ++part) parts[part] = batch.part_values(static_cast<int>(static_cast<std::size_t>(sample) * partCount + part));
            }
            result.parts.push_back(std::move(parts));
        }
    }
    return result;
}

Pacing pacingFromTree(const boost::property_tree::ptree& tree, const Pacing& fallback = {}) {
    Pacing pacing;
    pacing.mode = pacingModeFromString(tree.get<std::string>(
        "pacing.mode", tree.get<std::string>("mode", std::string(pacingModeName(fallback.mode)))));
    pacing.ratio = tree.get<double>("pacing.simulationSecondsPerWallSecond",
        tree.get<double>("simulationSecondsPerWallSecond", fallback.ratio));
    if (pacing.mode == PacingMode::realTime) pacing.ratio = 1;
    if (pacing.mode == PacingMode::limitedRatio && (!(pacing.ratio > 0) || !std::isfinite(pacing.ratio))) {
        throw std::runtime_error("Limited pacing requires a finite positive simulationSecondsPerWallSecond value.");
    }
    return pacing;
}

// A pacing wait, used below both for the paused-state poll and the real-time/limited-ratio
// per-step throttle. On every platform except the web build this is a plain
// std::this_thread::sleep_for(), a real, ordinary blocking call. Under Emscripten's pthread
// support specifically, that call was confirmed (directly, via a real live run in a real browser)
// to hang indefinitely for any non-negligible duration: the thread that instantiates a
// MODULARIZE'd module -- a dedicated Worker for every caller in this codebase (src/
// webEngineLiveRunWorker.mjs et al.), never the page's own thread -- is still treated by
// Emscripten's pthread support as ITS OWN distinct "main runtime thread", a role that does not
// support genuine blocking the way an ordinary pthread worker does. -sPROXY_TO_PTHREAD=1 is
// Emscripten's textbook fix for exactly this class of problem (it moves callMain() itself onto a
// real, dedicated proxy pthread where blocking works normally) -- also confirmed directly, and
// also confirmed to regress ordinary Module.FS-based batch runs/validate (they started failing
// with ErrnoError: No such file or directory) at the same time, an unacceptable tradeoff for a
// real-time-pacing-only problem, so it is not used. A plain busy-wait against a monotonic clock
// sidesteps the whole question: it needs no blocking primitive at all, so it behaves identically
// regardless of which thread runs it, at the cost of spinning one core for the wait's duration:
// each individual call is capped at a few tens of milliseconds, which is the whole cost for the
// real-time/limited-ratio per-step throttle (bounded by the run's own length), but the
// paused-state poll calls this repeatedly for as long as a web-edition run stays paused, meaning
// this Worker's core stays pegged at 100% for the entire pause, not just each 40ms slice of it --
// a real, known, accepted cost on the web build specifically, not a correctness problem (nothing
// elsewhere on the page is affected; pausing a run natively is unaffected, since this branch never
// compiles in there).
void pacingWait(std::chrono::milliseconds duration) {
#ifdef __EMSCRIPTEN__
    const auto deadline = std::chrono::steady_clock::now() + duration;
    while (std::chrono::steady_clock::now() < deadline) {}
#else
    std::this_thread::sleep_for(duration);
#endif
}

// Validates and pushes one already-length-delimited command frame's payload into inbox, tracking
// previousSequence the same way across calls a caller must maintain -- shared by both the
// native-shaped, thread-plus-blocking-stream reader below and the web build's own polling reader
// (see pollEmscriptenControlBytes()), which differ only in how the raw framed bytes arrive, not in
// how a frame's payload is validated or queued.
void handleControlCommandPayload(const char* payload, std::size_t size, ControlInbox& inbox, std::uint64_t& previousSequence) {
    protocol::EngineCommand command;
    if (!command.ParseFromArray(payload, static_cast<int>(size)) ||
        command.protocol_version() != 1 || !command.sequence() || command.sequence() <= previousSequence ||
        command.payload_case() == protocol::EngineCommand::PAYLOAD_NOT_SET) {
        {
            std::lock_guard lock(inbox.mutex);
            inbox.error = "The engine received an invalid, unsupported or out-of-order command.";
        }
        inbox.ready.notify_all();
        return;
    }
    previousSequence = command.sequence();
    {
        std::lock_guard lock(inbox.mutex);
        inbox.commands.push_back(std::move(command));
    }
    inbox.ready.notify_all();
}

#ifdef __EMSCRIPTEN__
extern "C" {
// Synchronously drains and returns whatever command bytes are currently queued (possibly zero) in
// the live-run job's SharedArrayBuffer-backed ring buffer -- see src/webEngineStdinBuffer.mjs's
// drainStdinBytes() and src/webEngineLiveRunWorker.mjs, which writes this Worker's stdinRing
// reference into Module.controlStreamRing before callMain() runs. Never blocks: unlike the
// native pipe transport's dedicated reader thread, this is called from
// pollEmscriptenControlBytes() below, itself called from the SAME thread running the whole
// simulation loop (see that function's own header comment for why), so it must return
// immediately with whatever is available, exactly like every other per-step check in that loop.
EM_JS(unsigned char*, wasmDrainControlBytes, (int* outLen), {
    if (typeof Module.drainControlStreamBytes !== 'function') {
        HEAP32[outLen >> 2] = 0;
        return 0;
    }
    const bytes = Module.drainControlStreamBytes();
    if (!bytes || bytes.length === 0) {
        HEAP32[outLen >> 2] = 0;
        return 0;
    }
    const buffer = _malloc(bytes.length);
    HEAPU8.set(bytes, buffer);
    HEAP32[outLen >> 2] = bytes.length;
    return buffer;
});
}

// The web build's control-stream reader: docs/proposals/webEdition.md's live-run design initially
// reused the native pipe transport's own std::cin/startControlReader() thread unchanged (matching
// this file's own "no engine changes needed" original plan), on the theory that a real std::thread
// under Emscripten's pthread support becomes a genuine separate Worker whose blocking stdin read
// would work exactly like a native blocking pipe read. Confirmed FALSE by direct testing in a real
// browser: Module.stdin was never invoked at all, and pause/setPacing/setParameterValue commands
// were silently dropped (no error -- the reader thread's own read() call is itself proxied back to
// whichever thread owns Emscripten's FS/TTY state, normally the thread that instantiated the
// module -- but that thread is THIS thread, permanently busy running the very simulation loop the
// proxied call would need to interrupt to be serviced, so it can never actually complete).
// -sPROXY_TO_PTHREAD=1 (Emscripten's textbook fix for "my code needs to block on what would
// otherwise be the main thread") was also tried and also confirmed broken, differently: it made
// ordinary Module.FS-based batch runs/validate fail outright. A synchronous EM_JS poll sidesteps
// the whole question the same way emitEngineEvent (engine/src/main.cpp) already does for the
// output direction: no blocking primitive, no separate thread, no thread-ownership question --
// just a plain, non-blocking, same-thread call, made from inside the main loop's own existing
// per-step refreshRunControl() poll (already gated on the same ~10ms cadence a real read would
// have imposed a syscall's worth of overhead for anyway).
struct EmscriptenControlBuffer {
    std::string pending;
    std::uint64_t previousSequence = 0;
};

void pollEmscriptenControlBytes(ControlInbox& inbox, EmscriptenControlBuffer& buffer) {
    int length = 0;
    unsigned char* bytes = wasmDrainControlBytes(&length);
    if (bytes && length > 0) {
        buffer.pending.append(reinterpret_cast<const char*>(bytes), static_cast<std::size_t>(length));
        std::free(bytes);
    }
    while (buffer.pending.size() >= 4) {
        const auto& header = buffer.pending;
        const auto size = (static_cast<std::uint32_t>(static_cast<unsigned char>(header[0])) << 24) |
            (static_cast<std::uint32_t>(static_cast<unsigned char>(header[1])) << 16) |
            (static_cast<std::uint32_t>(static_cast<unsigned char>(header[2])) << 8) |
             static_cast<std::uint32_t>(static_cast<unsigned char>(header[3]));
        if (!size || size > 1024 * 1024) {
            std::lock_guard lock(inbox.mutex);
            inbox.error = "The engine command frame has an invalid size.";
            return;
        }
        if (buffer.pending.size() < 4 + static_cast<std::size_t>(size)) return; // wait for the rest of this frame
        handleControlCommandPayload(buffer.pending.data() + 4, size, inbox, buffer.previousSequence);
        buffer.pending.erase(0, 4 + size);
    }
}
#endif

// stream must outlive the whole process -- see runSimulation()'s doc comment in
// simulationRunner.hpp. The thread below is deliberately detached rather than joined: joining it
// would mean blocking runSimulation()'s return on stream->read() reaching EOF or an error, which
// for the real caller (stdin, piped from a parent process) may never happen on a clean, one-shot
// successful run if the parent never closes its write end -- exactly the deadlock main.cpp's own
// std::_Exit() comment works around on the shutdown side. Detaching is the reason stream's
// lifetime requirement is "the whole process" rather than "until runSimulation() returns". Never
// actually used on the web build (see pollEmscriptenControlBytes() above for why), so it is
// excluded there entirely rather than left as unreachable dead code.
#ifndef __EMSCRIPTEN__
std::shared_ptr<ControlInbox> startControlReader(std::istream* stream) {
    auto inbox = std::make_shared<ControlInbox>();
    if (!stream) return inbox;
    std::thread([stream, inbox] {
        // However the stream ends, a session waiting for its next command is woken to find it ended.
        struct EndOnExit {
            ControlInbox& inbox;
            ~EndOnExit() {
                {
                    std::lock_guard lock(inbox.mutex);
                    inbox.ended = true;
                }
                inbox.ready.notify_all();
            }
        } endOnExit{*inbox};
        std::uint64_t previousSequence = 0;
        while (true) {
            unsigned char header[4];
            stream->read(reinterpret_cast<char*>(header), sizeof(header));
            const auto headerBytes = stream->gcount();
            if (!headerBytes && stream->eof()) return;
            if (headerBytes != static_cast<std::streamsize>(sizeof(header))) {
                std::lock_guard lock(inbox->mutex);
                inbox->error = "The engine command stream ended inside a frame header.";
                return;
            }
            const auto size = (static_cast<std::uint32_t>(header[0]) << 24) |
                (static_cast<std::uint32_t>(header[1]) << 16) |
                (static_cast<std::uint32_t>(header[2]) << 8) | static_cast<std::uint32_t>(header[3]);
            if (!size || size > 1024 * 1024) {
                std::lock_guard lock(inbox->mutex);
                inbox->error = "The engine command frame has an invalid size.";
                return;
            }
            std::vector<char> payload(size);
            stream->read(payload.data(), static_cast<std::streamsize>(payload.size()));
            if (stream->gcount() != static_cast<std::streamsize>(payload.size())) {
                std::lock_guard lock(inbox->mutex);
                inbox->error = "The engine command stream ended inside a frame payload.";
                return;
            }
            handleControlCommandPayload(payload.data(), payload.size(), *inbox, previousSequence);
        }
    }).detach();
    return inbox;
}
#endif

// Applies one of the commands a run understands (pacing, run state, a parameter set or scheduled) to its controls. A session's
// own commands are not among them and are left alone.
void applyControlCommand(RunControl& current, const protocol::EngineCommand& command, double now) {
    if (command.has_set_pacing()) {
        const auto& update = command.set_pacing();
        if (update.mode() == protocol::PACING_MODE_FASTEST) current.pacing.mode = PacingMode::fastest;
        else if (update.mode() == protocol::PACING_MODE_REAL_TIME) current.pacing.mode = PacingMode::realTime;
        else if (update.mode() == protocol::PACING_MODE_LIMITED_RATIO) current.pacing.mode = PacingMode::limitedRatio;
        else throw std::runtime_error("The engine received an unsupported pacing mode.");
        current.pacing.ratio = current.pacing.mode == PacingMode::realTime ? 1 : update.simulation_seconds_per_wall_second();
        if (!(current.pacing.ratio > 0) || !std::isfinite(current.pacing.ratio)) {
            throw std::runtime_error("The engine received an invalid pacing ratio.");
        }
    } else if (command.has_set_run_state()) {
        const auto state = command.set_run_state().state();
        if (state == protocol::RUN_STATE_RUNNING) current.executionState = RunState::running;
        else if (state == protocol::RUN_STATE_PAUSED) current.executionState = RunState::paused;
        else if (state == protocol::RUN_STATE_STOPPED) current.executionState = RunState::stopped;
        else throw std::runtime_error("The engine received an unsupported run state.");
    } else if (command.has_set_parameter_value()) {
        const auto& update = command.set_parameter_value();
        if (!update.parameter_id() || update.parameter_id() > 9007199254740991ULL || !std::isfinite(update.value())) {
            throw std::runtime_error("The engine received an invalid live parameter value.");
        }
        current.parameterValues[update.parameter_id()] = update.value();
        // Setting a value is the newest decision about this parameter, so it supersedes the schedules and waveforms
        // recorded for it until now. Without this a schedule that has begun would govern forever (a waveform has no
        // end of its own), and the slider could never take the parameter back.
        std::erase_if(current.activeSchedules, [&](const ParameterSchedule& schedule) { return schedule.parameterId == update.parameter_id(); });
        current.interventions.emplace_back(now, command);
    } else if (command.has_schedule_parameter_value()) {
        const auto& update = command.schedule_parameter_value();
        if (!update.parameter_id() || update.parameter_id() > 9007199254740991ULL) {
            throw std::runtime_error("The engine received an invalid parameter schedule identifier.");
        }
        if (!std::isfinite(update.start_time()) || !std::isfinite(update.duration()) ||
            !std::isfinite(update.target_value()) || !std::isfinite(update.base_value())) {
            throw std::runtime_error("The engine received a non-finite parameter schedule value.");
        }
        ParameterSchedule schedule;
        schedule.parameterId = update.parameter_id();
        schedule.startTime = update.start_time();
        schedule.duration = update.duration();
        schedule.targetValue = update.target_value();
        schedule.baseValue = update.base_value();
        switch (update.mode()) {
        case protocol::PARAMETER_SCHEDULE_MODE_STEP: schedule.mode = ParameterSchedule::Mode::step; break;
        case protocol::PARAMETER_SCHEDULE_MODE_RAMP: schedule.mode = ParameterSchedule::Mode::ramp; break;
        case protocol::PARAMETER_SCHEDULE_MODE_PULSE: schedule.mode = ParameterSchedule::Mode::pulse; break;
        case protocol::PARAMETER_SCHEDULE_MODE_WAVEFORM: {
            schedule.mode = ParameterSchedule::Mode::waveform;
            const double amplitude = update.amplitude();
            const double frequency = update.frequency();
            const double duty = update.duty_cycle();
            if (!std::isfinite(amplitude) || amplitude < 0 || !std::isfinite(frequency) || frequency < 0 ||
                !std::isfinite(update.phase_degrees()) || !std::isfinite(duty) || duty < 0 || duty >= 1) {
                throw std::runtime_error("The engine received an invalid waveform parameter schedule.");
            }
            switch (update.waveform_shape()) {
            case protocol::WAVEFORM_SHAPE_SINE: schedule.shape = ParameterSchedule::Shape::sine; break;
            case protocol::WAVEFORM_SHAPE_SQUARE: schedule.shape = ParameterSchedule::Shape::square; break;
            case protocol::WAVEFORM_SHAPE_TRIANGLE: schedule.shape = ParameterSchedule::Shape::triangle; break;
            case protocol::WAVEFORM_SHAPE_SAWTOOTH: schedule.shape = ParameterSchedule::Shape::sawtooth; break;
            case protocol::WAVEFORM_SHAPE_NOISE:
                // Noise draws `frequency` values per second, so none at all is not a signal.
                if (!(frequency > 0)) throw std::runtime_error("A noise parameter schedule needs a positive frequency.");
                schedule.shape = ParameterSchedule::Shape::noise;
                break;
            default:
                throw std::runtime_error("The engine received an unsupported waveform shape.");
            }
            schedule.amplitude = amplitude;
            schedule.frequency = frequency;
            schedule.phaseDegrees = update.phase_degrees();
            schedule.dutyCycle = duty;
            schedule.seed = update.seed();
            break;
        }
        case protocol::PARAMETER_SCHEDULE_MODE_PIECEWISE:
            schedule.mode = ParameterSchedule::Mode::piecewise;
            schedule.samples.reserve(update.samples_size());
            for (const auto& sample : update.samples()) {
                if (!std::isfinite(sample.time()) || !std::isfinite(sample.value())) {
                    throw std::runtime_error("The engine received a non-finite piecewise parameter schedule sample.");
                }
                schedule.samples.emplace_back(sample.time(), sample.value());
            }
            std::sort(schedule.samples.begin(), schedule.samples.end());
            break;
        default:
            throw std::runtime_error("The engine received an unsupported parameter schedule mode.");
        }
        current.activeSchedules.push_back(std::move(schedule));
        current.interventions.emplace_back(now, command);
    }
}

// Carries out the held commands whose time has come, in order: at the first step at or after each one's apply_at, as if it had
// arrived then.
void applyDueHeldCommands(RunControl& current, double now) {
    std::size_t due = 0;
    while (due < current.held.size() && current.held[due].apply_at() <= now) ++due;
    if (!due) return;
    std::vector<protocol::EngineCommand> commands(std::make_move_iterator(current.held.begin()), std::make_move_iterator(current.held.begin() + static_cast<std::ptrdiff_t>(due)));
    current.held.erase(current.held.begin(), current.held.begin() + static_cast<std::ptrdiff_t>(due));
    for (const auto& command : commands) applyControlCommand(current, command, now);
}

RunControl drainRunControl(const std::shared_ptr<ControlInbox>& inbox, RunControl current, double now) {
    std::vector<protocol::EngineCommand> commands;
    {
        std::lock_guard lock(inbox->mutex);
        if (!inbox->error.empty()) throw std::runtime_error(inbox->error);
        commands.swap(inbox->commands);
    }
    applyDueHeldCommands(current, now);
    for (auto& command : commands) {
        if (!std::isfinite(command.apply_at()) || command.apply_at() < 0) throw std::runtime_error("The engine received a command held until a time that is not a finite, non-negative number.");
        if (command.apply_at() > now) {
            // After every held command due at the same time or earlier, so commands for one step keep the order they were sent in.
            const auto at = std::upper_bound(current.held.begin(), current.held.end(), command.apply_at(),
                [](double time, const protocol::EngineCommand& other) { return time < other.apply_at(); });
            current.held.insert(at, std::move(command));
        } else {
            applyControlCommand(current, command, now);
        }
    }
    return current;
}

ExecutionSettings executionSettingsFromTree(const boost::property_tree::ptree& tree, const ExecutionPlan& plan) {
    ExecutionSettings settings;
    settings.requestedBackend = executionBackendFromString(tree.get<std::string>("execution.backend", "automatic"));
    settings.automaticParallelThreshold = tree.get<std::size_t>("execution.automaticParallelThreshold", 128);
    if (!settings.automaticParallelThreshold || settings.automaticParallelThreshold > 1000000) {
        throw std::runtime_error("execution.automaticParallelThreshold must be an integer from 1 through 1000000.");
    }
    for (const auto& node : plan.nodes) {
        settings.estimatedOperationsPerSynchronization += node.estimatedOperationsPerSubstep * node.substeps;
    }
    const auto hardwareThreads = std::max(1u, std::thread::hardware_concurrency());
    const auto requestedThreads = tree.get<std::size_t>("execution.workerThreads", hardwareThreads);
    if (!requestedThreads || requestedThreads > 256) {
        throw std::runtime_error("execution.workerThreads must be an integer from 1 through 256.");
    }
    settings.backend = settings.requestedBackend;
    settings.workerThreads = settings.requestedBackend == ExecutionBackend::serial
        ? 1 : std::min(requestedThreads, std::max<std::size_t>(1, plan.nodes.size()));
    return settings;
}

// How a global step's nodes are integrated: one at a time, on a thread pool, or by partition (docs/parallelExecution.md). Each
// is handed the states the step starts from and hands back what every node reached, and keeps no states of its own between
// steps, so the run's one state vector is the whole truth and restoring it restores every backend. A backend whose partitions
// kept their own states (docs/proposals/liveEngineSession.md, "Where the partitions' states live") would take its share of a
// restored vector in restore() and exchange only boundary states in integrate().
class StepExecutor {
public:
    struct Communication {
        std::uint64_t boundaryMessages = 0;
        std::uint64_t boundaryPayloadBytes = 0;
        std::uint64_t messagePreparationNanoseconds = 0;
        std::uint64_t transportPublishNanoseconds = 0;
        std::uint64_t boundaryWaitNanoseconds = 0;
    };

    virtual ~StepExecutor() = default;
    // `endTime` is the time the step ends at, as the run records it (see integrateNode).
    virtual std::vector<NodeIntegrationResult> integrate(const Values& snapshot, const RunControl& control, double time,
        double step, double endTime, std::size_t stepIndex, ProviderRuntime* providers) = 0;
    // The states the next step starts from have been set from outside (a restore); nothing to do while the states live in the
    // run's vector.
    virtual void restore(const Values&) {}
    virtual Communication communication() const { return {}; }
    // One stage of a whole-model step (docs/proposals/integrators.md): every node that takes part in stages evaluated at
    // `stageStates`, each reading the same immutable vector, so the derivatives are the same on every backend. Indexed by node;
    // a stepped node's entry is not to be read. The results stay the executor's, valid until its next evaluateStage, so each node's
    // derivatives keep their storage from one stage to the next.
    virtual const std::vector<NodeStageResult>& evaluateStage(const Values& stageStates, const RunControl& control, const StageRequest& request,
        ProviderRuntime* providers) = 0;

protected:
    explicit StepExecutor(const ExecutionPlan& plan) : plan_(plan) {}
    const ExecutionPlan& plan_;
    std::vector<NodeStageResult> stageResults_;
};

class SerialStepExecutor final : public StepExecutor {
public:
    explicit SerialStepExecutor(const ExecutionPlan& plan) : StepExecutor(plan) {}

    std::vector<NodeIntegrationResult> integrate(const Values& snapshot, const RunControl& control, double time, double step,
        double endTime, std::size_t, ProviderRuntime* providers) override {
        // The nodes are integrated one after another, so the step is timed once and its time shared among them by the work each
        // does (estimated operations a substep times substeps), as the stages are: timing every node cost a large part of a run.
        const auto startedAt = std::chrono::steady_clock::now();
        std::vector<NodeIntegrationResult> nodeResults(plan_.nodes.size());
        for (std::size_t index = 0; index < plan_.nodes.size(); ++index) {
            nodeResults[index] = integrateNode(plan_.nodes[index], snapshot, control.parameterValues, time, step, providers, control.activeSchedules,
                endTime, false);
        }
        const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - startedAt).count();
        nodeWeights_.resize(plan_.nodes.size());
        nodeShares_.assign(plan_.nodes.size(), 0);
        allNodes_.assign(plan_.nodes.size(), true);
        for (std::size_t index = 0; index < plan_.nodes.size(); ++index) {
            const auto& node = plan_.nodes[index];
            nodeWeights_[index] = static_cast<std::uint64_t>(node.estimatedOperationsPerSubstep) * static_cast<std::uint64_t>(node.substeps);
        }
        shareMeasuredTime(nodeWeights_, allNodes_, static_cast<std::uint64_t>(std::max<std::int64_t>(0, elapsed)), nodeShares_);
        for (std::size_t index = 0; index < plan_.nodes.size(); ++index) nodeResults[index].computeNanoseconds = nodeShares_[index];
        return nodeResults;
    }

    const std::vector<NodeStageResult>& evaluateStage(const Values& stageStates, const RunControl& control, const StageRequest& request,
        ProviderRuntime* providers) override {
        // The nodes are evaluated one after another, so the stage is timed once and its time shared among them (shareStageTime):
        // timing every node cost about a quarter of a large model's run.
        const auto startedAt = std::chrono::steady_clock::now();
        stageResults_.resize(plan_.nodes.size());
        evaluatedNodes_.assign(plan_.nodes.size(), false);
        for (std::size_t index = 0; index < plan_.nodes.size(); ++index) {
            const auto& wholeNode = request.wholeModel->nodes[index];
            if (wholeNode.stepped) continue;
            evaluateNodeStageInto(plan_.nodes[index], wholeNode, stageStates, control.parameterValues, control.activeSchedules,
                request.stageTime, request.stepSize, request.evaluateHeld, request.heldStepSize, request.held->at(index), providers, request.latches,
                stageResults_[index], false);
            evaluatedNodes_[index] = true;
        }
        shareStageTime(stageResults_, evaluatedNodes_, static_cast<std::uint64_t>(std::max<std::int64_t>(0,
            std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - startedAt).count())));
        return stageResults_;
    }

private:
    std::vector<bool> evaluatedNodes_;
    std::vector<std::uint64_t> nodeWeights_, nodeShares_;
    std::vector<bool> allNodes_;
};

class ThreadPoolStepExecutor final : public StepExecutor {
public:
    ThreadPoolStepExecutor(const ExecutionPlan& plan, std::size_t workerThreads) : StepExecutor(plan), taskExecutor_(workerThreads) {}

    std::vector<NodeIntegrationResult> integrate(const Values& snapshot, const RunControl& control, double time, double step,
        double endTime, std::size_t, ProviderRuntime* providers) override {
        std::vector<NodeIntegrationResult> nodeResults(plan_.nodes.size());
        const auto parameterValues = control.parameterValues;
        const auto activeSchedules = control.activeSchedules;
        std::vector<std::future<NodeIntegrationResult>> futures;
        futures.reserve(plan_.nodes.size());
        futures.resize(plan_.nodes.size());
        for (const auto index : plan_.taskSubmissionOrder) {
            const auto* nodePlan = &plan_.nodes[index];
            futures[index] = taskExecutor_.submit([nodePlan, &snapshot, &parameterValues, &activeSchedules, time, step, endTime, evaluatorPtr = providers] {
                return integrateNode(*nodePlan, snapshot, parameterValues, time, step, evaluatorPtr, activeSchedules, endTime);
            });
        }
        for (std::size_t index = 0; index < futures.size(); ++index) nodeResults[index] = futures[index].get();
        return nodeResults;
    }

    const std::vector<NodeStageResult>& evaluateStage(const Values& stageStates, const RunControl& control, const StageRequest& request,
        ProviderRuntime* providers) override {
        stageResults_.resize(plan_.nodes.size());
        std::vector<std::future<void>> futures(plan_.nodes.size());
        for (const auto index : plan_.taskSubmissionOrder) {
            const auto* wholeNode = &request.wholeModel->nodes[index];
            if (wholeNode->stepped) continue;
            const auto* nodePlan = &plan_.nodes[index];
            auto* held = &request.held->at(index);
            // Each task writes its own node's entry only, so the tasks never share one.
            auto* result = &stageResults_[index];
            futures[index] = taskExecutor_.submit([nodePlan, wholeNode, held, result, &stageStates, &control, &request, providers] {
                evaluateNodeStageInto(*nodePlan, *wholeNode, stageStates, control.parameterValues, control.activeSchedules,
                    request.stageTime, request.stepSize, request.evaluateHeld, request.heldStepSize, *held, providers, request.latches, *result);
            });
        }
        for (auto& future : futures) if (future.valid()) future.get();
        return stageResults_;
    }

private:
    TaskExecutor taskExecutor_;
};

class PartitionedStepExecutor final : public StepExecutor {
public:
    PartitionedStepExecutor(const ExecutionPlan& plan, const PartitionPlan& partitionPlan, const DependencyGraph& dependencyGraph,
                            std::size_t receiveTimeoutMilliseconds)
        : StepExecutor(plan), receiveTimeout_(receiveTimeoutMilliseconds) {
        partitionRuntimes_.reserve(partitionPlan.effectivePartitions);
        partitionNodeIndexes_.resize(partitionPlan.effectivePartitions);
        partitionSnapshotStateIds_.resize(partitionPlan.effectivePartitions);
        std::unordered_map<EntityId, std::size_t> executionNodeIndexes;
        std::unordered_map<EntityId, std::size_t> nodePartitions;
        for (std::size_t index = 0; index < plan.nodes.size(); ++index) {
            executionNodeIndexes[plan.nodes[index].nodeId] = index;
        }
        for (const auto& assignment : partitionPlan.assignments) {
            nodePartitions[assignment.nodeId] = assignment.partition;
            partitionNodeIndexes_[assignment.partition].push_back(executionNodeIndexes.at(assignment.nodeId));
        }
        for (std::size_t partition = 0; partition < partitionNodeIndexes_.size(); ++partition) {
            std::set<EntityId> snapshotStateIds;
            for (const auto nodeIndex : partitionNodeIndexes_[partition]) {
                snapshotStateIds.insert(plan.nodes[nodeIndex].stateIds.begin(), plan.nodes[nodeIndex].stateIds.end());
            }
            for (const auto& dependency : dependencyGraph.dependencies) {
                if (nodePartitions.at(dependency.targetNodeId) == partition) {
                    snapshotStateIds.insert(dependency.remoteStateIds.begin(), dependency.remoteStateIds.end());
                }
            }
            partitionSnapshotStateIds_[partition].assign(snapshotStateIds.begin(), snapshotStateIds.end());
        }
        for (std::size_t partition = 0; partition < partitionPlan.effectivePartitions; ++partition) {
            partitionRuntimes_.push_back(std::make_unique<PartitionRuntime>(partition, plan, partitionNodeIndexes_[partition]));
        }
        partitionTransport_ = std::make_unique<InMemoryPartitionTransport>();
    }

    std::vector<NodeIntegrationResult> integrate(const Values& snapshot, const RunControl& control, double time, double step,
        double endTime, std::size_t stepIndex, ProviderRuntime* providers) override {
        std::vector<NodeIntegrationResult> nodeResults(plan_.nodes.size());
        // Each partition worker gets the run's active schedules with the live values, so a
        // scheduled parameter intervention (a scenario fork's changes) applies under this
        // backend as it does under serial and thread-pool execution.
        const auto parameterValues = control.parameterValues;
        const auto activeSchedules = control.activeSchedules;
        for (std::size_t partition = 0; partition < partitionRuntimes_.size(); ++partition) {
            const auto preparationStartedAt = std::chrono::steady_clock::now();
            PartitionBoundaryMessage message;
            message.synchronizationIndex = stepIndex;
            message.targetPartition = partition;
            message.states.reserve(partitionSnapshotStateIds_[partition].size());
            for (const auto& stateId : partitionSnapshotStateIds_[partition]) {
                message.states[stateId] = snapshot.at(plan_.stateIndexes.at(stateId));
            }
            communication_.messagePreparationNanoseconds += static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now() - preparationStartedAt).count());
            communication_.boundaryPayloadBytes += partitionMessagePayloadBytes(message);
            ++communication_.boundaryMessages;
            const auto publishStartedAt = std::chrono::steady_clock::now();
            partitionTransport_->publish(std::move(message));
            communication_.transportPublishNanoseconds += static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now() - publishStartedAt).count());
        }
        std::vector<std::future<PartitionResultMessage>> futures;
        futures.reserve(partitionRuntimes_.size());
        for (auto& runtime : partitionRuntimes_) {
            futures.push_back(runtime->submit(
                *partitionTransport_, stepIndex, parameterValues, step, time,
                std::chrono::milliseconds(receiveTimeout_), providers, activeSchedules, endTime));
        }
        for (std::size_t partition = 0; partition < futures.size(); ++partition) {
            const auto result = futures[partition].get();
            if (result.version != 1 || result.synchronizationIndex != stepIndex || result.sourcePartition != partition) {
                throw std::runtime_error("A partition returned an incompatible result message.");
            }
            communication_.boundaryWaitNanoseconds += result.boundaryWaitNanoseconds;
            for (const auto& nodeResult : result.nodes) {
                nodeResults[nodeResult.nodeIndex] = {nodeResult.states, nodeResult.computeNanoseconds};
            }
        }
        return nodeResults;
    }

    Communication communication() const override { return communication_; }

    // As integrate(), a stage at a time: each partition is sent its nodes' and their neighbours' stage values, one boundary message
    // a stage, on a transport of its own so the stages' messages never meet the node-by-node steps'.
    const std::vector<NodeStageResult>& evaluateStage(const Values& stageStates, const RunControl& control, const StageRequest& request,
        ProviderRuntime* providers) override {
        // Fresh every stage, as before: a node no partition reports stays empty rather than keeping a previous stage's values.
        auto& results = stageResults_;
        results.assign(plan_.nodes.size(), NodeStageResult{});
        const auto sequence = stageSequence_++;
        for (std::size_t partition = 0; partition < partitionRuntimes_.size(); ++partition) {
            const auto preparationStartedAt = std::chrono::steady_clock::now();
            PartitionBoundaryMessage message;
            message.synchronizationIndex = sequence;
            message.targetPartition = partition;
            message.states.reserve(partitionSnapshotStateIds_[partition].size());
            for (const auto& stateId : partitionSnapshotStateIds_[partition]) message.states[stateId] = stageStates.at(plan_.stateIndexes.at(stateId));
            communication_.messagePreparationNanoseconds += static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now() - preparationStartedAt).count());
            communication_.boundaryPayloadBytes += partitionMessagePayloadBytes(message);
            ++communication_.boundaryMessages;
            const auto publishStartedAt = std::chrono::steady_clock::now();
            stageTransport_.publish(std::move(message));
            communication_.transportPublishNanoseconds += static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now() - publishStartedAt).count());
        }
        std::vector<std::future<PartitionStageMessage>> futures;
        futures.reserve(partitionRuntimes_.size());
        for (auto& runtime : partitionRuntimes_) {
            futures.push_back(runtime->submitStage(stageTransport_, sequence, control.parameterValues, control.activeSchedules, request,
                std::chrono::milliseconds(receiveTimeout_), providers));
        }
        for (std::size_t partition = 0; partition < futures.size(); ++partition) {
            auto result = futures[partition].get();
            if (result.version != 1 || result.synchronizationIndex != sequence || result.sourcePartition != partition) {
                throw std::runtime_error("A partition returned an incompatible result message.");
            }
            communication_.boundaryWaitNanoseconds += result.boundaryWaitNanoseconds;
            for (auto& [nodeIndex, nodeResult] : result.nodes) results[nodeIndex] = std::move(nodeResult);
        }
        return results;
    }

private:
    std::size_t receiveTimeout_;
    InMemoryPartitionTransport stageTransport_;
    std::size_t stageSequence_ = 0;
    std::vector<std::vector<std::size_t>> partitionNodeIndexes_;
    std::vector<std::vector<EntityId>> partitionSnapshotStateIds_;
    std::vector<std::unique_ptr<PartitionRuntime>> partitionRuntimes_;
    std::unique_ptr<InMemoryPartitionTransport> partitionTransport_;
    Communication communication_;
};

// Throws the run settings' errors before the model is compiled, so a bad configuration is reported first, as it always was.
// A session has no end time, so only its step and output interval are checked.
bool checkTimeSettings(double targetTime, double globalTimeStep, double outputInterval, bool session) {
    const auto outputRatio = outputInterval / globalTimeStep;
    if (session && (!(globalTimeStep > 0) || !std::isfinite(globalTimeStep) || !(outputInterval > 0) || !std::isfinite(outputInterval))) {
        throw std::runtime_error("A session requires a finite positive globalTimeStep and outputInterval.");
    }
    if (!session && (!(targetTime > 0) || !(globalTimeStep > 0) || globalTimeStep > targetTime || !(outputInterval > 0) ||
        !std::isfinite(targetTime) || !std::isfinite(globalTimeStep) || !std::isfinite(outputInterval))) {
        throw std::runtime_error("A run requires a finite positive targetTime and numerical timestep values.");
    }
    if (outputInterval < globalTimeStep || std::abs(outputRatio - std::round(outputRatio)) > 1e-9) {
        throw std::runtime_error("outputInterval must be an integer multiple of globalTimeStep.");
    }
    return true;
}

// One simulation as an object: the compiled model, its providers and execution backend, the states and the time they have
// reached, the controls the run is being driven with, and what it has recorded. runSimulation() drives one from start to
// target time; a session (docs/proposals/liveEngineSession.md) will drive one by commands, going back to its checkpoints.
class Simulation {
public:
    // `session` makes it a session (docs/proposals/liveEngineSession.md): no end time and no result file; it is driven by
    // commands through serveSession() instead.
    Simulation(const boost::property_tree::ptree& document, const boost::property_tree::ptree& configuration,
               const std::filesystem::path& outputPath, std::istream* controlStream, std::ostream* eventStream,
               std::shared_ptr<const ExecutionPlan> compiledPlan, bool session = false);

    std::size_t steps = 0;
    bool wholeSteps = true;
    double startTime = 0;
    double targetTime = 0;
    double globalTimeStep = 0;
    Pacing pacing;
    RunControl runControl;
    double currentTime = 0;

    void refreshRunControl(bool force = false);
    void captureBoundary();
    void writeResult(const std::string& lifecycle, double simulationTime, bool completeSnapshot = false);
    void settleIfParametersChanged();
    // Runs the update phase (applyUpdates) on `states` at `time`. A ring that did not settle within its limit is a finding
    // (ringDidNotSettle), one per ring however many steps it fails in, and is said once on standard error.
    void updateStates(double time, bool afterStep, double stepSize);
    void integrateStep(std::size_t step, double synchronizationStep, double elapsed);
    // integrateStep under a whole-model method (docs/proposals/integrators.md).
    void integrateWholeModelStep(double synchronizationStep, double elapsed);
    void paceStep(std::chrono::steady_clock::time_point wallStepStarted, double stepStartTime, double stepEndTime);
    // Where real-time and limited-ratio pacing measure from: the wall-clock moment a simulated time was due, at the pace
    // then set. Reset by a pause, a change of pace, and a run falling far behind (see paceStep).
    struct PacingAnchor { std::chrono::steady_clock::time_point wall; double simulationTime; PacingMode mode; double ratio; };
    std::optional<PacingAnchor> pacingAnchor;
    void recordStepOutput(std::size_t step, double elapsed);
    // Answers commands until the control stream closes.
    void serveSession();

private:
    // A session's commands; each throws, leaving the session as it was, when it cannot be carried out.
    std::uint32_t advanceTo(double time, bool takeCheckpoints);
    const ProviderCheckpointStates& restoreCheckpoint(const protocol::RestoreCheckpoint& command);
    ProviderCheckpointStates restoreState(const protocol::RestoreState& command);
    void retainFrom(double time);
    void appendInputSamples(const protocol::AppendInputSamples& command);
    void followStates(double time);
    void startFollowing(double start, double end);
    void settleAt(double time);
    void restoreProviderStates(const std::vector<std::pair<EntityId, std::vector<std::byte>>>& providerStates);
    long long checkpointKey(double time) const;
    std::optional<protocol::EngineCommand> waitForCommand();
    // `restored`, for a restore: the provider states it restored, sent back with the whole state rather than asked for again.
    void reply(const protocol::EngineCommand& command, bool ok, const std::string& message, const ProviderCheckpointStates* restored,
               std::uint64_t computeNanoseconds, std::uint32_t checkpointsTaken = 0);

    void flushSampleEvents();
    void appendStreamRecord(const std::string& type, double time, const Values& recordStates, const std::string& uuid = {});
    ProviderCheckpointStates captureProviderStates();
    // A checkpoint of the run as it stands at `time`.
    Checkpoint makeCheckpoint(double time) {
        Checkpoint checkpoint{createUuid(), time, states, captureProviderStates(), solverState(), {}, {}};
        if (providerRuntime) checkpoint.programMemory = providerRuntime->programMemory();
        return checkpoint;
    }
    // Version 2 programs (docs/proposals/programSdkV2.md): each clock's period checked against the global step; at a fresh run's start,
    // the clocks' first tick and the programs' values into Update states; after each global step, the ticks due and those values.
    void checkProgramClocks();
    void startPrograms(double time);
    void afterGlobalStep(double time, double stepSize);
    bool programClocksPresent = false;
    bool programUpdatesPresent = false;
    // Under a whole-model method: whether a version 2 program in a node taking part in the stages advances after every accepted step,
    // and which nodes take part (the others are stepped on their own, and advance their programs in their substeps).
    bool programsAdvanceAtSteps = false;
    std::vector<unsigned char> stageNodeMask;
    // A clock's tick changed some program's memory at the last global step's end: BDF's table, carried across global steps, starts again.
    bool programMemoryTicked = false;
    // advance() for the programs of the nodes taking part in the stages, after a step an adaptive or stiff method accepted, at `time`
    // with its size, reading the states it reached; whether any program's memory changed.
    bool advanceProgramsAfter(double time, double step, const Values& accepted) {
        const auto before = providerRuntime->programMemory();
        advancePlanPrograms(executionPlan, accepted, runControl.parameterValues, runControl.activeSchedules, time, step, false,
            providerRuntime.get(), stageNodeMask);
        const auto after = providerRuntime->programMemory();
        for (std::size_t index = 0; index < before.size() && index < after.size(); ++index) {
            for (std::size_t field = 0; field < before[index].fields.size(); ++field) {
                if (before[index].fields[field].words != after[index].fields[field].words) return true;
            }
        }
        return false;
    }
    // What was said while restoring programs' memory from a checkpoint (a field added or dropped since), told once on standard error.
    std::vector<std::string> programMemoryNotes;
    void restoreStartCheckpoint(const boost::property_tree::ptree& checkpoint);
    void prependContinuedResult(const std::filesystem::path& path);

    const boost::property_tree::ptree& configuration;
    std::filesystem::path outputPath;
    std::ostream* eventStream;
    double outputInterval;
    std::shared_ptr<ControlInbox> controlInbox;
#ifdef __EMSCRIPTEN__
    EmscriptenControlBuffer emscriptenControlBuffer;
#endif
    bool timeSettingsChecked;
    // How the run integrates: Euler node by node (the default), or a whole-model method, read and checked with the time settings,
    // before the model is compiled.
    IntegrationSettings integration;
    // A whole-model method's plan: which nodes are stepped, which programs held, which states integrated; and the held programs'
    // values for the step in progress, one list per node.
    WholeModelPlan wholeModel;
    std::vector<std::vector<EvaluatedContribution>> heldValues;
    // Dormand–Prince 5(4) and Tsit5: every state's absolute tolerance, the controller's memory (kept in checkpoints), the stiffness test and the
    // work done, for the result's summary.
    std::vector<double> absoluteToleranceByState;
    integrators::DormandPrince54Controller adaptiveController;
    integrators::DormandPrince54Stiffness adaptiveStiffness;
    integrators::DormandPrince54Statistics adaptiveStatistics;
    bool adaptiveStiffnessReported = false;
    // Rodas4: the model's structure worked out once (the integrated states, the Jacobian's pattern from the graph, its colours and
    // the sparse LU's ordering), the controller's memory (kept in checkpoints), the work done, and whether stages read the time.
    std::optional<integrators::Rodas4System> stiffSystem;
    integrators::Rodas4Controller stiffController;
    integrators::Rodas4Statistics stiffStatistics;
    bool stagesReadTimeAlways = false;
    // The stiff methods' exact Jacobian columns (docs/proposals/integrators.md, Jacobians for Rodas4 and BDF): the equations'
    // derivatives, compiled once; and under jacobian "check", the largest difference from finite differences seen, each entry scaled
    // as the error control sees the states and relative to the largest so scaled, where and when, over how many Jacobians.
    JacobianPlan jacobianPlan;
    double jacobianCheckLargest = 0;
    double jacobianCheckTime = 0;
    std::size_t jacobianCheckRow = 0;
    std::size_t jacobianCheckColumn = 0;
    std::size_t jacobianChecks = 0;
    // The Jacobian in the run's summary: how it was worked out, how many of its columns exactly, and the check's finding.
    void writeJacobianSummary(std::ostream& json) const {
        json << ",\"jacobian\":\"" << (integration.jacobian == JacobianMethod::finiteDifference ? "finiteDifference"
            : integration.jacobian == JacobianMethod::check ? "check" : "analytic") << '"'
             << ",\"exactColumns\":" << (stiffSystem ? stiffSystem->exactColumns : 0);
        if (integration.jacobian == JacobianMethod::check) {
            json << ",\"jacobianCheck\":{\"checks\":" << jacobianChecks << ",\"largestDifference\":" << jacobianCheckLargest;
            if (jacobianCheckLargest > 0) {
                json << ",\"time\":" << jacobianCheckTime << ",\"rowStateId\":" << executionPlan.stateIds.at(jacobianCheckRow)
                     << ",\"columnStateId\":" << executionPlan.stateIds.at(jacobianCheckColumn);
            }
            json << '}';
        }
    }
    // Event location (docs/proposals/integrators.md, Event location), under every whole-model method for a model with switching
    // conditions: the conditions, their latches, the events located (how many instants, and the first thousand, each with its
    // condition), and whether a global step has had to stop locating (chattering). Under Euler, node by node, the conditions it does not
    // locate, for the run's summary.
    using SwitchingEvaluate = std::function<void(double, const Values&, std::vector<double>&)>;
    EventPlan eventPlan;
    std::optional<integrators::Switching<SwitchingEvaluate>> switching;
    std::size_t eventInstants = 0;
    std::vector<std::pair<double, std::size_t>> eventList;
    bool chatteringReported = false;
    std::vector<std::pair<EntityId, EntityId>> unlocated;
    // BDF: its table of differences, order and step (kept in checkpoints), the work done, and the controls as they were at the last
    // global step's end: a live parameter set or a new intervention starts its table again at order 1.
    integrators::BdfHistory bdfHistory;
    integrators::BdfStatistics bdfStatistics;
    EntityValues bdfParameterValues;
    std::size_t bdfSchedules = 0;
    // The switching conditions' latches BDF's table was built under: a condition that flips at a global step's start starts it again.
    std::vector<double> bdfLatches;
    // The hidden state a checkpoint taken now keeps: the controller's memory under Adaptive and Stiff, BDF's table under BDF, and the
    // conditions' latches when events are located; nothing under every other method.
    std::string solverState() const {
        if (integration.method == IntegrationMethod::bdf) {
            return switching ? encodeBdfSolverState(bdfHistory, &switching->latches, &switching->armed) : encodeBdfSolverState(bdfHistory);
        }
        if (switching) {
            const bool stiff = isStiff(integration);
            return encodeEventSolverState(stiff ? stiffController.proposedStep : isAdaptive(integration) ? adaptiveController.proposedStep : 0.0,
                stiff ? stiffController.previousError : adaptiveController.previousError, stiff ? stiffController.previousStep : 0.0,
                switching->latches, switching->armed);
        }
        if (isStiff(integration)) return encodeStiffSolverState(stiffController.proposedStep, stiffController.previousError, stiffController.previousStep);
        return isAdaptive(integration) ? encodeAdaptiveSolverState(adaptiveController.proposedStep, adaptiveController.previousError) : std::string();
    }
    // The controller started afresh: its first step chosen again by the initial step algorithm; every condition read afresh.
    void resetSolverState(const std::string& record = {}) {
        adaptiveController = {};
        stiffController = {};
        // BDF: its table (and, when events are located, the conditions' latches) from its own record.
        bdfHistory = {};
        bdfParameterValues = runControl.parameterValues;
        bdfSchedules = runControl.activeSchedules.size();
        if (integration.method == IntegrationMethod::bdf) {
            if (switching) switching->reset();
            if (stiffSystem && decodeBdfSolverState(record, stiffSystem->integratedStates.size(), executionPlan.initialStates.size(), bdfHistory,
                    switching ? &switching->latches : nullptr, switching ? &switching->armed : nullptr) && switching) {
                switching->established = true;
            }
            bdfLatches = switching ? switching->latches : std::vector<double>{};
            return;
        }
        if (switching) {
            switching->reset();
            double proposed = 0;
            double previousError = 0;
            double previousStep = 0;
            if (decodeEventSolverState(record, proposed, previousError, previousStep, switching->latches, switching->armed)) {
                switching->established = true;
                if (proposed > 0 && isStiff(integration)) {
                    stiffController.proposedStep = proposed;
                    stiffController.previousError = previousError;
                    stiffController.previousStep = previousStep;
                } else if (proposed > 0 && isAdaptive(integration)) {
                    adaptiveController.proposedStep = proposed;
                    adaptiveController.previousError = previousError;
                }
            }
            return;
        }
        if (isAdaptive(integration)) decodeAdaptiveSolverState(record, adaptiveController.proposedStep, adaptiveController.previousError);
        if (isStiff(integration)) decodeStiffSolverState(record, stiffController.proposedStep, stiffController.previousError, stiffController.previousStep);
    }
    std::chrono::steady_clock::time_point planningStartedAt;
    std::shared_ptr<const ExecutionPlan> plan;
    const ExecutionPlan& executionPlan;
    std::unique_ptr<ProviderRuntime> providerRuntime;
    DependencyGraph dependencyGraph;
    ExecutionSettings executionSettings;
    PartitionPlan partitionPlan;
    double maximumPartitionCutFraction = 0;
    ExecutionBackendDecision backendDecision;
    std::uint64_t planningNanoseconds = 0;
    std::unique_ptr<StepExecutor> stepExecutor;
    std::size_t activeWorkerThreads = 1;
    Values states;
    std::unordered_map<EntityId, std::size_t> nodeSubsteps;
    std::vector<EntityId> nodeIds;
    std::vector<NodeRuntimeMetrics> nodeMetrics;
    std::uint64_t synchronizationComputeNanoseconds = 0;
    std::vector<Sample> samples;
    // The parts recorded with each sample (recordedParts), and their values from the states as they stand at `time`, with the
    // parameters as they stand then. Working them out reads the states and changes nothing.
    std::vector<RecordedPart> partTable;
    Values partsAt(double time) const {
        return evaluateRecordedParts(executionPlan, states, runControl.parameterValues, runControl.activeSchedules, time);
    }
    std::vector<Checkpoint> checkpoints;
    // The interventions of the run this one continues, before the restart: written first, so the result keeps the whole record.
    std::vector<protocol::Intervention> continuedInterventions;
    std::vector<Sample> pendingEventSamples;
    std::unordered_set<EntityId> stabilityMonitoredNodeIds;
    std::optional<DuringRunStabilityMonitor> stabilityMonitor;
    std::vector<DuringRunStabilityFinding> stabilityFindings;
    std::chrono::steady_clock::time_point lastControlReadAt;
    // How many parameter changes the algebraic states were last set with (see settleIfParametersChanged).
    std::size_t settledInterventions = 0;
    // How many times a ring of settling Updates stopped at its limit without settling; for each such ring (by its index in
    // the plan's settleGroups), its finding in stabilityFindings and the steps it failed in; and what to call each state.
    std::size_t ringsUnsettled = 0;
    struct UnsettledRingRecord { std::size_t finding = 0; std::size_t times = 0; double largestChange = 0; EntityId largestState = 0; };
    std::unordered_map<std::size_t, UnsettledRingRecord> unsettledRingRecords;
    std::unordered_map<EntityId, std::string> stateLabels;
    // A session's own: the states it sends samples of, its checkpoints (one every checkpointInterval from the time it began,
    // the latest pass through each kept), the time it was last restored to and how many steps it has taken since, the step
    // counter partitions are told (never reused), and the states the model computes from others, which cannot be set.
    bool sessionMode = false;
    std::vector<std::size_t> reportedIndexes;
    double checkpointInterval = 0;
    double sessionOrigin = 0;
    std::map<long long, Checkpoint> sessionCheckpoints;
    double baseTime = 0;
    long long stepsSinceBase = 0;
    // Global steps between samples: the output interval is a whole number of them (checkTimeSettings). A run samples after every
    // outputSteps-th step counted from its start, so its samples fall on the same steps however long it runs; a time accumulated
    // interval by interval drifted from the step's own time and, late in a long run, missed a sample.
    long long outputSteps = 1;
    std::size_t stepCounter = 0;
    std::unordered_set<std::size_t> algebraicIndexes;

public:
    std::chrono::steady_clock::time_point lastPublishedAt;
};

Simulation::Simulation(const boost::property_tree::ptree& document, const boost::property_tree::ptree& configuration,
                       const std::filesystem::path& outputPath, std::istream* controlStream, std::ostream* eventStream,
                       std::shared_ptr<const ExecutionPlan> compiledPlan, bool session)
    : targetTime(session ? std::numeric_limits<double>::infinity() : configuration.get<double>("targetTime")),
      globalTimeStep(configuration.get<double>("globalTimeStep", configuration.get<double>("timeStep", 0.01))),
      pacing(pacingFromTree(configuration)),
      // `startPaused` holds the run at its first step (the state is written, nothing is integrated) until it is resumed, so
      // live values can be set before anything moves; unlike a pause command sent just after the start, it cannot lose a race.
      runControl{pacing, configuration.get<bool>("startPaused", false) ? RunState::paused : RunState::running, {}},
      configuration(configuration),
      outputPath(outputPath),
      eventStream(eventStream),
      outputInterval(configuration.get<double>("outputInterval", globalTimeStep)),
#ifdef __EMSCRIPTEN__
      // See pollEmscriptenControlBytes()'s own header comment for why the web build never spawns
      // startControlReader()'s thread at all here (not just why it wouldn't work): a thread that can
      // never make progress would otherwise permanently occupy one of a finite number of pthread
      // pool slots for the rest of the run, competing with slots parallel execution may need.
      controlInbox((static_cast<void>(controlStream), std::make_shared<ControlInbox>())),
#else
      controlInbox(startControlReader(controlStream)),
#endif
      timeSettingsChecked(checkTimeSettings(targetTime, globalTimeStep, outputInterval, session)),
      integration(integrationSettingsFromTree(configuration)),
      planningStartedAt(std::chrono::steady_clock::now()),
      plan(compiledPlan ? std::move(compiledPlan) : std::make_shared<const ExecutionPlan>(compileExecutionPlan(document))),
      executionPlan(*plan),
      lastControlReadAt(std::chrono::steady_clock::now() - std::chrono::seconds(1)),
      sessionMode(session) {
    ProviderConfiguration providerConfig;
    if (const auto providers = configuration.get_child_optional("providers")) {
        providerConfig.cppCompiler = providers->get<std::string>("cpp.compiler", "");
        providerConfig.cppSdkPath = providers->get<std::string>("cpp.sdkPath", "");
        providerConfig.pythonInterpreter = providers->get<std::string>("python.interpreter", "");
        providerConfig.pythonSdkPath = providers->get<std::string>("python.sdkPath", "");
        providerConfig.buildDirectory = providers->get<std::string>("buildDirectory", "");
        // See ProviderExecutionMode. Absent or unrecognized always defaults to the
        // always-available pipe transport.
        const auto executionModeText = providers->get<std::string>("executionMode", "");
        providerConfig.executionMode = executionModeText == "inProcess" ? ProviderExecutionMode::inProcess
            : executionModeText == "sharedMemoryWorker" ? ProviderExecutionMode::sharedMemoryWorker
            : ProviderExecutionMode::pipeWorker;
    }
    if (planRequiresProviders(executionPlan)) {
        providerRuntime = std::make_unique<ProviderRuntime>(providerConfig);
        providerRuntime->initialize(executionPlan);
    }
    dependencyGraph = buildDependencyGraph(executionPlan);
    executionSettings = executionSettingsFromTree(configuration, executionPlan);
    if (integration.method != IntegrationMethod::nodeByNode) {
        wholeModel = buildWholeModelPlan(executionPlan, providerRuntime.get());
        heldValues.resize(executionPlan.nodes.size());
        // Rodas4's structure, from the graph: which states each state's derivative reads, so the Jacobian's pattern, its colours
        // and the sparse LU's ordering are worked out once, here.
        if (isRosenbrock(integration.method) || integration.method == IntegrationMethod::bdf) {
            stiffSystem = integrators::makeStiffSystem(wholeModel.integrated, stageReads(executionPlan, wholeModel, providerRuntime.get()), wholeModel.errorGroups);
            stagesReadTimeAlways = stagesReadTime(executionPlan, wholeModel);
        }
        // A node's work a global step is its work an evaluation times the method's evaluations a step, not its substeps.
        // Adaptive's and Stiff's steps a global step are not known before the run: one is assumed (Stiff's with its Jacobian's).
        const auto evaluations = (integrationMethodStages(integration.method) + (stiffSystem ? stiffSystem->colours : 0)) *
            std::max<std::size_t>(1, integration.stepsPerGlobalStep);
        executionSettings.estimatedOperationsPerSynchronization = 0;
        for (std::size_t index = 0; index < executionPlan.nodes.size(); ++index) {
            const auto& node = executionPlan.nodes[index];
            executionSettings.estimatedOperationsPerSynchronization += node.estimatedOperationsPerSubstep *
                (wholeModel.nodes[index].stepped ? node.substeps : evaluations);
        }
        if (hasTolerance(integration.method)) {
            absoluteToleranceByState = absoluteTolerances(document, executionPlan, integration.absoluteTolerance);
        }
        // Switching conditions are located under Runge–Kutta 4, Adaptive and Stiff (not Dormand–Prince or Rodas4 with the error control
        // off, which is for measuring the method's order): their stage terms then read them latched.
        if (integration.method == IntegrationMethod::rungeKutta4 || isAdaptive(integration) || isStiff(integration) || integration.method == IntegrationMethod::bdf) {
            eventPlan = compileEventPlan(executionPlan, wholeModel);
            if (!eventPlan.functions.empty()) {
                std::vector<unsigned char> comparisons;
                for (const auto& function : eventPlan.functions) comparisons.push_back(function.comparison);
                switching.emplace([this](double time, const Values& values, std::vector<double>& out) {
                    evaluateSwitchingFunctions(executionPlan, eventPlan, values, runControl.parameterValues, runControl.activeSchedules, time, out);
                }, std::move(comparisons));
            }
        }
        // The stage terms are final now that they read their conditions latched: each node's compiled for the stage loop.
        compileStageKernels(executionPlan, wholeModel);
        // The stiff methods' Jacobian: each column whose every term is an equation (or a program supplying its derivatives) from the
        // equations' derivatives, compiled here once the stage terms read their conditions latched; the rest by finite differences.
        if (stiffSystem && integration.jacobian != JacobianMethod::finiteDifference) {
            jacobianPlan = compileJacobianPlan(executionPlan, wholeModel, *stiffSystem, providerRuntime.get());
            if (std::any_of(jacobianPlan.exactColumn.begin(), jacobianPlan.exactColumn.end(), [](unsigned char exact) { return exact != 0; })) {
                integrators::useExactColumns(*stiffSystem, jacobianPlan.exactColumn);
                stiffSystem->exact = [this](double time, const Values& states, std::vector<double>& jacobian, std::vector<double>* dT) {
                    evaluateExactJacobian(executionPlan, wholeModel, jacobianPlan, time, states, runControl.parameterValues,
                        runControl.activeSchedules, switching ? &switching->latches : nullptr, jacobian, dT, providerRuntime.get());
                };
            }
            if (integration.jacobian == JacobianMethod::check) {
                stiffSystem->check = [this](double time, const std::vector<double>& states, const std::vector<double>& exact,
                                            const std::vector<double>& differences) {
                    // Each entry as the error control sees it, J_ij s_j / s_i with s = absolute + relative |y|, and the largest difference
                    // relative to the largest such entry: a check of the step's linear algebra, not of entries too small to matter.
                    ++jacobianChecks;
                    const auto& system = *stiffSystem;
                    const auto scaleOf = [&](std::size_t position) {
                        const auto index = system.integratedStates[position];
                        return absoluteToleranceByState[index] + integration.relativeTolerance * std::abs(states[index]);
                    };
                    double largestEntry = 0;
                    double largestDifference = 0;
                    std::size_t row = 0, column = 0;
                    for (std::size_t position = 0; position < system.integratedStates.size(); ++position) {
                        const double rowScale = scaleOf(position);
                        for (std::size_t entry = system.rowStart[position]; entry < system.rowStart[position + 1]; ++entry) {
                            const auto other = system.rows[position][entry - system.rowStart[position]];
                            const double weight = scaleOf(other) / rowScale;
                            largestEntry = std::max(largestEntry, std::abs(exact[entry]) * weight);
                            const double difference = std::abs(exact[entry] - differences[entry]) * weight;
                            if (difference > largestDifference) {
                                largestDifference = difference;
                                row = position;
                                column = other;
                            }
                        }
                    }
                    if (!(largestEntry > 0)) return;
                    const double relative = largestDifference / largestEntry;
                    if (relative > jacobianCheckLargest) {
                        jacobianCheckLargest = relative;
                        jacobianCheckTime = time;
                        jacobianCheckRow = system.integratedStates[row];
                        jacobianCheckColumn = system.integratedStates[column];
                    }
                };
            }
        }
    } else {
        unlocated = unlocatedConditions(executionPlan);
    }
    const auto requestedPartitions = configuration.get<std::size_t>("execution.partitionCount", executionSettings.workerThreads);
    if (!requestedPartitions || requestedPartitions > 256) {
        throw std::runtime_error("Partition count must be an integer from 1 through 256.");
    }
    const auto executablePartitions = executionSettings.requestedBackend == ExecutionBackend::partitioned ||
        executionSettings.requestedBackend == ExecutionBackend::automatic
        ? std::min(requestedPartitions, executionSettings.workerThreads) : requestedPartitions;
    const auto communicationBias = configuration.get<double>("execution.partitionCommunicationBias", 4);
    const auto partitionAlgorithm = configuration.get<std::string>("execution.partitionAlgorithm", "automatic");
    partitionPlan = createPartitionPlan(dependencyGraph, executablePartitions, communicationBias, partitionAlgorithm);
    partitionPlan.requestedPartitions = requestedPartitions;
    const auto totalCommunicationWeight = std::accumulate(
        dependencyGraph.dependencies.begin(), dependencyGraph.dependencies.end(), std::size_t{0},
        [](std::size_t total, const auto& dependency) { return total + dependency.communicationWeight; });
    maximumPartitionCutFraction = configuration.get<double>("execution.automaticMaximumPartitionCutFraction", 0.25);
    backendDecision = selectExecutionBackend(
        executionSettings.requestedBackend, executionPlan.nodes.size(),
        executionSettings.estimatedOperationsPerSynchronization, executionSettings.automaticParallelThreshold,
        partitionPlan.selected.communicationCutWeight, totalCommunicationWeight, maximumPartitionCutFraction, executionPlan.stateIds.size());
    executionSettings.backend = backendDecision.backend;
#if defined(__EMSCRIPTEN__) && !defined(__EMSCRIPTEN_PTHREADS__)
    // The default web build (docs/proposals/webEdition.md's "web" preset) has no pthread
    // support at all -- TaskExecutor/PartitionRuntime constructing real std::threads there
    // aborts the whole WASM instance rather than throwing a catchable C++ exception. Only the
    // separate "web-threads" preset (-pthread, a different vcpkg triplet) defines
    // __EMSCRIPTEN_PTHREADS__. Same fail-loud-on-explicit/quietly-downgrade-on-automatic
    // convention as the node-provider/partitioned case just below.
    if (executionSettings.backend == ExecutionBackend::threadPool || executionSettings.backend == ExecutionBackend::partitioned) {
        if (executionSettings.requestedBackend != ExecutionBackend::automatic) {
            throw std::runtime_error("The threadPool and partitioned execution backends require the pthread-enabled web build "
                "(see docs/proposals/webEdition.md's \"web-threads\" preset); this build has no thread support.");
        }
        executionSettings.backend = ExecutionBackend::serial;
    }
#endif
    // Computational-node providers work through the partitioned backend "for free" -- it calls
    // the same evaluateContributionTasks() as serial/threadPool -- but are untested there this
    // release (see docs/pluginDevelopment.md). An explicit request fails loudly; an automatic
    // choice quietly downgrades to threadPool, which is fully supported.
    if (executionSettings.backend == ExecutionBackend::partitioned &&
        std::any_of(executionPlan.nodes.begin(), executionPlan.nodes.end(),
            [](const auto& node) { return node.nodeProvider.has_value(); })) {
        if (executionSettings.requestedBackend == ExecutionBackend::partitioned) {
            throw std::runtime_error("Computational-node providers are not yet supported by the partitioned execution backend.");
        }
        executionSettings.backend = ExecutionBackend::threadPool;
    }
    if (executionSettings.backend == ExecutionBackend::serial) executionSettings.workerThreads = 1;
    planningNanoseconds = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now() - planningStartedAt).count());
    const auto partitionReceiveTimeoutMilliseconds = configuration.get<std::size_t>(
        "execution.partitionReceiveTimeoutMilliseconds", 5000);
    if (executionSettings.backend == ExecutionBackend::threadPool) {
        stepExecutor = std::make_unique<ThreadPoolStepExecutor>(executionPlan, executionSettings.workerThreads);
    }
    if (!partitionReceiveTimeoutMilliseconds || partitionReceiveTimeoutMilliseconds > 60000) {
        throw std::runtime_error("execution.partitionReceiveTimeoutMilliseconds must be an integer from 1 through 60000.");
    }
    if (executionSettings.backend == ExecutionBackend::partitioned) {
        stepExecutor = std::make_unique<PartitionedStepExecutor>(executionPlan, partitionPlan, dependencyGraph, partitionReceiveTimeoutMilliseconds);
    }
    if (!stepExecutor) stepExecutor = std::make_unique<SerialStepExecutor>(executionPlan);
    activeWorkerThreads = executionSettings.backend == ExecutionBackend::partitioned
        ? partitionPlan.effectivePartitions : executionSettings.workerThreads;
    states = executionPlan.initialStates;
    for (const auto& node : executionPlan.nodes) {
        nodeSubsteps[node.nodeId] = node.substeps;
    }

    if (const auto checkpoint = configuration.get_child_optional("startCheckpoint")) restoreStartCheckpoint(*checkpoint);
    if (!(startTime >= 0) || !(targetTime > startTime)) throw std::runtime_error("targetTime must be later than the restart checkpoint.");
    checkProgramClocks();
    // A fresh run's programs start at its start: their clocks' first tick, then their values into Update states. A run continued from a
    // checkpoint has both in the checkpoint already (it was taken after the step's ticks and Updates), so nothing is repeated.
    if (!configuration.get_child_optional("startCheckpoint")) {
        startPrograms(startTime);
        if (programUpdatesPresent) stepExecutor->restore(states);
    }
    for (const auto& note : programMemoryNotes) std::cerr << "note: " << note << '\n';

    for (const auto& item : nodeSubsteps) nodeIds.push_back(item.first);
    std::sort(nodeIds.begin(), nodeIds.end());

    // A run (or the rest of one, from a checkpoint) that is a whole number of steps, give or take rounding in
    // targetTime - startTime, takes exactly that many full steps: a resumed run then steps exactly as the run it
    // came from, rather than ending on a step a few ulps short.
    if (!sessionMode) {
        const auto stepsExactly = (targetTime - startTime) / globalTimeStep;
        wholeSteps = std::abs(stepsExactly - std::round(stepsExactly)) <= 1e-9 * std::max(1.0, stepsExactly);
        steps = static_cast<std::size_t>(wholeSteps ? std::round(stepsExactly) : std::ceil(stepsExactly));
    }
    nodeMetrics.resize(executionPlan.nodes.size());
    if (std::any_of(executionPlan.settleGroups.begin(), executionPlan.settleGroups.end(), [](const auto& group) { return group.ring; })) {
        for (const auto& nodeItem : document.get_child("nodes")) {
            const auto nodeName = nodeItem.second.get<std::string>("name", "");
            for (const auto& stateItem : nodeItem.second.get_child("states")) {
                const auto stateId = stateItem.second.get<EntityId>("id", 0);
                const auto symbol = stateItem.second.get<std::string>("symbol", stateItem.second.get<std::string>("name", ""));
                stateLabels[stateId] = nodeName.empty() ? symbol : nodeName + "'s " + symbol;
            }
        }
    }
    // The settling nodes' Updates are settled before anything is recorded or read, so the first sample, the first
    // checkpoint and every node's first step all see consistent values -- after a restart too, where a fork may have
    // changed the parameters they depend on. An Update worked out once per step starts at its initial value.
    updateStates(startTime, false, globalTimeStep);
    partTable = recordedParts(executionPlan);
    samples = {{startTime, states, partsAt(startTime)}};
    checkpoints = {makeCheckpoint(startTime)};
    // A run extended from its last checkpoint ("Extend simulation"): the run it continues, up to that checkpoint, comes first in
    // this run's result, so the result file holds the whole run and not only the part since the restart -- what is exported,
    // saved, forked from and read back is then all of it. The app passes a copy of that run's result file.
    if (const auto continued = configuration.get_optional<std::string>("continuesResult"); continued && !sessionMode) {
        prependContinuedResult(*continued);
    }
    // During-run phase of docs/proposals/numericalStabilityDiagnostics.md -- entirely opt-in
    // (empty monitoredNodeIds, the default, makes observeGlobalStep() a no-op below) via the run
    // configuration's own stabilityMonitoring.nodeIds, not a project/schema concept: this is about
    // how THIS run is executed, not what the model is, matching pacing/providers' own placement.
    if (const auto stabilityMonitoring = configuration.get_child_optional("stabilityMonitoring.nodeIds")) {
        for (const auto& entry : *stabilityMonitoring) stabilityMonitoredNodeIds.insert(entry.second.get_value<EntityId>());
    }
    stabilityMonitor.emplace(executionPlan, stabilityMonitoredNodeIds, globalTimeStep);
    if (eventStream) {
        protocol::EngineEvent event;
        event.set_protocol_version(1);
        auto* table = event.mutable_state_table();
        for (const auto stateId : executionPlan.stateIds) table->add_states()->set_state_id(stateId);
        writeFramedEvent(*eventStream, event);
    }
    currentTime = startTime;
    outputSteps = std::llround(outputInterval / globalTimeStep);
    settledInterventions = runControl.interventions.size();
    if (!sessionMode) {
        appendStreamRecord("sample", startTime, states);
        // This run's own first checkpoint: the last one so far, after any of a continued run's.
        appendStreamRecord("checkpoint", startTime, states, checkpoints.back().uuid);
        return;
    }
    // A session: what it reports, how often it keeps a checkpoint, and which states it may not set.
    if (const auto reported = configuration.get_child_optional("reportedStateIds")) {
        for (const auto& entry : *reported) {
            const auto stateIndex = executionPlan.stateIndexes.find(entry.second.get_value<EntityId>());
            if (stateIndex == executionPlan.stateIndexes.end()) throw std::runtime_error("A reported state is not in the model.");
            reportedIndexes.push_back(stateIndex->second);
        }
    } else {
        for (const auto stateId : executionPlan.stateIds) reportedIndexes.push_back(executionPlan.stateIndexes.at(stateId));
    }
    checkpointInterval = configuration.get<double>("checkpointInterval", outputInterval);
    const auto checkpointRatio = checkpointInterval / globalTimeStep;
    if (!(checkpointInterval > 0) || !std::isfinite(checkpointInterval) || std::abs(checkpointRatio - std::round(checkpointRatio)) > 1e-9) {
        throw std::runtime_error("checkpointInterval must be a whole number of time steps.");
    }
    sessionOrigin = startTime;
    baseTime = startTime;
    sessionCheckpoints.emplace(0, checkpoints.front());
    checkpoints.clear();
    samples.clear();
    for (const auto& node : executionPlan.nodes) {
        for (const auto& task : node.algebraicTasks) algebraicIndexes.insert(node.stateIndexes.at(task.outputStateIndex));
        if (node.nodeProvider) {
            for (const auto& output : node.nodeProvider->outputs) {
                if (output.setsValue) algebraicIndexes.insert(executionPlan.stateIndexes.at(output.stateId));
            }
        }
    }
    for (const auto index : executionPlan.algebraicStateIndexes) algebraicIndexes.insert(index);
}

// Everything of the continued run before this run's start: its samples, its checkpoints (so a fork can be made from any of them)
// and its interventions. Its states are matched by id, so a result from another model is refused rather than misread.
void Simulation::prependContinuedResult(const std::filesystem::path& path) {
    const auto stored = readStoredResult(path);
    const auto& table = stored.header.state_table().states();
    if (static_cast<std::size_t>(table.size()) != states.size()) throw std::runtime_error("The run to continue does not match this model's states.");
    std::vector<std::size_t> planIndex;
    planIndex.reserve(states.size());
    for (const auto& descriptor : table) {
        const auto found = executionPlan.stateIndexes.find(descriptor.state_id());
        if (found == executionPlan.stateIndexes.end()) throw std::runtime_error("The run to continue does not match this model's states.");
        planIndex.push_back(found->second);
    }
    const auto toPlanOrder = [&](const auto& values) {
        Values ordered(states.size());
        for (std::size_t index = 0; index < planIndex.size() && index < static_cast<std::size_t>(values.size()); ++index) ordered[planIndex[index]] = values[static_cast<int>(index)];
        return ordered;
    };
    const auto before = [&](double time) { return time < startTime - 1e-12; };
    // Its recorded parts, matched to this run's by what each is: a part it did not record (it was written before parts were,
    // or the part is new) is NaN, unknown, rather than worked out again with parameters that may not be the ones it ran with.
    std::vector<std::size_t> storedPart(partTable.size(), std::numeric_limits<std::size_t>::max());
    const auto& storedParts = stored.header.part_table().parts();
    for (std::size_t part = 0; part < partTable.size(); ++part) {
        for (int candidate = 0; candidate < storedParts.size(); ++candidate) {
            const auto& descriptor = storedParts[candidate];
            if (descriptor.source_id() == partTable[part].sourceId && descriptor.state_id() == partTable[part].stateId && descriptor.negated() == partTable[part].negated) {
                storedPart[part] = static_cast<std::size_t>(candidate);
                break;
            }
        }
    }
    std::vector<Sample> earlierSamples;
    for (std::size_t index = 0; index < stored.times.size(); ++index) {
        if (!before(stored.times[index])) continue;
        Values ordered(states.size());
        for (std::size_t state = 0; state < planIndex.size() && state < stored.values[index].size(); ++state) ordered[planIndex[state]] = stored.values[index][state];
        Values parts(partTable.size(), std::numeric_limits<double>::quiet_NaN());
        const auto& storedRow = stored.parts[index];
        for (std::size_t part = 0; part < partTable.size(); ++part) {
            if (storedPart[part] < storedRow.size()) parts[part] = storedRow[storedPart[part]];
        }
        earlierSamples.push_back({stored.times[index], std::move(ordered), std::move(parts)});
    }
    std::vector<Checkpoint> earlierCheckpoints;
    for (const auto& checkpoint : stored.header.checkpoints()) {
        if (!before(checkpoint.time())) continue;
        ProviderCheckpointStates providerStates;
        for (const auto& providerState : checkpoint.provider_states()) {
            const auto& payload = providerState.payload();
            std::vector<std::byte> bytes(payload.size());
            std::transform(payload.begin(), payload.end(), bytes.begin(), [](char byte) { return static_cast<std::byte>(byte); });
            providerStates.emplace_back(providerState.node_id(), std::move(bytes));
        }
        Checkpoint earlier;
        earlier.uuid = checkpoint.uuid();
        earlier.time = checkpoint.time();
        earlier.states = toPlanOrder(checkpoint.values());
        earlier.providerStates = std::move(providerStates);
        earlier.solverKind = checkpoint.solver_kind();
        earlier.solverState = checkpoint.solver_state();
        for (const auto& memory : checkpoint.program_memory()) earlier.programMemory.push_back(decodeProgramMemory(memory));
        earlierCheckpoints.push_back(std::move(earlier));
    }
    for (const auto& intervention : stored.header.interventions()) {
        if (before(intervention.applied_time())) continuedInterventions.push_back(intervention);
    }
    samples.insert(samples.begin(), std::make_move_iterator(earlierSamples.begin()), std::make_move_iterator(earlierSamples.end()));
    checkpoints.insert(checkpoints.begin(), std::make_move_iterator(earlierCheckpoints.begin()), std::make_move_iterator(earlierCheckpoints.end()));
}

void Simulation::restoreStartCheckpoint(const boost::property_tree::ptree& checkpoint) {
    startTime = checkpoint.get<double>("time");
    std::set<EntityId> restored;
    for (const auto& stateItem : checkpoint.get_child("states")) {
        const auto stateId = entityIdValue(stateItem.second, "stateId");
        const auto stateIndex = executionPlan.stateIndexes.find(stateId);
        if (stateIndex == executionPlan.stateIndexes.end() || !restored.insert(stateId).second) {
            throw std::runtime_error("The restart checkpoint does not match the model state vector.");
        }
        states[stateIndex->second] = stateItem.second.get<double>("value");
    }
    if (restored.size() != states.size()) throw std::runtime_error("The restart checkpoint is missing model states.");
    // The controller's memory, when the checkpoint was made by the method this run uses (its solver_state, as base64): a run continued
    // from it takes the steps the uninterrupted run took. Made by another method, or with none, the controller starts afresh.
    if (checkpoint.get<std::string>("solver.kind", "") == solverKindName(integration.method)) {
        resetSolverState(decodeBase64Text(checkpoint.get<std::string>("solver.state", "")));
    }

    // Opaque provider-owned state (e.g. a controller's integral term) has no analog in the
    // ordinary numeric state vector restored above, so it must be restored explicitly and
    // exhaustively: a missing entry fails loudly here rather than silently resetting a
    // provider instance to its initialize()-time default.
    const auto providerNodeCount = std::count_if(executionPlan.nodes.begin(), executionPlan.nodes.end(),
        [](const auto& node) { return node.nodeProvider.has_value() && node.nodeProvider->programVersion != 2; });
    if (providerNodeCount) {
        const auto providerStatesNode = checkpoint.get_child_optional("providerStates");
        if (!providerStatesNode) {
            throw std::runtime_error("The restart checkpoint is missing computational-node provider state.");
        }
        std::set<EntityId> restoredNodes;
        for (const auto& entry : *providerStatesNode) {
            const auto nodeId = entityIdValue(entry.second, "nodeId");
            const auto nodeIt = std::find_if(executionPlan.nodes.begin(), executionPlan.nodes.end(),
                [&](const auto& node) { return node.nodeId == nodeId; });
            if (nodeIt == executionPlan.nodes.end() || !nodeIt->nodeProvider || nodeIt->nodeProvider->programVersion == 2 || !restoredNodes.insert(nodeId).second) {
                throw std::runtime_error("The restart checkpoint references an unknown computational-node provider.");
            }
            providerRuntime->requestNodeRestore(*nodeIt->nodeProvider,
                decodeBase64Bytes(entry.second.get<std::string>("payload", "")));
        }
        if (static_cast<std::size_t>(providerNodeCount) != restoredNodes.size()) {
            throw std::runtime_error("The restart checkpoint is missing computational-node provider state.");
        }
    }
    // Version 2 programs' memory, by field name; a checkpoint from before a program had memory leaves it at its declared start.
    if (const auto memory = checkpoint.get_child_optional("programMemory"); memory && providerRuntime) {
        providerRuntime->restoreProgramMemory(programMemoryFromJson(*memory), &programMemoryNotes);
    }
    stepExecutor->restore(states);
}

ProviderCheckpointStates Simulation::captureProviderStates() {
    ProviderCheckpointStates result;
    if (!providerRuntime) return result;
    for (const auto& node : executionPlan.nodes) {
        if (node.nodeProvider && node.nodeProvider->programVersion != 2) result.emplace_back(node.nodeId, providerRuntime->requestNodeCheckpoint(*node.nodeProvider));
    }
    return result;
}

void Simulation::flushSampleEvents() {
    if (!eventStream || pendingEventSamples.empty()) return;
    const auto& stateIds = executionPlan.stateIds;
    protocol::EngineEvent event;
    event.set_protocol_version(1);
    auto* batch = event.mutable_sample_batch();
    batch->set_state_count(static_cast<std::uint32_t>(stateIds.size()));
    constexpr std::size_t maximumLiveBatchSamples = 256;
    const auto transmittedSamples = std::min(pendingEventSamples.size(), maximumLiveBatchSamples);
    for (std::size_t outputIndex = 0; outputIndex < transmittedSamples; ++outputIndex) {
        const auto sampleIndex = transmittedSamples == 1 ? std::size_t{0} : static_cast<std::size_t>(std::llround(
            static_cast<double>(outputIndex) * static_cast<double>(pendingEventSamples.size() - 1) /
            static_cast<double>(transmittedSamples - 1)));
        const auto& sample = pendingEventSamples[sampleIndex];
        batch->add_times(sample.time);
        for (const auto stateId : stateIds) {
            batch->add_values(sample.states.at(executionPlan.stateIndexes.at(stateId)));
        }
    }
    writeFramedEvent(*eventStream, event);
    pendingEventSamples.clear();
}

void Simulation::appendStreamRecord(const std::string& type, double time, const Values& recordStates, const std::string& uuid) {
    if (eventStream && type == "sample") {
        pendingEventSamples.push_back({time, recordStates, {}});
    }
    static_cast<void>(uuid);
}

void Simulation::captureBoundary() {
    if (currentTime > samples.back().time + 1e-12) {
        samples.push_back({currentTime, states, partsAt(currentTime)});
        appendStreamRecord("sample", currentTime, states);
    }
    if (currentTime > checkpoints.back().time + 1e-12) {
        checkpoints.push_back(makeCheckpoint(currentTime));
        appendStreamRecord("checkpoint", currentTime, states, checkpoints.back().uuid);
    }
}

void Simulation::writeResult(const std::string& lifecycle, double simulationTime, bool completeSnapshot) {
    flushSampleEvents();
    const auto& stateIds = executionPlan.stateIds;
    const auto& stateNodes = executionPlan.stateNodes;
    const auto communication = stepExecutor->communication();
    std::ostringstream json;
    json << std::setprecision(17) << "{\"resultVersion\":2,\"engineVersion\":\"0.2.0\",\"configurationName\":\""
         << escape(configuration.get<std::string>("name", "Untitled")) << "\",\"snapshotMode\":\"" << (completeSnapshot ? "full" : "live")
         << "\",\"lifecycle\":\"" << lifecycle
         << "\",\"simulationTime\":" << simulationTime << ",\"availableResultTime\":" << samples.back().time
         << ",\"pacing\":{\"mode\":\"" << pacingModeName(pacing.mode) << "\",\"simulationSecondsPerWallSecond\":" << pacing.ratio << "}"
         << ",\"targetTime\":" << targetTime << ",\"globalTimeStep\":" << globalTimeStep << ",\"outputInterval\":" << outputInterval;
    // A whole-model method, with its settings, the nodes it stepped on their own and the programs it held (docs/proposals/
    // integrators.md): written only when the run used one, so a node-by-node result says what it always said.
    if (integration.method != IntegrationMethod::nodeByNode) {
        json << ",\"integration\":{\"method\":\"" << integrationMethodName(integration.method) << '"';
        if (!hasTolerance(integration.method) || integration.stepsPerGlobalStep) {
            json << ",\"stepsPerGlobalStep\":" << integration.stepsPerGlobalStep;
        }
        // Dormand–Prince: its tolerances (under error control) and the work it did -- the steps it took and rejected, its evaluations
        // of the model, its smallest and largest step -- and when its stiffness test first fired.
        if (isExplicitPair(integration.method)) {
            if (isAdaptive(integration)) {
                json << ",\"tolerance\":{\"relative\":" << integration.relativeTolerance << ",\"absolute\":"
                     << integration.absoluteTolerance << '}';
            }
            json << ",\"steps\":" << adaptiveStatistics.acceptedSteps << ",\"rejectedSteps\":" << adaptiveStatistics.rejectedSteps
                 << ",\"evaluations\":" << adaptiveStatistics.evaluations;
            if (adaptiveStatistics.acceptedSteps) {
                json << ",\"smallestStep\":" << adaptiveStatistics.smallestStep << ",\"largestStep\":"
                     << adaptiveStatistics.largestStep;
            }
            if (!std::isnan(adaptiveStiffness.detectedAt)) json << ",\"stiffnessDetectedAt\":" << adaptiveStiffness.detectedAt;
        }
        // Rodas4 and Rodas5P: the same, and their linear algebra -- the Jacobians worked out and the evaluations each took (one per
        // colour), the factorisations, the size of the system, whether it was solved sparsely, and how often the sparse LU fell back to
        // the dense.
        if (isRosenbrock(integration.method)) {
            if (isStiff(integration)) {
                json << ",\"tolerance\":{\"relative\":" << integration.relativeTolerance << ",\"absolute\":"
                     << integration.absoluteTolerance << '}';
            }
            json << ",\"steps\":" << stiffStatistics.acceptedSteps << ",\"rejectedSteps\":" << stiffStatistics.rejectedSteps
                 << ",\"evaluations\":" << stiffStatistics.evaluations;
            if (stiffStatistics.acceptedSteps) {
                json << ",\"smallestStep\":" << stiffStatistics.smallestStep << ",\"largestStep\":" << stiffStatistics.largestStep;
            }
            writeJacobianSummary(json);
            json << ",\"jacobians\":" << stiffStatistics.jacobians << ",\"jacobianColours\":" << (stiffSystem ? stiffSystem->colours : 0)
                 << ",\"factorisations\":" << stiffStatistics.factorisations << ",\"linearSystemSize\":"
                 << (stiffSystem ? stiffSystem->integratedStates.size() : 0) << ",\"sparse\":" << (stiffSystem && stiffSystem->sparse ? "true" : "false");
            if (stiffStatistics.denseFallbacks) json << ",\"denseFallbacks\":" << stiffStatistics.denseFallbacks;
        }
        // BDF: the same, its Newton iterations, the highest order it reached and how often its table started again at order 1.
        if (integration.method == IntegrationMethod::bdf) {
            json << ",\"tolerance\":{\"relative\":" << integration.relativeTolerance << ",\"absolute\":" << integration.absoluteTolerance << '}'
                 << ",\"steps\":" << bdfStatistics.acceptedSteps << ",\"rejectedSteps\":" << bdfStatistics.rejectedSteps
                 << ",\"evaluations\":" << bdfStatistics.evaluations;
            if (bdfStatistics.acceptedSteps) {
                json << ",\"smallestStep\":" << bdfStatistics.smallestStep << ",\"largestStep\":" << bdfStatistics.largestStep;
            }
            writeJacobianSummary(json);
            json << ",\"jacobians\":" << bdfStatistics.jacobians << ",\"jacobianColours\":" << (stiffSystem ? stiffSystem->colours : 0)
                 << ",\"factorisations\":" << bdfStatistics.factorisations << ",\"newtonIterations\":" << bdfStatistics.newtonIterations
                 << ",\"highestOrder\":" << bdfStatistics.highestOrder << ",\"restarts\":" << bdfStatistics.restarts
                 << ",\"linearSystemSize\":" << (stiffSystem ? stiffSystem->integratedStates.size() : 0)
                 << ",\"sparse\":" << (stiffSystem && stiffSystem->sparse ? "true" : "false");
            if (bdfStatistics.denseFallbacks) json << ",\"denseFallbacks\":" << bdfStatistics.denseFallbacks;
        }
        json << ",\"steppedNodeIds\":[";
        for (std::size_t index = 0; index < wholeModel.steppedNodes.size(); ++index) {
            json << (index ? "," : "") << executionPlan.nodes[wholeModel.steppedNodes[index]].nodeId;
        }
        json << "],\"heldTerms\":[";
        for (std::size_t index = 0; index < wholeModel.heldTerms.size(); ++index) {
            json << (index ? "," : "") << "{\"sourceId\":" << wholeModel.heldTerms[index].sourceId << ",\"stateId\":"
                 << wholeModel.heldTerms[index].stateId << '}';
        }
        json << ']';
        // Event location: how many switching conditions were watched, how many instants located, and the first thousand events, each
        // the term whose condition changed and whether the condition holds after it. Only for a model with switching conditions.
        if (switching) {
            json << ",\"switchingConditions\":" << eventPlan.functions.size() << ",\"events\":" << eventInstants << ",\"eventList\":[";
            for (std::size_t index = 0; index < eventList.size(); ++index) {
                const auto& [time, condition] = eventList[index];
                const auto& function = eventPlan.functions[condition];
                json << (index ? "," : "") << "{\"time\":" << time << ",\"sourceId\":" << function.sourceId << ",\"stateId\":" << function.stateId << '}';
            }
            json << ']';
        }
        json << '}';
    } else if (!unlocated.empty()) {
        // Euler, node by node, does not locate switching conditions: the terms whose conditions it read at each substep instead.
        json << ",\"unlocatedConditions\":[";
        for (std::size_t index = 0; index < unlocated.size(); ++index) {
            json << (index ? "," : "") << "{\"sourceId\":" << unlocated[index].first << ",\"stateId\":" << unlocated[index].second << '}';
        }
        json << ']';
    }
    // The older program format's hazards that change no number (docs/proposals/programSdkV2.md, decision 8): written only
    // when there are some, so a result without them says what it always said. Ids only; the app names them.
    if (providerRuntime && !providerRuntime->warnings().empty()) {
        json << ",\"programWarnings\":[";
        const auto& warnings = providerRuntime->warnings();
        for (std::size_t index = 0; index < warnings.size(); ++index) {
            const auto& warning = warnings[index];
            json << (index ? "," : "") << "{\"code\":\"" << warning.code << "\",\"language\":\""
                 << (warning.implementation == ContributionImplementation::cppProvider ? "cpp" : "python") << "\",\"entityIds\":[";
            for (std::size_t entity = 0; entity < warning.entityIds.size(); ++entity) json << (entity ? "," : "") << warning.entityIds[entity];
            json << "]";
            if (!warning.port.empty()) json << ",\"port\":\"" << escape(warning.port) << '"';
            json << '}';
        }
        json << ']';
    }
    json
         << ",\"execution\":{\"planVersion\":1,\"requestedBackend\":\"" << executionBackendName(executionSettings.requestedBackend)
         << "\",\"backend\":\"" << executionBackendName(executionSettings.backend)
         << "\",\"workerThreads\":" << activeWorkerThreads << ",\"planningNanoseconds\":" << planningNanoseconds
         << ",\"estimatedOperationsPerSynchronization\":" << executionSettings.estimatedOperationsPerSynchronization
         << ",\"automaticParallelThreshold\":" << executionSettings.automaticParallelThreshold
         << ",\"selectionReason\":\"" << backendSelectionReasonName(backendDecision.reason) << "\",\"communicationCutFraction\":"
         << backendDecision.communicationCutFraction << ",\"automaticMaximumPartitionCutFraction\":"
         << maximumPartitionCutFraction
         << ",\"schedulingPolicy\":\"" << (executionSettings.backend == ExecutionBackend::partitioned
             ? "partitionAffinity" : "largestEstimatedWorkFirst")
         << "\",\"synchronizationComputeNanoseconds\":"
         << synchronizationComputeNanoseconds << ",\"partitionCommunication\":{\"messageVersion\":1,\"transport\":\"inMemory\""
         << ",\"boundaryMessages\":" << communication.boundaryMessages << ",\"boundaryPayloadBytes\":"
         << communication.boundaryPayloadBytes << ",\"messagePreparationNanoseconds\":"
         << communication.messagePreparationNanoseconds << ",\"serializationNanoseconds\":0,\"transportPublishNanoseconds\":"
         << communication.transportPublishNanoseconds << ",\"boundaryWaitNanoseconds\":"
         << communication.boundaryWaitNanoseconds << "},\"nodeMetrics\":[";
    for (std::size_t index = 0; index < executionPlan.nodes.size(); ++index) {
        if (index) json << ',';
        const auto& node = executionPlan.nodes[index];
        const auto& metrics = nodeMetrics[index];
        json << "{\"nodeId\":" << node.nodeId << ",\"estimatedOperationsPerSubstep\":"
             << node.estimatedOperationsPerSubstep << ",\"invocations\":" << metrics.invocations
             << ",\"executedSubsteps\":" << metrics.executedSubsteps << ",\"evaluatedContributions\":"
             << metrics.evaluatedContributions << ",\"computeNanoseconds\":" << metrics.computeNanoseconds << '}';
    }
    json << "]},\"dependencyGraph\":{\"version\":" << dependencyGraph.version << ",\"componentCount\":"
         << dependencyGraph.componentCount << ",\"nodes\":[";
    for (std::size_t index = 0; index < dependencyGraph.nodes.size(); ++index) {
        if (index) json << ',';
        const auto& node = dependencyGraph.nodes[index];
        json << "{\"nodeId\":" << node.nodeId << ",\"stateCount\":" << node.stateCount
             << ",\"substeps\":" << node.substeps << ",\"estimatedOperationsPerSynchronization\":"
             << node.estimatedOperationsPerSynchronization << ",\"component\":" << node.component << '}';
    }
    json << "],\"dependencies\":[";
    for (std::size_t index = 0; index < dependencyGraph.dependencies.size(); ++index) {
        if (index) json << ',';
        const auto& dependency = dependencyGraph.dependencies[index];
        json << "{\"sourceNodeId\":" << dependency.sourceNodeId << ",\"targetNodeId\":"
             << dependency.targetNodeId << ",\"remoteStateIds\":[";
        for (std::size_t stateIndex = 0; stateIndex < dependency.remoteStateIds.size(); ++stateIndex) {
            if (stateIndex) json << ',';
            json << dependency.remoteStateIds[stateIndex];
        }
        json << "],\"contributionTaskCount\":" << dependency.contributionTaskCount << ",\"remoteBindingsPerSubstep\":"
             << dependency.remoteBindingsPerSubstep << ",\"estimatedDependentOperationsPerSynchronization\":"
             << dependency.estimatedDependentOperationsPerSynchronization << ",\"communicationWeight\":"
             << dependency.communicationWeight << '}';
    }
    json << "]},\"partitionPlan\":{\"version\":" << partitionPlan.version << ",\"algorithm\":\""
         << partitionPlan.algorithm << "\",\"algorithmVersion\":\"" << partitionPlan.algorithmVersion
         << "\",\"requestedAlgorithm\":\"" << partitionPlan.requestedAlgorithm
         << "\",\"fallbackReason\":\"" << escape(partitionPlan.fallbackReason)
         << "\",\"metisAvailable\":" << (metisPartitionerAvailable() ? "true" : "false")
         << ",\"requestedPartitions\":" << partitionPlan.requestedPartitions
         << ",\"effectivePartitions\":" << partitionPlan.effectivePartitions << ",\"communicationBias\":"
         << partitionPlan.communicationBias << ",\"assignments\":[";
    for (std::size_t index = 0; index < partitionPlan.assignments.size(); ++index) {
        if (index) json << ',';
        json << "{\"nodeId\":" << partitionPlan.assignments[index].nodeId << ",\"partition\":"
             << partitionPlan.assignments[index].partition << '}';
    }
    json << "],\"partitions\":[";
    for (std::size_t index = 0; index < partitionPlan.partitions.size(); ++index) {
        if (index) json << ',';
        const auto& partition = partitionPlan.partitions[index];
        json << "{\"partition\":" << partition.partition << ",\"nodeCount\":" << partition.nodeCount
             << ",\"computeWeight\":" << partition.computeWeight << ",\"localStateCount\":"
             << partition.localStateCount << ",\"boundaryStateCount\":" << partition.boundaryStateCount << '}';
    }
    const auto appendComparison = [&json](const PartitionComparison& comparison) {
        json << "{\"communicationCutWeight\":" << comparison.communicationCutWeight
             << ",\"cutDependencyCount\":" << comparison.cutDependencyCount
             << ",\"computeImbalance\":" << comparison.computeImbalance << '}';
    };
    json << "],\"selected\":";
    appendComparison(partitionPlan.selected);
    json << ",\"greedy\":";
    appendComparison(partitionPlan.greedy);
    json << ",\"roundRobin\":";
    appendComparison(partitionPlan.roundRobin);
    json << '}'
         << ",\"globalSteps\":" << steps << ",\"nodeTimesteps\":[";
    for (std::size_t index = 0; index < nodeIds.size(); ++index) {
        if (index) json << ',';
        const auto& nodeId = nodeIds[index];
        json << "{\"nodeId\":" << nodeId << ",\"substepsPerGlobalStep\":" << nodeSubsteps.at(nodeId)
             << ",\"effectiveTimeStep\":" << globalTimeStep / static_cast<double>(nodeSubsteps.at(nodeId)) << '}';
    }
    json << "],\"states\":[";
    for (std::size_t index = 0; index < stateIds.size(); ++index) {
        if (index) json << ',';
        const auto& stateId = stateIds[index];
        json << "{\"nodeId\":" << stateNodes.at(stateId) << ",\"stateId\":" << stateId
             << ",\"value\":" << states.at(executionPlan.stateIndexes.at(stateId)) << '}';
    }
    json << "]}";
    protocol::ResultFile result;
    result.set_result_version(2);
    result.set_metadata_json(json.str());
    for (const auto& intervention : continuedInterventions) *result.add_interventions() = intervention;
    for (const auto& [appliedTime, command] : runControl.interventions) {
        auto* intervention = result.add_interventions();
        intervention->set_applied_time(appliedTime);
        if (command.has_set_parameter_value()) *intervention->mutable_set_value() = command.set_parameter_value();
        else *intervention->mutable_schedule() = command.schedule_parameter_value();
    }
    for (const auto stateId : stateIds) result.mutable_state_table()->add_states()->set_state_id(stateId);
    for (const auto& part : partTable) {
        auto* descriptor = result.mutable_part_table()->add_parts();
        descriptor->set_source_id(part.sourceId);
        descriptor->set_state_id(part.stateId);
        if (part.negated) descriptor->set_negated(true);
    }
    // During-run phase of docs/proposals/numericalStabilityDiagnostics.md -- a real protobuf
    // field on ResultFile, not a JSON string: doubles (globalTime, and any future numeric
    // finding data) natively represent Infinity/NaN in protobuf, the same reason the one-shot
    // report messages moved off hand-written JSON (see engineProtocol.proto's own comment on
    // ValidationIssueReport and friends) -- a diverging amplification factor should never be
    // able to produce output a JSON parser rejects outright.
    for (const auto& finding : stabilityFindings) {
        auto* report = result.add_stability_findings();
        report->set_node_id(finding.nodeId);
        report->set_state_id(finding.stateId);
        report->set_code(finding.code);
        report->set_message(finding.message);
        report->set_global_time(finding.globalTime);
    }
    if (completeSnapshot) {
        for (const auto& checkpoint : checkpoints) {
            auto* encoded = result.add_checkpoints();
            encoded->set_uuid(checkpoint.uuid);
            encoded->set_time(checkpoint.time);
            // The method that made it, and its hidden state: none for Euler and Runge–Kutta 4, the controller's memory for Adaptive,
            // so a run continued from it with the same method continues to the bit. A continued run's earlier checkpoints keep theirs.
            encoded->set_solver_kind(checkpoint.solverKind.empty() ? std::string(solverKindName(integration.method)) : checkpoint.solverKind);
            encoded->set_solver_version(1);
            if (!checkpoint.solverState.empty()) encoded->set_solver_state(checkpoint.solverState);
            for (const auto stateId : stateIds) {
                encoded->add_values(checkpoint.states.at(executionPlan.stateIndexes.at(stateId)));
            }
            for (const auto& [nodeId, payload] : checkpoint.providerStates) {
                auto* providerState = encoded->add_provider_states();
                providerState->set_node_id(nodeId);
                providerState->set_payload(std::string(reinterpret_cast<const char*>(payload.data()), payload.size()));
            }
            for (const auto& memory : checkpoint.programMemory) encodeProgramMemory(memory, *encoded->add_program_memory());
        }
    }
    const auto appendLength = [](std::string& target, std::size_t size) {
        if (size > 0xffffffffu) throw std::runtime_error("A binary result section is too large to serialize.");
        const auto length = static_cast<std::uint32_t>(size);
        target.push_back(static_cast<char>((length >> 24) & 0xff));
        target.push_back(static_cast<char>((length >> 16) & 0xff));
        target.push_back(static_cast<char>((length >> 8) & 0xff));
        target.push_back(static_cast<char>(length & 0xff));
    };
    std::string header;
    if (!result.SerializeToString(&header)) throw std::runtime_error("The binary result header could not be serialized.");
    std::string container("KJR\x02", 4);
    appendLength(container, header.size());
    container += header;
    protocol::ResultIndex index;
    index.set_result_version(2);
    index.set_sample_count(completeSnapshot ? samples.size() : 0);
    constexpr std::size_t samplesPerResultBatch = 4096;
    if (completeSnapshot) {
        for (std::size_t start = 0; start < samples.size(); start += samplesPerResultBatch) {
            const auto end = std::min(samples.size(), start + samplesPerResultBatch);
            protocol::SampleBatch batch;
            batch.set_state_count(static_cast<std::uint32_t>(stateIds.size()));
            for (std::size_t sampleIndex = start; sampleIndex < end; ++sampleIndex) {
                const auto& sample = samples[sampleIndex];
                batch.add_times(sample.time);
                for (const auto stateId : stateIds) {
                    batch.add_values(sample.states.at(executionPlan.stateIndexes.at(stateId)));
                }
            }
            // Each sample's recorded parts, NaN where a sample has none (one recorded before a parameter was settled, say).
            if (!partTable.empty()) {
                batch.set_part_count(static_cast<std::uint32_t>(partTable.size()));
                for (std::size_t sampleIndex = start; sampleIndex < end; ++sampleIndex) {
                    const auto& parts = samples[sampleIndex].parts;
                    for (std::size_t part = 0; part < partTable.size(); ++part) {
                        batch.add_part_values(parts.size() == partTable.size() ? parts[part] : std::numeric_limits<double>::quiet_NaN());
                    }
                }
            }
            std::string payload;
            if (!batch.SerializeToString(&payload)) throw std::runtime_error("A result sample batch could not be serialized.");
            auto* entry = index.add_batches();
            entry->set_start_time(samples[start].time);
            entry->set_end_time(samples[end - 1].time);
            entry->set_offset(container.size());
            entry->set_length(static_cast<std::uint32_t>(payload.size()));
            entry->set_sample_count(static_cast<std::uint32_t>(end - start));
            appendLength(container, payload.size());
            container += payload;
        }
    }
    std::string indexPayload;
    if (!index.SerializeToString(&indexPayload)) throw std::runtime_error("The binary result index could not be serialized.");
    container += indexPayload;
    appendLength(container, indexPayload.size());
    container += "KJIX";
    atomicWrite(outputPath, container);
}

void Simulation::refreshRunControl(bool force) {
    const auto now = std::chrono::steady_clock::now();
    if (force || now - lastControlReadAt >= std::chrono::milliseconds(10)) {
#ifdef __EMSCRIPTEN__
        pollEmscriptenControlBytes(*controlInbox, emscriptenControlBuffer);
#endif
        runControl = drainRunControl(controlInbox, std::move(runControl), currentTime);
        lastControlReadAt = now;
    } else {
        // A held command is carried out at its own step, however long since the inbox was last read.
        applyDueHeldCommands(runControl, currentTime);
    }
}

// A parameter changed since the algebraic states were last set (a fork's changes, made while it was held before
// its first step; a slider moved during the run): they are set again from the new values before the step reads
// them, so the step starts from states that agree with its parameters, as a run started with those values would,
// rather than from states set with the old values a step before. At a time already recorded (the fork point),
// the sample and the checkpoint there show them too.
void Simulation::settleIfParametersChanged() {
    if (runControl.interventions.size() == settledInterventions) return;
    settledInterventions = runControl.interventions.size();
    updateStates(currentTime, false, globalTimeStep);
    if (!samples.empty() && samples.back().time == currentTime) {
        samples.back().states = states;
        samples.back().parts = partsAt(currentTime);
    }
    if (!checkpoints.empty() && checkpoints.back().time == currentTime) checkpoints.back().states = states;
}

// One global step: every node integrated from the step's starting snapshot by the execution backend, the results gathered into
// the state vector, then the algebraic relationships set at the step's end and the stability monitor told. `elapsed` is the
// time the step ends at, worked out by the caller from the step count rather than by adding steps up.
void Simulation::checkProgramClocks() {
    if (!providerRuntime) return;
    programUpdatesPresent = planHasProgramUpdates(executionPlan);
    if (integration.method != IntegrationMethod::nodeByNode) {
        stageNodeMask.assign(executionPlan.nodes.size(), 0);
        for (std::size_t index = 0; index < executionPlan.nodes.size(); ++index) {
            const auto& node = executionPlan.nodes[index];
            if (wholeModel.nodes[index].stepped || !node.hasVersion2Programs) continue;
            stageNodeMask[index] = 1;
            for (const auto* tasks : {&node.contributions, &node.algebraicTasks, &node.valueTerms}) {
                for (const auto& task : *tasks) if (task.programVersion == 2 && providerRuntime->programAdvancesEachStep(task.sourceId)) programsAdvanceAtSteps = true;
            }
            if (node.nodeProvider && node.nodeProvider->programVersion == 2 && providerRuntime->programAdvancesEachStep(node.nodeId)) programsAdvanceAtSteps = true;
        }
    }
    for (const auto& [owner, period] : providerRuntime->programClocks()) {
        programClocksPresent = true;
        const double ratio = period / globalTimeStep;
        const double whole = std::round(ratio);
        if (whole >= 1 && std::abs(ratio - whole) <= 1e-9 * whole) continue;
        const double below = std::max(1.0, std::floor(ratio)) * globalTimeStep;
        const double above = std::max(1.0, std::ceil(ratio)) * globalTimeStep;
        std::ostringstream message;
        message << std::setprecision(10) << "The clock of " << providerRuntime->programName(owner) << " ticks every " << period
                << " s, which is not a whole number of the run's time steps (" << globalTimeStep << " s). Use a period of " << below << " s";
        if (above != below) message << " or " << above << " s";
        message << " in the program, or a time step that divides " << period << " s.";
        throw std::runtime_error(message.str());
    }
}

void Simulation::startPrograms(double time) {
    if (!providerRuntime) return;
    if (programClocksPresent) {
        advancePlanPrograms(executionPlan, states, runControl.parameterValues, runControl.activeSchedules, time, 0, true, providerRuntime.get());
    }
    if (programUpdatesPresent) {
        const auto read = states;
        applyProgramUpdates(executionPlan, read, states, runControl.parameterValues, runControl.activeSchedules, time, providerRuntime.get());
    }
}

// The end of a global step: the clocks that tick at it, then the update phase, version 2 programs' values into Update states read from
// the states as the update phase reads them (Rate states at the step's end, Update states at its start).
void Simulation::afterGlobalStep(double time, double stepSize) {
    if (programClocksPresent) {
        const auto before = integration.method == IntegrationMethod::bdf ? providerRuntime->programMemory() : std::vector<ProgramMemoryState>{};
        advancePlanPrograms(executionPlan, states, runControl.parameterValues, runControl.activeSchedules, time, 0, true, providerRuntime.get());
        if (integration.method == IntegrationMethod::bdf) {
            const auto after = providerRuntime->programMemory();
            for (std::size_t index = 0; index < before.size() && index < after.size(); ++index) {
                for (std::size_t field = 0; field < before[index].fields.size(); ++field) {
                    if (before[index].fields[field].words != after[index].fields[field].words) programMemoryTicked = true;
                }
            }
        }
    }
    if (!programUpdatesPresent) {
        updateStates(time, true, stepSize);
        return;
    }
    const auto read = states;
    updateStates(time, true, stepSize);
    applyProgramUpdates(executionPlan, read, states, runControl.parameterValues, runControl.activeSchedules, time, providerRuntime.get());
}

void Simulation::integrateStep(std::size_t step, double synchronizationStep, double elapsed) {
    if (integration.method != IntegrationMethod::nodeByNode) {
        integrateWholeModelStep(synchronizationStep, elapsed);
        return;
    }
    const auto synchronizationStartedAt = std::chrono::steady_clock::now();
    const auto snapshot = states;
    auto synchronizedStates = snapshot;
    const auto nodeResults = stepExecutor->integrate(snapshot, runControl, currentTime, synchronizationStep, elapsed, step, providerRuntime.get());
    for (std::size_t index = 0; index < executionPlan.nodes.size(); ++index) {
        const auto& node = executionPlan.nodes[index];
        const auto& result = nodeResults[index];
        for (std::size_t stateIndex = 0; stateIndex < node.stateIndexes.size(); ++stateIndex) {
            synchronizedStates[node.stateIndexes[stateIndex]] = result.states.at(stateIndex);
        }
        auto& metrics = nodeMetrics[index];
        ++metrics.invocations;
        metrics.executedSubsteps += node.substeps;
        metrics.evaluatedContributions += node.substeps * (node.contributions.size() + node.algebraicTasks.size());
        // A Verlet node reads its first part's equations once more a global step: at the start of its first substep.
        if (node.verlet) metrics.evaluatedContributions += static_cast<std::uint64_t>(std::count_if(node.contributions.begin(), node.contributions.end(),
            [&](const auto& task) { return task.implementation == ContributionImplementation::equation && node.verletKicked[task.outputStateIndex]; }));
        metrics.computeNanoseconds += result.computeNanoseconds;
    }
    const auto synchronizationElapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now() - synchronizationStartedAt).count();
    synchronizationComputeNanoseconds += static_cast<std::uint64_t>(std::max<std::int64_t>(0, synchronizationElapsed));
    states = std::move(synchronizedStates);
    currentTime = elapsed;
    // The states algebraic relationships set, from the states the step reached, at its end: every
    // node reads them from the next step's synchronization snapshot.
    afterGlobalStep(currentTime, synchronizationStep);
    if (!stabilityMonitoredNodeIds.empty()) {
        auto newFindings = stabilityMonitor->observeGlobalStep(states, currentTime);
        stabilityFindings.insert(stabilityFindings.end(),
            std::make_move_iterator(newFindings.begin()), std::make_move_iterator(newFindings.end()));
    }
}

// One global step of a whole-model method (docs/proposals/integrators.md): the stepped nodes integrated node by node from the
// step's start; every other node's integrated states taken through the method's stages, every stage evaluated by the execution
// backend from one immutable vector of stage values; every other state held. Then, as node by node, the Updates set at the step's
// end and the stability monitor told: the global step stays the instant at which Updates, controls, samples and checkpoints happen.
void Simulation::integrateWholeModelStep(double synchronizationStep, double elapsed) {
    const auto synchronizationStartedAt = std::chrono::steady_clock::now();
    const auto snapshot = states;
    std::vector<NodeIntegrationResult> stepped;
    stepped.reserve(wholeModel.steppedNodes.size());
    for (const auto index : wholeModel.steppedNodes) {
        stepped.push_back(integrateNode(executionPlan.nodes[index], snapshot, runControl.parameterValues, currentTime, synchronizationStep,
            providerRuntime.get(), runControl.activeSchedules, elapsed));
    }
    auto reached = snapshot;
    const auto steps = integration.stepsPerGlobalStep;
    const auto internalStep = synchronizationStep / static_cast<double>(std::max<std::size_t>(1, steps));
    // Programs evaluated at stages are given the method's step: Runge–Kutta 4's, or under Dormand–Prince the global step, its largest.
    StageRequest request{&wholeModel, &heldValues, 0, integration.method == IntegrationMethod::rungeKutta4 ? internalStep : synchronizationStep,
        false, synchronizationStep};
    // What a program's message names as where it was called from.
    auto& callContext = programCallContext();
    callContext = {integration.method == IntegrationMethod::rungeKutta4 ? "Runge–Kutta 4" : integration.method == IntegrationMethod::bdf ? "Stiff, BDF"
        : integration.method == IntegrationMethod::rodas5p ? "Stiff, Rodas5P"
        : isStiff(integration) || integration.method == IntegrationMethod::rodas4 ? "Stiff, Rodas4"
        : integration.method == IntegrationMethod::tsit5 ? "Adaptive, Tsit5" : "Adaptive, Dormand–Prince 5(4)", 0,
        integrationMethodStages(integration.method)};
    const auto evaluateAt = [&](bool atStart, double time, const Values& stageStates, Values& derivatives) {
        request.stageTime = time;
        request.evaluateHeld = atStart;
        const auto& results = stepExecutor->evaluateStage(stageStates, runControl, request, providerRuntime.get());
        for (std::size_t index = 0; index < executionPlan.nodes.size(); ++index) {
            const auto& wholeNode = wholeModel.nodes[index];
            if (wholeNode.stepped) continue;
            const auto& node = executionPlan.nodes[index];
            for (const auto state : wholeNode.integratedStates) derivatives[state] = 0;
            for (const auto& [local, value] : results[index].derivatives) derivatives[node.stateIndexes[local]] = value;
            auto& metrics = nodeMetrics[index];
            metrics.evaluatedContributions += results[index].evaluatedContributions;
            metrics.computeNanoseconds += results[index].computeNanoseconds;
        }
    };
    // The steps taken inside this global step, for each node's substep count.
    std::size_t takenSteps = steps;
    // Switching conditions latched as they hold at the global step's start (Updates, controls and schedules may have moved them since).
    if (switching) {
        request.latches = &switching->latches;
        switching->beginGlobalStep(currentTime, reached);
    }
    if (isExplicitPair(integration.method)) {
        // Every step lands on the global step's end and on every corner of a schedule within it; the controller's memory carries
        // from one global step to the next (and into checkpoints). The held programs are evaluated at the first evaluation, the
        // global step's start.
        const auto breakpoints = isAdaptive(integration)
            ? scheduleBreakpoints(executionPlan, runControl.activeSchedules, currentTime, elapsed) : std::vector<double>{};
        const auto acceptedBefore = adaptiveStatistics.acceptedSteps;
        integrators::DormandPrince54Tolerance tolerance{integration.relativeTolerance, absoluteToleranceByState};
        // Samples stay on global steps, where Updates are set too: the dense output is not used for them (it is kept for event
        // location), so no sample shows a Rate state between global steps beside an Update still at its value from the step's start.
        const auto evaluateDormandPrince = [&](std::size_t evaluation, double time, const Values& stageStates, Values& derivatives) {
            evaluateAt(evaluation == 0, time, stageStates, derivatives);
        };
        // Dormand–Prince 5(4) or Tsit5: the same arguments, the same controller and memory, another tableau.
        const auto globalStepWith = [&](auto& events) {
            if (integration.method == IntegrationMethod::tsit5) {
                integrators::tsit5GlobalStepWithEvents(currentTime, elapsed, reached, wholeModel.integrated, wholeModel.errorGroups, tolerance,
                    breakpoints, {}, integration.stepsPerGlobalStep, adaptiveController, adaptiveStiffness, adaptiveStatistics, events,
                    evaluateDormandPrince, [](double, const Values&) {});
            } else {
                integrators::dormandPrince54GlobalStepWithEvents(currentTime, elapsed, reached, wholeModel.integrated, wholeModel.errorGroups, tolerance,
                    breakpoints, {}, integration.stepsPerGlobalStep, adaptiveController, adaptiveStiffness, adaptiveStatistics, events,
                    evaluateDormandPrince, [](double, const Values&) {});
            }
        };
        integrators::DormandPrince54NoEvents none;
        if (programsAdvanceAtSteps) {
            const auto advance = [&](double time, double step, const Values& accepted) { return advanceProgramsAfter(time, step, accepted); };
            if (switching) {
                ProgramStepEvents<std::remove_reference_t<decltype(*switching)>, decltype(advance)> events{*switching, advance};
                globalStepWith(events);
            } else {
                ProgramStepEvents<integrators::DormandPrince54NoEvents, decltype(advance)> events{none, advance};
                globalStepWith(events);
            }
        } else if (switching) {
            globalStepWith(*switching);
        } else {
            globalStepWith(none);
        }
        takenSteps = adaptiveStatistics.acceptedSteps - acceptedBefore;
        // Hairer's stiffness test said so: once a run, as a finding about the whole model, with what to do about it.
        if (!adaptiveStiffnessReported && !std::isnan(adaptiveStiffness.detectedAt)) {
            adaptiveStiffnessReported = true;
            DuringRunStabilityFinding finding;
            finding.code = "adaptiveStepsLimitedByStiffness";
            finding.globalTime = adaptiveStiffness.detectedAt;
            finding.message = "This model looks stiff: Adaptive is taking steps limited by stability, not accuracy -- many small steps even "
                "where its fastest parts have settled, which a looser tolerance will not make fewer.";
            stabilityFindings.push_back(std::move(finding));
        }
    } else if (isRosenbrock(integration.method)) {
        // As Adaptive: landing on the global step's end and every corner of a schedule within it, the controller's memory carried on,
        // the held programs evaluated at the first evaluation. df/dt is worked out when a stage may read the time, a recorded
        // intervention included. Rodas4 and Rodas5P share everything here but the step itself.
        const auto breakpoints = isStiff(integration)
            ? scheduleBreakpoints(executionPlan, runControl.activeSchedules, currentTime, elapsed) : std::vector<double>{};
        const auto acceptedBefore = stiffStatistics.acceptedSteps;
        integrators::Rodas4Tolerance tolerance{integration.relativeTolerance, absoluteToleranceByState};
        const auto evaluateRodas = [&](std::size_t evaluation, double time, const Values& stageStates, Values& derivatives) {
            evaluateAt(evaluation == 0, time, stageStates, derivatives);
        };
        const bool readsTime = stagesReadTimeAlways || !runControl.activeSchedules.empty();
        // df/dt from the equations' derivatives, unless a recorded intervention or a program makes the time matter otherwise.
        stiffSystem->exactTime = jacobianPlan.exactTime && runControl.activeSchedules.empty();
        const auto globalStepWith = [&](auto& events) {
            if (integration.method == IntegrationMethod::rodas5p) {
                integrators::rodas5pGlobalStepWithEvents(currentTime, elapsed, reached, *stiffSystem, tolerance, breakpoints, {},
                    integration.stepsPerGlobalStep, readsTime, stiffController, stiffStatistics, events, evaluateRodas, [](double, const Values&) {});
            } else {
                integrators::rodas4GlobalStepWithEvents(currentTime, elapsed, reached, *stiffSystem, tolerance, breakpoints, {},
                    integration.stepsPerGlobalStep, readsTime, stiffController, stiffStatistics, events, evaluateRodas, [](double, const Values&) {});
            }
        };
        integrators::Rodas4NoEvents none;
        if (programsAdvanceAtSteps) {
            const auto advance = [&](double time, double step, const Values& accepted) { return advanceProgramsAfter(time, step, accepted); };
            if (switching) {
                ProgramStepEvents<std::remove_reference_t<decltype(*switching)>, decltype(advance)> events{*switching, advance};
                globalStepWith(events);
            } else {
                ProgramStepEvents<integrators::Rodas4NoEvents, decltype(advance)> events{none, advance};
                globalStepWith(events);
            }
        } else if (switching) {
            globalStepWith(*switching);
        } else {
            globalStepWith(none);
        }
        takenSteps = stiffStatistics.acceptedSteps - acceptedBefore;
    } else if (integration.method == IntegrationMethod::bdf) {
        // As Stiff: landing on the global step's end and every corner of a schedule within it, the held programs evaluated at the first
        // evaluation. Its table carries on from the last global step unless the controls changed there: a live parameter set, a new
        // intervention, or a schedule turning a corner at this very instant.
        const auto breakpoints = scheduleBreakpoints(executionPlan, runControl.activeSchedules, currentTime, elapsed);
        const auto around = scheduleBreakpoints(executionPlan, runControl.activeSchedules, currentTime - globalTimeStep, currentTime + globalTimeStep);
        const bool cornerHere = std::any_of(around.begin(), around.end(), [&](double time) {
            return std::abs(time - currentTime) <= std::max(1e-9 * globalTimeStep, 1e3 * std::numeric_limits<double>::epsilon() * std::abs(currentTime));
        });
        const bool restart = cornerHere || runControl.parameterValues != bdfParameterValues || runControl.activeSchedules.size() != bdfSchedules
            || (switching && switching->latches != bdfLatches) || programMemoryTicked;
        programMemoryTicked = false;
        const auto acceptedBefore = bdfStatistics.acceptedSteps;
        integrators::BdfTolerance tolerance{integration.relativeTolerance, absoluteToleranceByState};
        const auto evaluateBdf = [&](std::size_t evaluation, double time, const Values& stageStates, Values& derivatives) {
            evaluateAt(evaluation == 0, time, stageStates, derivatives);
        };
        if (programsAdvanceAtSteps) {
            integrators::BdfNoEvents none;
            const auto advance = [&](double time, double step, const Values& accepted) { return advanceProgramsAfter(time, step, accepted); };
            if (switching) {
                ProgramStepEvents<std::remove_reference_t<decltype(*switching)>, decltype(advance)> events{*switching, advance};
                integrators::bdfGlobalStepWithEvents(currentTime, elapsed, reached, *stiffSystem, tolerance, breakpoints, {}, restart, bdfHistory,
                    bdfStatistics, events, evaluateBdf, [](double, const Values&) {});
            } else {
                ProgramStepEvents<integrators::BdfNoEvents, decltype(advance)> events{none, advance};
                integrators::bdfGlobalStepWithEvents(currentTime, elapsed, reached, *stiffSystem, tolerance, breakpoints, {}, restart, bdfHistory,
                    bdfStatistics, events, evaluateBdf, [](double, const Values&) {});
            }
        } else if (switching) {
            integrators::bdfGlobalStepWithEvents(currentTime, elapsed, reached, *stiffSystem, tolerance, breakpoints, {}, restart, bdfHistory, bdfStatistics,
                *switching, evaluateBdf, [](double, const Values&) {});
        } else {
            integrators::bdfGlobalStep(currentTime, elapsed, reached, *stiffSystem, tolerance, breakpoints, {}, restart, bdfHistory, bdfStatistics,
                evaluateBdf, [](double, const Values&) {});
        }
        bdfParameterValues = runControl.parameterValues;
        bdfSchedules = runControl.activeSchedules.size();
        if (switching) bdfLatches = switching->latches;
        takenSteps = bdfStatistics.acceptedSteps - acceptedBefore;
    } else {
        const auto evaluateRungeKutta = [&](std::size_t step, std::size_t stage, double time, const Values& stageStates, Values& derivatives) {
            callContext.stage = stage + 1;
            evaluateAt(step == 0 && stage == 0, time, stageStates, derivatives);
        };
        if (!programsAdvanceAtSteps) {
            if (switching) {
                integrators::rungeKutta4GlobalStepWithEvents(currentTime, synchronizationStep, steps, reached, wholeModel.integrated, *switching,
                    evaluateRungeKutta);
            } else {
                integrators::rungeKutta4GlobalStep(currentTime, synchronizationStep, steps, reached, wholeModel.integrated, evaluateRungeKutta);
            }
        } else {
            // Version 2 programs with memory advance after every accepted step (docs/proposals/programSdkV2.md): the global step is taken
            // as its internal steps one at a time, the same arithmetic in the same order (each step starts at currentTime + i h with h
            // the global step over `steps`), with advance() between them, reading the states each step reached.
            const auto internal = synchronizationStep / static_cast<double>(std::max<std::size_t>(1, steps));
            for (std::size_t step = 0; step < std::max<std::size_t>(1, steps); ++step) {
                const double start = currentTime + static_cast<double>(step) * internal;
                const auto evaluateStep = [&](std::size_t, std::size_t stage, double time, const Values& stageStates, Values& derivatives) {
                    evaluateRungeKutta(step, stage, time, stageStates, derivatives);
                };
                if (switching) integrators::rungeKutta4GlobalStepWithEvents(start, internal, 1, reached, wholeModel.integrated, *switching, evaluateStep);
                else integrators::rungeKutta4GlobalStep(start, internal, 1, reached, wholeModel.integrated, evaluateStep);
                const double end = step + 1 == std::max<std::size_t>(1, steps) ? elapsed : currentTime + static_cast<double>(step + 1) * internal;
                advancePlanPrograms(executionPlan, reached, runControl.parameterValues, runControl.activeSchedules, end, internal, false,
                    providerRuntime.get(), stageNodeMask);
            }
        }
    }
    callContext = {};
    // The events located this global step: each instant counted once, however many conditions changed at it; the first thousand kept
    // for the result, each with its condition. A global step that reached the limit is said once, as a finding.
    if (switching) {
        double last = std::numeric_limits<double>::quiet_NaN();
        for (const auto& [time, condition] : switching->fired) {
            if (!(time == last)) ++eventInstants;
            last = time;
            if (eventList.size() < 1000) eventList.emplace_back(time, condition);
        }
        switching->fired.clear();
        if (switching->chattering && !chatteringReported) {
            chatteringReported = true;
            DuringRunStabilityFinding finding;
            finding.code = "eventsChattering";
            finding.globalTime = currentTime;
            std::ostringstream message;
            message << "Switching conditions changed " << switching->limit << " times within one step starting at " << currentTime
                    << " s, so the rest of that step read them as they stood at each internal step's start instead of locating each change. "
                    << "A condition that switches back and forth this fast (a diode or friction at zero, a threshold without hysteresis) "
                    << "makes the result depend on the step; a band between switching on and off, or a smooth transition, avoids it.";
            finding.message = message.str();
            stabilityFindings.push_back(std::move(finding));
        }
    }
    for (std::size_t position = 0; position < wholeModel.steppedNodes.size(); ++position) {
        const auto index = wholeModel.steppedNodes[position];
        const auto& node = executionPlan.nodes[index];
        for (std::size_t stateIndex = 0; stateIndex < node.stateIndexes.size(); ++stateIndex) {
            reached[node.stateIndexes[stateIndex]] = stepped[position].states.at(stateIndex);
        }
        auto& metrics = nodeMetrics[index];
        metrics.executedSubsteps += node.substeps;
        metrics.evaluatedContributions += node.substeps * (node.contributions.size() + node.algebraicTasks.size());
        metrics.computeNanoseconds += stepped[position].computeNanoseconds;
    }
    for (std::size_t index = 0; index < executionPlan.nodes.size(); ++index) {
        ++nodeMetrics[index].invocations;
        if (!wholeModel.nodes[index].stepped) nodeMetrics[index].executedSubsteps += takenSteps;
    }
    const auto synchronizationElapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now() - synchronizationStartedAt).count();
    synchronizationComputeNanoseconds += static_cast<std::uint64_t>(std::max<std::int64_t>(0, synchronizationElapsed));
    states = std::move(reached);
    currentTime = elapsed;
    afterGlobalStep(currentTime, synchronizationStep);
    if (!stabilityMonitoredNodeIds.empty()) {
        auto newFindings = stabilityMonitor->observeGlobalStep(states, currentTime);
        stabilityFindings.insert(stabilityFindings.end(),
            std::make_move_iterator(newFindings.begin()), std::make_move_iterator(newFindings.end()));
    }
}

// Real-time and limited-ratio pacing, against a deadline: the step ending at simulated time t is due at the anchor's
// wall-clock moment plus (t - the anchor's simulated time) / ratio, and the step waits until then, reading commands
// meanwhile. A wait that wakes late (a busy or throttled machine, whose timers can fire tens of milliseconds late) is
// made up by the steps after it not waiting, so the run keeps to the clock. Pacing each step by its own share of wall
// time, as before, lost every late wake-up for good: on a throttled macOS virtual machine a 3 s real-time run of 10 ms
// steps took 27 s. A run that falls more than a quarter of a second behind (its steps cost more than the pace allows,
// or the process was stopped) is not raced to catch up: the anchor moves to now, so it carries on at the pace from there.
void Simulation::paceStep(std::chrono::steady_clock::time_point wallStepStarted, double stepStartTime, double stepEndTime) {
    constexpr auto mostBehind = std::chrono::milliseconds(250);
    while (pacing.mode != PacingMode::fastest) {
        if (!pacingAnchor || pacingAnchor->mode != pacing.mode || pacingAnchor->ratio != pacing.ratio) {
            pacingAnchor = PacingAnchor{pacingAnchor ? std::chrono::steady_clock::now() : wallStepStarted, stepStartTime, pacing.mode, pacing.ratio};
        }
        const auto due = pacingAnchor->wall + std::chrono::duration_cast<std::chrono::steady_clock::duration>(
            std::chrono::duration<double>((stepEndTime - pacingAnchor->simulationTime) / pacing.ratio));
        const auto now = std::chrono::steady_clock::now();
        if (now >= due) {
            if (now - due > mostBehind) pacingAnchor = PacingAnchor{now, stepEndTime, pacing.mode, pacing.ratio};
            break;
        }
        pacingWait(std::min(std::chrono::duration_cast<std::chrono::milliseconds>(due - now), std::chrono::milliseconds(20)));
        refreshRunControl(true);
        pacing = runControl.pacing;
        if (runControl.executionState != RunState::running) break;
    }
    if (pacing.mode == PacingMode::fastest) pacingAnchor.reset();
}

// At an output boundary (and at the last step): the sample, a checkpoint, and now and then the result file.
void Simulation::recordStepOutput(std::size_t step, double elapsed) {
    if (!((step + 1) % static_cast<std::size_t>(outputSteps) == 0 || step + 1 == steps)) return;
    samples.push_back({elapsed, states, partsAt(elapsed)});
    appendStreamRecord("sample", elapsed, states);
    // A checkpoint is captured at every output boundary (not only the final step) so any
    // displayed sample is forkable, matching the documented design intent (see "Result
    // output samples already occur at global synchronization boundaries" in
    // docs/resultExploration.md's "Checkpoints and reproducibility" section) -- previously
    // only the first and last checkpoints existed for an uninterrupted run, so "Fork here"
    // at an arbitrary scrubbed time silently snapped to the nearest of just those two.
    if (elapsed > checkpoints.back().time + 1e-12) {
        checkpoints.push_back(makeCheckpoint(elapsed));
        appendStreamRecord("checkpoint", elapsed, states, checkpoints.back().uuid);
    }
    const auto publicationTime = std::chrono::steady_clock::now();
    if (step + 1 == steps || publicationTime - lastPublishedAt >= std::chrono::milliseconds(250)) {
        writeResult(step + 1 == steps ? "completed" : "running", elapsed, step + 1 == steps);
        lastPublishedAt = publicationTime;
    }
}

// Which checkpoint of a session a time is: the number of checkpoint intervals since the session began, if it is a whole number.
long long Simulation::checkpointKey(double time) const {
    const auto intervals = (time - sessionOrigin) / checkpointInterval;
    const auto rounded = std::round(intervals);
    if (!std::isfinite(intervals) || std::abs(intervals - rounded) > 1e-9 * std::max(1.0, std::abs(rounded))) return -1;
    return static_cast<long long>(rounded);
}

void Simulation::updateStates(double time, bool afterStep, double stepSize) {
    const auto outcome = applyUpdates(executionPlan, states, runControl.parameterValues, runControl.activeSchedules, time, afterStep, stepSize, providerRuntime.get());
    if (outcome.ringsUnsettled && !ringsUnsettled) {
        std::cerr << "warning: a ring of Updates that settle within the step did not settle within its limit at " << time
                  << " s; its values are those of the last sweep.\n";
    }
    ringsUnsettled += outcome.ringsUnsettled;
    for (const auto& ring : outcome.unsettledRings) {
        const auto& group = executionPlan.settleGroups.at(ring.group);
        const auto label = [&](EntityId stateId) {
            const auto found = stateLabels.find(stateId);
            return found != stateLabels.end() && !found->second.empty() ? found->second : "state " + std::to_string(stateId);
        };
        const auto changedState = executionPlan.stateIds.at(ring.stateIndex);
        auto [record, first] = unsettledRingRecords.try_emplace(ring.group);
        if (first) {
            DuringRunStabilityFinding finding;
            finding.stateId = changedState;
            finding.nodeId = executionPlan.stateNodes.count(changedState) ? executionPlan.stateNodes.at(changedState) : 0;
            finding.code = "ringDidNotSettle";
            finding.globalTime = time;
            record->second.finding = stabilityFindings.size();
            stabilityFindings.push_back(finding);
        }
        auto& kept = record->second;
        ++kept.times;
        if (!(ring.change <= kept.largestChange)) { kept.largestChange = ring.change; kept.largestState = changedState; }
        // The states the ring sets, in the order they are first set, named as the canvas names them.
        std::vector<EntityId> ringStates;
        for (const auto stepIndex : group.steps) {
            const auto stateId = executionPlan.stateIds.at(executionPlan.updateSteps.at(stepIndex).writes);
            if (std::find(ringStates.begin(), ringStates.end(), stateId) == ringStates.end()) ringStates.push_back(stateId);
        }
        std::string names;
        const std::size_t shown = std::min<std::size_t>(ringStates.size(), 6);
        for (std::size_t index = 0; index < shown; ++index) {
            if (index) names += index + 1 == shown && shown == ringStates.size() ? " and " : ", ";
            names += label(ringStates[index]);
        }
        if (shown < ringStates.size()) names += " and " + std::to_string(ringStates.size() - shown) + " more";
        std::ostringstream message;
        message << "A ring of values settled within the step (" << names << ") was still changing after " << group.limit
                << (group.limit == 1 ? " sweep" : " sweeps") << ", by up to " << kept.largestChange << " in " << label(kept.largestState)
                << ", in " << kept.times << (kept.times == 1 ? " step" : " steps") << " of the run. The run carried on with the last "
                << "sweep's values. The ring may have no settled value; if it settles slowly, give its nodes more sweeps, or let them "
                << "update once per step, so the ring goes round once a step.";
        stabilityFindings.at(kept.finding).message = message.str();
    }
}

// The algebraic states set again for the instant, as a run does when it starts or resumes from a checkpoint.
void Simulation::settleAt(double time) {
    updateStates(time, false, globalTimeStep);
}

void Simulation::restoreProviderStates(const std::vector<std::pair<EntityId, std::vector<std::byte>>>& providerStates) {
    for (const auto& [nodeId, payload] : providerStates) {
        const auto node = std::find_if(executionPlan.nodes.begin(), executionPlan.nodes.end(),
            [&](const auto& candidate) { return candidate.nodeId == nodeId; });
        if (node == executionPlan.nodes.end() || !node->nodeProvider || node->nodeProvider->programVersion == 2) {
            throw std::runtime_error("A saved provider state names a node with no provider.");
        }
        providerRuntime->requestNodeRestore(*node->nodeProvider, payload);
    }
}

// Steps to `time` and holds there: a whole number of steps after the time the session was last restored to, counted from that
// time (so a step ends at that time plus n steps, exactly as a run started there would have it). On the way, the reported
// states' samples are sent at every output time, and a checkpoint is kept at every checkpoint time.
std::uint32_t Simulation::advanceTo(double time, bool takeCheckpoints) {
    const auto stepsTarget = (time - baseTime) / globalTimeStep;
    const auto rounded = std::round(stepsTarget);
    if (!std::isfinite(time) || std::abs(stepsTarget - rounded) > 1e-9 * std::max(1.0, std::abs(rounded))) {
        throw std::runtime_error("A session advances by whole time steps from the time it was last restored to.");
    }
    const auto targetSteps = static_cast<long long>(rounded);
    if (targetSteps < stepsSinceBase) throw std::runtime_error("A session cannot advance to a time before the one it is at.");
    protocol::EngineEvent event;
    event.set_protocol_version(1);
    auto* batch = event.mutable_sample_batch();
    batch->set_state_count(static_cast<std::uint32_t>(reportedIndexes.size()));
    const auto flush = [&] {
        if (!batch->times_size()) return;
        writeFramedEvent(*eventStream, event);
        batch->clear_times();
        batch->clear_values();
    };
    std::uint32_t taken = 0;
    while (stepsSinceBase < targetSteps) {
        startFollowing(baseTime + static_cast<double>(stepsSinceBase) * globalTimeStep, baseTime + static_cast<double>(stepsSinceBase + 1) * globalTimeStep);
        settleIfParametersChanged();
        const double elapsed = baseTime + static_cast<double>(stepsSinceBase + 1) * globalTimeStep;
        integrateStep(stepCounter++, globalTimeStep, elapsed);
        ++stepsSinceBase;
        followStates(elapsed);
        if (stepsSinceBase % outputSteps == 0) {
            batch->add_times(elapsed);
            for (const auto index : reportedIndexes) batch->add_values(states[index]);
            if (batch->times_size() >= 4096) flush();
        }
        if (const auto key = takeCheckpoints ? checkpointKey(elapsed) : -1; key >= 0) {
            sessionCheckpoints[key] = makeCheckpoint(elapsed);
            ++taken;
        }
    }
    flush();
    return taken;
}

// Back to the checkpoint kept at `time`, with the listed states replaced, and the algebraic states set again. Everything is
// checked before anything is changed, so a refused restore leaves the session where it was.
const ProviderCheckpointStates& Simulation::restoreCheckpoint(const protocol::RestoreCheckpoint& command) {
    const auto key = checkpointKey(command.time());
    const auto found = key >= 0 ? sessionCheckpoints.find(key) : sessionCheckpoints.end();
    if (found == sessionCheckpoints.end()) {
        std::ostringstream message;
        message << std::setprecision(17) << "No checkpoint is kept at " << command.time() << " s.";
        throw std::runtime_error(message.str());
    }
    std::vector<std::pair<std::size_t, double>> overrides;
    for (const auto& item : command.overrides()) {
        const auto stateIndex = executionPlan.stateIndexes.find(item.state_id());
        if (stateIndex == executionPlan.stateIndexes.end()) throw std::runtime_error("A state to set is not in the model.");
        if (algebraicIndexes.contains(stateIndex->second)) {
            throw std::runtime_error("State " + std::to_string(item.state_id()) + " is computed by the model from other states, so it cannot be set.");
        }
        if (!std::isfinite(item.value())) throw std::runtime_error("A state can only be set to a finite number.");
        overrides.emplace_back(stateIndex->second, item.value());
    }
    const auto& checkpoint = found->second;
    states = checkpoint.states;
    restoreProviderStates(checkpoint.providerStates);
    if (providerRuntime) providerRuntime->restoreProgramMemory(checkpoint.programMemory, nullptr);
    for (const auto& [index, value] : overrides) states[index] = value;
    // Back at a checkpoint as it was, the controller carries on as it did; with states replaced it starts afresh (Hairer's initial step).
    resetSolverState(overrides.empty() ? checkpoint.solverState : std::string());
    currentTime = checkpoint.time;
    baseTime = checkpoint.time;
    stepsSinceBase = 0;
    settleAt(currentTime);
    stepExecutor->restore(states);
    return checkpoint.providerStates;
}

// The whole state from the message: how a session is carried on in a new engine.
ProviderCheckpointStates Simulation::restoreState(const protocol::RestoreState& command) {
    if (static_cast<std::size_t>(command.values_size()) != states.size()) throw std::runtime_error("The state to restore does not match the model's states.");
    for (const auto value : command.values()) {
        if (!std::isfinite(value)) throw std::runtime_error("A state can only be set to a finite number.");
    }
    if (!std::isfinite(command.time())) throw std::runtime_error("The time to restore to must be finite.");
    const auto providerNodes = std::count_if(executionPlan.nodes.begin(), executionPlan.nodes.end(),
        [](const auto& node) { return node.nodeProvider.has_value() && node.nodeProvider->programVersion != 2; });
    if (command.provider_states_size() != providerNodes) throw std::runtime_error("The state to restore needs the saved state of every node provider.");
    std::vector<std::pair<EntityId, std::vector<std::byte>>> providerStates;
    for (const auto& item : command.provider_states()) {
        const auto* bytes = reinterpret_cast<const std::byte*>(item.payload().data());
        providerStates.emplace_back(item.node_id(), std::vector<std::byte>(bytes, bytes + item.payload().size()));
    }
    const auto& stateIds = executionPlan.stateIds;
    for (std::size_t index = 0; index < stateIds.size(); ++index) states[executionPlan.stateIndexes.at(stateIds[index])] = command.values(static_cast<int>(index));
    restoreProviderStates(providerStates);
    // Version 2 programs' memory, field by field by name; a state saved before a program had memory leaves it as it is.
    if (providerRuntime && command.program_memory_size()) {
        std::vector<ProgramMemoryState> memory;
        for (const auto& item : command.program_memory()) memory.push_back(decodeProgramMemory(item));
        providerRuntime->restoreProgramMemory(memory, nullptr);
    }
    resetSolverState();
    currentTime = command.time();
    baseTime = command.time();
    stepsSinceBase = 0;
    settleAt(currentTime);
    stepExecutor->restore(states);
    return providerStates;
}

// Forgets the checkpoints from before `time`, and every input reading from before it but the last, which still holds at it.
void Simulation::retainFrom(double time) {
    std::erase_if(sessionCheckpoints, [&](const auto& entry) { return entry.second.time < time - 1e-9 * std::max(1.0, std::abs(time)); });
    for (auto& schedule : runControl.activeSchedules) {
        if (!schedule.input || schedule.samples.size() < 2) continue;
        const auto firstKept = std::upper_bound(schedule.samples.begin(), schedule.samples.end(), time,
            [](double at, const auto& sample) { return at < sample.first; });
        if (firstKept - schedule.samples.begin() > 1) schedule.samples.erase(schedule.samples.begin(), firstKept - 1);
    }
}

void Simulation::appendInputSamples(const protocol::AppendInputSamples& command) {
    if (!command.parameter_id()) throw std::runtime_error("An input names no parameter.");
    std::vector<std::pair<double, double>> incoming;
    for (const auto& sample : command.samples()) {
        if (!std::isfinite(sample.time()) || !std::isfinite(sample.value())) throw std::runtime_error("An input reading must be a finite time and value.");
        if (!incoming.empty() && !(sample.time() > incoming.back().first)) throw std::runtime_error("Input readings must come in time order.");
        incoming.emplace_back(sample.time(), sample.value());
    }
    auto existing = std::find_if(runControl.activeSchedules.begin(), runControl.activeSchedules.end(),
        [&](const auto& schedule) { return schedule.input && schedule.parameterId == command.parameter_id(); });
    auto kept = existing == runControl.activeSchedules.end() ? std::vector<std::pair<double, double>>{} : existing->samples;
    if (command.replace()) std::erase_if(kept, [&](const auto& sample) { return sample.first >= command.replace_from(); });
    if (!kept.empty() && !incoming.empty() && !(incoming.front().first > kept.back().first)) {
        throw std::runtime_error("Input readings must come in time order; a corrected reading is sent with replace.");
    }
    kept.insert(kept.end(), incoming.begin(), incoming.end());
    if (command.follow_state_id() && executionPlan.stateIndexes.find(command.follow_state_id()) == executionPlan.stateIndexes.end()) {
        throw std::runtime_error("An input follows a state that is not in the model.");
    }
    if (command.follow_state_id() && !std::isfinite(command.follow_from())) throw std::runtime_error("An input follows a state from a finite time.");
    if (command.follow_state_id() && command.follow_bounded() && !(command.follow_minimum() <= command.follow_maximum())) {
        throw std::runtime_error("An input follows a state within limits whose minimum is at most its maximum.");
    }
    const double followMinimum = command.follow_bounded() ? command.follow_minimum() : -std::numeric_limits<double>::infinity();
    const double followMaximum = command.follow_bounded() ? command.follow_maximum() : std::numeric_limits<double>::infinity();
    if (existing == runControl.activeSchedules.end()) {
        if (kept.empty()) return;
        ParameterSchedule schedule;
        schedule.parameterId = command.parameter_id();
        schedule.mode = ParameterSchedule::Mode::piecewise;
        schedule.hold = true;
        schedule.input = true;
        schedule.startTime = kept.front().first;
        schedule.samples = std::move(kept);
        schedule.followStateId = command.follow_state_id();
        schedule.followFrom = command.follow_from();
        schedule.followMinimum = followMinimum;
        schedule.followMaximum = followMaximum;
        runControl.activeSchedules.push_back(std::move(schedule));
        return;
    }
    if (kept.empty()) {
        runControl.activeSchedules.erase(existing);
        return;
    }
    existing->samples = std::move(kept);
    existing->startTime = std::min(existing->startTime, existing->samples.front().first);
    existing->followStateId = command.follow_state_id();
    existing->followFrom = command.follow_from();
    existing->followMinimum = followMinimum;
    existing->followMaximum = followMaximum;
}

// A state an input follows starts from what the input was doing: before the step over followFrom (from `start` to `end`), the state
// is set to the input's value there, within its limits, so a controller's memory (a thermostat on or off) is the input's, in every
// pass over that time (a forecast from now, an estimator's member run on from its anchor). A state the model computes from others
// has no memory to set, and is left to the model.
void Simulation::startFollowing(double start, double end) {
    bool set = false;
    for (const auto& schedule : runControl.activeSchedules) {
        if (!schedule.input || !schedule.followStateId || schedule.samples.empty()) continue;
        const double tolerance = 1e-9 * std::max(1.0, std::abs(schedule.followFrom));
        if (!(start <= schedule.followFrom + tolerance && end > schedule.followFrom + tolerance)) continue;
        const auto index = executionPlan.stateIndexes.at(schedule.followStateId);
        if (algebraicIndexes.contains(index)) continue;
        states[index] = std::clamp(evaluateParameterSchedule(schedule, schedule.followFrom), schedule.followMinimum, schedule.followMaximum);
        set = true;
    }
    if (set) settleAt(start);
}

// Each input that follows a state past its followFrom takes the state's value at the end of this step as its next reading; what a
// step over these times added before (an earlier pass, before a restore) is dropped first, so the input is what this pass made it.
void Simulation::followStates(double time) {
    const auto tolerance = 1e-9 * std::max(1.0, std::abs(time));
    for (auto& schedule : runControl.activeSchedules) {
        if (!schedule.input || !schedule.followStateId || !(time > schedule.followFrom + tolerance)) continue;
        while (!schedule.samples.empty() && schedule.samples.back().first > schedule.followFrom + tolerance && schedule.samples.back().first >= time - tolerance) {
            schedule.samples.pop_back();
        }
        schedule.samples.emplace_back(time, std::clamp(states[executionPlan.stateIndexes.at(schedule.followStateId)], schedule.followMinimum, schedule.followMaximum));
    }
}

#ifndef __EMSCRIPTEN__
std::optional<protocol::EngineCommand> Simulation::waitForCommand() {
    std::unique_lock lock(controlInbox->mutex);
    controlInbox->ready.wait(lock, [&] { return !controlInbox->commands.empty() || controlInbox->ended || !controlInbox->error.empty(); });
    if (!controlInbox->error.empty()) throw std::runtime_error(controlInbox->error);
    if (controlInbox->commands.empty()) return std::nullopt;
    auto command = std::move(controlInbox->commands.front());
    controlInbox->commands.erase(controlInbox->commands.begin());
    return command;
}
#else
std::optional<protocol::EngineCommand> Simulation::waitForCommand() {
    throw std::runtime_error("The web edition has no engine session yet.");
}
#endif

void Simulation::reply(const protocol::EngineCommand& command, bool ok, const std::string& message, const ProviderCheckpointStates* restored,
                       std::uint64_t computeNanoseconds, std::uint32_t checkpointsTaken) {
    protocol::EngineEvent event;
    event.set_protocol_version(1);
    auto* answer = event.mutable_session_reply();
    answer->set_sequence(command.sequence());
    answer->set_ok(ok);
    answer->set_message(message);
    answer->set_time(currentTime);
    answer->set_compute_nanoseconds(computeNanoseconds);
    answer->set_checkpoints_taken(checkpointsTaken);
    if (restored) {
        for (const auto stateId : executionPlan.stateIds) answer->add_values(states[executionPlan.stateIndexes.at(stateId)]);
        for (const auto& [nodeId, payload] : *restored) {
            auto* saved = answer->add_provider_states();
            saved->set_node_id(nodeId);
            saved->set_payload(std::string(reinterpret_cast<const char*>(payload.data()), payload.size()));
        }
        // And every version 2 program's memory as restored, for the session log.
        if (providerRuntime) for (const auto& memory : providerRuntime->programMemory()) encodeProgramMemory(memory, *answer->add_program_memory());
    }
    writeFramedEvent(*eventStream, event);
}

// Answers commands, one at a time and in order, until the control stream closes. A command that cannot be carried out is
// answered with the reason and changes nothing, and the commands after it in the same batch are not carried out.
void Simulation::serveSession() {
    {
        protocol::EngineEvent event;
        event.set_protocol_version(1);
        auto* info = event.mutable_session_info();
        for (const auto stateId : executionPlan.stateIds) {
            if (algebraicIndexes.contains(executionPlan.stateIndexes.at(stateId))) info->add_algebraic_state_ids(stateId);
        }
        info->add_features("followState");
        writeFramedEvent(*eventStream, event);
    }
    std::uint64_t failedBatch = 0;
    while (const auto command = waitForCommand()) {
        if (command->batch() && command->batch() == failedBatch) {
            reply(*command, false, "Not carried out: an earlier command in the same batch failed.", nullptr, 0);
            continue;
        }
        const auto startedAt = std::chrono::steady_clock::now();
        const auto elapsedNanoseconds = [&] {
            return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - startedAt).count());
        };
        try {
            if (command->has_advance_to()) {
                const auto taken = advanceTo(command->advance_to().time(), command->advance_to().take_checkpoints());
                reply(*command, true, "", nullptr, elapsedNanoseconds(), taken);
            } else if (command->has_restore_checkpoint()) {
                const auto restored = restoreCheckpoint(command->restore_checkpoint());
                reply(*command, true, "", &restored, elapsedNanoseconds());
            } else if (command->has_restore_state()) {
                const auto restored = restoreState(command->restore_state());
                reply(*command, true, "", &restored, elapsedNanoseconds());
            } else {
                if (command->has_retain_checkpoints_from()) retainFrom(command->retain_checkpoints_from().time());
                else if (command->has_append_input_samples()) appendInputSamples(command->append_input_samples());
                else applyControlCommand(runControl, *command, currentTime);
                reply(*command, true, "", nullptr, elapsedNanoseconds());
            }
        } catch (const std::exception& error) {
            if (command->batch()) failedBatch = command->batch();
            reply(*command, false, error.what(), nullptr, elapsedNanoseconds());
        }
    }
}

}

void runSimulation(const boost::property_tree::ptree& document,
                   const boost::property_tree::ptree& configuration,
                   const std::filesystem::path& outputPath,
                   std::istream* controlStream,
                   std::ostream* eventStream,
                   std::shared_ptr<const ExecutionPlan> plan) {
    Simulation simulation(document, configuration, outputPath, controlStream, eventStream, std::move(plan));
    simulation.writeResult("running", simulation.startTime);
    simulation.lastPublishedAt = std::chrono::steady_clock::now();
    const auto steps = simulation.steps;
    for (std::size_t step = 0; step < steps; ++step) {
        simulation.refreshRunControl();
        simulation.pacing = simulation.runControl.pacing;
        if (simulation.runControl.executionState == RunState::paused) {
            simulation.captureBoundary();
            simulation.writeResult("paused", simulation.currentTime);
            while (simulation.runControl.executionState == RunState::paused) {
                pacingWait(std::chrono::milliseconds(40));
                const auto changesBefore = simulation.runControl.interventions.size();
                simulation.refreshRunControl(true);
                // A value set while the run is held shows in the result at once, not only when it is resumed.
                if (simulation.runControl.interventions.size() != changesBefore) simulation.writeResult("paused", simulation.currentTime);
            }
            simulation.pacing = simulation.runControl.pacing;
            // The pause took wall time no step should be paced against: the pace starts again from here.
            simulation.pacingAnchor.reset();
            if (simulation.runControl.executionState == RunState::stopped) {
                simulation.writeResult("stopped", simulation.currentTime, true);
                return;
            }
            simulation.writeResult("running", simulation.currentTime);
        } else if (simulation.runControl.executionState == RunState::stopped) {
            simulation.captureBoundary();
            simulation.writeResult("stopped", simulation.currentTime, true);
            return;
        }
        simulation.settleIfParametersChanged();
        const auto wallStepStarted = std::chrono::steady_clock::now();
        const auto synchronizationStep = simulation.wholeSteps || step + 1 < steps
            ? simulation.globalTimeStep
            : std::min(simulation.globalTimeStep, simulation.targetTime - simulation.startTime - static_cast<double>(step) * simulation.globalTimeStep);
        const auto elapsed = std::min(simulation.targetTime, simulation.startTime + static_cast<double>(step + 1) * simulation.globalTimeStep);
        simulation.integrateStep(step, synchronizationStep, elapsed);
        simulation.paceStep(wallStepStarted, elapsed - synchronizationStep, elapsed);
        simulation.recordStepOutput(step, elapsed);
    }
}


void runSession(const boost::property_tree::ptree& document,
                const boost::property_tree::ptree& configuration,
                std::istream* controlStream,
                std::ostream* eventStream,
                std::shared_ptr<const ExecutionPlan> plan) {
    if (!controlStream || !eventStream) throw std::runtime_error("A session needs its control and event streams.");
    Simulation simulation(document, configuration, {}, controlStream, eventStream, std::move(plan), true);
    simulation.serveSession();
}

}
