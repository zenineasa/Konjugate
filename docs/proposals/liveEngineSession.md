---
type: Proposal
title: "A long-lived engine session for keeping a model in step with live data"
description: Build proposal for step 2 of the digital twin connections, an engine that stays running for a whole session and is driven by commands to advance, rewind to a checkpoint with some states replaced, and take input readings as they arrive, so the comparison window's cycle pays no start-up cost; with the restructuring of the run loop it needs and the tests that prove it against the engine as it is.
tags: [proposals, digital-twin, state-estimation, engine, protocol, checkpoints, real-time]
status: draft
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# A long-lived engine session for keeping a model in step with live data

**Status: proposed.** Step 2 of [Digital twin connections](digitalTwinConnections.md): the engine side of a model kept in step with arriving data. A first version of this proposal recommended running each cycle of the comparison window as a fresh engine run, since the measured start-up cost was small (8 ms for an equation-only model, about 45 ms with one Python provider). That was turned down, on experience from the robotics toolbox that small per-call costs add up once they are paid thousands of times. This version designs the engine that stays running instead.

## What the cycle needs

The default policy of the [comparison window](predictionActualWindow.md#the-default-reset-at-each-move), repeated each time the data has advanced by a stride S:

1. Go back to the model's state at the new anchor (now minus the window length W).
2. Record the **jump**: the model's prediction there against the measurement it is about to be replaced by.
3. Set each measured state to its measurement; keep the model's own value for every other state.
4. Run from the anchor to now on the inputs that were actually applied, and compare with what was measured.
5. Run on from now to the horizon H for the forecast.

So the engine must be able to go back in time to a checkpoint, change some states there, and run forward again on inputs that keep arriving, many times over, without starting again.

## What the engine has, and what stands in the way

Already there:

- **A checkpoint at every output time,** with the full state vector and each node provider's saved state (`simulationRunner.cpp`, at every output boundary).
- **Restoring from a checkpoint,** state vector and provider states, but only when a run starts (`startCheckpoint`).
- **Settling the algebraic states** after a restore and after any parameter change, so states computed from others agree with them.
- **Commands while running,** on the control stream: pause, resume, stop, pacing, set a parameter, add a parameter schedule (step, ramp, pulse, piecewise, waveform).
- **Samples streamed** to the app as they are made.

In the way:

1. **The run is one function.** `runSimulation` is a single function of some 660 lines: setting up, the step loop, the provider runtime, checkpoints and result writing all share its local variables. Nothing about a run can outlive the call, so there is nothing to keep alive between cycles.
2. **Restoring happens only at the start.** Provider states are restored through `requestNodeRestore` before the first step; doing it later in a run is untested.
3. **Every checkpoint is kept for the whole run.** Fine for a run of fixed length; a session that runs for days needs a bounded set.
4. **Streamed samples are thinned** to at most 256 per batch (`flushSampleEvents`), which suits a live plot but loses the samples a comparison needs.
5. **Inputs have no stream.** A parameter's stored schedule is fixed when the model is compiled, and a piecewise schedule command is a one-off intervention. Readings that arrive one at a time, held between them, and that a late correction can replace, have no form yet.
6. **A run has a fixed end** (`targetTime`); a session has none.

## The design

### First, the run loop becomes an object

A `Simulation` class (`engine/include/simulation.hpp`) holds what `runSimulation` keeps in local variables today: the compiled plan, the provider runtime, the execution backend, the states and the current time, the run controls, and the checkpoints. It offers what a run and a session both need:

```
Simulation
  Simulation(plan, configuration)          set up: providers started, backend chosen, algebraic states settled
  advanceTo(time, sink)                    step to a time, handing each output sample (and checkpoint) to the sink
  restore(checkpoint, stateOverrides)      states and provider states back to a checkpoint, some states replaced, algebraic states settled again
  checkpointAt(time)                       one of the retained checkpoints
  retainCheckpointsFrom(time)              forget the older ones
  apply(command)                           the existing control commands, and the new ones below
```

`runSimulation` is then a short loop over it: set up, advance to the target time with a sink that writes the result file and the streamed events, honour pause and stop as it does today. **This step changes no behaviour,** and it is done and proved first, on its own, by the engine's existing tests: numerical regression, the live-run, pause, fork and intervention tests, stability monitoring, the code and FMU export fidelity tests, and the interaction suite. It is the largest single piece of the work and the one that carries the risk, so nothing else is built on it until it passes.

### Then, a session command

`konjugate session <model.kjt> --configuration <file>` sets up a `Simulation` and waits for commands on the control stream, with no end time and no result file. It answers on the event stream. New messages, in the existing framed protobuf protocol, each command carrying its sequence number and each answer naming the sequence it answers:

| Command | What it does |
| --- | --- |
| `AdvanceTo { time }` | Steps to `time` and holds there. Every output sample on the way is sent, unthinned. Answered by `Advanced { time, computeNanoseconds }`. |
| `AppendInputSamples { parameterId, samples, replaceFrom }` | Adds readings to a shared parameter's input stream, held between samples. With `replaceFrom`, the readings already there at or after that time are dropped first, which is how a late correction arrives. |
| `Restore { time, stateOverrides }` | Goes back to the retained checkpoint at exactly `time` (an output time), restores every state and every provider's saved state, replaces the listed states, and settles the algebraic states again. Answered by `Restored { time, values }` with the full state vector after the overrides, for the session log. A listed state that the model computes from others (an algebraic state) is refused, with the state named. |
| `RetainCheckpointsFrom { time }` | Forgets checkpoints before `time`. |
| The existing commands | Pacing, pause, resume and stop, setting and scheduling parameters, as now. |

A failed command is answered by `CommandFailed { sequence, message }` and leaves the session as it was. The process ends when the control stream closes.

**Input streams** are a new kind of schedule held in the run controls, not the compiled plan: a list of `(time, value)` held between them, which takes over from the parameter's own value or stored schedule from its first sample. After its last sample it holds its last value, which is the forecast's agreed assumption. Because it lives in the run controls, a `Restore` leaves it alone: a rewind goes back in the model's time, not in what is known about the inputs.

### In JavaScript

- **`EngineSession`** (`src/engineSession.mjs`, desktop): starts the session process through the same path as a run (providers, plugins, FMUs resolved as for any run), and gives promises for each command: `advanceTo(time)` resolving to the samples, `appendInputs`, `restore(time, overrides)`, `retainFrom(time)`, `close()`. It measures each command's wall time.
- **`WindowSession`** (beside `dataLogReplay.mjs`): the comparison window's logic, as in the window document, driving an `EngineSession`. Fed observations by one `push(observations)` call, from a finished log now and a growing file later. Each cycle: append the new input readings, `restore` the anchor with the measured states replaced, `advanceTo(now)` for the window, `advanceTo(now + H)` for the forecast, then `retainFrom` the oldest time still needed. It keeps the session log (every cycle's anchor, overrides, jump, the state vector `Restored` reported, and timings), and reports the real-time factor and lag.
- **If the engine process dies,** the session starts a new one, restores the last logged anchor from its logged state vector (the same `startCheckpoint` a run already accepts), replays the inputs since, and carries on; the log says it happened.

