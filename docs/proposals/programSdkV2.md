---
type: Proposal
title: Program SDK version 2
description: A second version of the C++ and Python program SDK in which evaluate() only computes outputs, memory is declared as named, typed fields that change only in advance() once per accepted step (or on a declared clock) and that the engine saves and restores itself, and ports are declared once with units and checked at load; so a program's purity follows from its shape, every program can take part in Runge-Kutta 4, Dormand-Prince and Rodas4 stages, checkpoints cannot forget a field, and typos fail at load by name. Also the further hazards of this kind found in today's SDK and the design's answer to each, how the engine calls programs under every method, automatic memory checkpoints, migration from version 1, which keeps working unchanged, documentation, backwards compatibility and staged delivery.
tags: [proposals, engine, sdk, providers, programs, integrators, checkpoints, python, cpp]
status: draft
implementation: none
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Program SDK version 2

**Status: accepted 23 November 2026, with all nine of its open questions decided as recommended (see [Decisions](#decisions)); not yet built. It builds on [Integrators](integrators.md) (whole-model stages, held programs) and [Rates and updates](ratesAndUpdates.md) (Rate and Update states), and replaces the `pure` declaration the integrators proposal planned for version 1 (decision 1).**

## The problem

A term or a node written as a program (C++ or Python, inline or from a plugin) is written today against version 1 of the SDK: `engine/include/konjugate/relationshipProvider.hpp` (`konjugate::sdk::v1::RelationshipProvider` and `NodeProvider`) and its Python mirror `engine/sdk/python/konjugate/__init__.py`, run in-process through `providerInProcessAbi.hpp`, over shared memory (`providerSharedMemoryChannel.hpp`) or over framed protobuf on a pipe (`protocol/relationshipProvider.proto`; the messages are protobuf, the transport is a pipe, not a gRPC service), and in the web edition through Pyodide (`_webBridge.py`). It works, and it was right for the one integrator Konjugate had. It is wrong for the integrators that are coming, and three problems were named before this proposal was written. Each is real; here is where each lives.

**1. Memory is hidden.** `RelationshipProvider::evaluate(const EvaluationContext&, OutputCollector&)` and `NodeProvider::evaluate(...)` are non-const, and the Python `evaluate(self, context, inputs, outputs)` has `self`. A program may keep anything in its members, and [Rates and updates](ratesAndUpdates.md#terms) says it may ("Programs may keep memory of their own… called exactly once per substep, never twice for one instant, its memory needs no special care"). That promise is exactly what a whole-model method breaks: Runge–Kutta 4 calls a term four times a step, Dormand–Prince six or seven and again for a rejected step, Rodas4 once per Jacobian colour besides. A program that does `integral_ += error * context.stepSize` in `evaluate()` would integrate four to forty times too fast, silently. The engine cannot tell from outside whether a program keeps memory, so the integrators proposal had to hold every version 1 program (once per global step, first-order coupling) unless its author declared `pure`, and a wrong declaration corrupts results with no symptom.

**2. Checkpoints are hand-written bytes.** `NodeProvider::checkpoint()` returns `std::vector<std::byte>` (Python `bytes`) that the author serialises by hand, and `restore()` reads back. A field added to the class and not to `checkpoint()` makes a fork, a resumed run, a live twin's rewind and every state-estimator member (which go back to a checkpoint at each anchor, [State estimator](stateEstimator.md)) diverge from the run they continue, with nothing to say so. Worse, relationship programs have no checkpoint at all: `ResultCheckpoint.provider_states` (`protocol/engineProtocol.proto`) is keyed by `node_id` and carries only node providers, so a relationship or source-term program that keeps memory, which Rates and updates permits, loses it on every resume and fork, and the estimator's members inherit one another's.

**3. Ports are string-keyed.** `context.inputs.at("sourceTemperature")`, `inputs["sourceTemperature"]` and `outputs.addGradient("command", value)` look ports up by string at every call. A typo in an input key throws only when that line runs (`InputView::at` raises "Unknown relationship-provider input key", not naming the key); a typo in a node output's key is found only when the engine maps the result back ("A computational-node provider returned an undeclared output key"). And the port lists are themselves written twice: once in `describe()` and once in every lookup.

Reading the code for these turned up more of the same kind, verified in the source:

- **One Python object serves every instance.** `__main__.py`'s `_load_provider_class` constructs one provider object per worker, and one worker serves every instance sharing a source; `handle_initialize` calls `initialize()` on the same object for each instance, and `handle_checkpoint` calls `provider.checkpoint()` with no instance at all. Two nodes running the same Python node program share one integral and checkpoint the same bytes. (The C++ in-process node shim does construct one object per instance; the C++ relationship shim, `providerInProcessShim.cpp`, shares one object across every edge using the source, which is safe only while relationship programs keep no memory, which nothing enforces.)
- **Unbound inputs read zero.** Both `providerInProcessNodeShim.cpp` (`std::fill(scratchValues, 0.0)`) and `__main__.py`'s `_ordered_inputs` give a declared input that nothing is bound to the value 0.0, without a word.
- **Outputs left unset count as zero.** The node shim fills the output buffer with zeros and notes that a provider may "omit an output it did not contribute to this step, defaulting it to 0"; a Python program that forgets `return` or an `add_gradient` call contributes nothing, silently.
- **`stepSize` is passed to `evaluate()`.** `EvaluationContext::stepSize` invites code whose meaning depends on the step: `(target - current) / stepSize` (which `setsValue` once used, [Interaction providers](../interactionProviders.md)), or an integral advanced by it. Under a whole-model method there is no single step a stage belongs to.
- **Non-finite outputs are reported without a name.** `executionPlan.cpp` throws "A contribution task produced a non-finite derivative." and "A computational-node provider produced a non-finite value.", naming neither the program, the node or edge, the port, the time nor the inputs.
- **The hot path allocates.** `NodeOutputCollector::addGradient` builds a `std::string` per call, and the Python worker builds a dict per evaluation.
- **The shared-memory transport has fixed capacity.** `kMaxInputsPerSlot = 16`: a program with a seventeenth input fails at its first evaluation over that transport ("exceeds the shared-memory transport's fixed capacity").

This proposal fixes all of these for programs written against a version 2 of the SDK, keeps version 1 exactly as it is, and answers the wider list of hazards a program author or the engine can meet, in [Further hazards](#further-hazards-and-the-designs-answer-to-each).

## Decisions in brief

1. **`evaluate()` only computes.** In C++ it is a `const` method that receives the time and a read-only view of its inputs, parameters and memory, and writes outputs; in Python it receives the time and the same read-only view and returns its outputs. It gets nothing it can change, and it is never given a step size.
2. **Memory is declared**: named, typed fields (a real, an integer, a flag, a fixed array of reals, a random-number stream). It changes only in **`advance()`**, which the engine calls once per **accepted** step, never for a rejected step or a stage, or, for a program that declares a **clock**, at every tick of that clock. The engine knows the layout, so it saves and restores memory itself; there is no `checkpoint()` or `restore()` to write.
3. **Continuous memory is a state, not memory.** A quantity that evolves continuously (an analogue integrator, a filter) is a node state that the program's output drives, integrated by the method at every stage; declared memory is for what is truly discrete (a digital controller's samples, a latch, a counter, a random stream). The guide and the templates say so, because it decides whether a program is first order or as accurate as the method.
4. **Ports are declared once**, as members (C++) or class attributes (Python), each with an optional unit and an optional default. Code refers to a port by its identifier, so a typo is a compile error (C++) or an error at load naming the port and listing the real ones (Python). Every declared input must be bound unless it declares a default; every output must be set by every call. Units are checked at load, converted at the port where they are compatible, and refused by name where not.
5. **Purity follows from the shape; there is no flag.** A version 2 program joins the stages of every method. A version 1 program is held under a whole-model method, as the integrators proposal says, always: no `pure` declaration is added to version 1.
6. **One object per instance, frozen after `initialize()`**, in both languages and every transport, so two nodes never share a program's members, and instances can later be evaluated concurrently.
7. **Version 1 keeps working unchanged** beside version 2 (`konjugate::sdk::v2`, `<konjugate/sdk/v2/program.hpp>`; Python `konjugate.v2`). A program says which it is through `providerApiVersion: 2`, which every released engine already refuses by name; the engine checks the source agrees.
8. **Errors name the program, its node or relationship, the port, the time, the stage and the inputs**, and point at the line. Non-finite outputs and exceptions fail the run; an explicit `OutOfDomain` asks an adaptive method to reject the step instead. Nothing is ever clamped.
9. **A small harness** in both languages lets an author call `evaluate()` and `advance()` outside Konjugate and check purity, the memory round trip and the ports; the app's **Check program** runs the same checks.

## The shape of a version 2 program

### Two kinds, one base

A **relationship program** computes one output: an interaction term on a relationship or a source term on a node. A **node program** computes several outputs for one node, as a computational-node provider does today. Both may declare memory and a clock; Rates and updates already lets a relationship's program keep memory, and stick-slip friction or a hysteretic contact needs it. What a program's output means follows the state it is bound to, as Rates and updates says of every term: bound to a Rate state, the output is a rate, read at every stage; bound to an Update state, it is a value, read at the update instant (the end of each global step). The program does not declare which; it declares a unit, and the unit is checked against the state's (a rate's unit is the state's per second).

### C++

The public header is `engine/include/konjugate/sdk/v2/program.hpp`: header-only, standard C++20, no dependency, as version 1's is. Abridged to what an author sees:

```cpp
namespace konjugate::sdk::v2 {

// ---- Declarations: members of a program, each declared once. ----------------------------------
// The quoted key is what the project file binds; the unit is checked at load ("" means not checked).

struct Default { double value; };                       // an input that may be left unbound
constexpr Default optional(double value) { return {value}; }

class Input     { public: Input(Program* owner, const char* key, const char* unit = "", std::optional<Default> = {}); };
class Parameter { public: Parameter(Program* owner, const char* key, const char* unit = "", std::optional<Default> = {}); };
class Constant  { public: Constant(Program* owner, const char* key, const char* unit = "", std::optional<Default> = {}); };
class Output    { public: Output(Program* owner, const char* key, const char* unit = ""); };

// advance() at t = 0, period, 2 period, ... rather than at every accepted step.
class Clock {
public:
    Clock(Program* owner, double period);
    Clock(Program* owner, const Constant& period);       // the period read from a bound constant
};

// T is double, std::int64_t, bool, std::array<double, N> or Random.
template <class T> class Memory {
public:
    Memory(Program* owner, const char* name, T initial = T{}, const char* unit = "");
};

// A random stream whose whole state is one counter in memory (splitmix64, the generator the engine's
// noise schedules use), seeded by the engine. Drawing changes it, so it can only be drawn in advance().
class Random {
public:
    double uniform();            // [0, 1)
    double normal();             // mean 0, standard deviation 1
    std::uint64_t bits();
};

// ---- What each call receives. -----------------------------------------------------------------

class Inputs {                   // read-only: inputs at the stage, parameters, constants, memory
public:
    double operator[](const Input&) const;
    double operator[](const Parameter&) const;
    double operator[](const Constant&) const;
    template <class T> const T& operator[](const Memory<T>&) const;
    bool bound(const Input&) const;                       // false for an optional input left unbound
};

class Outputs {                  // every declared output must be written by every evaluate()
public:
    double& operator[](const Output&);
};

class MemoryWriter {             // only advance() and initialize() receive one
public:
    template <class T> T& operator[](const Memory<T>&);
};

struct Step {
    double time;                 // the end of the accepted step, or the clock's tick
    double size;                 // the accepted step's size, or the clock's period
    bool first;                  // the first call of a run (not of a run continued from a checkpoint)
};

struct Setup {
    std::uint64_t instanceId;
    std::string_view owner;      // "node Heater", "relationship Wall → Room": for messages
    double startTime;
    double operator[](const Constant&) const;
};

// Thrown by evaluate(): "these inputs are outside what I can compute". An adaptive or stiff method rejects
// the step and tries a smaller one; a fixed-step method stops the run with the message.
class OutOfDomain : public std::exception {
public:
    OutOfDomain(std::string message, std::source_location = std::source_location::current());
};

// Stops the run with a message that names this line.
[[noreturn]] void fail(std::string message, std::source_location = std::source_location::current());

// ---- The two kinds. ---------------------------------------------------------------------------

class Program {
public:
    Program(const Program&) = delete;
    Program& operator=(const Program&) = delete;
    virtual ~Program() = default;

    // Once per instance, before the run (and before a checkpoint is restored). May read constants,
    // fill members (tables, precomputed constants) and set memory's starting values.
    virtual void initialize(const Setup&, MemoryWriter&) {}

    // Once per accepted step, or at each clock tick. The only place memory changes.
    virtual void advance(const Step&, const Inputs&, MemoryWriter&) const {}

    virtual void shutdown() noexcept {}

protected:
    Program() = default;
};

class Relationship : public Program {
public:
    // The one declared output's value at time t. Called at every stage, any number of times.
    virtual double evaluate(double t, const Inputs& x) const = 0;
};

class Node : public Program {
public:
    virtual void evaluate(double t, const Inputs& x, Outputs& y) const = 0;
};

} // namespace konjugate::sdk::v2

// The one factory every version 2 source defines, whichever kind it is.
std::unique_ptr<konjugate::sdk::v2::Program> createProgram();
```

The declarations register themselves with their owner when the object is constructed (each takes `this`), so the program's description is built from them and there is no `describe()` to keep in step. A port is an index into the arrays the engine passes, so `x[hot]` is an array read, not a search, and `hot` is an identifier the compiler checks. `evaluate()` and `advance()` are `const`: the only thing either can change is what it is handed, outputs and memory. `initialize()` is the only non-const call, and runs before anything is evaluated.

### Python

The module is `konjugate.v2` (`engine/sdk/python/konjugate/v2/`), standard library only, as version 1 is:

```python
class Input:      def __init__(self, unit="", *, name=None, default=None): ...
class Parameter:  def __init__(self, unit="", *, name=None, default=None): ...
class Constant:   def __init__(self, unit="", *, name=None, default=None): ...
class Output:     def __init__(self, unit="", *, name=None): ...
class Clock:      def __init__(self, period): ...          # a number of seconds, or a Constant
class Memory:     def __init__(self, initial=0.0, *, unit=""): ...   # float, int, bool or a list of floats (fixed length)
class Random:     ...                                      # .uniform(), .normal(), .bits(); drawn only in advance()

class Step:       time: float; size: float; first: bool
class Setup:      instance_id: int; owner: str; start_time: float   # constants as attributes: setup.kp

class OutOfDomain(Exception): ...

class Program:
    def initialize(self, setup, m): ...      # may set attributes on self, and memory through m
    def advance(self, step, x, m): ...       # the only place memory changes
    def shutdown(self): ...

class Relationship(Program):
    def evaluate(self, t, x): ...            # returns the one output, a number

class Node(Program):
    def evaluate(self, t, x): ...            # returns self.outputs(name=value, ...)
```

`x` is a read-only view: `x.hot` is an input, a parameter, a constant or a memory field; assigning to it raises. `m` is the memory writer: `m.integral = ...`, `m.noise.normal()`. A port's key in the project file is its attribute name with snake_case turned into camelCase (`previous_error` binds as `previousError`), so the binding keys match the identifier rule the file already uses (`^[a-z][A-Za-z0-9]*$`, `src/providerTemplate.mjs`) and a C++ and a Python version of one program bind alike. `self.outputs(...)` is generated from the declared outputs with exactly their names as keyword parameters, so a missing or misspelt output is Python's own `TypeError`, naming it, at C speed. After `initialize()` returns, the object is frozen: `self.anything = ...` in `evaluate()` or `advance()` raises an error that says where memory belongs. (A list mutated in place through `self` is not caught by the freeze; the purity check and the editor's warnings below are for that.)

### Worked example: a pure relationship (conduction)

Heat conducted from a hot body to a cold one warms the cold one at $G\,(T_h - T_c)/C$.

```cpp
#include <konjugate/sdk/v2/program.hpp>

#include <memory>

namespace k = konjugate::sdk::v2;

namespace {

// Warms the cold side at G (Th - Tc) / C.
class Conduction final : public k::Relationship {
public:
    k::Input     hot        {this, "hot",         "K"};
    k::Input     cold       {this, "cold",        "K"};
    k::Parameter conductance{this, "conductance", "W/K"};
    k::Parameter capacity   {this, "capacity",    "J/K"};
    k::Output    warming    {this, "warming",     "K/s"};

    double evaluate(double, const k::Inputs& x) const override {
        return x[conductance] * (x[hot] - x[cold]) / x[capacity];
    }
};

}

std::unique_ptr<k::Program> createProgram() { return std::make_unique<Conduction>(); }
```

```python
from konjugate.v2 import Input, Output, Parameter, Relationship


class Conduction(Relationship):
    """Warms the cold side at G (Th - Tc) / C."""

    hot = Input("K")
    cold = Input("K")
    conductance = Parameter("W/K")
    capacity = Parameter("J/K")
    warming = Output("K/s")

    def evaluate(self, t, x):
        return x.conductance * (x.hot - x.cold) / x.capacity
```

Bound to a cold body whose temperature is in °C, `cold` is converted at the port (an offset; see [Units](#units-and-dimensions)), and `warming` in K/s into a state in °C is the same number. Bound to a state in metres, the load stops with "Input ‘cold’ of the program Conduction on the relationship Wall → Room is in K but is bound to Wall.position, in m."

### Worked example: a stateful node (a digital PID controller with a noisy sensor)

A digital controller samples its sensor on a clock, keeps an integral and the last error between samples, and holds its command until the next sample. That is discrete by nature, so its memory is exact, not an approximation: this is what declared memory is for. The sensor's noise is drawn from a seeded stream that is itself memory, so a fork, a resumed run and a rewind draw the same numbers.

```cpp
#include <konjugate/sdk/v2/program.hpp>

#include <algorithm>
#include <memory>

namespace k = konjugate::sdk::v2;

namespace {

// A PID controller sampled every 10 ms, reading a noisy temperature sensor, with anti-windup.
class PidController final : public k::Node {
public:
    k::Input     measurement{this, "measurement", "K"};
    k::Parameter setpoint   {this, "setpoint",    "K"};
    k::Constant  kp         {this, "kp",          "W/K"};
    k::Constant  ki         {this, "ki",          "W/(K*s)"};
    k::Constant  kd         {this, "kd",          "W*s/K"};
    k::Constant  maxPower   {this, "maxPower",    "W"};
    k::Constant  sensorNoise{this, "sensorNoise", "K", k::optional(0.0)};
    k::Output    power      {this, "power",       "W"};   // bound to the node's Update state "power"

    k::Clock clock{this, 0.01};                          // advance() at 0, 10 ms, 20 ms, ...

    k::Memory<double>    integral     {this, "integral",      0.0, "K*s"};
    k::Memory<double>    previousError{this, "previousError", 0.0, "K"};
    k::Memory<double>    held         {this, "held",          0.0, "W"};
    k::Memory<k::Random> noise        {this, "noise"};

    // The command is held between samples, as a real controller's output is.
    void evaluate(double, const k::Inputs& x, k::Outputs& y) const override {
        y[power] = x[held];
    }

    void advance(const k::Step& step, const k::Inputs& x, k::MemoryWriter& m) const override {
        const double measured = x[measurement] + x[sensorNoise] * m[noise].normal();
        const double error = x[setpoint] - measured;
        const double derivative = step.first ? 0.0 : (error - x[previousError]) / step.size;
        const double candidate = x[integral] + error * step.size;
        const double unclamped = x[kp] * error + x[ki] * candidate + x[kd] * derivative;
        const double command = std::clamp(unclamped, 0.0, x[maxPower]);
        if (command == unclamped) m[integral] = candidate;   // stop integrating while saturated
        m[previousError] = error;
        m[held] = command;
    }
};

}

std::unique_ptr<k::Program> createProgram() { return std::make_unique<PidController>(); }
```

```python
from konjugate.v2 import Clock, Constant, Input, Memory, Node, Output, Parameter, Random


class PidController(Node):
    """A PID controller sampled every 10 ms, reading a noisy temperature sensor, with anti-windup."""

    measurement = Input("K")
    setpoint = Parameter("K")
    kp = Constant("W/K")
    ki = Constant("W/(K*s)")
    kd = Constant("W*s/K")
    max_power = Constant("W")
    sensor_noise = Constant("K", default=0.0)
    power = Output("W")                      # bound to the node's Update state "power"

    clock = Clock(0.01)                      # advance() at 0, 10 ms, 20 ms, ...

    integral = Memory(0.0, unit="K*s")
    previous_error = Memory(0.0, unit="K")
    held = Memory(0.0, unit="W")
    noise = Random()

    def evaluate(self, t, x):
        # The command is held between samples, as a real controller's output is.
        return self.outputs(power=x.held)

    def advance(self, step, x, m):
        measured = x.measurement + x.sensor_noise * m.noise.normal()
        error = x.setpoint - measured
        derivative = 0.0 if step.first else (error - x.previous_error) / step.size
        candidate = x.integral + error * step.size
        unclamped = x.kp * error + x.ki * candidate + x.kd * derivative
        command = min(max(unclamped, 0.0), x.max_power)
        if command == unclamped:             # stop integrating while saturated
            m.integral = candidate
        m.previous_error = error
        m.held = command
```

Three things this example shows on purpose:

- **The clock makes the controller independent of the method.** Its samples are at 0, 10 ms, 20 ms whatever steps Euler, Runge–Kutta 4 or Dormand–Prince take, so the same controller gives the same commands under every method and every tolerance, and its noise is the same sequence. The period must be a whole number of global steps (validated by name, with the nearest that are offered); see [Fixed and variable steps](#time-fixed-and-variable-steps).
- **An analogue controller is written differently.** A continuous PI controller's integral is a node state: the program has an output `integralRate` bound as a rate into the node's state `integral` and an input bound to the same state, returns `integralRate = setpoint - measurement` from `evaluate()`, and declares no memory and no clock. The method then integrates it at every stage, to its own order. The template's comments and the guide make this choice explicit, because writing a continuous integral as memory advanced per step quietly makes it first order.
- **The noise needs no seed in the code.** The engine seeds each `Random` from the program instance's stable id and the field's name (see [Non-determinism](#non-determinism)), so two controllers built from one program draw different streams, and the same model run twice draws the same.

## How the engine calls a program

The rules hold for every method:

- `evaluate()` may be called any number of times, at any stage time, with any inputs, including stages of steps that will be rejected and states perturbed for a Jacobian; within a step, memory is the memory at the step's start. It must give the same outputs for the same `(t, inputs, memory)`.
- `advance()` is called exactly once per accepted step, with the step's end time, its size and the inputs at its end (the states the step reached), or, for a program with a clock, exactly once per tick, at the tick, after the global step that lands on it is accepted. It is never called for a rejected step, a stage or a Jacobian.
- Outputs into Update states are read at the update instant (the end of each global step), from `evaluate()` at the step's end with the memory `advance()` just wrote, and at the start of the run after `initialize()` (and, for a program with a clock, its first tick at the start time), as a value source term's are settled before the first step.
- A program with no memory and no clock is never sent `advance()` at all: purity costs nothing.

| Method | `evaluate()` per step | `advance()` (no clock) | Rejected steps |
| --- | --- | --- | --- |
| Euler, node by node | once per substep, at its start, reading its own states as they are and others from the snapshot (as today) | after each substep, with that substep's end and size | none |
| Runge–Kutta 4 | four stages, every program with the step's starting memory | after each internal step (`stepsPerGlobalStep` per global step) | none |
| Dormand–Prince 5(4) | six new stages (seven with the last), starting memory | after each accepted internal step | stages discarded, memory untouched, the step retried smaller |
| Rodas4 | six stages, plus one per Jacobian colour (and one for $\partial f/\partial t$), starting memory | after each accepted internal step | as Dormand–Prince |

In pseudocode, one internal step of any whole-model method:

```text
m0 = memory of every program at the step's start
for each stage k:
    Y_k = stage values of every Rate state
    for each program (batched per program source across all its instances):
        outputs = evaluate(t + c_k h, inputs gathered from Y_k, Updates held at their step-start values, m0)
    K_k = reduced contributions, in compiled order
estimate error (adaptive methods); if rejected: shrink h, go again from m0      // advance() not called
accept: y_{n+1}
for each program without a clock: memory = advance({t + h, h, first}, inputs gathered from y_{n+1}, memory)
at a global step: for each program with a clock whose tick this is: memory = advance({tick, period, first}, inputs, memory)
                  Update outputs = evaluate(t_{n+1}, inputs, memory); Updates replaced; checkpoint, samples, live control
```

**First same as last.** Dormand–Prince reuses its last stage, evaluated at $(t_{n+1}, y_{n+1})$ with the step's starting memory, as the next step's first. If any program's memory changed in `advance()`, that reuse is wrong for the stages that read it. The engine compares each program's memory before and after `advance()` (a byte comparison of a few doubles) and evaluates the first stage again only for the programs whose memory changed; otherwise the reuse stands. This keeps the integrators proposal's checkpoint statement true: the reused derivative is recomputed on restart and gives the same bits, because `evaluate()` is pure.

**A memory change is a step in the model.** Memory is constant within a step and may jump between steps, so to the method it is a discontinuity at a step boundary: harmless to Runge–Kutta 4 and to an adaptive method, which starts its next step afresh. A clock's ticks fall on global steps, which adaptive methods already land on, so no new breakpoint machinery is needed.

**Version 1 programs** are held under a whole-model method exactly as [Integrators](integrators.md#programs) describes: called once per global step at its start, outputs held through the stages, a version 1 node provider stepped with its own substeps; the Run dialog and the result name them, with "Convert to version 2 ›" beside each (see [Migration](#migration-from-version-1)). Under Euler node by node, nothing about a version 1 program changes at all.

## Automatic memory checkpoints

Because memory is declared, the engine knows every field's name, type and size, and owns a copy: in-process, memory lives in a buffer the engine allocates per instance and passes by pointer; out of process, the worker keeps it and returns the new memory in the reply to each `advance()` batch (a few bytes), so the engine's copy is always exact without asking. A checkpoint therefore needs no call into the program, and a restore is the engine sending memory back.

The checkpoint gains one repeated field, beside `provider_states` (which stays for version 1 node providers) and `solver_state` (field 7, reserved by the integrators proposal):

```proto
message ProgramMemoryField {
    string name = 1;
    enum Type { REAL = 0; INTEGER = 1; FLAG = 2; REALS = 3; RANDOM = 4; }
    Type type = 2;
    repeated double reals = 3;       // REAL (one), REALS (the array)
    repeated sint64 integers = 4;    // INTEGER, FLAG (0 or 1)
    repeated fixed64 words = 5;      // RANDOM: seed and counter
}

message ProgramMemory {
    // The stable id of the node, relationship or source term the program belongs to, and which.
    uint64 owner_id = 1;
    enum OwnerKind { NODE_PROGRAM = 0; SOURCE_TERM = 1; RELATIONSHIP_TERM = 2; }
    OwnerKind owner_kind = 2;
    uint32 term_index = 3;           // which of a relationship's terms, when it has several
    fixed64 layout = 4;              // a hash of the declared fields' names, types and sizes
    repeated ProgramMemoryField fields = 5;
}

message ResultCheckpoint {
    // ... fields 1-6 as today, 7 solver_state ...
    repeated ProgramMemory program_memory = 8;
}
```

The live session's checkpoint messages that carry `provider_states` today (`engineProtocol.proto`'s rewind and advance replies) gain the same field, and the run configuration's `startCheckpoint` gains `programMemory` beside `providerStates`, as JSON with the same shape. Each is written only when a run has version 2 programs with memory, so every checkpoint of a model without them is byte for byte what it is today.

A clock needs no saved state: its ticks are whole multiples of its period from the run's start, so the next tick follows from the checkpoint's time. A checkpoint is taken after the global step's `advance()` calls and Updates, so a restore never repeats a tick.

**Restoring after the program was edited.** Fields are matched by name. A field in the checkpoint and in the program, with the same type and size, is restored. A field new to the program starts from its declared initial value, and the run says so ("Memory ‘filtered’ of PidController on node Heater is new since this checkpoint and starts from 0"). A field the program no longer has is dropped with the same kind of note. A field whose type or size changed stops the continuation, naming it, because no value is right. The `layout` hash makes the common case, nothing changed, a single comparison.

**What this buys beyond correctness.** Memory can be shown: the node's Results tab can list a program's memory at each checkpoint, by name, and the harness prints it. The state estimator's members each restore their own memory at every anchor, and a live twin's rewind restores it, with no work by the author. FMU export can include memory in `fmi2GetFMUstate`, which version 1 cannot (see [Export](#export-parity)). And a node program becomes migratable between workers, which the partitioned backend needs before it can run node programs at all.

## Further hazards and the design's answer to each

Each entry: the problem, an example, the response, and whether it is in the first cut. Items considered and found not to be real for Konjugate are said to be so.

### Exceptions and non-finite values

**Problem.** A program that throws, or returns NaN or infinity, stops the run with a message that names nothing (verified above). Under adaptive and stiff methods it is also worse than useless to stop: a rejected trial step can visit states the solution never reaches (a concentration slightly negative, a temperature overshooting), and a program correctly refusing them is not a failure.

**Example.** A table lookup for viscosity covers 250–400 K; a Dormand–Prince stage with a step that is too big asks for 412 K.

**Response.** Three outcomes, chosen by what happened, never by a setting: (a) **an exception** other than `OutOfDomain` is a bug: the run stops, naming the program, its node or relationship, the time, the method and stage, the inputs, and the line (Python's traceback trimmed to the author's own frames; C++'s through `fail()`'s `std::source_location`, or the exception's `what()` when thrown otherwise). (b) **`OutOfDomain`** is the program saying "not these inputs": under Dormand–Prince and Rodas4 the step is rejected and retried smaller, up to the controller's minimum step, after which the run stops with the program's message; under Euler and Runge–Kutta 4 it stops at once. (c) **A non-finite output** is treated as `OutOfDomain` under adaptive and stiff methods (the standard practice of rejecting a step whose evaluation overflowed) and stops the run under fixed-step methods; the message says whether the inputs were already non-finite ("the input ‘cold’ was already NaN: look at what sets Room.temperature") or the program made it from finite inputs ("PidController made NaN from finite inputs"). Clamping or replacing a value is never offered: it turns a visible failure into a wrong answer. **First cut** (the rejection path arrives with Dormand–Prince).

### Non-determinism

**Problem.** Konjugate promises identical numbers across runs, backends and restarts. A program can break it from inside: the wall clock, an unseeded random generator, threads racing, and state shared between instances (C++ `static` variables are shared by every instance in one in-process library; Python module-level variables by every instance in one worker).

**Example.** `std::mt19937 rng{std::random_device{}()};` as a member, or `import random; random.gauss(0, 1)` in `evaluate()`: every run differs, and under Runge–Kutta 4 the noise is drawn four times a step.

**Response.** The shape removes most of it: `evaluate()` cannot draw from a `Random` (drawing changes memory, and memory is read-only there: a compile error in C++, an error at the call in Python, explaining why), and randomness that is declared memory is saved, restored and seeded by the engine. **Seeding**: each `Random` starts from `mix(ownerId, hash(fieldName), seed)`, where `seed` is 0 unless the program's card sets one (written in the file only when set), so runs repeat, instances differ, and a person can draw a different stream on purpose. The generator is the engine's own splitmix64 (`mixBits` in `executionPlan.cpp`, already used by noise schedules), specified exactly so the C++ SDK, the Python SDK, code export and the web give the same draws; `normal()` is Box–Muller on two draws with nothing cached, so its whole state is one counter. For the rest, the code editor warns as you type, by reading the source and never running it (as its syntax check does today): `random`, `time`, `datetime`, `secrets`, `threading`, `os.urandom`, `numpy.random`, `global` and assignments to `self` in `evaluate()`/`advance()` in Python; `static` and `mutable` variables, `rand(`, `std::random_device`, `system_clock`/`steady_clock` and `std::thread` in C++. The purity check below catches what the warnings miss. Threads inside a program are not forbidden, but the guide says a program's result must not depend on them. **First cut.**

### Events and discontinuities

**Problem.** `if`/`else` on a state, a switch, a saturation or hysteresis makes the right-hand side discontinuous. Under node-by-node Euler this costs a little accuracy; under Dormand–Prince the controller shrinks the step to resolve the corner and may chatter around it; under Rodas4 a finite-difference Jacobian taken across the switch is wrong. Hysteresis also needs memory, the latch, which in version 1 lives in a member and is changed at stage points it was never meant to see.

**Example.** A thermostat turns its heater on below 19.5 °C and off above 20.5 °C.

**Response, first cut.** The latch is memory, flipped in `advance()`; `evaluate()` reads it, so the right-hand side is smooth within every step and the switch happens at a step boundary, which every method handles:

```python
class Thermostat(Node):
    temperature = Input("degC")
    heater = Output("W")
    on = Memory(False)

    def evaluate(self, t, x):
        return self.outputs(heater=2000.0 if x.on else 0.0)

    def advance(self, step, x, m):
        if x.temperature < 19.5:
            m.on = True
        elif x.temperature > 20.5:
            m.on = False
```

The switch then lands up to one accepted step late, an error of the order of the step, which the guide states. A saturation without memory (`min(max(u, 0), umax)`) is continuous and needs nothing. A jump without memory (`2000 if T < 20 else 0`) is the case the guide warns against, and the editor flags a comparison of an input in `evaluate()` with a link to the pattern above. **Later**, with dense output: a program may declare **crossings**, functions of `(t, inputs, memory)` whose sign change marks an event (`k::Crossing tooCold{this, "tooCold"}` with `double crossing(const Crossing&, double t, const Inputs&) const`); the engine locates a sign change within an accepted step from the method's dense output, shortens the step to land on it, and calls `advance()` there. That is the standard event location of ODE suites, and it is left for later as the integrators proposal leaves events.

### Time: fixed and variable steps

**Problem.** A program may assume time moves forward in equal steps: computing `dt = t - self.last_t` in `evaluate()`, or reading `stepSize`. Stage times are not monotonic (Runge–Kutta 4 visits $t + h/2$ twice; a rejected step goes back) and an adaptive step has no fixed size.

**Response.** `evaluate()` receives the stage time `t` and never a step size; nothing it could keep between calls survives the shape. `advance()` receives the accepted step's size, and the guide says that code using it must be right for any size, because under an adaptive method it varies with the tolerance. Code that models a device with a fixed sample rate (a digital controller, a sampled sensor, a discrete filter, noise with a set bandwidth) declares a **clock** instead, so it is independent of the method's steps altogether. A clock's period must be a whole number of global steps, so its ticks are global steps (where Updates, samples and checkpoints already happen) and its value outputs reach the model as Updates do; a period that is not is refused by name with the nearest valid periods offered. Faster clocks than the global step would need ticks inside a step and their outputs between Updates, which [Rates and updates](ratesAndUpdates.md) does not have, so version 2 does not offer them (decision 5); the guide says to shorten the global step instead. **First cut.**

### Jacobians for Rodas4

**Problem.** Rodas4 needs $\partial f/\partial y$. For a program the engine can only difference it, one evaluation per colour, which across a Python transport is the dominant cost of a stiff step.

**Response.** The coloured finite differences of [Integrators](integrators.md#jacobians-for-rodas4) work for version 2 programs unchanged, because `evaluate()` is pure; memory is constant within the step and never a column. Two optional additions, by shape: **declared dependencies**, `k::Output warming{this, "warming", "K/s", k::dependsOn(hot, cold)}` (Python `Output("K/s", depends_on=("hot", "cold"))`), sharpen the sparsity from "every output depends on every input" to the truth, which shrinks the colouring; and an **analytic Jacobian**, `void jacobian(double t, const Inputs&, Jacobian& J) const` with `J(warming, hot) = x[conductance] / x[capacity]` (Python `def jacobian(self, t, x): return {("warming", "hot"): ...}`), which the engine chains with the binding (the state each input reads, and the unit scale at the port) to fill the model's entries without perturbing the program. A program that provides one is checked against differences by the harness. A program that reads `t` costs one more evaluation for $\partial f/\partial t$; declaring `timeInvariant` is not offered, because a wrong declaration is the kind of promise this proposal removes, and the cost is one evaluation. **Later, with Rodas4** (integrators stage 3); declared dependencies are useful to the stability analysis earlier, but not needed.

### Units and dimensions

**Problem.** Version 1 ports carry a unit string that nothing reads. A program written for kelvin bound to a state in °C computes nonsense; one written for watts whose output feeds a state in K/s is off by a capacity.

**Response.** Units are checked at load with the app's existing unit compatibility code (the same that checks equations and the twin's mappings). For inputs, parameters and constants: the same unit binds as is; a compatible unit is **converted at the port**, affinely where it must be (°C to K adds 273.15), with an information line on the program's card ("‘cold’ is converted from °C to K"); an incompatible unit stops the load, naming both. For outputs: into a Rate state the unit must be the state's unit per second, and into an Update state the state's unit, converted linearly (a rate never takes an offset: 1 °C/s is 1 K/s). A port declared without a unit is not checked, and the card says so. Conversion is a multiply and an add per port at evaluation, folded into the gather the engine already does. **First cut.**

### Performance

**Problem.** A whole-model method multiplies evaluations: four a step for Runge–Kutta 4, six for Dormand–Prince, six plus the colours for Rodas4. What that costs depends on the transport: a C function call in-process, a semaphore round trip over shared memory, and a pipe round trip with protobuf encoding and a Python interpreter on the other side, tens of microseconds per message before any work. Version 1 also allocates on the hot path.

**Response.** (a) **Batch per stage, not per node.** A whole-model stage gathers every evaluation of one program source, across all its instances and nodes, into one message, so a Python program used on fifty edges costs one round trip per stage, not fifty. (b) **No allocation in C++**: inputs, outputs and memory are views over buffers the engine keeps per instance; ports are indices; nothing in `evaluate()` names a string. (c) **Python**: the generated input view uses `__slots__` and `outputs()` is generated with fixed parameters; the result says how much of the run was spent in each program, per transport, as the execution summary should already ([Interaction providers](../interactionProviders.md#parallel-and-partitioned-execution)). (d) **Vectorised evaluation, later**: a Python program may define `evaluate_many(self, t, xs)` taking columns (one list per port over the batch's instances) and returning columns; the worker uses it when present. (e) **Advance is cheap**: one batch per accepted step, only for programs with memory and no clock, and only at ticks for those with one. (f) The guide's table states the cost per evaluation on each transport, measured by `benchmark:providers` extended to version 2, so an author knows a Python program under Rodas4 is the slow case and why. **First cut** for (a), (b), (c) and (e); (d) later.

### Thread safety, instances and reentrancy

**Problem.** Python shares one object between instances (verified above); C++ relationship programs share one object across edges; every transport serialises calls into a program with a mutex because a member might change.

**Response.** **One object per instance**, constructed with `createProgram()` (C++) or the class (Python), in every transport, for both kinds. Because `evaluate()` and `advance()` cannot change the object, calls into different instances are independent; calls into one instance are never concurrent (the engine never needs them to be). Static and module-level mutable state is the one hole left, and it is already a determinism bug the editor warns of. Evaluating instances concurrently in-process, dropping today's per-artifact mutex for version 2, is **later**, after it is measured; the first cut keeps the mutex (decision 6). Reentrancy: a program cannot call back into the engine (there is no API to), so there is nothing to reenter. The partitioned backend, which does not run node providers today, can run version 2 node programs once memory migration exists, which it does by construction: **later**.

### Lifetime and resources

**Problem.** Version 1 says little about what each phase may do: whether `initialize()` may open a file, whether `evaluate()` may write one, what happens to an open socket at a restore.

**Response.** A table in the guide and the header's comments:

| Phase | Called | May | Must not |
| --- | --- | --- | --- |
| construction | once per instance | declare ports, memory, a clock | read anything; its result is the description |
| `initialize()` | once per instance, before the run and before a checkpoint is restored | read constants, open and read files (a data table), allocate, set members and memory's starting values | write anything another run would see; depend on anything but constants and the files it reads |
| `evaluate()` | any number of times | compute | change anything; do I/O; take time that depends on anything but its inputs |
| `advance()` | once per accepted step or tick | change memory | do I/O (a write here is repeated by a fork from an earlier checkpoint) |
| `shutdown()` | once, after any end of the run where `initialize()` succeeded | release what `initialize()` took | throw |

Files a program reads belong in `initialize()`, which runs again before every restore, so a restored run reopens them; sockets, devices and live data belong to connectors, not programs ([Plugin development](../pluginDevelopment.md#connectors)), and the guide says so. A program that never returns cannot be interrupted in-process; cancelling a run stops an out-of-process worker by ending its process, as now. **First cut** (documentation, and the freeze).

### Parameters: live, scheduled and constant

**Problem.** In version 1 a parameter is just an input; the program cannot say "this is fixed for the run" (a table size, a sample period) or "this may change while running" (a setpoint the operator turns).

**Response.** `Parameter` is read at every call and may change between global steps (live control, a recorded intervention) or within a step (a schedule, read at the stage time as substeps read it today). `Constant` is fixed for the run: the app does not offer it as live or scheduled, `initialize()` may read it, and a change re-initialises the program (tuning a constant is fine: every tuning trial is a fresh run). Finite-difference gradients through programs, as parameter tuning computes them, are sound for version 2 because runs are deterministic and memory restarts with each trial; under an adaptive method, the integrators proposal's open question 8 applies unchanged. Parameter sensitivities supplied by the program (an analytic $\partial f/\partial p$ beside the Jacobian) are **later**, if tuning needs them. **First cut** for `Parameter` and `Constant`.

### Versioning, capabilities and older engines

**Problem.** A version 2 program must be refused by name by an engine that cannot run it, not compiled against the wrong header or run with the wrong meaning; future additions must not need a version 3 for every optional method.

**Response.** **In the file**: `implementation.providerApiVersion: 2`. Every released engine already refuses anything but 1 by name in `modelValidator.cpp` ("Programmable relationships require provider API version 1.", and the same for node programs and source terms), so a file with a version 2 program opens in an older Konjugate and refuses to run with that message rather than running something else. From this version, an unknown future version is refused with "This program is written for version N of the program SDK, which this Konjugate does not have; update Konjugate." **Detection**: the app sets the version from the source (an `#include <konjugate/sdk/v2/program.hpp>`, an `import` from `konjugate.v2`) when the program is saved, and the engine checks the two agree when it builds or loads the program, with an error that says which to change: the file is the engine's switch, the source is the truth. **In-process ABI**: a new entry symbol, `konjugate_in_process_program_v2`, returning a table that begins with its own size and an ABI version, so later fields are appended and an older engine reads only the part it knows; optional methods (a Jacobian, crossings) are capabilities by presence (a null function pointer when absent). Everything crossing it stays POD and no exception crosses it, as in version 1. **Protocol**: `HandshakeRequest.provider_api_version = 2`; a worker that knows only 1 already answers `versionMismatch`. The handshake's response carries the full description (ports with kind, unit and default; memory fields; the clock; capabilities); new messages are a stage evaluation batch (with the stage's index and the method's name, for messages only), an advance batch whose reply carries the new memory, a set-memory request for restores, and later a Jacobian request. `relationshipProvider.proto` stays the one source of truth, and the hand-written codecs in `providerWorker.cpp` and `__main__.py` follow it, as now. **First cut.**

### Export parity

**Problem.** Code export pastes a program's source with a vendored copy of the SDK types; FMU export builds the same code into an FMU; the web edition runs Python programs through Pyodide. Each must run a version 2 program exactly as the engine does, or refuse it by name.

**Response.** **Code export** vendors `program.hpp` (header-only, no dependency) or the `konjugate.v2` module into the generated file, as it vendors version 1's types, keeps each instance's memory in a plain struct or object, and calls `evaluate()` and `advance()` in the exported method's order, exactly as above; it remains refused by name for a program in the other language or from an installed plugin. **FMU export** includes every program's memory in `fmi2GetFMUstate` and its serialisation, automatically: version 1 cannot (code export documents that a node provider's `checkpoint()` is never called), so version 2 makes exported FMUs restartable where version 1 could not. **The web edition** runs version 2 Python programs through the same Pyodide bridge: `_webBridge.py` dispatches the new request kinds to the same shared handlers the native worker uses, as it does today. C++ programs in the web edition remain blocked for the reason [Web edition](webEdition.md) records (the in-browser compile); version 2 adds nothing to that, being header-only standard C++. **First cut** for code export and the web; FMU export with the integrators' export stage.

### Testing outside Konjugate

**Problem.** An author can only try a program by running a model, and a hand-written checkpoint can only be tested by forking a run and comparing.

**Response.** A harness in each SDK, with no test framework required:

```python
from konjugate.v2.testing import Harness

h = Harness(PidController, constants={"kp": 50.0, "ki": 5.0, "kd": 1.0, "max_power": 2000.0}, seed=7)
h.tick(time=0.0, setpoint=293.15, measurement=290.0)     # advance() at a clock tick
print(h.evaluate(t=0.0, setpoint=293.15, measurement=290.0))   # {'power': ...}
print(h.memory)                                          # {'integral': ..., 'previousError': ..., ...}
h.check(setpoint=293.15, measurement=290.0)              # the standard checks, raising with a plain message
```

```cpp
#include <konjugate/sdk/v2/testing.hpp>

k::testing::Harness<PidController> h{{.constants = {{"kp", 50}, {"ki", 5}, {"kd", 1}, {"maxPower", 2000}}, .seed = 7}};
h.tick(0.0, {{h.program().setpoint, 293.15}, {h.program().measurement, 290.0}});
const auto report = h.check({{h.program().setpoint, 293.15}, {h.program().measurement, 290.0}});
if (!report.ok()) { std::puts(report.text().c_str()); return 1; }
```

`check()` runs the standard checks: every port declared once, with keys valid in a file; `evaluate()` finite at the given inputs and every output set; **purity**: `evaluate()` called twice gives identical bits and leaves memory identical; **memory round trip**: memory saved and restored into a fresh instance gives identical outputs and identical further `advance()`s; a Jacobian, if provided, agrees with differences. The same checks run as `python -m konjugate.v2.check program.py`, and as **Check program** in the code editor, which runs them in the worker and shows the result beside the source (an explicit button, because it runs the code, unlike the live syntax check). The engine itself also calls the first evaluation of each instance twice at the start of a run and compares, one extra call per instance per run, which catches the commonest impurity (a counter in a member) before it corrupts anything. **First cut.**

### Diagnostics in the app

**Problem.** Today's failures surface as engine strings without names, far from the code.

**Response.** Every message from a program says, in plain words, which program, where it is used, which port, and when, and opens the code editor at the line when it has one. Examples of the messages the design produces:

- Load: "The program PidController on node Heater reads ‘measurment’, which is not one of its inputs (measurement, setpoint). Line 14." (Python; C++ does not compile, with the compiler's line, as today.)
- Binding: "Input ‘measurement’ of PidController is not bound to anything and has no default. Bind it on the Program tab, or give it a default in the code."
- Output: "PidController did not set ‘power’ (evaluate() at t = 0 s)."
- Runtime: "Conduction on the relationship Wall → Room gave NaN for ‘warming’ at t = 12.35 s (stage 3 of 4, Runge–Kutta 4) from finite inputs: hot = 310 K, cold = 295 K, conductance = 4 W/K, capacity = 0 J/K."
- Purity: "PidController gave a different ‘power’ when called twice with the same inputs at t = 0 s (12.0, then 14.0). evaluate() must not change anything: keep what it remembers in declared memory and change it in advance()."
- Held: "Under Runge–Kutta 4, these programs are held once per global step because they use the older program format: Valve (node Inlet), Friction (relationship Cart → Track). Convert to version 2 ›"

Each is a finding in the existing findings list where it concerns a run, and a validation message where it concerns the model, so it is shown on the canvas at the node or relationship. **First cut.**

### Considered and not real here

- **Algebraic loops through programs.** A program's outputs never feed back within an instant: Rates are integrated and Updates are replaced at step ends reading the step's start ([Rates and updates](ratesAndUpdates.md)), so no program is ever solved for implicitly. Nothing to design.
- **Vector and matrix ports.** Real for neural networks and lookup surfaces, but a separate design ([Interaction providers](../interactionProviders.md#6-begin-with-scalar-floating-point-ports) keeps scalar ports for now); version 2's port table leaves room (a port with a size), unused in the first cut.
- **Memory too large to send per step.** Memory crosses a transport only after `advance()`, and declared memory is small (fixed arrays, not unbounded buffers). A program needing large opaque state is the FMU case, which stays version 1, stepped.

## Migration from version 1

**Nothing changes for an existing program.** Version 1's header, Python module, ABI symbols, protocol messages and engine paths stay as they are; a version 1 program gives the same numbers to the bit under Euler node by node, and is held under a whole-model method. A file is never converted on opening.

**Converting, when the author wants a program to take stages.** The code editor shows a version 1 program with a line, "Older program format: held under Runge–Kutta 4 and the adaptive methods. Convert to version 2 ›", and the Run dialog's list of held programs links to the same. **Convert** opens a side-by-side diff, undoable as one step:

- `describe()`'s ports become declarations; each `context.inputs.at("key")` / `inputs["key"]` becomes `x[key]` / `x.key`; `addGradient(value)` / `add_gradient(value)` becomes a return (a relationship) or an output assignment (a node), several `add_gradient` calls to one key becoming their sum.
- A program whose `evaluate()` assigns to no member and reads no `stepSize` is then complete, and the editor says so. Most relationship programs, including every one made from today's template and the CSV replay generator's, are of this kind.
- A program that assigns to members, or reads `stepSize`, or has a hand-written `checkpoint()` with a non-empty payload, is converted as far as the ports, with its old `evaluate()` body kept and a short comment at each place that needs a decision ("this member changes in evaluate(): declare it as memory and change it in advance(), or make it a state if it is continuous"); the editor says it is not finished and the program stays version 1 until it compiles as version 2. Nothing claims a conversion it did not make.

The converter is in the app (`src/providerTemplate.mjs` beside the templates), works on the source text, and recognises the shapes the templates produce; anything else gets the version 2 template filled with the program's ports and its old body commented below, which is honest and still saves the typing.

**Generated programs.** The templates switch to version 2 when it ships. The CSV replay generator (`replayProviderSource`) emits a version 2 relationship, which then takes stages (its value is a function of time alone). The FMU resolver keeps emitting a version 1 node provider: an FMU is a co-simulation slave and is stepped under a whole-model method whatever SDK wraps it.

**Plugins.** A `.kjp` package declares `providerApiVersion: 2` for a version 2 provider; [Package compatibility](packageCompatibility.md)'s minimum Konjugate version keeps it from being offered to an app without version 2.

## Documentation plan

- **Doc comments in the header and docstrings in the module**, on every declaration and call: what it is, when it is called, what it may and must not do, as in the table under [Lifetime](#lifetime-and-resources). The header is pasted into code exports, so its comments travel with exported programs.
- **A guide page, `docs/programs.md`, "Writing a program"**: the two kinds; `evaluate()` and why it changes nothing; memory, `advance()` and clocks, with the digital-versus-analogue PID as the deciding example; ports, defaults and units; randomness; switches and hysteresis; errors and `OutOfDomain`; testing with the harness and Check program; performance by transport; converting from version 1. The two worked examples above are its spine, each in both languages.
- **Templates** (`src/providerTemplate.mjs`): a relationship template and a node template in each language, naming every bound input and output as today's do, with three short comments: where the computation goes, that memory is declared and changed only in `advance()`, and that a continuously changing quantity should be a state. A node template with a clock and a `Random` is offered as "Controller (sampled)".
- **Examples**: `examples/providers` gains version 2 conduction and PID in both languages, each with a harness test the repository's test suite runs.
- **Updated references**: [Interaction providers](../interactionProviders.md) (status, runtime contract: `commit` is `advance()`), [Provider execution](../providerExecution.md) (the version 2 ABI and messages), [Plugin development](../pluginDevelopment.md) (the manifest's API version), [Project schema](../projectSchema.md) (`providerApiVersion: 2`, a program's `seed`, `startCheckpoint.programMemory`), [Code export](../codeExport.md) (version 2 and FMU memory), and the in-app help for the Program tab.

## Backwards compatibility

The hard rule: every file a released version wrote opens and gives the same numbers to the bit; a file this version writes without the new features is byte for byte the file the version before wrote; new fields are written only when needed.

**By construction.** Version 2 is new code beside version 1: a new header, a new Python package, a new ABI symbol, new protocol messages and a new engine path chosen only by `providerApiVersion: 2`. A version 1 program runs through today's code unchanged. No version 1 number changes: the shared Python object, zero for unbound inputs and silent missing outputs remain in version 1 because changing them could change numbers of saved models. What version 1 gains is two warnings that change nothing (decision 8): an input with no binding, and a Python node program with several instances returning a non-empty `checkpoint()`; the guide documents the rest, and conversion is the way out.

### Project document

| Change | Written when | Older files in this version | This version's files in older versions |
| --- | --- | --- | --- |
| `implementation.providerApiVersion: 2` | for a program written against version 2 | `1`: version 1, identical numbers | refused by name by every released validator ("…require provider API version 1") |
| `implementation.seed` | only when a person sets one | absent: 0 | only in version 2 programs, which older engines refuse anyway |
| A version 2 program's source | as written | -- | kept by the codec's pass-through; not run |

### Results and checkpoints

| Change | Older results in this version | This version's results in older versions |
| --- | --- | --- |
| `ResultCheckpoint.program_memory` (field 8) and the live session's equivalents | absent: no version 2 memory | skipped as an unknown protobuf field; the model it belongs to cannot run there anyway |
| `startCheckpoint.programMemory` in a run configuration | absent | ignored, as above |
| The result's list of held version 1 programs (with the integrators work) | absent | skipped |

### Protocol and ABI

Version 1's messages and entry symbols are unchanged; version 2 adds messages to the `oneof`s at new field numbers and a new symbol. A version 1 worker asked for version 2 answers `versionMismatch`, which the engine reports by name; a version 2 worker serves version 1 requests from version 1 programs, because the Python package keeps both and the C++ glue is chosen per program.

## Verification

- **The default, to the bit**: every bundled example's digest and every toolbox engine test unchanged; every test of version 1 programs (`engine/tests/nodeProviderRuntimeTests.cpp`, the provider interaction tests) passing untouched; a saved file with no version 2 program byte-identical.
- **Equivalence**: each bundled model's programs rewritten in version 2 (by the converter where it completes) give the version 1 numbers to the bit under Euler node by node, where the version 1 program was pure; the conduction example in both languages gives the same bits as the equation it replaces.
- **Stages**: `benchmarks/coupling/graphSplit` with its coupling written as a version 2 program reaches the method's order under Runge–Kutta 4 and Dormand–Prince, and stays first order with the same coupling as a version 1 program (held), proving the hold is what the result says.
- **Memory**: a run to $T$ equals a run to $T/2$ continued from its checkpoint, to the bit, for the PID example under every method (clocked memory and the noise stream included), on serial and thread-pool backends; a fork with an edited program restores fields by name as described; the state estimator's members, each with its own memory, give the same analysis as a run with the controller written as equations, within the filter's own noise.
- **Rejection**: a program raising `OutOfDomain` at large steps completes under Dormand–Prince with no change in memory from rejected steps (memory compared after each accepted step against a fixed-step reference), and stops by name under Runge–Kutta 4.
- **First same as last**: a program whose memory changes at every step gives the same bits under Dormand–Prince as with reuse disabled.
- **Harness and messages**: each check fails for a deliberately broken program (a member counter, a missing output, a forgotten memory field, a wrong Jacobian) with the message above; every error message in [Diagnostics](#diagnostics-in-the-app) is produced by a test model and its wording asserted.
- **Export and web**: the C++ and Python exports of the PID example reproduce the engine to the bit; an exported FMU restored from `fmi2GetFMUstate` mid-run continues to the bit; the web edition runs the Python examples with the native numbers, checked in real Chrome.
- **Performance**: `benchmark:providers` extended to version 2 on each transport and method, recorded, not asserted, as today.

## Order of work

1. **The SDK and Euler node by node.** `program.hpp` and `konjugate.v2` with the harness and `konjugate.v2.check`; the in-process ABI (`konjugate_in_process_program_v2`) and the pipe protocol's version 2 messages, Python and C++ (C++ in-process first, as node programs are today); one object per instance; ports, defaults and units checked at load and converted at the port; engine-owned memory, `advance()` per substep and on clocks, `program_memory` in checkpoints, live sessions and `startCheckpoint`; named errors, the double first call, and Check program; version 1's two warnings (decision 8); templates, the guide and examples; code export and the web edition's Pyodide bridge. Nothing ships until every digest is unchanged.
2. **Stages**, with integrators stage 1: version 2 programs evaluated per stage, batched per program source across instances; version 1 programs held and named; the converter; the Run dialog's held list with "Convert to version 2 ›".
3. **Rejection**, with integrators stage 2: `OutOfDomain` and non-finite outputs rejecting adaptive steps; the first-same-as-last rule; FMU export with memory.
4. **Jacobians**, with integrators stage 3: declared dependencies and the optional analytic `jacobian()`, checked by the harness.
5. **Later, each when measured or asked for**: crossings located with dense output; `evaluate_many` for Python; a version 2 shared-memory channel sized at handshake (lifting the 16-input limit) and the C++ worker transports; concurrent evaluation of instances in-process; version 2 node programs on the partitioned backend; memory shown in the node's Results; parameter sensitivities for tuning.

## Decisions

The nine questions this proposal left open were decided on 23 November 2026, each as it recommended. The text above already follows them; each is recorded here with its reason and the alternative it rules out.

1. **Version 2 replaces the integrators proposal's `pure` declaration; no flag is added to version 1.** That proposal planned `description.pure = true` (C++) and `pure = True` (Python) on version 1 programs, written set by the templates. A wrong `pure` silently corrupts results, which is exactly problem 1; version 2 makes purity a fact of the code. The accepted cost: today's stateless version 1 programs are held (first-order coupling) under a whole-model method until converted, and the converter completes most of them in one click. [Integrators](integrators.md)' stage 1 (which listed "the `pure` declaration in both SDKs and the templates") and its open question 5 (templates declaring `pure`) are superseded by this decision: a program joins the stages by being written against version 2.
2. **`advance()` runs once per accepted step by default, and on a clock for anything clocked.** Requiring every program with memory to declare a clock would be simpler to explain, but would make a latch (the thermostat) or a running maximum act only at global steps, coarser than the method's own steps.
3. **A `Random` stream is seeded from the program instance's stable id and the field's name, with an optional `seed` on the program's card**, written in the file only when set: reproducible by default, different per instance, re-drawable on purpose. Not a run-level seed (one number for the whole model, which the run configuration does not have), and not a seed in the code, which every copy of the program would share.
4. **Compatible units are converted at the port, and the card says so; incompatible ones are refused by name**, as the twin's mappings already do. Refusing a °C state for a K port would push authors to write conversions inside programs, where they are easy to get wrong in both directions.
5. **A clock's period is a whole number of global steps; faster clocks are not part of version 2.** Its outputs then reach the model as Updates. Faster clocks need values that change inside a global step, which Rates and updates deliberately does not have; the person shortens the global step instead (Adaptive still chooses its own smaller steps within it).
6. **In-process, the first cut keeps today's per-artifact mutex; it is lifted for version 2 in a later stage, once measured** (stage 5 below). The shape makes concurrent evaluation of instances safe except for `static` state, which is already a determinism bug the editor warns of; but a crash from a missed `static` is worse than the speed it buys before anyone has measured the need.
7. **In Python, a relationship returns a number and a node returns `self.outputs(name=value, …)`.** A plain dict (`{"power": u}`) is more familiar but brings back string keys checked only at run time; a tuple in declaration order is fastest but fragile when outputs are reordered.
8. **Version 1's numbers are left alone, and two warnings that change none are added to it**: validation warns of a version 1 input with no binding ("reads 0"), and a run warns once when a Python node program with more than one instance returns a non-empty `checkpoint()` (the shared-object case). Each points at converting. The shared Python object, zero for unbound inputs and silent missing outputs otherwise live on in version 1, for compatibility.
9. **The person mostly does not see "version 2".** The app speaks of programs; "older program format" appears only beside a version 1 program and in the held list, and "version 2" only in the guide, the SDK's names and the file.
