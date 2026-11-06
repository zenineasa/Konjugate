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
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <map>
#include <future>
#include <memory>
#include <mutex>
#include <numeric>
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
struct Sample { double time; Values states; };
// Each entry pairs a computational-node-provider-owning node's id with that provider instance's
// opaque checkpoint() payload. Empty for a plan with no computational-node providers.
using ProviderCheckpointStates = std::vector<std::pair<EntityId, std::vector<std::byte>>>;
struct Checkpoint { std::string uuid; double time; Values states; ProviderCheckpointStates providerStates; };
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

RunControl drainRunControl(const std::shared_ptr<ControlInbox>& inbox, RunControl current, double now) {
    std::vector<protocol::EngineCommand> commands;
    {
        std::lock_guard lock(inbox->mutex);
        if (!inbox->error.empty()) throw std::runtime_error(inbox->error);
        commands.swap(inbox->commands);
    }
    for (const auto& command : commands) applyControlCommand(current, command, now);
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

protected:
    explicit StepExecutor(const ExecutionPlan& plan) : plan_(plan) {}
    const ExecutionPlan& plan_;
};

class SerialStepExecutor final : public StepExecutor {
public:
    explicit SerialStepExecutor(const ExecutionPlan& plan) : StepExecutor(plan) {}

    std::vector<NodeIntegrationResult> integrate(const Values& snapshot, const RunControl& control, double time, double step,
        double endTime, std::size_t, ProviderRuntime* providers) override {
        std::vector<NodeIntegrationResult> nodeResults(plan_.nodes.size());
        for (std::size_t index = 0; index < plan_.nodes.size(); ++index) {
            nodeResults[index] = integrateNode(plan_.nodes[index], snapshot, control.parameterValues, time, step, providers, control.activeSchedules, endTime);
        }
        return nodeResults;
    }
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

private:
    std::size_t receiveTimeout_;
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
    void integrateStep(std::size_t step, double synchronizationStep, double elapsed);
    void paceStep(std::chrono::steady_clock::time_point wallStepStarted, double synchronizationStep);
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
    void restoreStartCheckpoint(const boost::property_tree::ptree& checkpoint);

    const boost::property_tree::ptree& configuration;
    std::filesystem::path outputPath;
    std::ostream* eventStream;
    double outputInterval;
    std::shared_ptr<ControlInbox> controlInbox;
#ifdef __EMSCRIPTEN__
    EmscriptenControlBuffer emscriptenControlBuffer;
#endif
    bool timeSettingsChecked;
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
    std::vector<Checkpoint> checkpoints;
    std::vector<Sample> pendingEventSamples;
    std::unordered_set<EntityId> stabilityMonitoredNodeIds;
    std::optional<DuringRunStabilityMonitor> stabilityMonitor;
    std::vector<DuringRunStabilityFinding> stabilityFindings;
    std::chrono::steady_clock::time_point lastControlReadAt;
    double nextOutputTime = 0;
    // How many parameter changes the algebraic states were last set with (see settleIfParametersChanged).
    std::size_t settledInterventions = 0;
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
    // Algebraic states are set from their expressions before anything is recorded or read, so the
    // first sample, the first checkpoint and every node's first step all see consistent values --
    // after a restart too, where a fork may have changed the parameters they depend on.
    settleAlgebraicStates(executionPlan, states, runControl.parameterValues, startTime, globalTimeStep, providerRuntime.get(), runControl.activeSchedules);
    // And the states algebraic relationships set, across nodes, in dependency order.
    evaluateAlgebraicRelationships(executionPlan, states, runControl.parameterValues, runControl.activeSchedules, startTime);
    samples = {{startTime, states}};
    checkpoints = {{createUuid(), startTime, states, captureProviderStates()}};
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
    nextOutputTime = startTime + outputInterval;
    settledInterventions = runControl.interventions.size();
    if (!sessionMode) {
        appendStreamRecord("sample", startTime, states);
        appendStreamRecord("checkpoint", startTime, states, checkpoints.front().uuid);
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
    outputSteps = std::llround(outputInterval / globalTimeStep);
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

    // Opaque provider-owned state (e.g. a controller's integral term) has no analog in the
    // ordinary numeric state vector restored above, so it must be restored explicitly and
    // exhaustively: a missing entry fails loudly here rather than silently resetting a
    // provider instance to its initialize()-time default.
    const auto providerNodeCount = std::count_if(executionPlan.nodes.begin(), executionPlan.nodes.end(),
        [](const auto& node) { return node.nodeProvider.has_value(); });
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
            if (nodeIt == executionPlan.nodes.end() || !nodeIt->nodeProvider || !restoredNodes.insert(nodeId).second) {
                throw std::runtime_error("The restart checkpoint references an unknown computational-node provider.");
            }
            providerRuntime->requestNodeRestore(*nodeIt->nodeProvider,
                decodeBase64Bytes(entry.second.get<std::string>("payload", "")));
        }
        if (static_cast<std::size_t>(providerNodeCount) != restoredNodes.size()) {
            throw std::runtime_error("The restart checkpoint is missing computational-node provider state.");
        }
    }
    stepExecutor->restore(states);
}

