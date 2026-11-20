---
type: Proposal
title: Rates and updates
description: One governing equation for every node, with two kinds of state - a Rate, integrated over the step, and an Update, replaced at its end - both reading the start of the step, so every graph shape is valid, rings included, and no result depends on the order terms are worked out in; with settling within a step as an option, and a migration that keeps released models' numbers.
tags: [proposals, engine, equations, schema, execution]
status: draft
implementation: none
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Rates and updates

**Status: proposed, 21 November 2026. Nothing here is built. It replaces this proposal's first version (commit `9adbd95`), which settled values at the same instant; the steps of it that were built were reverted (commit `652425d`) for the reasons below.**

## The problem

Konjugate is described by one equation: a node's rate of change is the sum of what its relationships bring in plus its own term,

$$\dot{x}_i = \sum_j f_{ij}(x_i, x_j, t) + s_i(x_i, u, t)$$

Over time the engine learned a second thing, a value worked out at the same instant rather than integrated, and learned it several times over, each with its own rules: a `setsValue` source term (the value now, from its own node), a relationship with several equations (values now, across nodes, in dependency order, summed), a program's `setsValue` output (the value after the program's step). The same word meant "now" in one place and "after the step" in another, and building on it made a patchwork.

More basic than the patchwork: **settling values at the same instant only works on a graph without cycles.** Three values in a ring,

$$a = f(c), \quad b = g(a), \quad c = h(b),$$

have no first value to start from: at the instant they are an equation to solve, not to evaluate, and the engine refuses them (`algebraicLoop`). For a tool whose point is drawing graphs, where rings are ordinary -- a logistics loop, a circuit mesh, a closed linkage, a recurrent network -- that is the wrong rule.

