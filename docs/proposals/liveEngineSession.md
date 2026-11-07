---
type: Proposal
title: "A long-lived engine session for keeping a model in step with live data"
description: Build proposal for step 2 of the digital twin connections, an engine that stays running for a whole session and is driven by commands to advance, rewind to a checkpoint with some states replaced, and take input readings as they arrive, so the comparison window's cycle pays no start-up cost; with the restructuring of the run loop it needs and the tests that prove it against the engine as it is.
tags: [proposals, digital-twin, state-estimation, engine, protocol, checkpoints, real-time]
status: draft
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# A long-lived engine session for keeping a model in step with live data

**Status: steps 1 to 5 built: the run loop as a `Simulation` object, the session command, `WindowSession`, the live twin in the tuning card and the first rung of the degrade ladder.** Step 2 of [Digital twin connections](digitalTwinConnections.md): the engine side of a model kept in step with arriving data. A first version of this proposal recommended running each cycle of the comparison window as a fresh engine run, since the measured start-up cost was small (8 ms for an equation-only model, about 45 ms with one Python provider). That was turned down, on experience from the robotics toolbox that small per-call costs add up once they are paid thousands of times. This version designs the engine that stays running instead.

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

`konjugate session <model.kjt> --configuration <file>` sets up a `Simulation` and waits for commands on the control stream, with no end time and no result file. It answers on the event stream. Besides the time step and output interval, the configuration says two things a run does not need:

- **`checkpointInterval`:** a checkpoint is taken only at multiples of it, not at every output time. The window session sets it to the stride, since anchors are the only times it ever goes back to.
- **`reportedStateIds`:** only these states' samples are sent: the measured states being compared and any being plotted, not the whole state vector.

New messages, in the existing framed protobuf protocol, each command carrying its sequence number and each answer naming the sequence it answers:

| Command | What it does |
| --- | --- |
| `AdvanceTo { time }` | Steps to `time` and holds there. Every output sample of the reported states on the way is sent, unthinned. Answered by `Advanced { time, computeNanoseconds }`. |
| `AppendInputSamples { parameterId, samples, replaceFrom }` | Adds readings to a shared parameter's input stream, held between samples. With `replaceFrom`, the readings already there at or after that time are dropped first, which is how a late correction arrives. |
| `Restore { time, stateOverrides }` | Goes back to the retained checkpoint at exactly `time` (a multiple of `checkpointInterval`), restores every state and every provider's saved state, replaces the listed states, and settles the algebraic states again. Answered by `Restored { time, values }` with the full state vector after the overrides, for the session log. A listed state that the model computes from others (an algebraic state) is refused, with the state named. |
| `RestoreState { time, values, providerStates }` | Sets the whole state, every state's value and every provider's saved state, from the message itself rather than from a retained checkpoint, then settles the algebraic states. This is how a session recovers after its engine has died: the new engine is given the last logged state as a command, as protobuf, with no JSON and no base64. |
| `RetainCheckpointsFrom { time }` | Forgets checkpoints before `time`. |
| The existing commands | Pacing, pause, resume and stop, setting and scheduling parameters, as now. |

A failed command is answered by `CommandFailed { sequence, message }` and leaves the session as it was, and the commands sent after it are not carried out (each answered `CommandFailed` naming the one that failed), so a batch never runs half on a wrong footing. The process ends when the control stream closes.

### What a cycle costs, and how it is kept down

Measured on the engine as it is, on a 512-node ring model with heavy equations over 500 steps, 8 partitions on 8 cores: the run took 2915 ms. The partitions exchanged 4000 messages, 4.16 MB in all, about 1040 bytes each; building them took 5.6 ms (0.2% of the run), sending them 0.4 ms, and waiting at the end of each step for the slowest partition 71 ms (2.4%). So between partitions in one process, communication is not where the time goes. What a session adds, and what it does about each:

1. **Checkpoints.** A run takes one at every output time, and for a node with a Python or C++ worker provider each is a round trip to the provider's process. A session takes them only every `checkpointInterval`: at a one-minute stride and a one-second step, sixty times fewer, provider round trips included.
2. **Samples.** Only the reported states are sent, not the whole state vector at every output time.
3. **Round trips between the app and the engine.** A cycle is five commands (append the inputs, restore, advance to now, advance to the horizon, retain). `EngineSession` sends them together, without waiting for each answer, and matches the answers by sequence number; a cycle then costs one trip across the process boundary, not five.
4. **Simulating the window again.** Each cycle simulates its window again, so the window is simulated W/S times over. This comes from the reset policy, not from the engine, and no engine design removes it; the stride is how it is set, and a stride equal to the window costs the least. The session reports it with the real-time factor.