ProviderCheckpointStates Simulation::captureProviderStates() {
    ProviderCheckpointStates result;
    if (!providerRuntime) return result;
    for (const auto& node : executionPlan.nodes) {
        if (node.nodeProvider) result.emplace_back(node.nodeId, providerRuntime->requestNodeCheckpoint(*node.nodeProvider));
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
        pendingEventSamples.push_back({time, recordStates});
    }
    static_cast<void>(uuid);
}

void Simulation::captureBoundary() {
    if (currentTime > samples.back().time + 1e-12) {
        samples.push_back({currentTime, states});
        appendStreamRecord("sample", currentTime, states);
    }
    if (currentTime > checkpoints.back().time + 1e-12) {
        checkpoints.push_back({createUuid(), currentTime, states, captureProviderStates()});
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
         << ",\"targetTime\":" << targetTime << ",\"globalTimeStep\":" << globalTimeStep << ",\"outputInterval\":" << outputInterval
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
    for (const auto& [appliedTime, command] : runControl.interventions) {
        auto* intervention = result.add_interventions();
        intervention->set_applied_time(appliedTime);
        if (command.has_set_parameter_value()) *intervention->mutable_set_value() = command.set_parameter_value();
        else *intervention->mutable_schedule() = command.schedule_parameter_value();
    }
    for (const auto stateId : stateIds) result.mutable_state_table()->add_states()->set_state_id(stateId);
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
            encoded->set_solver_kind("explicitEuler");
            encoded->set_solver_version(1);
            for (const auto stateId : stateIds) {
                encoded->add_values(checkpoint.states.at(executionPlan.stateIndexes.at(stateId)));
            }
            for (const auto& [nodeId, payload] : checkpoint.providerStates) {
                auto* providerState = encoded->add_provider_states();
                providerState->set_node_id(nodeId);
                providerState->set_payload(std::string(reinterpret_cast<const char*>(payload.data()), payload.size()));
            }
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
    settleAlgebraicStates(executionPlan, states, runControl.parameterValues, currentTime, globalTimeStep, providerRuntime.get(), runControl.activeSchedules);
    evaluateAlgebraicRelationships(executionPlan, states, runControl.parameterValues, runControl.activeSchedules, currentTime);
    if (!samples.empty() && samples.back().time == currentTime) samples.back().states = states;
    if (!checkpoints.empty() && checkpoints.back().time == currentTime) checkpoints.back().states = states;
}

// One global step: every node integrated from the step's starting snapshot by the execution backend, the results gathered into
// the state vector, then the algebraic relationships set at the step's end and the stability monitor told. `elapsed` is the
// time the step ends at, worked out by the caller from the step count rather than by adding steps up.
void Simulation::integrateStep(std::size_t step, double synchronizationStep, double elapsed) {
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
        metrics.computeNanoseconds += result.computeNanoseconds;
    }
    const auto synchronizationElapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now() - synchronizationStartedAt).count();
    synchronizationComputeNanoseconds += static_cast<std::uint64_t>(std::max<std::int64_t>(0, synchronizationElapsed));
    states = std::move(synchronizedStates);
    currentTime = elapsed;
    // The states algebraic relationships set, from the states the step reached, at its end: every
    // node reads them from the next step's synchronization snapshot.
    evaluateAlgebraicRelationships(executionPlan, states, runControl.parameterValues, runControl.activeSchedules, currentTime);
    if (!stabilityMonitoredNodeIds.empty()) {
        auto newFindings = stabilityMonitor->observeGlobalStep(states, currentTime);
        stabilityFindings.insert(stabilityFindings.end(),
            std::make_move_iterator(newFindings.begin()), std::make_move_iterator(newFindings.end()));
    }
}

// Real-time and limited-ratio pacing: waits out what is left of the step's share of wall time, reading commands meanwhile.
void Simulation::paceStep(std::chrono::steady_clock::time_point wallStepStarted, double synchronizationStep) {
    while (pacing.mode != PacingMode::fastest) {
        const auto targetDuration = std::chrono::duration<double>(synchronizationStep / pacing.ratio);
        const auto spent = std::chrono::steady_clock::now() - wallStepStarted;
        if (spent >= targetDuration) break;
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(targetDuration - spent);
        pacingWait(std::min(remaining, std::chrono::milliseconds(20)));
        refreshRunControl(true);
        pacing = runControl.pacing;
        if (runControl.executionState != RunState::running) break;
    }
}