And trying to settle a ring anyway, by working its values out in turn, each reading the latest, gives an answer that depends on where it starts and which way it goes round. The same model could give different results on the serial, thread-pool and partitioned backends, and nothing in the model would say which is right. Graph neural networks show it most sharply; see [Neural Toolbox, Paused, and why](neuralToolbox.md#paused-and-why).

## The equation

Each state of each node is one of two kinds. Both sum what reaches them -- what the node's relationships bring in, plus its own terms:

$$\textbf{Rate:}\quad \frac{d x_i}{dt} = \sum_j f_{ij} + s_i \qquad\qquad \textbf{Update:}\quad x_i^{+} = \sum_j f_{ij} + s_i$$

where $x_i^{+}$ is the state's value at the end of the step. A **Rate** says how fast the state changes, and is integrated over the step; an **Update** says what the state becomes, and replaces it at the step's end. A relationship has no kind of its own: what it means follows from the state it lands on.

## When things are worked out

For each step, from $t$ to $t + h$:

1. **Every state is read at $t$** (the snapshot).
2. **Rate states are integrated** over the step, as today: a node may take several substeps; a term reads its own node's Rate states as they advance, and everything else -- other nodes, and every Update state -- as it was at $t$.
3. **Update states are replaced.** Every Update term reads the Rate states as they are at $t + h$ (they have just been integrated), every Update state as it was at $t$, and the time $t + h$.

Every Update reads the same values, so **the order Updates are worked out in never matters**, and no graph shape is refused: an Update reading another Update reads it one step back, and a ring is a loop that goes round once per step.

Reading the Rate states at $t + h$ is what keeps derived quantities exact. A battery's terminal voltage worked out from its charge, a port's waiting time from its queue, a sensor's reading from the tank level: each reads states that have just been integrated, so it agrees with them at every sample. Rate states cannot form a cycle with Updates within a step -- a Rate reads Updates from $t$ -- so this introduces no ordering.

**Time** is the one input known ahead: an Update reads the time at the end of the step, so a recorded input replayed through a schedule, a clock (`a = t`) or a scheduled parameter lands exactly on its sample.

## Settling within a step

Some models need values settled within the step: a chain of values each worked out from the one before, all meant to agree at one instant. A robot's joints pass poses outward, inertias inward and accelerations outward again; a network computes its layers in turn. Under "once per step" each link of such a chain is a step late.

So a node, or a subsystem, can ask for its Updates to **settle within the step**: the Updates in it are worked out again and again within the step -- each sweep reading only the previous sweep's values, with the Rate states held at $t + h$ -- until nothing changes, up to a limit:

- **without cycles**, the values settle after the chain's length plus one sweep, and are exactly the values settling at the same instant gives today;
- **a ring that converges** settles on its fixed point -- the correct answer to the loops refused today;
- **a ring that does not** stops at the limit, with a warning naming the ring rather than an error.

Because every sweep reads only the previous sweep, settling is as independent of the order of evaluation as a single Update is. Its cost is the sweeps: each sweep works out every Update in the region, so a chain $D$ links long costs about $D$ times as much as working it out once in order. Working out only what changed in the previous sweep removes most of that waste (see [Neural Toolbox, the bottleneck](neuralToolbox.md#the-bottleneck-to-solve-before-it-runs-efficiently)); it is an optimisation to make once settling exists, not a condition of it.

## Terms

A **term** is anything that reaches a state: a *source term* on a node, or an *interaction term* on a relationship. Each is written either as an **equation** or as a **program** (C++, Python or an installed plugin). A term reaching a Rate state is a rate; reaching an Update state, a value; terms reaching one state sum, whatever writes them. A state has one kind, so a rate and a value never meet on one state.

A relationship may carry several terms, each into a state at either end -- what "a relationship with several equations" is today -- and each takes its meaning from its state. A bidirectional relationship adds its term at one end and subtracts it at the other, whichever kind the states are.

**Programs may keep memory of their own** between calls. A program advances itself as it does today: it is called once per substep of its node, its outputs into Rate states are rates, and its outputs into Update states are where it got to by the end of the step, from what it read at the start of each substep. Called exactly once per substep, never twice for one instant, its memory needs no special care. An imported FMU is such a program.

## Where it is shown

The node editor and the relationship editor share one card and one **Term** editor (see the November 2026 prototype, described in this proposal's history): the node's first tab shows each state with every term reaching it, as its equation, and a relationship's first tab shows its terms inside the equations of the states they reach. Choosing a state's kind shows both equations, typeset with the state's own symbol, side by side:

$$\frac{d\,\mathrm{temperature}}{dt} = \sum \qquad\text{or}\qquad \mathrm{temperature}^{+} = \sum$$

so the choice reads as what it does. A node's or subsystem's setting to settle within the step sits on its Numerics tab, beside substeps, which it mirrors.

## In the file

- A state gains `"kind": "rate" | "update"`, absent meaning `rate`.
- A node or subsystem gains `"updates": "oncePerStep" | "settle"`, absent meaning `oncePerStep`, and a limit on sweeps.
- **Reading a file written before this**, which has no `kind`: a state a `setsValue` source term or a relationship's several equations set is an Update, every other a Rate; a program output's `setsValue` makes its state an Update; and the model opens with every node set to `settle`, so that it gives the numbers it gave before (below). The `setsValue` markers are read and not written again.

## What changes for released models

Measured on 21 November 2026, structurally, over the bundled examples, the models the Logistics Toolbox's engine tests build and run (and its saved network), and those the Robotics Toolbox's engine tests build and run. Each value worked out at the same instant today was classed by what it reads: **exact** if it reads only Rate states, time and parameters (under the rule above it is the same value as today), **chained** if it reads another such value (one step late per link under "once per step", and the same as today under "settle").

| Released models | Values worked out at the same instant | Exact | Chained | Longest chain |
| --- | ---: | ---: | ---: | ---: |
| Bundled examples (19; 3 with such values) | 26 | 8 | 18, all in the excavator | 3 |
| Logistics Toolbox (59 test models) | 4,083 | 4,083 | 0 | 0 |
| Robotics Toolbox (54 test models) | 83,119 | 27,206 | 55,913 | 35 |

So, structurally: the Logistics Toolbox and two of the three examples keep their numbers under either setting; the excavator and the Robotics Toolbox keep theirs under "settle", which is how an older file opens. Two cautions, both for the first build to measure rather than for this proposal to assume:

- **Substeps.** Today a node's own same-instant values are worked out again at each of its substeps, so its rates see them change within the step; under this rule they hold from $t$ through the step. A node with substeps and such values may move slightly.
- **Settling's cost.** The Robotics Toolbox's chains are up to 35 links, so settling sweeps its Updates up to 36 times a step until the efficient form exists.

Elsewhere: **causal-inference replay** (today a generated C++ program with the recording compiled in) becomes an Update reading a scheduled parameter, exact by the time rule and with no compiler needed; **live-twin inputs** (a `setsValue` source term copying an input parameter) are Updates reading their parameter, exact likewise; **imported FMUs** are programs, unchanged; **code export** writes the new rule, settling included, and refuses what it cannot write by name until it can.

## Not in this proposal

- Solving stiff rings that settling does not converge on (Newton over the ring).
- Events: jumps at a moment other than a step's end.
- Delays $x(t - \tau)$, noise as a kind of term, implicit integrators.

## Open questions

- **Where settling is chosen**: per node, per subsystem, or both, and its default limit.
- **Whether a new model should default to "settle"** for nodes that relationships set values of, rather than "once per step" everywhere.
- **Words.** "Rate" and "Update" in the editor; `kind` and `updates` in the file; how the README's headline equation is written with both.

## Order of work

1. **The engine**: the execution rule, `kind` and `updates` read from the file, older markers mapped onto them, settling with its limit and warning; and a comparison, run over the examples and both toolboxes, of every sample against the engine before it -- the numbers in the table above, measured. Nothing ships until that comparison is understood.
2. **The validator**, in plain words: a rate and a value on one state; a settling region that did not settle.
3. **The editors**: the shared card, the Term editor, choosing a kind by its two equations, the settle setting.
4. **Code export** of the new rule.
5. **The toolboxes** writing `kind` and `updates` themselves; settling made efficient by working out only what changed.
