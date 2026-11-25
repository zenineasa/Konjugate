---
type: Guide
title: Writing a program
description: "How to write a term or a node of a model as a C++ or Python program against the program SDK: the two kinds, ports and units, evaluate() and why it changes nothing, memory, advance() and clocks, randomness, switches, errors and OutOfDomain, testing with the harness and the code editor's Test, performance by transport, and converting a program written in the older format."
tags: [programs, sdk, providers, cpp, python, memory, checkpoints]
status: stable
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Writing a program

A term of a relationship, a node's own part, or a whole node can be written as a program, in C++ or Python, when an equation is not the natural way to say it: a table lookup, a digital controller, a state machine, a model with many cases. A program is written against Konjugate's program SDK: `#include <konjugate/sdk/v2/program.hpp>` in C++ (header-only, standard C++20, no dependency) and `from konjugate.v2 import ...` in Python (standard library only). The templates a new program starts from already declare every value it is bound to. This page explains what a program is allowed to do and why; the design behind it is [Program SDK version 2](proposals/programSdkV2.md).

## The code editor

A program is edited in its own code editor, and only there. The part's card shows the program read-only: its name and language ("PidController · C++"), what it reads and sets in the model's names (a port bound to nothing reads "measurement · not bound"), **Bind its inputs in Ports ›**, its first lines, and **Edit program**, which opens the editor; clicking one of those lines opens it at that line. On the right of the heading the card shows at most one status for the exact source it holds, kept only while the app is open: "✓ passed Test", "1 problem · line 17 ›" (which opens the editor at the line), or "older format · Convert to version 2 ›". A part switched to C++ or Python with no source yet says "No program yet." and offers **Write program**, which opens the editor on the template, to apply. "set by program ›" on a node's state, and the chip of a node's program in an equation, open the same editor at that output's port. The editor's title names what the program belongs to ("Heater · Program"), and its toolbar says the language and format ("C++ · version 2", or "Python · older format" with Convert to version 2 ›), counts the problems the compiler or Python finds as you type (clicking the count moves the cursor to the first one), and offers **Reset template** (the template written again from the program's bindings, which undo takes back), **Test**, **Cancel** and **Apply**. Apply (or Ctrl/Cmd‑S) puts the source into the model and keeps the editor open; Cancel closes it without changing the model. Closing it any other way with changes not yet applied, or closing the project window while it has some, asks "Apply your changes to Heater's program?" with Apply, Don't apply and Keep editing. Beside the code, the **Ports** panel lists what the program declares, in declaration order, as the engine reads it (`describeProgram`, [Engine CLI](engineCli.md)): each input, parameter and constant with its unit, what the model binds it to, its value now, and the conversion a run applies at the port when the units differ ("°C → K at the port", or why they cannot be converted); each output with the state it reaches and whether it is a rate or a value there; each memory value with its start value; and the clock with its period. **Binding happens here:** a click on an input's "bound to" lists what it can read in the model, those whose unit converts to the port's first; one that cannot is listed but not offered, with the reason, and Not bound unbinds it. The binding is written into the project as the card's binding rows used to write it, and is one undoable change; the card's reads line follows. A port bound to nothing and with no default says so in the run's words, and a binding to a key the program no longer declares stays listed, marked "not a port of this program", with Remove this binding. Clicking a port goes to the line that declares it. While the program does not load, the panel shows its ports as they last were, greyed. Until the engine has read the program, and where it cannot (a C++ program in the web edition), the panel lists the ports as the code declares them, without memory and clock. A program in the older format lists its bindings only. The panel folds away with › and can be made wider by dragging its edge. **Test** runs the program where it is written, in the panel's Test tab, through the engine and the transport a run uses (`testProgram`, [Engine CLI](engineCli.md)), so it gives a run's numbers. Its inputs are every input, parameter and constant at its value in the model now (else its default), each editable, with the time it starts at; they are not saved, and Reset brings the model's values back. **Run once** calls `initialize()` and then `evaluate()` once, with the standard checks (ports, outputs, purity, the memory round trip and, when the program gives one, its Jacobian), each shown as a line; **Step N** then advances and evaluates N times with the inputs held, every Δt: the clock's period for a program with a clock, otherwise the model's step, which can be changed. The results are a table of the time, every output and every memory value at each step, to six significant figures (Copy, or copying from the table, gives every digit), and a small plot of one column. Each problem says its step and, when the engine knows it, its line, which it links to and underlines in the code. Test is offered for a program in the current format, and on the web for Python programs (a C++ program is tested in the desktop app). The check as you type waits for a pause (half a second for Python, 0.8 s for C++, which starts a compiler), runs one check at a time for each editor, stops a check a newer edit has made pointless (the compiler and anything it started), gives up on one still running after 10 s ("Check took too long; it will run again when you pause"), and remembers its last 32 answers by the source, the compiler and its flags, so going back to a source already checked starts nothing. The check knows the SDK. For a Python program, once the source parses, it reports together a read of a port or memory value the program does not declare (`x.measurment`, with what it does declare), an input, parameter or constant it never reads (a hint, which is not counted as a problem), and Python's own warnings; for C++ the compiler reports a read it does not declare. A port's problem in the model (a unit that does not convert, nothing bound and no default) is underlined on its declaration as well as listed in Ports, and after Test passes it names, as a hint, any input whose change moves no output over the steps. Completion knows the program and the SDK: after `x[` (C++) or `x.` (Python) it offers the program's own ports and memory in the order it declares them, each with its unit, what the model binds it to and its value now; after `m[` or `m.` its memory; after `y[` its outputs; after `k::` (or, in Python, as a word) the SDK's names with their one line of documentation; and, as you type a word, snippets (a memory value with `advance()`, a clock, `OutOfDomain` for a lookup, `jacobian()`), inserted only when chosen. Hovering an SDK name shows its line and a link to the section of this page that explains it; hovering a port shows its unit, binding and value now. The colour theme is in the ⋯ menu. In the web edition the same editor opens in a panel over the project, which moves by its title bar and resizes from its corner; Python is checked there through Pyodide, and C++ through an in-browser compiler in the browsers that allow the faster web build (elsewhere C++ is checked in the desktop app).

## The two kinds

A **relationship program** (`Relationship`) computes one output: an interaction term on a relationship, or a node's own part. A **node program** (`Node`) computes several outputs for one node. What an output means follows the state it is bound to: bound to a Rate state it is a rate, read at every stage of the method; bound to an Update state it is the state's value, read at the end of each global step. The program does not say which; it says its output's unit, and the unit is checked against the state's (a rate's unit is the state's per second).

## A pure relationship: conduction

Heat conducted from a hot body to a cold one warms the cold one at $G\,(T_h - T_c)/C$:

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

Both are in `examples/providers` (`conduction.cpp`, `conduction.py`), and both give, to the bit, the numbers of the equation they replace.

## Ports, defaults and units

Each port is declared once, as a member (C++) or a class attribute (Python): `Input` (bound to a state or the time), `Parameter` (bound to a parameter, read at every call, so it may change while running or follow a schedule), `Constant` (a parameter fixed for the run, which `initialize()` may read) and `Output`. In C++ the quoted key is what the project file binds; in Python the key is the attribute's name in camelCase (`previous_error` binds as `previousError`), or `name=` when it should be another. Code refers to a port by its identifier, so a misspelt port is a compile error in C++, and in Python an error when the program is loaded, naming the line and the real ports.

Every input must be bound, unless it declares a default (`k::optional(0.0)`, `default=0.0`); `x.bound(port)` (C++) says whether it was. Every output must be set by every call: a node program in Python returns `self.outputs(name=value, ...)`, whose keyword parameters are exactly the declared outputs, so a missing or misspelt one is Python's own error naming it.

A unit (`"K"`, `"W/(K*s)"`) is checked when the run starts, with the same catalogue the app uses for equations and the twin's mappings. A port bound to the same unit reads the value as it is; a compatible unit is converted at the port, a temperature with its offset (a room in °C bound to an input in K arrives in K); an incompatible one stops the run, naming both ("Input ‘cold’ of the program Conduction on relationship Wall → Room is in K but is bound to Room.temperature, in m."). An output into a Rate state must be the state's unit per second, and a rate is converted by a scale alone (1 °C/s is 1 K/s); into an Update state, the state's unit. A port declared without a unit is not checked.

## `evaluate()` changes nothing

`evaluate()` receives the time and a read-only view of the inputs, parameters, constants and memory, and gives its outputs; in C++ it is `const`. It is never given a step size. Runge–Kutta 4 calls it four times a step, Adaptive six or seven and again for a step it rejects, Stiff once more per column of its Jacobian, so it must give the same outputs for the same inputs, memory and time, however often and in whatever order it is called. The engine calls each instance's first evaluation twice and compares, and stops the run if the two differ, naming the program and the output. After `initialize()` a Python program's object is frozen: setting an attribute in `evaluate()` or `advance()` raises, saying where memory belongs.

| Call | When | May | Must not |
| --- | --- | --- | --- |
| construction | once per instance | declare ports, memory, a clock | read anything |
| `initialize()` | once per instance, before the run and before a checkpoint is restored | read constants, open and read files, set members and memory's starting values | write anything another run would see |
| `evaluate()` | any number of times | compute | change anything; do I/O |
| `advance()` | once per accepted step, or per clock tick | change memory | do I/O (a fork from an earlier checkpoint repeats it) |
| `shutdown()` | once | release what `initialize()` took | throw |

Every instance is its own object: two nodes using one program never share its members.

## Memory, `advance()` and clocks: a digital PID controller

What a program must remember between steps is declared as **memory**: a real, an integer, a flag, a fixed array of reals or a random stream. It is read through `x` and changed only in **`advance()`**, through `m`, which the engine calls once per accepted step (never for a stage or a rejected step), or, for a program that declares a **clock**, once at the start of the run and at every tick. The engine keeps memory itself and saves and restores it with every checkpoint, so a fork, a run continued from a checkpoint and a live twin's rewind carry on exactly; there is nothing to write to save it.

A digital controller samples its sensor on a clock and holds its command between samples. That is discrete by nature, so its memory is exact:

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

The C++ version is `examples/providers/pidController.cpp`; the two give the same bits. Its clock makes the controller independent of the method: its samples are at 0, 10 ms, 20 ms whatever steps the method takes. A clock's period must be a whole number of the run's time steps (the run says which periods would do, if it is not); to sample faster, shorten the time step. Without a clock, `advance()` runs after every accepted step: after every substep under Euler node by node, after every internal step under Runge–Kutta 4, and after every step Adaptive and Stiff (Rodas4 or BDF) accept, never for a step they reject or take again to land on an event; BDF carries its history on across a change of memory (a jump it makes shortens the step, as at any corner), and starts it again only where a clock's tick changed memory, as at a schedule's corner. When `advance()` changed the memory, Adaptive evaluates the next step's first stage again rather than reusing its last. `step.size` is then the accepted step's size, which an adaptive method varies with its tolerance, so code using it must be right for any size. An output into an Update state is read at the end of each global step, from `evaluate()` with the memory `advance()` just wrote, and at the start of the run after the clock's first tick.

**An analogue controller is written differently.** A continuous PI controller's integral changes continuously, so it is a node state, not memory: the program has an output `integralRate` bound as a rate into the node's state `integral` and an input bound to that state, gives `integralRate = setpoint - measurement` from `evaluate()`, and declares no memory and no clock. The method then integrates it at every stage, to its own order; memory advanced once a step would make it first order.

## Randomness

A `Random` stream is memory: its whole state is a seed and a counter, so a resumed run, a fork and a rewind draw the same numbers. The engine seeds it from the program's place in the model and the field's name, so runs repeat and two instances of one program draw different streams; a seed set on the program's card draws another stream on purpose. Drawing changes it, so it can be drawn only in `advance()` (in C++ `x[noise].normal()` does not compile; in Python it raises). `uniform()` is in [0, 1), `normal()` is Box–Muller on two draws, and `bits()` gives 64 bits; the generator is splitmix64, the one the engine's noise schedules use, so C++, Python and exported code draw alike. The wall clock, an unseeded generator, threads racing and `static` or module-level variables make a run unrepeatable: do not use them.

## Switches and hysteresis

A switch with memory, a thermostat, keeps its latch in memory and flips it in `advance()`, so the right-hand side is smooth within each step and the switch happens between steps, which every method handles:

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

The switch lands up to one accepted step late, an error of the order of the step. A saturation without memory (`min(max(u, 0), umax)`) is continuous and needs nothing. A jump without memory (`2000 if T < 20 else 0` in `evaluate()`) makes the step size chase the corner under an adaptive method; write it as above.

## Errors and `OutOfDomain`

A failure names the program, what it belongs to, the time, the stage and the method where there is one, the line where the program says it, and the inputs: "Conduction on relationship Wall → Room failed in evaluate() at t = 0 s: ZeroDivisionError: float division by zero (line 18). Inputs: hot = 310 K, cold = 295 K, conductance = 4 W/K, capacity = 0 J/K". `fail("...")` (C++) stops the run with the line it was called on. A value that is not a finite number says whether an input already was ("the input ‘cold’ was already NaN: look at what sets Room.temperature") or the program made it from finite inputs. Raising **`OutOfDomain`** says "not these inputs" (a table lookup asked for a value outside its range): under Adaptive and Stiff the step is rejected and tried smaller, as for too large an error, and a step that becomes too small to take stops the run with the program's message; under Euler and Runge–Kutta 4 the run stops with it at once. An output that is not a finite number is treated the same way. Nothing is ever clamped.

## Testing a program

Each SDK has a harness for trying a program outside Konjugate:

```python
from konjugate.v2.testing import Harness

h = Harness(PidController, constants={"kp": 50.0, "ki": 5.0, "kd": 1.0, "max_power": 2000.0}, seed=7)
h.tick(time=0.0, setpoint=293.15, measurement=290.0)           # advance() at a clock tick
print(h.evaluate(t=0.0, setpoint=293.15, measurement=290.0))   # {'power': ...}
print(h.memory)                                                # {'integral': ..., 'previousError': ..., ...}
h.check(setpoint=293.15, measurement=290.0)                    # the standard checks, raising with a plain message
```

```cpp
#include <konjugate/sdk/v2/testing.hpp>

k::testing::Harness<PidController> h{{.constants = {{"kp", 50}, {"ki", 5}, {"kd", 1}, {"maxPower", 2000}}, .seed = 7}};
h.tick(0.0, {{h.program().setpoint, 293.15}, {h.program().measurement, 290.0}});
const auto report = h.check({{h.program().setpoint, 293.15}, {h.program().measurement, 290.0}});
if (!report.ok()) { std::puts(report.text().c_str()); return 1; }
```

`check()` runs the standard checks: every port declared once with a key a file can bind; `evaluate()` finite at the inputs with every output set; purity (two calls give identical bits and leave memory as it was); the memory round trip (memory restored into a fresh instance gives identical outputs and identical further `advance()`s, which catches something remembered outside declared memory); and a Jacobian, if the program gives one, against differences. The same checks run as `python -m konjugate.v2.check program.py name=value ...`, and, through the engine and the transport a run uses, as **Test** in the code editor (`konjugateEngine checkProgram`, [Engine CLI](engineCli.md)).

## Jacobians, for Stiff

Stiff (Rodas4 or BDF) works out the model's Jacobian exactly in each column every term reading it can give its derivatives, an equation from its own and a program from its `jacobian()`, and by differences in the others, one evaluation per colour of those columns ([Integrators](proposals/integrators.md#jacobians-for-rodas4)). A program can sharpen that: `k::Output warming{this, "warming", "K/s", k::dependsOn(hot, cold)}` (Python `Output("K/s", depends_on=("hot", "cold"))`) declares which inputs an output reads, and an optional `jacobian()` gives the derivatives themselves (`J(warming, hot) = x[conductance] / x[capacity]`; Python returns `{("warming", "hot"): ...}`). Declare dependencies only when sure: an output that reads an input it does not declare is wrong silently. Stiff uses declared dependencies for the Jacobian's structure, and a given Jacobian for the program's own entries: asked where the Jacobian is worked out, converted at the program's ports and taken through what each input is bound to (a state's entry; a parameter or the time is not a column), the other end of a two-way relationship with the sign flipped, beside the equations' derivatives, so the program's columns are worked out without differencing it. The run's summary counts the exact columns, and the run configuration's `jacobian: "check"` compares them with differences at every Jacobian. A program is still differenced in time, as it may read the time. A wrong Jacobian makes Stiff take more, smaller steps or fail to converge, so the harness and the code editor's Test check a given one against differences; a program with several outputs is still differenced.

## A relationship with several outputs

A relationship's program may reach several states, of either end, when one calculation gives them together (heat that leaves one body and reaches another, a reaction's products): declare several outputs (in C++ derive from `k::Node`, in Python from `Node`) and, in the relationship's editor, press **＋ Another output** beside the program, then choose each output's key and the state it reaches. Each output is a row of the relationship and a part of its state's equation, shown as "C++ program · output 1 of 2". It needs a program in this format and a one-way relationship; in the file the outputs are `implementation.outputs`, in place of `output` ([Project schema](projectSchema.md)).

## Performance

| Transport | Used for | Cost of a call |
| --- | --- | --- |
| In-process | C++ programs | a function call |
| Pipe to a worker | Python programs | a round trip with protobuf encoding, tens of microseconds before any work |
| Pyodide | Python programs in the web edition | a call into the browser's Python |

A whole-model method multiplies evaluations (four a step for Runge–Kutta 4, six for Adaptive, more for Stiff), so a Python program under Stiff is the slow case. C++ evaluations allocate nothing: ports are indexes, and memory is a buffer the engine owns.

## In the web edition and in exports

The web edition runs Python programs through its own Python (Pyodide), with the same code the desktop's worker uses, so they give the same numbers; C++ programs need the desktop app, which compiles them. Code export writes a program in this format into the C++ or Python program it exports, with the program SDK pasted in, one instance for each program (both ends of a two-way relationship share it), kept as the engine keeps it: started before the run with its inputs there (its memory set, a `Random` seeded from what the program belongs to, `initialize()` called), each input converted at its port as the engine converts it, `advance()` called after every substep under Euler node by node and after every step Runge–Kutta 4, Adaptive, Stiff and BDF accept, a clock ticking at the end of each global step it lands on, and a node's program setting its Update states at the update instant; under Adaptive, Stiff and BDF a refusal or a value that is not a finite number rejects the step there too. So the exported program gives the engine's numbers ([Code export](codeExport.md)). What it does not write yet is refused by name rather than written to run differently: a program's own `jacobian()` under Stiff, a value term (an Update) whose program has a clock, a relationship's program with several outputs, and a parallel mode other than serial for a program that remembers or under a whole-model method. FMU export writes them as code export does under Euler, node by node, and carries their memory in the FMU state, so an FMU restored from `fmi2GetFMUstate` continues as it would have.

## The older program format

Programs written before this SDK (`konjugate/relationshipProvider.hpp`, `from konjugate import RelationshipProvider`) keep working exactly as they did: under Euler node by node they give the same numbers to the bit, and under a whole-model method they are held, evaluated once per global step at its start, because nothing says that calling one again changes nothing. The Run dialog names the held programs with "Convert to version 2 ›", and the code editor shows an older program with "Older program format", and the same link. Converting turns the ports into declarations and the reads into `x[...]`; a program that changes its members in `evaluate()`, reads the step size, or saves a checkpoint by hand is converted as far as its ports, with a note at each place that needs a decision. The file's `implementation.providerApiVersion` says which format a program is (`1` or `2`); the app sets it from the source when the program is saved, and the engine refuses a file whose version and source disagree, saying which to change.
