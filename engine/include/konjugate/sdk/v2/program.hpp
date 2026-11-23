/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// Version 2 of Konjugate's program SDK (docs/programs.md, "Writing a program"; docs/proposals/programSdkV2.md). Header-only, standard
// C++20, no dependency: code export pastes this header into the programs it writes, so its comments travel with them.
//
// A program is a class derived from Relationship (one output: an interaction term on a relationship, or a node's own part) or Node
// (several outputs for one node). It declares, as members, each written once:
//
//   k::Input     hot     {this, "hot", "K"};                 // a value bound to a state (or the time)
//   k::Parameter g       {this, "conductance", "W/K"};       // a value bound to a parameter; may change while running
//   k::Constant  kp      {this, "kp", "W/K"};                // a parameter fixed for the run; initialize() may read it
//   k::Output    warming {this, "warming", "K/s"};           // what the program computes
//   k::Clock     clock   {this, 0.01};                       // advance() every 10 ms rather than every accepted step
//   k::Memory<double> integral{this, "integral", 0.0, "K*s"}; // what it remembers between steps
//
// The quoted key is what the project file binds; the unit is checked when the run starts ("" means not checked), and a compatible
// unit is converted at the port (°C bound to a K input arrives in K). A port is an index into the arrays the engine passes, so x[hot]
// is an array read and a misspelt port is a compile error.
//
// What each call may do:
//
//   construction   once per instance        declare ports, memory and a clock          read anything; its result is the description
//   initialize()   once per instance,       read constants, open and read files,       write anything another run would see
//                  before the run and       allocate, set members and memory's
//                  before a restore         starting values
//   evaluate()     any number of times      compute                                    change anything; do I/O
//   advance()      once per accepted step   change memory                              do I/O (a fork from an earlier checkpoint
//                  or clock tick                                                       repeats it)
//   shutdown()     once                     release what initialize() took             throw
//
// evaluate() may be called at any stage of any method, for steps that will be rejected and for states perturbed for a Jacobian; it
// must give the same outputs for the same (t, inputs, memory). Memory changes only in advance(), which the engine calls once per
// accepted step (never for a stage or a rejected step), or once per tick of a declared clock; the engine saves and restores memory
// itself, in every checkpoint. A quantity that changes continuously (an analogue integrator, a filter) is a node's state that an
// output drives, not memory: the method then integrates it to its own order, where memory advanced once a step is first order.

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <exception>
#include <initializer_list>
#include <memory>
#include <optional>
#include <source_location>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace konjugate::sdk::v2 {

class Program;
class Input;
class Output;

namespace detail {

// What a declaration registers with its program: the description the engine reads, built by construction.
enum class PortKind : std::uint8_t { input, parameter, constant, output };
enum class MemoryType : std::uint8_t { real = 0, integer = 1, flag = 2, reals = 3, random = 4 };

struct PortRecord {
    PortKind kind = PortKind::input;
    std::string key;
    std::string unit;
    bool hasDefault = false;
    double defaultValue = 0.0;
    // An output's declared dependencies, as indexes among the program's inputs (empty: every input).
    std::vector<std::size_t> dependsOn;
    bool declaresDependencies = false;
};

struct MemoryRecord {
    std::string name;
    MemoryType type = MemoryType::real;
    std::size_t count = 1;    // reals: the array's length; one otherwise
    std::size_t offset = 0;   // bytes from the start of the instance's memory, a multiple of 8
    std::string unit;
    std::vector<std::byte> initial;
};

struct Registry {
    std::vector<PortRecord> inputs;    // inputs, parameters and constants, in declaration order: one index space
    std::vector<PortRecord> outputs;
    std::vector<MemoryRecord> memory;
    std::size_t memorySize = 0;
    double clockPeriod = 0.0;          // 0: no clock
    std::optional<std::size_t> clockConstant;
};

Registry& registryOf(Program* program);

// splitmix64's finaliser, exactly as the engine's noise schedules use it (mixBits in executionPlan.cpp).
constexpr std::uint64_t mixBits(std::uint64_t value) noexcept {
    value += 0x9E3779B97F4A7C15ULL;
    value = (value ^ (value >> 30U)) * 0xBF58476D1CE4E5B9ULL;
    value = (value ^ (value >> 27U)) * 0x94D049BB133111EBULL;
    return value ^ (value >> 31U);
}

// FNV-1a over a field's name: part of a Random stream's seed.
constexpr std::uint64_t nameHash(std::string_view name) noexcept {
    std::uint64_t hash = 0xCBF29CE484222325ULL;
    for (const char character : name) {
        hash ^= static_cast<std::uint8_t>(character);
        hash *= 0x100000001B3ULL;
    }
    return hash;
}

}