### Where the partitions' states live

None of the execution backends keeps state of its own between steps today: the thread pool's tasks and the partition runtimes are handed the states they need from the main state vector at the start of every step, and hand back the step's result. So restoring the main state vector, and the provider runtime the backends share, restores all of them.

That is right for correctness and is not the cheapest for communication. Of the roughly 65 states in each partition message above, 64 are the partition's own states from the step before, sent back to it, and one or two are the boundary states it reads from its neighbours. Partitions that kept their own states would exchange only the boundary states, about 30 to 60 times less, and a `Restore` would then hand each partition its share once a cycle, which is cheap because cycles are far fewer than steps. In one process the saving is about 0.2% of a run and not worth the change now; across processes or machines it would dominate, and it is the design to use then.

So `Simulation` reaches the backend's states only through two operations, "take the states for the next step" and "restore these states", and the session is written against those. The backends today implement them with the main state vector; a backend whose partitions hold their own states implements them by exchanging only boundary states each step and scattering the restored states to each partition. Moving to it changes no command and no test.

### Found while measuring: parallel runs scale poorly

On the model above, 8 partitions on 8 cores ran only 1.2 times faster than serial, and the thread pool 1.3 times. Communication and waiting explain under 3% of the run, so most of the time is spent somewhere that runs on one thread. This is not part of the session, but the session would pay it on every cycle of a large model. It is recorded here to be profiled as its own piece of work, before any change to the partitions.

**Input streams** are a new kind of schedule held in the run controls, not the compiled plan: a list of `(time, value)` held between them, which takes over from the parameter's own value or stored schedule from its first sample. After its last sample it holds its last value, which is the forecast's agreed assumption. Because it lives in the run controls, a `Restore` leaves it alone: a rewind goes back in the model's time, not in what is known about the inputs.

### In JavaScript

- **`EngineSession`** (`src/engineSession.mjs`, desktop): starts the session process through the same path as a run (providers, plugins, FMUs resolved as for any run), and gives promises for each command: `advanceTo(time)` resolving to the samples, `appendInputs`, `restore(time, overrides)`, `retainFrom(time)`, `close()`. It measures each command's wall time.
- **`WindowSession`** (beside `dataLogReplay.mjs`): the comparison window's logic, as in the window document, driving an `EngineSession`. Fed observations by one `push(observations)` call, from a finished log now and a growing file later. Each cycle: append the new input readings, `restore` the anchor with the measured states replaced, `advanceTo(now)` for the window, `advanceTo(now + H)` for the forecast, then `retainFrom` the oldest time still needed. It keeps the session log (every cycle's anchor, overrides, jump, the state vector `Restored` reported, and timings), and reports the real-time factor and lag.
- **If the engine process dies,** the session starts a new one, sends it the last logged anchor's state with `RestoreState`, replays the inputs since, and carries on; the log says it happened.

### In the app

The replay goal of the tuning card gains a second way to replay: **as a live twin**, with W, S, H and a speed (as fast as it can go, or a multiple of real time). It plays the log through a `WindowSession` and shows the moving window on the plot (settled, window, forecast), the jump at each move as a series of its own, the real-time factor and the lag. The existing replay, one run unaided from the start, stays as the hold policy.

## How it is proved

The engine as it is today is the reference for the engine as it will be:

- **The restructuring changes nothing.** Every existing engine test and the full interaction suite pass unchanged after step 1, and the numerical regression results are identical to the bit.
- **A session cycle equals a fresh run.** For a cycle made by the session (`Restore` with overrides, then `AdvanceTo`), a fresh `run` from the same checkpoint, with the same states replaced and the same input schedule, gives identical samples, bit for bit. Tested on the simulated rig's model, on a model with algebraic states, and on the PI-controlled tank, whose Python provider carries an integral term that only a correct provider restore gets right; and on each execution backend (serial, thread pool, partitioned), on a model large enough to be split into partitions.
- **Rewinding many times changes nothing.** A thousand restores to the same checkpoint, each followed by the same advance, give the same samples every time, and the process's memory does not grow.
- **Memory stays bounded** over a long session (say a hundred thousand cycles), with `RetainCheckpointsFrom` keeping the checkpoint count constant.
- **Corrections work.** A reading replaced through `replaceFrom` gives the same window as if the corrected value had arrived in the first place.
- **A crash is recovered.** Killing the engine mid-session leads to a new one, and the session's jumps after recovery match a session that was never interrupted.
- **It is faster, as intended.** The cost per cycle on the PI-controlled tank, against the measured cost of a fresh run per cycle, is reported in the test output, so the gain is a number, not an assumption; and so is the number of provider checkpoint round trips per cycle, which must be one.
- **A failed command stops its batch.** A `Restore` to a time with no checkpoint, sent with an advance behind it, fails, the advance is not carried out, and the session is where it was.
- **The comparison window works on the rig.** The simulated rig gains a `--drift` option that makes the tank's heat loss coefficient change slowly, as insulation that is getting wet would. With the true constant values the jumps stay within the thermometer's noise with no trend, and the forecast an hour ahead agrees with what the log then says; with drift, the jumps grow in one direction before the hold-policy replay of the same log has left its tolerance.