### In the app

The replay goal of the tuning card gains a second way to replay: **as a live twin**, with W, S, H and a speed (as fast as it can go, or a multiple of real time). It plays the log through a `WindowSession` and shows the moving window on the plot (settled, window, forecast), the jump at each move as a series of its own, the real-time factor and the lag. The existing replay, one run unaided from the start, stays as the hold policy.

## How it is proved

The engine as it is today is the reference for the engine as it will be:

- **The restructuring changes nothing.** Every existing engine test and the full interaction suite pass unchanged after step 1, and the numerical regression results are identical to the bit.
- **A session cycle equals a fresh run.** For a cycle made by the session (`Restore` with overrides, then `AdvanceTo`), a fresh `run` from the same checkpoint, with the same states replaced and the same input schedule, gives identical samples, bit for bit. Tested on the simulated rig's model, on a model with algebraic states, and on the PI-controlled tank, whose Python provider carries an integral term that only a correct provider restore gets right.
- **Rewinding many times changes nothing.** A thousand restores to the same checkpoint, each followed by the same advance, give the same samples every time, and the process's memory does not grow.
- **Memory stays bounded** over a long session (say a hundred thousand cycles), with `RetainCheckpointsFrom` keeping the checkpoint count constant.
- **Corrections work.** A reading replaced through `replaceFrom` gives the same window as if the corrected value had arrived in the first place.
- **A crash is recovered.** Killing the engine mid-session leads to a new one, and the session's jumps after recovery match a session that was never interrupted.
- **It is faster, as intended.** The cost per cycle on the PI-controlled tank, against the measured cost of a fresh run per cycle, is reported in the test output, so the gain is a number, not an assumption.
- **The comparison window works on the rig.** The simulated rig gains a `--drift` option that makes the tank's heat loss coefficient change slowly, as insulation that is getting wet would. With the true constant values the jumps stay within the thermometer's noise with no trend, and the forecast an hour ahead agrees with what the log then says; with drift, the jumps grow in one direction before the hold-policy replay of the same log has left its tolerance.

## Decisions

Agreed 2026-11-06.

- **A long-lived engine session,** not a fresh run per cycle: small per-run costs add up over thousands of cycles.
- **The output interval divides the stride.** A cycle's anchor must be a retained checkpoint, so the session sets the output interval to the time step for the window and checks that the stride is a whole number of steps. The stride is also at most the window, so that every anchor lies in a stretch already run on actual inputs, not in a forecast.
- **A provider that cannot checkpoint** cannot be rewound; the session refuses to start, with the node named.
- **The forecast holds inputs at their last value;** a declared forecast per input comes later.
- **The jump trend's alert threshold** is a multiple of the tolerance, shown and editable, with no alert until a person sets one.

## Open questions

- **The web edition.** The engine there runs in a worker and already polls control bytes, so a session can work the same way, but its prebuilt engine is out of date and twin connections are a desktop feature for now. Recommended: desktop first; the web edition's session follows when its engine is rebuilt, with no other design.
- **Parallel backends.** A `Restore` must reach the thread pool and the partition runtimes' own copies of state. Recommended: the session runs on the serial and thread-pool backends first, and refuses the partitioned backend, with a message, until a test covers it.

## Changes to the other documents

When this is agreed, [Digital twin connections](digitalTwinConnections.md) "What the engine must do first" and step 2 are rewritten to this design, and the [comparison window](predictionActualWindow.md)'s "What it needs" list to match.

## Order of work

1. **`Simulation` from `runSimulation`,** with no change in behaviour: every engine test, the numerical regression to the bit, and the interaction suite.
2. **The session command and its messages,** with restore in mid-session (provider states included), input streams, bounded checkpoints and unthinned samples; `EngineSession` in JavaScript. Proved by the equivalence, repetition, memory, correction and crash tests above, and the cost comparison.
3. **`WindowSession`** and the rig's `--drift`, proved through the real engine.
4. **Replay as a live twin** in the tuning card.
5. **The first rung of the degrade ladder** (lengthen the stride when cycles cannot keep up), tested with an artificially slow model.
6. Then step 3 of the connections document: the same session fed by a file that is still growing.