// An input that may be left unbound, reading `value` when it is: k::Input load{this, "load", "W", k::optional(0.0)}.
struct Default {
    double value;
};
constexpr Default optional(double value) noexcept { return {value}; }

// A port: a key the project file binds, an optional unit, and its place in the arrays the engine passes.
class Port {
public:
    [[nodiscard]] std::size_t index() const noexcept { return index_; }
    [[nodiscard]] const char* key() const noexcept { return key_; }

protected:
    Port(std::size_t index, const char* key) noexcept : index_(index), key_(key) {}

private:
    std::size_t index_;
    const char* key_;
};

class Input : public Port {
public:
    Input(Program* owner, const char* key, const char* unit = "", std::optional<Default> fallback = {});

protected:
    Input(Program* owner, detail::PortKind kind, const char* key, const char* unit, std::optional<Default> fallback);
};

// A value bound to a parameter, read at every call; it may change between steps (live control, a recorded intervention) or within
// one (a schedule, read at the stage's time).
class Parameter : public Input {
public:
    Parameter(Program* owner, const char* key, const char* unit = "", std::optional<Default> fallback = {})
        : Input(owner, detail::PortKind::parameter, key, unit, fallback) {}
};

// A parameter fixed for the run: never offered as live or scheduled, readable in initialize(). Changing it starts the program again.
class Constant : public Input {
public:
    Constant(Program* owner, const char* key, const char* unit = "", std::optional<Default> fallback = {})
        : Input(owner, detail::PortKind::constant, key, unit, fallback) {}
};

// The inputs an output depends on, when not every one: k::Output warming{this, "warming", "K/s", k::dependsOn(hot, cold)}. It sharpens
// the sparsity a stiff method's Jacobian is worked out on; an output that reads an input it does not declare is wrong silently, so
// declare it only when sure.
struct Dependencies {
    std::vector<std::size_t> inputs;
};
template <class... Ports>
Dependencies dependsOn(const Ports&... ports) {
    return Dependencies{{ports.index()...}};
}

class Output : public Port {
public:
    Output(Program* owner, const char* key, const char* unit = "");
    Output(Program* owner, const char* key, const char* unit, Dependencies dependencies);
};

// advance() at t = start, start + period, start + 2 period, ... rather than at every accepted step. The period must be a whole number
// of the run's global steps.
class Clock {
public:
    Clock(Program* owner, double period);
    Clock(Program* owner, const Constant& period);
};

// A random stream whose whole state is a seed and a counter, kept in memory: the engine seeds it from the program's place in the model
// (and the program's optional seed), so runs repeat, instances differ, and a resumed run or a fork draws the same numbers. Drawing
// changes it, so it can be drawn only in advance() (through a MemoryWriter), never in evaluate().
class Random {
public:
    std::uint64_t bits() noexcept {
        ++counter_;
        return detail::mixBits(seed_ + counter_ * 0x9E3779B97F4A7C15ULL);
    }
    // In [0, 1).
    double uniform() noexcept { return static_cast<double>(bits() >> 11U) * 0x1.0p-53; }
    // Mean 0, standard deviation 1: Box–Muller on two draws, nothing cached.
    double normal() noexcept {
        const double first = uniform();
        const double second = uniform();
        return std::sqrt(-2.0 * std::log(1.0 - first)) * std::cos(6.283185307179586 * second);
    }
    [[nodiscard]] std::uint64_t seed() const noexcept { return seed_; }
    [[nodiscard]] std::uint64_t counter() const noexcept { return counter_; }

private:
    std::uint64_t seed_ = 0;
    std::uint64_t counter_ = 0;
};