// At an output boundary (and at the last step): the sample, a checkpoint, and now and then the result file.
void Simulation::recordStepOutput(std::size_t step, double elapsed) {
    if (!(elapsed + 1e-12 >= nextOutputTime || step + 1 == steps)) return;
    samples.push_back({elapsed, states});
    appendStreamRecord("sample", elapsed, states);
    // A checkpoint is captured at every output boundary (not only the final step) so any
    // displayed sample is forkable, matching the documented design intent (see "Result
    // output samples already occur at global synchronization boundaries" in
    // docs/resultExploration.md's "Checkpoints and reproducibility" section) -- previously
    // only the first and last checkpoints existed for an uninterrupted run, so "Fork here"
    // at an arbitrary scrubbed time silently snapped to the nearest of just those two.
    if (elapsed > checkpoints.back().time + 1e-12) {
        checkpoints.push_back({createUuid(), elapsed, states, captureProviderStates()});
        appendStreamRecord("checkpoint", elapsed, states, checkpoints.back().uuid);
    }
    while (nextOutputTime <= elapsed + 1e-12) nextOutputTime += outputInterval;
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

// The algebraic states set again for the instant, as a run does when it starts or resumes from a checkpoint.
void Simulation::settleAt(double time) {
    settleAlgebraicStates(executionPlan, states, runControl.parameterValues, time, globalTimeStep, providerRuntime.get(), runControl.activeSchedules);
    evaluateAlgebraicRelationships(executionPlan, states, runControl.parameterValues, runControl.activeSchedules, time);
}

void Simulation::restoreProviderStates(const std::vector<std::pair<EntityId, std::vector<std::byte>>>& providerStates) {
    for (const auto& [nodeId, payload] : providerStates) {
        const auto node = std::find_if(executionPlan.nodes.begin(), executionPlan.nodes.end(),
            [&](const auto& candidate) { return candidate.nodeId == nodeId; });
        if (node == executionPlan.nodes.end() || !node->nodeProvider) throw std::runtime_error("A saved provider state names a node with no provider.");
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
        settleIfParametersChanged();
        const double elapsed = baseTime + static_cast<double>(stepsSinceBase + 1) * globalTimeStep;
        integrateStep(stepCounter++, globalTimeStep, elapsed);
        ++stepsSinceBase;
        if (stepsSinceBase % outputSteps == 0) {
            batch->add_times(elapsed);
            for (const auto index : reportedIndexes) batch->add_values(states[index]);
            if (batch->times_size() >= 4096) flush();
        }
        if (const auto key = takeCheckpoints ? checkpointKey(elapsed) : -1; key >= 0) {
            sessionCheckpoints[key] = Checkpoint{createUuid(), elapsed, states, captureProviderStates()};
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
    for (const auto& [index, value] : overrides) states[index] = value;
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
    const auto providerNodes = std::count_if(executionPlan.nodes.begin(), executionPlan.nodes.end(), [](const auto& node) { return node.nodeProvider.has_value(); });
    if (command.provider_states_size() != providerNodes) throw std::runtime_error("The state to restore needs the saved state of every node provider.");
    std::vector<std::pair<EntityId, std::vector<std::byte>>> providerStates;
    for (const auto& item : command.provider_states()) {
        const auto* bytes = reinterpret_cast<const std::byte*>(item.payload().data());
        providerStates.emplace_back(item.node_id(), std::vector<std::byte>(bytes, bytes + item.payload().size()));
    }
    const auto& stateIds = executionPlan.stateIds;
    for (std::size_t index = 0; index < stateIds.size(); ++index) states[executionPlan.stateIndexes.at(stateIds[index])] = command.values(static_cast<int>(index));
    restoreProviderStates(providerStates);
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
    if (existing == runControl.activeSchedules.end()) {
        if (kept.empty()) return;
        ParameterSchedule schedule;
        schedule.parameterId = command.parameter_id();
        schedule.mode = ParameterSchedule::Mode::piecewise;
        schedule.hold = true;
        schedule.input = true;
        schedule.startTime = kept.front().first;
        schedule.samples = std::move(kept);
        runControl.activeSchedules.push_back(std::move(schedule));
        return;
    }
    if (kept.empty()) {
        runControl.activeSchedules.erase(existing);
        return;
    }
    existing->samples = std::move(kept);
    existing->startTime = std::min(existing->startTime, existing->samples.front().first);
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
    }
    writeFramedEvent(*eventStream, event);
}

// Answers commands, one at a time and in order, until the control stream closes. A command that cannot be carried out is
// answered with the reason and changes nothing, and the commands after it in the same batch are not carried out.
void Simulation::serveSession() {
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
        simulation.paceStep(wallStepStarted, synchronizationStep);
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
