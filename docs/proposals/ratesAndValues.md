---
type: Proposal
title: Rates and values
description: One governing equation for every node - each of its states either changes over time or is worked out at each instant, chosen per node with a per-state choice for mixed nodes - replacing setsValue, relationships that set values and the feedthrough flag with one rule, and giving recorded and streamed signals one form.
tags: [proposals, engine, equations, schema, algebraic-states]
status: draft
implementation: none
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Rates and values

**Status: proposed, November 2026. Steps 1 and the first half of 2 are built: a state's `changes`, kept by the codec and checked by the validator; the engine compiling from a state's kind; values summing from every kind of term, an ordinary relationship or source term into a state marked worked out setting its value. Pure programs and the rest are not. It comes from building core changes 1 and 2 of the [Neural Toolbox](neuralToolbox.md), which showed that the engine's ways of setting a value had grown into a patchwork.**

## The problem

Konjugate is described by one equation: a node's rate of change is the sum of what its relationships bring in plus its own term,

$$\dot{x}_i = \sum_j f_{ij}(x_i, x_j, t) + s_i(x_i, u, t)$$

Over time the engine has learned a second thing, a value worked out at an instant rather than integrated, and it has learned it four separate times:

| Mechanism | What it does | Its own rules |
| --- | --- | --- |
| `setsValue` on a source term | the state *is* the term's value, from its own node's states | sole contributor; ordered within its node |
| A relationship with several equations (`equationModel.outputs`) | sets states on either end | values from several relationships **sum**; ordered across the model |
| `setsValue` on a node program's output | the value the program reports **after advancing over the step** | sole contributor; one step behind its inputs |
| `implementation.feedthrough` (built, then withdrawn in favour of this proposal) | a program's outputs as values **at the instant** | every output must set a value |

The same word, `setsValue`, means *the value now* on a source term and *the value after the step* on a program. Values sum when relationships set them and are refused when anything else does. The feedthrough flag was added to make one of these behave like another, and on reflection it asks modellers a numerical-methods question they should never have to answer. Each addition was reasonable on its own; together they are hard to explain.

## The equation

$$M_i\,\dot{x}_i + (I - M_i)\,x_i = \sum_j f_{ij}(x_i, x_j, t) + s_i(x_i, u, t)$$

The right-hand side is unchanged: what node i's relationships bring in, plus its own term. $M_i$ is a diagonal matrix with one entry per state of node i:

- **1: the state changes over time.** Its row reads $\dot{x} = \sum f + s$, today's equation exactly.
- **0: the state is worked out at each instant.** Its row reads $x = \sum f + s$: the state *is* the sum of what arrives.

In words: **every relationship and source term adds a term. Each state says whether those terms are how fast it changes, or what it is.** Relationships have no kind of their own; a relationship's meaning follows from the state it lands on. The same expression `Q / C` is a rate when it lands on a tank's temperature and a value when it lands on a heat-flow state.

This is the standard mass-matrix form of a differential-algebraic system ($M\dot{x} = F$ with M diagonal and some entries zero), written so that a worked-out state reads naturally.

## Choosing, per node

The choice is made where people think about it, on the node, with a per-state choice only when a node needs both:

| Node | Setting | $M_i$ |
| --- | --- | --- |
| A tank, a mass, a battery's charge | **Changes over time** (the default) | $I$ |
| A neuron, a heater command, a sensor reading, a derived cost | **Worked out at each instant** | $0$ |
| A warehouse (`stock` changes, `utilisation` is worked out), a robot's solid, an excavator joint | **Mixed**: each state row shows a toggle | mixed |

Mixed nodes are common: every Logistics Toolbox component holds stocks beside quantities derived from them, every Robotics Toolbox solid holds integrated velocities beside poses its joints work out, and three of the excavator example's six nodes are mixed. A pure node-level switch would split each of them in two, so the choice is stored per state and shown per node.

On the canvas, a node worked out at each instant can be drawn differently (an outline, say), so a model shows at a glance which parts evolve and which are computed from them.

## How terms combine on a state

**Terms arriving at a state sum, whichever kind the state is.** Rates sum, as today; values sum, as relationship outputs already do: a neuron is $z_i = \sum_j w_{ij}\tanh(z_j) + b_i$, with the bias as the neuron's own term; currents into a junction sum; a heat load is the sum of its parts.

Summing values is sometimes a mistake: two sensors both meant to *be* a measured temperature would add. The node editor therefore shows a worked-out state's terms, as it already shows a state's contributions ("z: sum of 3 values"), and the validator warns when two **programs**, or two of a node's own **terms**, set the same worked-out state. Many relationships setting one state is the normal case and is not warned about.

There is no "rate and value on one state" any more: a state has one left-hand side. A person who wants an integrated quantity plus a computed offset adds a second, worked-out state that sums them, and the editor offers that when someone tries to set a state that changes over time.