namespace detail {
template <class T>
struct MemoryTraits;
template <> struct MemoryTraits<double> { static constexpr MemoryType type = MemoryType::real; static constexpr std::size_t count = 1; };
template <> struct MemoryTraits<std::int64_t> { static constexpr MemoryType type = MemoryType::integer; static constexpr std::size_t count = 1; };
template <> struct MemoryTraits<bool> { static constexpr MemoryType type = MemoryType::flag; static constexpr std::size_t count = 1; };
template <std::size_t N> struct MemoryTraits<std::array<double, N>> { static constexpr MemoryType type = MemoryType::reals; static constexpr std::size_t count = N; };
template <> struct MemoryTraits<Random> { static constexpr MemoryType type = MemoryType::random; static constexpr std::size_t count = 1; };

std::size_t registerMemory(Program* owner, const char* name, MemoryType type, std::size_t count, std::size_t bytes, const char* unit,
                           const void* initial);
}

// Something the program remembers between steps: a real, an integer, a flag, a fixed array of reals or a Random stream. It is read in
// evaluate() and advance() through Inputs (x[integral]) and changed only in advance() and initialize() through a MemoryWriter
// (m[integral] = ...). The engine keeps it, and saves and restores it with every checkpoint; nothing needs writing to save it.
template <class T>
class Memory {
    static_assert(std::is_same_v<T, double> || std::is_same_v<T, std::int64_t> || std::is_same_v<T, bool> ||
                  std::is_same_v<T, Random> || detail::MemoryTraits<T>::type == detail::MemoryType::reals,
                  "Memory holds a double, a std::int64_t, a bool, a std::array<double, N> or a Random.");

public:
    Memory(Program* owner, const char* name, T initial = T{}, const char* unit = "")
        : offset_(detail::registerMemory(owner, name, detail::MemoryTraits<T>::type, detail::MemoryTraits<T>::count, sizeof(T), unit, &initial)) {}
    [[nodiscard]] std::size_t offset() const noexcept { return offset_; }

private:
    std::size_t offset_;
};

// What evaluate(), advance() and jacobian() read: the inputs at the stage, the parameters and constants, and memory. Read-only.
class Inputs {
public:
    Inputs(const double* values, const std::byte* memory, const unsigned char* bound) noexcept
        : values_(values), memory_(memory), bound_(bound) {}

    double operator[](const Input& port) const noexcept { return values_[port.index()]; }
    template <class T>
    const T& operator[](const Memory<T>& field) const noexcept {
        return *std::launder(reinterpret_cast<const T*>(memory_ + field.offset()));
    }
    // False for an input with a default that nothing is bound to.
    [[nodiscard]] bool bound(const Input& port) const noexcept { return bound_ == nullptr || bound_[port.index()] != 0; }

private:
    const double* values_;
    const std::byte* memory_;
    const unsigned char* bound_;
};

// What a node program's evaluate() writes: every declared output, at every call.
class Outputs {
public:
    explicit Outputs(double* values) noexcept : values_(values) {}
    double& operator[](const Output& port) noexcept { return values_[port.index()]; }

private:
    double* values_;
};

