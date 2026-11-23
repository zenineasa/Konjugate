---
type: Proposal
title: Resets at events
description: Setting a state's value at the instant a condition becomes true -- a bouncing ball's velocity reversed at contact, a counter incremented at each crossing, a relay set on an edge, a controller's integrator reset, a dose added, a neuron's potential returned after it fires -- written as a reset under the state it sets ("when h < 0: v ← −e·v"), located exactly by the event location the whole-model methods already have and applied at substep ends under Euler, node by node; what Updates, latched conditions, settling and program memory already serve and what they cannot; the instant, simultaneous resets, cascades and a guard against Zeno behaviour; Updates, checkpoints, programs and algebraic constraints; determinism, export, FMUs and the web; a file that changes only where a reset is written; benchmarks against exact solutions; and a staged plan.
tags: [proposals, engine, numerics, events, integrators, equations, editors]
status: draft
implementation: none
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Resets at events

**Status: proposed 23 November 2026, design only; nothing here is built. It takes up decision 3 of [Integrators, Event location](integrators.md#event-location-built-the-stage-after-adaptive) ("No reinitialisation in this stage ... a separate proposal for setting a state at an event follows") and builds on what that stage built: switching conditions found in a Rate equation's `Which`, latched through each step and located on the step's interpolant (`engine/include/konjugate/integrators/events.hpp`, `engine/src/eventLocation.cpp`). It also leans on [Rates and updates](ratesAndUpdates.md) (Updates set at global steps only), [Program SDK version 2](programSdkV2.md) (declared memory and `advance()`), and [One editor for nodes and relationships](unifiedEntityEditors.md) (one equation per state, its left side giving the state's order). [Algebraic constraints](algebraicConstraints.md) is deferred and is mentioned only for how it would interact. The [open questions](#open-questions) each carry a recommendation.**

## The problem

Some models need a state to jump. A ball reaches the floor and its velocity changes sign at once, losing a fraction. A counter goes up by one each time a shaft completes a turn. A relay closes when a temperature falls below one threshold and opens above another. A controller's integrator is emptied when its setpoint changes. A dose is added to a patient's plasma at eight o'clock. A model neuron's potential returns to rest the moment it fires. In each case a state is continuous between instants and is **set** to a new value at an instant that the model's own motion decides.

Konjugate cannot write that today. A Rate state only changes by integrating its rate. An Update is replaced at the end of every global step and never between steps ([Rates and updates](ratesAndUpdates.md)). The event location just built finds the instant a condition flips, but it only switches which branch of an equation is read. It sets nothing: "An event flips a mode and nothing else."

So the bouncing ball in the benchmarks (`benchmarks/mechanical/bouncingBall`) has a floor that is a stiff spring and damper. That gives a contact about 31 ms long, a coefficient of restitution that follows from the damping ratio rather than being stated, and a stiff model whose contact stability limit is 2 ms under explicit Euler. It is a fine benchmark of event location. It is the wrong model for a person who means "the ball bounces back at 0.8 of its speed".

This proposal adds a **reset**: a rule, kept under the state it sets, that gives the state a new value at the instant a condition becomes true. Modelica writes this as `when h < 0 then reinit(v, -e*pre(v))`.

## Decisions in brief

These are the recommendations. Each open choice among them is listed in [Open questions](#open-questions).

1. **A reset belongs to the state it sets.** It is one line under that state's equation, "when $h < 0$: $v \leftarrow -e\,v$", owned by the node in the first stage and by a relationship later.
2. **It fires when its condition becomes true.** The condition is a comparison, or comparisons joined by and, or and not, exactly as a `Which` condition is written. Its direction is the way the comparison is written: $h < 0$ fires as $h$ falls through 0, and $h > 0$ as it rises through. "Either way" is a stated choice, read "when $h$ crosses 0". A condition that already holds when the run starts does not fire.
3. **The instant is exact under Runge–Kutta 4, Adaptive and Stiff.** Every comparison in a reset's condition is a switching function in the set event location already watches, latched and located in the same way, and the step is cut to end on it. Under Euler, node by node, a reset is checked at the end of each of its node's substeps and applied there, up to one substep late, and the run says so.
4. **Every reset that fires at one instant reads the values just before it** (Modelica's `pre`), and all of them are applied together. The order they are worked out in never matters, as for Updates. Two resets of one state at one instant: the first listed under the state is taken.
5. **Cascades are rounds at the same instant.** After the resets are applied, every condition is read again, and resets newly made true fire in the next round. This repeats up to 100 rounds; past that the run stops and names the resets that keep setting each other.
6. **Zeno behaviour stops the run, in words.** It is detected when resets use up a global step's events, as a ball bouncing ever faster does. The message gives the instant the firings accumulate towards and how to give the model a way to come to rest. It is never carried on unlocated, because that would quietly skip the resets.
7. **Updates are untouched.** They are still replaced only at global steps, from the Rate states the step reached, resets included. A reset sets Rate states only. A reset of an Update is refused, because the next global step would overwrite it.
8. **The file changes only where a reset is written.** A node gains `resets` and the project document gains `requires: ["resets"]`. Both are written only when a reset exists. Every other file is the file the previous version wrote, byte for byte, and gives its numbers to the bit.

## What needs a reset, and what is already served

### The needs, with examples

**Impacts.** A bouncing ball, $v \leftarrow -e\,v$ when $h < 0$. Other impacts follow the same pattern:

- a hammer and anvil;
- a valve that slams shut;
- a car hitting an end stop;
- a pendulum striking a wall (the impact oscillator of nonlinear dynamics);
- two pucks colliding, which sets both velocities from conservation of momentum and is a reset at both ends of a relationship.

The coefficient of restitution is a parameter a person states and fits, not a property that emerges from a stiff spring.

**Counters.** Revolutions of a shaft, $n \leftarrow n + 1$ when $\theta > 2\pi$, together with $\theta \leftarrow \theta - 2\pi$ to keep the angle wrapped. Other counters work the same way:

- spikes of a neuron;
- vehicles past a sensor in a traffic twin;
- cycles of an engine;
- zero crossings of a vibration.

A counter is a Rate state with no rate. It changes only at its resets, so its value is exact at every instant, however many crossings fall in a global step.

**Relays, latches and hysteresis.** A thermostat sets a relay state with two resets: on $\leftarrow 1$ when $T < 19.5$ and on $\leftarrow 0$ when $T > 20.5$. Its heater reads that state. Other cases:

- a flip-flop set on a rising edge;
- a pump that latches on at a high level until a low one;
- a Schmitt trigger;
- a circuit breaker that trips and stays open.

**Resets of integrators in controllers.**

- A PI controller's integral emptied when its setpoint changes ("when $t > t_s$: $I \leftarrow 0$", a condition on time).
- A Clegg integrator, reset to 0 whenever its input crosses zero.
- Back-calculation set at the moment of saturation.
- A sample-and-hold driven by a comparator.
- A timer restarted on an event.

**Piecewise state jumps.**

- A bolus dose in pharmacokinetics: $A \leftarrow A + D$ at $t = 8$ h.
- An integrate-and-fire neuron: $V \leftarrow V_{\text{reset}}$ when $V > \theta$.
- A relaxation oscillator's capacitor discharged through a spark gap.
- A dosing siphon emptying when full.
- A cell dividing, its mass halved.
- An inventory reordered at its reorder point, $s \leftarrow s + Q$ when $s < r$, in a Logistics Toolbox model.
- A sawtooth generator.

### What is already served, and what is not

| Need | Served today by | Exact? | What a reset adds |
| --- | --- | --- | --- |
| A switched right-hand side: a diode, a thermostat without hysteresis, a contact force | a `Which` condition, latched and located ([Integrators, Event location](integrators.md#event-location-built-the-stage-after-adaptive)) | yes, under the whole-model methods | nothing: no state jumps |
| A conditional integration, such as anti-windup by stopping the integral while saturated | a `Which` on the integral's rate | yes | nothing |
| A sampled controller, sample-and-hold on a clock, a discrete filter | Updates at global steps; version 2's `advance()` on a clock | yes, at its clock | nothing |
| A counter of crossings | an Update reading itself and a stored previous value, `n = n + [x \ge 0 \wedge x_{\text{prev}} < 0]` | only with at most one crossing per global step, counted up to a step late | every crossing, at its instant |
| Hysteresis (a relay) | an Update latching itself, up to a global step late; version 2 memory flipped in `advance()`, up to an accepted step late, and exact once version 2's declared crossings are built | no (yes, later, inside a program only) | an exact relay written as equations, its state visible and plotted |
| An integrator reset or a state jump at a known time | nothing; a schedule can only drive a parameter, and a pulse of rate only approximates a jump | no | the jump, exactly at its time |
| An impact with restitution | a stiff contact spring and damper on a `Which`, as in the benchmark | the contact is exact; the physics is a different model | the rigid impact, with $e$ stated |
| Settling | chains and rings of Updates within a step | not relevant: it settles values at an instant, it never moves a Rate state | -- |

Two conclusions follow. Latched conditions serve every case where a state's rate jumps, and nothing new is needed there. Updates and version 2 memory serve every case where the jump may wait for a step or a clock tick. What remains is a Rate state set at an instant only the motion knows, and that is what a reset is.

Version 2 memory remains the right home for logic that is a program's own business, such as a controller's internal mode. A reset is for a quantity that is a state of the model: plotted, read by relationships and checkpointed with the others.

## Writing a reset

### The choices, weighed

| | A reset under the state it sets | A free-standing "when" block on the node (Modelica's form) | A new kind of relationship |
| --- | --- | --- | --- |
| Fits one equation per state | yes: it is part of what changes the state | no: one block may set several states, so a state's changes are spread over several places | partly |
| Where a person looks for "why did $v$ jump" | on $v$'s row | anywhere in the node | on the canvas |
| One condition setting several states (a ball's $v$, and $h \leftarrow 0$) | written on each state, compiled once | written once | once |
| Order of two resets of one state | their order under the state, visible | the order of blocks, harder to see | not defined |

**Recommendation: under the state it sets.** One condition that sets several states is written on each of them. The engine compiles identical conditions into one switching function, so the resets fire at the same instant to the bit. The editor offers the node's existing conditions when a reset is added ("when $h < 0$, as Velocity's"), so a person types a condition only once.

### In the editors

A state's row on the Equations tab ([One editor for nodes and relationships](unifiedEntityEditors.md)) gains its resets as lines under the equation, each marked ↯:

```
Velocity · v · starts at 0 m/s
  dv/dt = −g
  ↯ when  h < 0  :  v ← −e·v                    when Height falls below 0, Velocity becomes −e times what it was
  + Add a term    + Add a reset
```

- **"+ Add a reset"** sits beside "+ Add a term" on every Rate state's row. That is the plain, visible entry point.
- **The condition is a math field**, typed as a `Which` condition is: $h < 0$, $\theta > 2\pi$, $T < 19.5 \wedge \text{on} = 1$. Beside it is a small choice: **becomes true** (the default) or **crosses**, which is shown only when the condition is a single comparison. The words beside the line then say "falls below", "rises above" or "crosses", so the direction is read and not guessed.
- **The value is a math field**: the state's new value, reading any of the node's states, its parameters and the time. Each value is the one held **just before** the instant. The value may read its own state, as $-e\,v$ does.
- **The line in words**, in small type, always appears: "when Height falls below 0, Velocity becomes −e times what it was". It is generated from the math in the reader's names, as chips are.
- **Order.** Several resets under one state are listed in order, with ↑ ↓ to reorder them. The first one that fires at an instant is the one taken (below), and the row says so when there are two.
- **A state with no rate and only resets** (a counter, a relay) no longer folds into "stays at 0". It reads "Revolutions · n · starts at 0 · changes only at its resets", with its resets under it.
- **The parameters** a reset uses (e, $v_{\text{rest}}$) are the node's own and appear on its Parameters tab under the state, as a term's do. They can be tuned and steered live like any parameter.
- **Refused in words, on the row** (the validator's message shown where it applies):
  - a reset of an Update: "Count is an Update: it is worked out again at every global step, so a value set at an event would last only until then. Make Count a Rate (dn/dt =) with no terms; it then changes only at its resets";
  - a condition with no ordering comparison ("a reset fires when a comparison becomes true; = and ≠ are never crossed over an interval: write < or >");
  - a reset on a state set by a program;
  - a reset on a node that is a program of its own, or an imported FMU, which owns its states.

**On a relationship's card (stage 3)**, a reset onto an end's state is written the same way. A collision sets both ends at one condition, so it has two lines that share the condition, as a term running both ways has two rows. On each node, the relationship's reset is a read-only chip under the state, opening the relationship.

**Higher orders.** Once a state of order 2 exists ($\frac{d^2h}{dt^2} = -g$), its reset chooses which it sets: the state, or its hidden derivative. In that case "when $h < 0$: $h' \leftarrow -e\,h'$" is the ball in one state. Until then the ball has two states, $h$ and $v$, as today.

### On the canvas

- **A node with resets** carries a small ↯ beside its name, with the number of resets when there are several. Hovering lists them in words ("Velocity: when Height falls below 0, becomes −e times what it was").
- **A relationship with resets (stage 3)** carries the mark at its midpoint, as an edge's other badges do.
- **While results are open**, a state set by a reset is drawn with its jump: a vertical segment from the value before to the value after, at the instant, taken from the result's event list (below). The sampled line is not drawn across it. Each event instant is a faint tick on the time axis of the node's plots. After the first thousand events, which is as many as the list keeps, plots fall back to the samples and say so.

### The bouncing ball, written

```
Height · h · starts at 1 m
  dh/dt = v
  ↯ when  h < 0  :  h ← 0                          when Height falls below 0, Height becomes 0
Velocity · v · starts at 0 m/s
  dv/dt = −g        (while h > 0 or v > 0; 0 otherwise)
  ↯ when  h < 0  :  v ← −e·v  if  −e·v > v_rest,  else 0
```

The first reset puts the ball back on the floor. Without it the ball sits a rounding below the floor, since the instant is located where the condition already holds.

The `Which` on $dv/dt$ together with $v_{\text{rest}}$ gives the ball a way to stop: a bounce slower than $v_{\text{rest}}$ ends with the ball resting on the floor. The library's example is written this way, so the Zeno guard below never has to stop it. The plain form, with only "when $h < 0$: $v \leftarrow -e\,v$", is valid. It bounces correctly until its bounces accumulate, and then stops with the Zeno message.

## Semantics

### The instant

A reset fires at the instant its condition becomes true. Under a whole-model method that instant is located as event location locates any switch (Adaptive and Stiff on their dense output, Runge–Kutta 4 on its cubic Hermite interpolant, by bisection to $10^{-12}$ of the step), and the step is retaken to end there. As built, the located instant is the end of the final bracket, **where the condition already holds**. So $h$ is at most a rounding past zero, and the values a reset reads are the states the retaken step reached. The state values before the reset are written $x(t^{*-})$.

At the instant, in order:

1. The step that ends at $t^*$ is accepted in the old mode, as today.
2. A version 2 program's `advance()` for that step is called, with the inputs at $t^{*-}$, as it is for every accepted step.
3. **Every reset that fires reads $x(t^{*-})$**, together with the Updates as they have been since the global step began, the parameters at $t^*$ and the time $t^*$. Its value is worked out from these.
4. **All of them are applied together.** No reset reads another's new value at the same round, so the order they are worked out in never matters. This is the rule that makes Updates independent of order, applied to an instant.
5. **Every condition is read again** from the new values (below). That covers the `Which` latches the equations read and the resets' own conditions.
6. The next step starts from $x(t^{*+})$ with a fresh derivative, as every step after an event does today. Adaptive and Stiff keep their controllers' proposed step. Rodas4 works out its Jacobian again. Runge–Kutta 4 takes the rest of its grid step and so stays on its grid.

A crossing in a reset's condition is located and the step cut there **whatever its direction**, even when no reset fires. If $h$ rises through 0 in mid-step, nothing fires, but cutting there means a fall back through 0 later in the same step is seen. Without the cut, two crossings in one step would cancel. Only firing is filtered by direction. Each cut is a step of the method, so the cost is a step per crossing, the same as a `Which` already pays.

### Becoming true

Each reset keeps whether its condition **held** after the last instant it was read. The condition is a Boolean of its comparisons' latches. A reset that "becomes true" fires when it went from not holding to holding. A reset that "crosses" fires on any change.

Three consequences follow. A condition already true at the run's start does not fire. A condition true when a run is restored with its states replaced (a twin's rewind) does not fire. A compound condition ($T < 19.5 \wedge \text{enabled} = 1$) fires on the edge of the whole condition, not of each part.

**Arming**, as built, carries over. After a switching function's crossing, it is not located again until it is clear of zero by more than rounding. That keeps a ball resting a rounding below the floor from firing again and again. A function that a reset moves clear of zero is armed at once. For example, $\theta \leftarrow \theta - 2\pi$ takes $\theta - 2\pi$ from 0 to $-2\pi$, so the next turn is counted.

**Conditions that change at a global step.** An Update replaced at the end of a step can make a reset's condition true. So can a live parameter set, a recorded intervention or a schedule's step. The engine already reads every latch afresh at a global step's start and records a change there as an event. A reset whose condition became true there fires there, at the global step's instant, after the Updates. A counter of an Update's edges therefore counts them. A condition on time against a constant ("when $t > t_s$") is a breakpoint known in advance. Adaptive and Stiff land on it as they land on a schedule's corners, and Runge–Kutta 4 locates it like any other.

### Simultaneous resets

Several resets fire at one instant when their conditions cross within the location's tolerance of each other. Event location already takes such crossings together, in plan order. They all read $x(t^{*-})$, so a ball hitting a corner gets both its $v_x$ and its $v_y$ reversed, each from the other's old value.

**Two resets of one state** firing at one instant are a conflict, and the first listed under the state is taken (Modelica's `elsewhen`). The run notes it once: "Velocity had two resets at t = 1.204 s; the first listed, when Height falls below 0, was taken." The alternative, refusing the model, is weighed in the open questions. Validation cannot know in general whether two conditions can coincide.

### Cascades

A reset can make another condition true at the same instant. Examples: a counter reaching 3 triggers a second reset, or a reset of $\theta$ lands it past another threshold. After step 5 above, every reset whose condition has newly become true fires in a **round** of its own at the same $t^*$. It reads the values the previous round left, and the rounds go on until none fires. The event list records each firing's round.

A reset that fires in its own cascade with no time passing (n ← n + 1 when n > 0) would never end. Past 100 rounds the run stops, keeping its samples so far, with "Resets set each other without end at t = 3.000 s: Count (when Count > 0) fired 100 times without time passing. A reset's new value must not make its own condition become true again". A reset of a state cannot fire in its own round twice, because a condition becomes true only once per reading.

### Zeno behaviour

A ball with $e < 1$ bounces infinitely often before $t_\infty = t_1 \frac{1 + e}{1 - e}$, with $t_1 = \sqrt{2 h_0 / g}$ the first impact. For $e = 0.8$ from 1 m, that is 4.064 s. A model that asks for that cannot be integrated past $t_\infty$ without saying what happens there. The engine cannot know whether the ball rests, sticks or does something else.

**The guard.** Event location already stops locating after 100 events in one global step and carries on reading its conditions at step starts, which is right for a chattering switch. For resets it is wrong: unlocated, the ball's reset would be skipped and the ball would fall through the floor. So **when a global step reaches its event limit and a reset fired in it**, the run stops, keeping its samples so far. The message names the reset, the number of firings, the ratio between successive intervals and the accumulation instant it points to. That instant comes from the last three intervals as a geometric series, $t_n + \Delta_n r / (1 - r)$:

> Ball's reset of Velocity (when Height falls below 0) fired 100 times between 4.0618 s and 4.0637 s, each interval about 0.80 of the one before, so they would pile up at about 4.0637 s: the model asks for infinitely many bounces in a finite time. Give it a way to come to rest, for example a rest speed below which Velocity becomes 0, and a rate that stays 0 while the ball rests (see the Bouncing ball example). The run stopped at 4.0637 s.

Two alternatives were considered and are not recommended. An automatic "rest" (freezing the states a reset sets once firings accumulate) is physics the engine would be inventing. A minimum time between firings would distort every impact model a little to protect a few.

The limit stays the built one, 100 events per global step, so a model with a fine global step meets it in the same circumstances as a coarse one: when firings accumulate.

### Updates, settling and latched conditions

- **Updates still change only at global steps.** A reset does not replace them, does not trigger them, and cannot target them. Within the step, resets read Updates held as every stage does. At the step's end, the Updates read the Rate states the step reached, resets included. A model's discrete-time Updates mean the same thing with and without resets, as [Rates and updates](ratesAndUpdates.md) and event location require.
- **Settling is unchanged.** It settles Updates at the global step and never runs at an event.
- **Latched conditions** (`Which`) are read afresh after the resets at an instant (step 5). As built, a flip only toggles the latches found changing. Once a reset has moved states, the latches are read from the new values instead. A function still within rounding of its crossing keeps the latch the event left it with, as arming already provides.

### Checkpoints and restart

A checkpoint is taken at a global step, after its Updates.

- **Whole-model methods** need nothing new in layout. A reset's comparisons join the switching conditions whose latches and armed flags `solver_state` record version 2 already keeps, and each reset's "held" is a Boolean of those latches. A run continued from a checkpoint therefore fires the uninterrupted run's resets, to the bit.
- **Euler, node by node** has had no hidden state (`explicitEuler`, empty `solver_state`). With resets it needs one: each reset's "held", because a condition that an Update changes at the boundary is an edge only if the value before the boundary is known. A new record carries it, version byte 1 followed by one byte per reset, under `explicitEuler`. It is written only for a model with resets, so every other Euler checkpoint stays empty.
- **A run started afresh, or restored with states replaced**, reads every condition without firing. That is the rule for a run's first reading as built.

### Methods

**Runge–Kutta 4, Adaptive and Stiff**: located, as above.

**Euler, node by node**: a reset is checked at the end of each substep of its node and applied there. The check reads the node's own states as they are at that substep's end; a reset's condition reads only its own node in the first stage. It runs after all the substep's moves (explicit, semi-implicit, or Verlet's three), and rounds run there as well. Each reset is up to one substep late. The ball penetrates the floor by up to $v\,h$, and its impact times are first order in $h$, like every other error of the method. The run's summary names the resets, as it names the conditions it did not locate: "2 resets applied at substep ends, up to 1 ms late; under Runge–Kutta 4, Adaptive or Stiff they are located exactly". The Run dialog shows the same line beside Method, with **Use Runge–Kutta 4** one click away.

Locating events node by node was rejected in event location's decision 2, because it would mean stopping every node at each event. Refusing resets under Euler altogether was weighed too. Euler is the default, so a person's first reset would then refuse to run until they found the Run dialog. Applying a reset at substep ends keeps the short path to a working result, and the line in the summary keeps it honest.

**Stepped nodes and held programs.** A node stepped on its own (a program of its own, or an imported FMU) cannot carry resets, because it owns its states. A held version 1 program on a node with resets reads the jumped state from the next global step, as it reads every state, and the run already names held programs.

### Programs (version 2)

A version 2 program cannot set a model state at an event. It changes its own memory in `advance()`, and its outputs reach states as rates or values. The ordering above (step 2 before step 3) fixes how the two meet: `advance()` sees $x(t^{*-})$, and the step after the instant evaluates with $x(t^{*+})$ and the memory `advance()` wrote.

When version 2's declared crossings are built, they join the same event list. A program whose crossing falls at the same instant as a reset gets its `advance()` in step 2. A crossing that a reset causes is taken in the next round, with `advance()` called there on the post-reset inputs, once per round in which its crossing changed. That rule is recorded here for version 2's crossings stage to adopt or replace. Until then, version 2 does not see resets except through its inputs.

### Algebraic constraints (deferred)

If [algebraic constraints](algebraicConstraints.md) are built, their algebraic states are solved again after every round of resets, with the reset Rate states fixed. This is consistent re-initialisation at $t^{*+}$, the same re-solve that proposal already does after Updates, live control and restores. A reset whose values leave a constraint unsolvable stops the run by name.

A reset of a state that a higher-index constraint ties down would break the hidden constraint. An example is the velocity of a rigid rod's end: it would need an impulse distributed through the constraint. Such a reset is refused until that proposal's reduction and projection exist. Ideal switches and diodes, whose structure changes at events, remain outside both proposals.

### Stability analysis, tuning and the twin

- **The stability analysis** linearises the flow between events. For a model with resets, its findings say "between resets", and it does not judge the resets themselves. An impact map's stability is a different analysis, not proposed.
- **Tuning** can fit $e$ or a threshold like any parameter. An objective is continuous in them, but its slope jumps where an event appears or disappears.
- **The state estimator's ensemble members** each locate their own events, at their own instants.

## Determinism

Event location already evaluates switching functions on one thread, from the gathered stage values in plan order, and breaks ties in plan order. Resets add three things to that path, each deterministic by construction:

- **Their values** are worked out on the same thread, node by node in plan order, from the one vector $x(t^{*-})$.
- **Their application** writes each reset state once per round, with conflicts settled by the listed order.
- **Their rounds** read whole vectors.

Under the partitioned backend, the post-reset values of a partition's states are sent to it with the next step's start, one message at an instant with resets. The bits are therefore the same on every backend and worker count, and from a checkpoint.

Under Euler, node by node, a node's resets read only that node's states, its parameters and the time, inside the node's own worker, so they are as deterministic as its substeps.

Across platforms, numbers differ only by rounding, as now. Under an adaptive method, rounding can on rare occasions tip a step's acceptance, and so tip an event's located instant within its tolerance.

## Export, FMUs and the web

**C++ and Python export** paste the event headers in, as they do for event location, and gain the reset code: the compiled conditions, the values, the rounds and the guard. Whole-model methods apply resets as the engine does. Euler applies them at substep ends as the engine does. The exported program therefore gives the engine's samples to the bit, as the fidelity tests check in every C++ mode and in Python. Export refuses what it cannot write by name until each piece is written.

**FMU export** writes FMI 2.0 and 3.0 Co-Simulation, stepping with Euler, node by node, inside `fmi2DoStep`. Resets are applied at substep ends inside the step exactly as the engine applies them, and each reset's "held" is part of `fmi2GetFMUstate` and its serialisation. The importer sees jumps at its communication points, as it sees any state.

FMI 3's event mode for Co-Simulation (`eventModeUsed`, `earlyReturnAllowed`) would let an exported FMU return early at an internal event, so the importer sees the instant. It is not proposed: it serves importers that need event instants rather than values, and none has asked.

When the whole-model methods are exported into FMUs (a later stage of [Integrators](integrators.md)), events and resets are located inside `fmi2DoStep` as within a global step. Model Exchange is deliberately not offered ([Code export](../codeExport.md)). If it ever were, resets would map directly onto it: the switching functions would become event indicators (`fmi2GetEventIndicators`), and the resets would run in `fmi2NewDiscreteStates` with `valuesOfContinuousStatesChanged` set.

**Imported FMUs** keep their own events inside their own steps, unchanged. The Reference FMU BouncingBall remains a co-simulation FMU that bounces itself.

**The web edition** compiles the same engine to WebAssembly, so resets behave there as on the desktop, within rounding of native.

## File format and backwards compatibility

The hard rule holds:

- every file a released version wrote opens and gives the same numbers, to the bit;
- a file this version writes without resets is, byte for byte, the file the version before wrote;
- new fields are written only when used.

### Project document

A node gains `resets`, beside `sourceTerms`, written only when the node has one:

```json
"resets": [
  {
    "id": "reset-1",
    "state": "velocity",
    "when": { "latex": "h < 0", "mathJson": ["Less", "height", 0] },
    "fires": "crosses",
    "value": { "latex": "-e\\,v", "mathJson": ["Negate", ["Multiply", "restitution", "velocity"]] },
    "bindings": [ ... ],
    "parameters": [ ... ]
  }
]
```

- **`state`** names the node's own state by symbol, as a source term names its output.
- **`when`** and **`value`** are each editable LaTeX and executable MathJSON. Their local-state and parameter bindings, and their own `parameters`, take the shape of a source term's `expressionModel`.
- **`fires`** is written only when the reset fires on a crossing in either direction. When it is absent, the reset fires when its condition becomes true.
- **The order of a state's resets** is their order in the array.
- **In stage 3, a relationship gains `resets` of the same shape**, each naming its end's state by role, as an edge's output does.

The validator gives the new rules their codes:

| Code | When it is given |
| --- | --- |
| `resetIntoUpdateState` | a reset of an Update |
| `resetConditionInvalid` | no ordering comparison, or `Equal` |
| `resetStateInvalid` | a missing state, a program's state, or a stepped node's |
| `resetsCascade` | the run stopped after 100 rounds |
| `resetsZeno` | the run stopped by the Zeno guard |

A reset's value that is not finite at an instant stops the run with `resetValueNotFinite`, naming the reset and the instant.

**`requires: ["resets"]`** is written on the project document whenever a reset exists. It is the first entry of the lever [Integrators](integrators.md#decisions) added: every engine from the one that added `requires` refuses an entry it does not know, by name ("This model requires "resets", which this version of Konjugate does not know; open it in a newer version."). A version that has `requires` but not resets cannot run the ball through the floor quietly.

| Change | Written when | Older files in this version | This version's files in older versions |
| --- | --- | --- | --- |
| A node's `resets` | only when it has one | absent: no resets, identical numbers | from the version with `requires`: refused by name through `requires`. The released 1.4 series knows neither field: it ignores both, keeps them where it preserves fields it does not know, and runs the model without its resets (open question 9) |
| `requires: ["resets"]` | only when a reset exists | absent | as above |
| A relationship's `resets` (stage 3) | only when it has one | absent | as above |

### Results and checkpoints

| Change | Older results in this version | This version's results in older versions |
| --- | --- | --- |
| The result's `integration.resets` (how many fired) and, in `eventList`, each reset's firing as `resetId`, `round`, `before` and `after` | absent | skipped as fields they do not know |
| Under Euler, the summary's `resetsAtSubsteps` | absent | skipped |
| `solver_state` under `explicitEuler`: a record of each reset's "held" (version byte 1, then a byte per reset) | empty, as now | an older engine cannot run such a model anyway (`requires`) |
| `solver_state` under the whole-model methods | unchanged layout (record version 2): the resets' comparisons are among its conditions | as above |

## Verification

The [benchmark suite](../../benchmarks/README.md) is the proof, with its rules unchanged: committed models, exact references, and thresholds in each `benchmark.json`.

**Nothing else changes.** Every bundled example's digest, and the Logistics and Robotics Toolboxes' engine-test runs, are unchanged to the bit. `benchmark:accuracy` passes with no threshold changed, including `mechanical/bouncingBall`, the stiff floor, which stays as event location's benchmark. A file saved without resets is byte-identical to the previous version's.

**A true bouncing ball** (`mechanical/bouncingBallRestitution`): $h_0 = 1$ m, $g = 9.81$ m/s², $e = 0.8$.

- **The exact solution.** The first impact is at $t_1 = \sqrt{2h_0/g}$, and the $k$-th flight after it lasts $2 e^k t_1$. So impact $k + 1$ comes at $t_{k+1} = t_k + 2 e^k t_1$, and the speed leaving impact $k$ is $e^k g t_1$.
  - A parabola is integrated exactly by every method of order two or more. Under Runge–Kutta 4, Adaptive and Stiff, the ball's error is therefore the location's alone.
  - The impact times should be within the bisection's tolerance and the speeds within rounding, over the first 30 bounces. The thresholds are set when it is built.
- **The bounce ratio.** Each impact's speed after against the speed before is exactly $e$, and each peak height is $e^{2k} h_0$.
- **With linear air drag** ($\dot v = -g - c\,v$), the flight is no longer a polynomial.
  - The exact flight is closed-form, and each impact is its root found by bisection to the last bit, as the stiff floor's reference is.
  - The trajectory's observed order is checked: Runge–Kutta 4 at 3.6 to 4.1, and Adaptive and Stiff with their tolerance slopes.
  - The work is set against the stiff floor at the same accuracy, which should take many times more steps.
- **Zeno.** The plain ball stops with `resetsZeno` before $t_\infty = t_1(1+e)/(1-e) = 4.0637$ s. The message's predicted accumulation instant is checked against $t_\infty$. The library's form, with a rest speed, comes to rest and runs to 10 s.
- **Under Euler, node by node**, impacts are late by at most one substep, and the error is first order.

**A counter** (`verification/eventCounter`): an integrate-and-fire neuron, $\dot V = (I - V)/\tau$, $V \leftarrow 0$ and $n \leftarrow n + 1$ when $V > \theta$. With $\tau = 10$ ms, $I = 1.5$ and $\theta = 1$, the period is exactly $T = \tau \ln \frac{I}{I - \theta} = 10.986$ ms.

- The spike times are $kT$, at the method's order.
- $n(t) = \lfloor t/T \rfloor$ exactly, at a global step of 0.1 s, about nine spikes a step. An Update counter would count one.
- A shaft's revolutions ($\theta \leftarrow \theta - 2\pi$ with $n \leftarrow n + 1$) count exactly over $10^4$ turns.

**An integrator reset**: a PI controller on a first-order plant whose setpoint steps at $t_s$, with its integral reset there ("when $t > t_s$: $I \leftarrow 0$").

- The closed-loop response is exact, as a sum of exponentials.
- Adaptive and Stiff land on $t_s$ as a breakpoint.
- A bolus dose ($A \leftarrow A + D$ at 8 h and 16 h) against $A(t) = \sum_i D\,e^{-k(t - t_i)}$.

**A relay with hysteresis**: $\dot T = (T_a + P R\,\text{on} - T)/\tau$, with $T_a = 15$ and $P R = 10$, and on $\leftarrow 1$ when $T < 19.5$ and on $\leftarrow 0$ when $T > 20.5$.

- It switches every $\tau \ln(11/9)$ exactly, alternately on and off.
- Each switch is compared with the version 2 memory form, which switches up to an accepted step late.

**Semantics.**

- **Simultaneous**: a ball in a corner reverses $v_x$ and $v_y$ from each other's old values.
- **Conflict**: two resets of one state take the first listed, with the note.
- **Cascade**: a counter reaching 3 fires a second reset in round 1 of the same instant.
- **Endless cascade**: a cascade without end stops with `resetsCascade`.
- **No firing at start**: a condition true at the start does not fire.
- **Updates**: a condition made true by an Update fires at the global step.

**Determinism and restart.**

- Every case gives the same bits on serial, thread pool and partitioned backends at several worker counts.
- A run to $T$ equals, to the bit, a run to $T/2$ continued from its checkpoint, mid-bounce, under every method, Euler included.
- WebAssembly agrees with native within rounding.

**Export.** C++ (every mode) and Python reproduce the engine's samples to the bit on the ball, the counter and the relay. `test:fmiExportFidelity` and `test:fmiRoundTrip` run with resets under Euler, including `fmi2GetFMUstate` across a bounce.

## Order of work

1. **The engine and the editors, together**, since a reset nobody can write is no feature. This stage covers:
   - a node's own resets on its own Rate states, with `resets` and `requires` in the codec and the engine, and the validator's codes and messages;
   - conditions compiled into the event plan's switching functions, identical ones shared;
   - firing on becoming true or crossing, simultaneous resets, conflicts, rounds and the cascade limit, and the Zeno guard with its message;
   - Euler, node by node, at substep ends with its line in the summary and the Run dialog, and its `solver_state`;
   - the event list's reset fields;
   - "+ Add a reset" on a state's row, the line in words, the ↯ mark, and plots drawing jumps;
   - the bouncing ball as a bundled example with its rest speed, and a short tutorial, "A ball that bounces";
   - the benchmarks above.

   Nothing ships until every digest is unchanged.
2. **Export**: C++ and Python under every method, and FMU export under Euler.
3. **Relationship resets**: a collision between two nodes, a condition reading both ends, and resets at both ends at one condition. Their resets under Euler, node by node, are applied at the global step's end, since a node's substeps cannot set another node's states mid-step. Whether that is good enough is measured on two pucks colliding before this stage is offered.
4. **Later, each with the feature it waits for**:
   - resets of a higher-order state's derivatives, with [One editor's](unifiedEntityEditors.md) order 2;
   - version 2's crossings sharing the event instants;
   - re-initialisation of algebraic states, with [Algebraic constraints](algebraicConstraints.md);
   - FMU export of the whole-model methods with events inside `fmi2DoStep`.

## Not in this proposal

- **An automatic rest at a Zeno point**, or any regularisation the person has not written.
- **Impulses through a constraint**: a reset distributed across a rigid joint.
- **Structure that changes at events**: ideal switches, clutches that lock and slip.
- **FMI 3's Co-Simulation event mode, and Model Exchange.**
- **Resets written as programs.** A version 2 program changes its own memory, not model states.
- **Delays and timers measured from an event**, beyond what a state with rate 1 that is reset at the event already gives.

## Open questions

1. **Where a reset is written.** Under the state it sets; as a free-standing "when" block on the node; or as a relationship of its own. *Recommendation: under the state*, for one equation per state, a visible order for conflicts, and "why did $v$ jump" answered on $v$'s row.
2. **Words.** "Reset" in the file, the help and messages, and "↯ when … : $v \leftarrow$ …" with its line in words in the editor; or "jump", or Modelica's "reinit". "Reset" is also how [Prediction-actual window](predictionActualWindow.md) describes moving a model to its measurements. *Recommendation: "reset"*: it is the word controllers (integrator reset), counters and circuits use. The twin's use is about the whole model at once, and its documents can say "reset to the measurements" where it matters.
3. **Euler, node by node.** Apply resets at substep ends, up to a substep late, and say so; or refuse a model with resets until a whole-model method is chosen. *Recommendation: apply and say*: Euler is the default, the short path to a running model matters, and the summary and the Run dialog's one-click switch keep it honest.
4. **Two resets of one state at one instant.** Take the first listed, with a note; refuse at validation when two conditions could coincide; or stop the run. *Recommendation: the first listed*, since validation cannot tell in general and a stopped run for a corner case is harsh. The note says it happened.
5. **Zeno.** Stop with a message naming the accumulation instant; carry on unlocated, as chattering does; or rest automatically. *Recommendation: stop*, keeping the samples so far, because carrying on unlocated skips resets and resting invents physics. The bundled example shows how a model comes to rest.
6. **A condition true at the run's start.** Never fires, or fires once at the start. *Recommendation: never*, as Modelica's `when`: a reset acts on a change. A person who wants a value at the start sets the start value.
7. **Conditions changed at a global step** by an Update, a live parameter or a schedule. Fire there, or only on crossings located within steps. *Recommendation: fire there*, so a counter of an Update's edges counts every edge, and a reset driven by a live control acts when the control lands.
8. **Reading values just before or just after.** Every reset at an instant reads $x(t^{*-})$, with cascades in rounds; or each reads the latest values in a set order. *Recommendation: just before*: it is the rule that makes Updates independent of order, and it makes simultaneous resets (the corner, a collision's two ends) right by construction.
9. **The released 1.4 series**, which ignores `resets` and `requires` and runs the model without its resets. Accept it, as `method` and `kind` are accepted; or write a marker that 1.4 refuses. *Recommendation: accept*, and ship resets in a release no earlier than the one that ships `requires`. Every engine from then on refuses the file by name rather than quietly running a ball through its floor. Resets need not gate 2.0; if they land after it, `requires` is exactly what makes 2.0 refuse them by name.
10. **The limits.** 100 rounds at an instant and the built 100 events per global step, fixed; or set per run. *Recommendation: fixed*, as event location's are, with the messages naming them. A model that meets them legitimately is unknown so far.
11. **Relationship resets in the first stage.** Needed for collisions between two bodies and for a condition watching another node. *Recommendation: a later stage (3)*. Node resets cover every example above but collisions, and the Euler rule for resets that cross nodes wants measuring first.
12. **Plots drawing jumps.** Record each firing's value before and after in the event list and draw the jump; or plot samples only. *Recommendation: record and draw*. Without it, the ball's plot is a sawtooth of straight lines through the floor between samples, which misreads the model. Beyond the event list's first thousand firings, plots fall back to samples and say so.