## Decisions

Agreed 2026-11-06.

- **A long-lived engine session,** not a fresh run per cycle: small per-run costs add up over thousands of cycles.
- **The output interval divides the stride.** A cycle's anchor must be a retained checkpoint, so the session sets the output interval to the time step for the window and checks that the stride is a whole number of steps. The stride is also at most the window, so that every anchor lies in a stretch already run on actual inputs, not in a forecast.
- **A provider that cannot checkpoint** cannot be rewound; the session refuses to start, with the node named.
- **The forecast holds inputs at their last value;** a declared forecast per input comes later.
- **The jump trend's alert threshold** is a multiple of the tolerance, shown and editable, with no alert until a person sets one.

- **Desktop first.** The web edition's engine runs in a worker and already polls control bytes, so a session can work the same way there; it follows when the web edition's engine is rebuilt, with no other design.
- **Every execution backend,** serial, thread pool and partitioned, through the two state operations described in [Where the partitions' states live](#where-the-partitions-states-live). A `Restore` is only accepted between steps, when no message is in flight between partitions; the session only ever holds at the end of an `AdvanceTo`, and the engine checks that, not assumes it. Partitions that keep their own states are the design for when they leave the process.
- **Protobuf for everything live between processes Konjugate owns:** every session command and answer, crash recovery included (`RestoreState`), and the provider workers as now. The session's start-up configuration is a JSON file like a run's, so the two share the code that reads it. Messages between partitions in one process stay plain C++ structures with no serialization, and become protobuf if partitions leave the process. What faces other people's tools stays as plain as it can be: data logs are CSV, and the fallback push service, if built, takes JSON.
- **Checkpoints only every `checkpointInterval`, only the reported states sent, and a cycle's commands sent together,** as in [What a cycle costs](#what-a-cycle-costs-and-how-it-is-kept-down).

## Changes to the other documents

When this is agreed, [Digital twin connections](digitalTwinConnections.md) "What the engine must do first" and step 2 are rewritten to this design, and the [comparison window](predictionActualWindow.md)'s "What it needs" list to match.

## Order of work

1. **`Simulation` from `runSimulation`,** with no change in behaviour, its backends reached through the two state operations: every engine test, the numerical regression to the bit, and the interaction suite. **Built:** `Simulation` and the three `StepExecutor` classes (serial, thread pool, partitioned) are in `simulationRunner.cpp`, and `runSimulation` is a short loop over them. Every example model on every backend, and a restart from a checkpoint (a Python provider's included), gave samples, checkpoints and provider states identical to the bit with the code before it.
2. **Built.** **The session command and its messages,** with restore in mid-session (provider states included), input streams, bounded checkpoints and unthinned samples; `EngineSession` in JavaScript. Proved by the equivalence, repetition, memory, correction and crash tests above, and the cost comparison.
3. **Built.** **`WindowSession`** and the rig's `--drift`, proved through the real engine (`tests/engine/engineSession.mjs`, `tests/engine/liveTwin.mjs`). A cycle of the PI-controlled tank, with its Python provider, takes about 16 ms in the session against about 75 ms as a fresh run.
4. **Built** (and since moved to the twin's own window, [The twin's control room](controlRoom.md)). **Replay as a live twin** in the tuning card, with detaching into a sandbox and draft scenarios kept with the project.
5. **Built.** **The first rung of the degrade ladder:** a twin fed live data that falls three strides behind skips to the newest anchor, rebuilding the checkpoint there from the last move's state, and says how many moves it skipped. Tested by giving a twin the whole log at once.
6. Then step 3 of the connections document: the same session fed by a file that is still growing.