// Memory as advance() and initialize() may change it.
class MemoryWriter {
public:
    explicit MemoryWriter(std::byte* memory) noexcept : memory_(memory) {}
    template <class T>
    T& operator[](const Memory<T>& field) noexcept {
        return *std::launder(reinterpret_cast<T*>(memory_ + field.offset()));
    }

private:
    std::byte* memory_;
};

// What jacobian() writes: the derivative of an output with respect to an input, J(warming, hot) = ...; an entry left unwritten is 0.
class Jacobian {
public:
    Jacobian(double* values, std::size_t inputCount) noexcept : values_(values), inputCount_(inputCount) {}
    double& operator()(const Output& output, const Input& input) noexcept { return values_[output.index() * inputCount_ + input.index()]; }
    // Called by the default jacobian(): this program gives none, and the engine differences it instead.
    void notProvided() noexcept { provided_ = false; }
    [[nodiscard]] bool provided() const noexcept { return provided_; }

private:
    double* values_;
    std::size_t inputCount_;
    bool provided_ = true;
};

struct Step {
    double time;   // the end of the accepted step, or the clock's tick
    double size;   // the accepted step's size, or the clock's period; under an adaptive method it varies with the tolerance
    bool first;    // the first advance() of a run (not of a run continued from a checkpoint)
};

struct Setup {
    std::uint64_t instanceId = 0;
    std::string_view owner;        // "node Heater", "relationship Wall → Room": for messages
    double startTime = 0.0;
    const double* values = nullptr; // every input's value at the start; constants are read through operator[]
    double operator[](const Constant& constant) const noexcept { return values[constant.index()]; }
};

// Thrown by evaluate(): "these inputs are outside what I can compute". Under Adaptive and Stiff the step is rejected and tried
// smaller; under Euler and Runge–Kutta 4 the run stops with the message.
class OutOfDomain : public std::runtime_error {
public:
    explicit OutOfDomain(std::string message, std::source_location where = std::source_location::current())
        : std::runtime_error(std::move(message)), line_(where.line()) {}
    [[nodiscard]] std::uint_least32_t line() const noexcept { return line_; }

private:
    std::uint_least32_t line_;
};

// What fail() throws: the run stops with the message and this line.
class Failure : public std::runtime_error {
public:
    Failure(std::string message, std::uint_least32_t line) : std::runtime_error(std::move(message)), line_(line) {}
    [[nodiscard]] std::uint_least32_t line() const noexcept { return line_; }

private:
    std::uint_least32_t line_;
};

// Stops the run with a message that names this line.
[[noreturn]] inline void fail(std::string message, std::source_location where = std::source_location::current()) {
    throw Failure(std::move(message), where.line());
}

class Program {
public:
    Program(const Program&) = delete;
    Program& operator=(const Program&) = delete;
    Program(Program&&) = delete;
    Program& operator=(Program&&) = delete;
    virtual ~Program() = default;

    // Once per instance, before the run (and before a checkpoint is restored). May read constants, fill members (tables, precomputed
    // constants) and set memory's starting values.
    virtual void initialize(const Setup&, MemoryWriter&) {}

    // Once per accepted step, or at each clock tick: the only place memory changes.
    virtual void advance(const Step&, const Inputs&, MemoryWriter&) const {}

    // The derivatives of the outputs with respect to the inputs, optional: a stiff method uses them in place of differences. The
    // harness checks them against differences.
    virtual void jacobian(double, const Inputs&, Jacobian& J) const { J.notProvided(); }

    virtual void shutdown() noexcept {}

    // The description built by the declarations; for the engine and the harness.
    [[nodiscard]] const detail::Registry& registry() const noexcept { return registry_; }

protected:
    Program() = default;

private:
    friend detail::Registry& detail::registryOf(Program*);
    detail::Registry registry_;
};

// One output: an interaction term on a relationship, or a node's own part.
class Relationship : public Program {
public:
    // The one declared output's value at time t. Called at every stage, any number of times.
    virtual double evaluate(double t, const Inputs& x) const = 0;
};