## When things are worked out

At each synchronization instant (the run's start, the end of every global step, and again whenever a parameter has been set or scheduled):

1. **Worked-out states**, in dependency order across the whole model: every term setting a state before any term reading it. This is the cross-model algebraic pass the engine already has, extended to every worked-out state.
2. **States that change over time** are then integrated over the step, reading the worked-out values, which hold through the step, as explicit Euler holds everything it reads.

A node's own worked-out states are also refreshed at each of its substeps from its own changing states, as `setsValue` source terms are today, so a node with substeps sees its derived quantities move with it.

**Loops.** A path through a state that changes over time is not a loop: integration breaks it. A cycle made only of worked-out states, $x = F(x)$, has to be solved rather than evaluated; it is refused (`algebraicLoop`, as today), and solving it (Newton, over just the loop) is left for later. The equation already describes such a loop correctly; only the solver is missing.

## Programs

A node program's outputs are terms like any other, and land on states of either kind, with one distinction the equation does not cover:

- **A program with no state of its own** (a neural network, a lookup, a unit conversion) is a pure function. Its outputs into worked-out states are values at the instant, worked out in step 1 above; into states that change over time, rates. Being pure is declared **by whoever wrote the program**, not by the modeller: in the SDK's description (`NodeProviderDescription`) or in a plugin's manifest, so a toolbox such as the Neural Toolbox declares it once. The engine checks the claim: a pure program whose `checkpoint()` returns anything stops the run with an error naming the node. Being called more than once at an instant (a slider moved, a resume) is then harmless.
- **A program that keeps state** (a PI controller, an imported FMU) advances over the step and reports where it got to, as it does today. That is a discrete-time update, $x_{k+1} = F(x_k, u_k)$, not a term of the equation, and it is documented as exactly that: "its outputs are where it got to after the step". Its outputs are sole contributors to their states. This is the default for an inline program, so no existing model changes.

This replaces the `feedthrough` flag: the timing follows from the target state and from the program's own declaration, and nobody is asked to choose a timing.

## Recorded and streamed signals

The same need, a state that follows a signal from outside, is met five different ways today. Each is a workaround for there being no plain "worked out" state:

| Where | How it works today | In the new form |
| --- | --- | --- |
| **Causal inference, inputs marked "replay"** ([Causal inference](../causalInference.md), [Input replay](causalInferenceInputReplay.md)) | generates a **C++ program** (`replayProviderSource` in `src/providerTemplate.mjs`) with the recorded samples compiled into it, as a `setsValue` source term. Earlier versions emitted the local slope as a rate instead. It needs a C++ compiler, so it cannot run in the web edition, and the data is hidden inside generated code | a worked-out state whose term reads a shared parameter with a **linear schedule** of the samples. No compiler; it runs in the web edition; the samples are visible and editable as a schedule. Both interpolate linearly and hold beyond the ends; the replay's own guard against time rounding at sample boundaries must be checked against the schedule's |
| **Data-log replay**, inputs ([Digital twin connections](digitalTwinConnections.md)) | a log input can only be mapped to a **shared parameter**, "since only a shared parameter can follow a schedule" (`src/dataLogReplay.mjs`) | unchanged underneath, but an input can also be mapped to a state: the mapping makes it worked out, reading the scheduled parameter |
| **Live twins**, inputs (outdoor air, a heater's power) | a `setsValue` source term copying a shared parameter that the input stream drives; `statesSetByInputs` in `src/windowSession.mjs` recognises that shape by pattern-matching the term's expression | a worked-out state whose term reads an input parameter: recognised by the state's kind and what its term reads |
| **Imported FMUs** ([Code export](../codeExport.md#importing-an-fmu)) | outputs marked `setsValue` (earlier, `(value − x) / h` as a rate) | a program that keeps state, named honestly: its outputs are where it got to after the step |
| **Twin resets and state-estimator corrections** ([Live engine session](liveEngineSession.md), [State estimator](stateEstimator.md)) | `Restore` with `stateOverrides` replaces states at a checkpoint | unchanged: a jump to a state that changes over time is an event, not a term of the equation |

The [Neural Toolbox](neuralToolbox.md)'s replay of recorded activations is the first case again and takes the same form.

## In the file

- A state gains `"changes": "overTime" | "atEachInstant"`, absent meaning `overTime`. It is the one source of truth; the node-level setting in the editor is worked out from its states.
- **Reading an older file**: a state set by a `setsValue` source term, or by `equationModel.outputs`, is worked out at each instant; a node program output's `setsValue` keeps its present meaning (a program that keeps state, reporting after the step). Nothing is lost and no model's numbers change.
- **Writing**: `changes` is written, and for one release the old markers are written beside it, so an older Konjugate still runs a newer file as it did. After that, a source term no longer carries `setsValue`, and a relationship's several equations and a single equation become one shape: a relationship carrying one or more terms, each into a state of either end, its kind that state's.
- A worked-out state's `initialValue` is no longer asked for: it is settled before the first step. It is read and kept if present.

## What has to change

Everything that reads or writes today's markers, which is also the list a design-principles reviewer would want ([Design principles](../designPrinciples.md)): one definition, everything else reading it.

- **Engine:** plan compilation, the cross-model pass (extended from relationship outputs and joined source terms to every worked-out state), the validator (codes renamed in plain words; `algebraicStateMixed` and `setsValueNotSoleContributor` replaced), the runtime check on pure programs.
- **Codec and schema:** `src/modelCodec.mjs`, `docs/projectSchema.md`, the assistant's operation schema (`schemas/assistantOperations.schema.json`, `src/assistantOperations.mjs`).
- **Where models are made:** `src/relationshipEquations.mjs`, `src/equationModel.mjs`, `src/componentTemplate.mjs`, `src/fmiResolver.mjs`, `src/nodeProgram.mjs`, the causal-inference commit and `src/providerTemplate.mjs`'s replay generator, `src/windowSession.mjs`, the tutorial that adds a `setsValue` term (`src/tutorials/equationsThatDoMore.mjs`), and the Robotics and Logistics toolboxes' model builders.
- **The canvas:** the node editor's setting and state toggles; the source-term and relationship editors lose their "sets the value" choices.
- **Code and FMU export:** worked-out states are written as they are today for `setsValue` source terms; relationships into worked-out states are what code export does not yet write, as now.
- **The README:** its headline equation gains $M_i$ and its explanation gets shorter.

## Where this started

Building the Neural Toolbox's core changes 1 and 2 produced a cross-model pass ordering relationship outputs, source terms and programs together, and an `implementation.feedthrough` flag for programs computed at the instant. The pass, a `setsValue` source term joining it when it reads what the pass sets (a fix: it was a step late), its loop detection and its contract test (`tests/engine/algebraicPassContract.mjs`) were committed on their own. The flag, its validator code, a node-editor checkbox and a code-export refusal were not: this proposal replaces them.

## Not in this proposal

- **Solving loops of worked-out states** (Newton over the loop): circuits, hydraulic networks, closed kinematic chains.
- **Events and jumps** as part of a model (a bounce, a valve snapping shut, a reset at midnight) rather than only from a twin.
- **Delays** ($x(t - \tau)$), **noise** as a first-class term, and **implicit integrators** for stiff models.
- **An $M$ between 0 and 1.** The same equation then describes a first-order lag towards the right-hand side, with time constant $m / (1 - m)$: a sensor lag or a low-pass filter. Worth knowing; not worth exposing yet.

## Open questions

- **The field's name and values.** `changes: "overTime" | "atEachInstant"` reads plainly in a file; the editor's words ("Changes over time", "Worked out at each instant") matter more and should be tried on people who have not seen the engine.
- **A bidirectional relationship into worked-out states** adds a value at one end and subtracts it at the other. That is exactly Kirchhoff's current law for a resistor between two junctions, but it should be checked that it does not surprise anyone.
- **How a mixed node is drawn**, and whether the outline for worked-out nodes earns its place.
- **The transition period** for writing old markers beside the new field: one release, or until the next format version.

## Order of work

1. *Built.* The `changes` field kept by the codec; the validator's new rules and codes, checking it against what reaches a state and working a state's kind out from the older markers where it is absent. No model's numbers change; the existing tests are the guard. The engine does not compile from it yet: nothing it runs depends on a state's kind until step 2, and the validator keeps the field and the markers in agreement until then.
2. *First half built.* The engine compiling from a state's kind (the field, or the older markers where it is absent), so that values sum from every kind of term. An ordinary term becomes a value only where the state is marked `atEachInstant`; where a state is worked out only because a `setsValue` term or a relationship sets it, an ordinary term into it is still refused, so no file already written changes meaning. A node's own value terms are worked out at each substep where only they set the state, and in the cross-model pass, holding through the step, where something outside the node sets it too. `algebraicStateMixed` is gone (each case it covered is now a sum or a clearer error); `setsValueNotSoleContributor` remains for programs only. Code export refuses the new forms by name. Still to do: the runtime check on pure programs, with the SDK and plugin declaration.
3. The node editor: the node setting, state toggles, the "sum of" display, and the offer to add a worked-out state.
4. Recorded signals in the new form: causal-inference replay through a schedule (and its comparison with the generated program on the validation system), data-log inputs mapped to states, and live-twin input detection by kind.
5. The README and the schema documentation; the Robotics and Logistics model builders moved to the field.