// Several outputs for one node.
class Node : public Program {
public:
    // Every declared output's value at time t, written through y. Called at every stage, any number of times.
    virtual void evaluate(double t, const Inputs& x, Outputs& y) const = 0;
};

namespace detail {

inline Registry& registryOf(Program* program) { return program->registry_; }

inline std::size_t addPort(Program* owner, PortKind kind, const char* key, const char* unit, std::optional<Default> fallback,
                           Dependencies* dependencies = nullptr) {
    auto& registry = registryOf(owner);
    PortRecord record;
    record.kind = kind;
    record.key = key ? key : "";
    record.unit = unit ? unit : "";
    if (fallback) {
        record.hasDefault = true;
        record.defaultValue = fallback->value;
    }
    if (dependencies) {
        record.declaresDependencies = true;
        record.dependsOn = std::move(dependencies->inputs);
    }
    auto& list = kind == PortKind::output ? registry.outputs : registry.inputs;
    list.push_back(std::move(record));
    return list.size() - 1;
}

inline std::size_t registerMemory(Program* owner, const char* name, MemoryType type, std::size_t count, std::size_t bytes, const char* unit,
                                  const void* initial) {
    auto& registry = registryOf(owner);
    MemoryRecord record;
    record.name = name ? name : "";
    record.type = type;
    record.count = count;
    record.offset = registry.memorySize;
    record.unit = unit ? unit : "";
    // Each field takes whole 8-byte slots, so the layout is the same in every language: a flag in its slot's first byte, a Random as
    // its seed then its counter.
    const std::size_t slots = type == MemoryType::random ? 2 : type == MemoryType::reals ? count : 1;
    record.initial.assign(slots * 8, std::byte{0});
    std::memcpy(record.initial.data(), initial, bytes);
    registry.memorySize += slots * 8;
    registry.memory.push_back(std::move(record));
    return registry.memory.back().offset;
}

}

inline Input::Input(Program* owner, const char* key, const char* unit, std::optional<Default> fallback)
    : Port(detail::addPort(owner, detail::PortKind::input, key, unit, fallback), key) {}
inline Input::Input(Program* owner, detail::PortKind kind, const char* key, const char* unit, std::optional<Default> fallback)
    : Port(detail::addPort(owner, kind, key, unit, fallback), key) {}
inline Output::Output(Program* owner, const char* key, const char* unit)
    : Port(detail::addPort(owner, detail::PortKind::output, key, unit, std::nullopt), key) {}
inline Output::Output(Program* owner, const char* key, const char* unit, Dependencies dependencies)
    : Port(detail::addPort(owner, detail::PortKind::output, key, unit, std::nullopt, &dependencies), key) {}
inline Clock::Clock(Program* owner, double period) { detail::registryOf(owner).clockPeriod = period; }
inline Clock::Clock(Program* owner, const Constant& period) { detail::registryOf(owner).clockConstant = period.index(); }

// A Random stream's seed: from the program instance's place in the model (`owner`, the id of its node, relationship or term), the
// program's optional seed and the field's name. Exactly this in every language and every exported program.
constexpr std::uint64_t randomSeed(std::uint64_t owner, std::uint64_t programSeed, std::string_view field) noexcept {
    return detail::mixBits(detail::mixBits(owner ^ detail::mixBits(programSeed)) ^ detail::nameHash(field));
}

// Sets a Random field's seed and counter, as the engine and the harness do before initialize().
inline void seedRandom(std::byte* memory, std::size_t offset, std::uint64_t seed, std::uint64_t counter = 0) noexcept {
    std::memcpy(memory + offset, &seed, sizeof seed);
    std::memcpy(memory + offset + 8, &counter, sizeof counter);
}

} // namespace konjugate::sdk::v2

// The one factory every version 2 source defines, whichever kind it is.
std::unique_ptr<konjugate::sdk::v2::Program> createProgram();
