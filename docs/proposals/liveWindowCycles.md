---
type: Proposal
title: "Running the comparison window: each cycle a short run from a checkpoint"
description: Build proposal for step 2 of the digital twin connections, the engine side of a model kept in step with arriving data, which finds that each cycle of the comparison window can be a fresh run from a checkpoint the engine already writes, measures what that costs, and keeps a long-lived stepping engine for the cases where it is too slow.
tags: [proposals, digital-twin, state-estimation, engine, checkpoints, real-time]
status: draft
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Running the comparison window: each cycle a short run from a checkpoint

**Status: proposed.** Step 2 of [Digital twin connections](digitalTwinConnections.md), written before any code because it decides how the engine is used for everything live. That document said the engine had to be changed first: to run to a time and wait, to take inputs mid-run, to replace some states, to keep a rolling set of checkpoints and to report its speed. Looking at what the engine already does, and timing it, most of that turns out not to be needed yet. This document says why, what is needed instead, and when the long-lived stepping engine becomes worth building.

## What the cycle needs

The default policy of the [comparison window](predictionActualWindow.md#the-default-reset-at-each-move) is a cycle repeated every time the data has advanced by a stride S:

1. Take the model's state at the new anchor (now minus the window length W).
2. Record the **jump**: the model's prediction there against the measurement it is about to be replaced by.
3. Set each measured state to its measurement; keep the model's own value for every other state.
4. Run from the anchor to now on the inputs that were actually applied, and compare with what was measured.
5. Run on from now to the horizon H for the forecast.

## What the engine already does

| The cycle needs | The engine today |
| --- | --- |
| The state at the anchor | Every output sample is also a full checkpoint: the complete state vector, the solver's identity and each node provider's own saved state (`simulationRunner.cpp` captures one at every output boundary). Any output time is a restart point. |
| To start from that state | A run accepts a `startCheckpoint`: its state vector replaces the initial values and its time becomes the run's start, with `targetTime` absolute ([project schema](../projectSchema.md)). |
| To replace only the measured states | The checkpoint is a plain vector, so the session edits the measured entries before handing it back. The engine already recomputes every algebraic state when a run resumes from a checkpoint, so states tied to a reset one by an equation are made consistent with it, not left stale. |
| To drive the model with the applied inputs | A shared parameter's stored schedule (hold or linear), in absolute simulation time. [Replaying a data log](../connectingADataSource.md#replaying-a-log-in-konjugate) already turns a log's inputs into these. |
| A forecast past the last reading | A held schedule keeps its last value after its last sample: the forecast's default assumption ("the inputs stay as they are") with nothing extra. |
| To compare at the readings' times | The replay's interpolation and comparison (`src/dataLogReplay.mjs`). |

What it costs, measured on the simulated rig's model (three nodes) through the same path the app uses, process start, temporary files and result decoding included:

| Run | Time |
| --- | --- |
| One 60 s step | 8 ms |
| One hour at a 60 s step | 8 ms |
| One day at a 1 s step (86 400 steps) | 73 ms |

So for a model like this the fixed cost of starting a run is a few milliseconds, and the run itself is far faster than any lab's data arrives.

## The decision: a cycle is a run

Each cycle is one fresh, bounded engine run: from the checkpoint at the anchor, with the measured states replaced, the inputs as held schedules from the anchor to now, through to the horizon. Window and forecast are one run, since the inputs simply hold their last value after now. Its result gives the comparison (anchor to now), the forecast (now to the horizon) and the checkpoints the next cycle starts from.

Why this first:

- **Almost no engine change.** Everything in the table above exists. The new code is a JavaScript session that plans each cycle and keeps its log, much of it already written for replay.
- **Each cycle is reproducible on its own.** A cycle is fully described by its starting checkpoint, the states it replaced and the schedules it ran on, which is exactly the session log the proposals ask for. Any cycle can be rerun alone, later, to check it.
- **A late or corrected reading costs nothing special.** Every cycle reruns its window from the anchor anyway, so a correction inside the window is simply in the next cycle's schedules.
- **It works wherever a run works,** the web edition included.

What it costs, and the limit of it:

- Every cycle repeats the window, W/S times over, as the window document already says. For the rig at W = 1 h, S = 1 min that is 60 one-hour runs an hour, under a second of computing in all.
- **Starting a run is cheap only for a model without heavy providers.** A Python provider starts its interpreter and a worker, an FMU is unpacked and instantiated, and a C++ provider may be compiled; each of those is paid once per cycle. Their cost is measured on the first cycle and reported with the session's speed, and it is what decides when the next design is needed.

## When a long-lived stepping engine is needed

A session engine that stays alive between cycles, starts its providers once, and is driven by commands (run until a time and hold, append input samples, set some states, return a checkpoint) is the answer when starting a run is too expensive for the stride: heavy providers or FMUs, or a stride well under a second. It is a larger change to the engine and its protocol, and it is deferred until a real model needs it, with the measured start cost as the evidence. Its commands would extend the existing control stream, which already sets and schedules parameters, pauses and paces a run; the cycle-as-a-run session would then switch to it without changing what it plans, since the plan (start state, replaced states, schedules, run to) is the same either way.

## The session

A `WindowSession` class, in plain JavaScript beside `dataLogReplay.mjs` and built from the same pieces:

- **Given** the model, the mapping of signals (the replay's), the window W, the stride S, the horizon H, the time step and each output's tolerance.
- **Fed** observations, from a finished log at first (replayed as fast as it can go, or paced) and from a followed file or broker later (step 3), through one `push(observations)` call either way.
- **Each time the data passes the next anchor,** it plans and runs a cycle as above, and records the jump per measured state, the window's comparison and the forecast.
- **Keeps** only the checkpoints it can still need (those within the window and the lateness allowance), and a log of every cycle: start time, replaced values, jump, schedules' extent, run time.
- **Reports** its real-time factor (model seconds per wall second over the last cycles), its lag (how far the last finished cycle is behind the newest reading), and what the degrade ladder has done.
- **The degrade ladder,** first rung only: when cycles cannot keep up, lengthen the stride (skip anchors) and say so. The other rungs follow when there is a model slow enough to need them.

The first cycle starts from the model's initial state at the first reading's time, with the measured states set, as replay does today. A measured state that the model computes from others (an algebraic state) cannot be set; the mapping screen says so, and it is compared but not reset.

## In the app

The replay goal of the tuning card gains a second way to replay: **as a live twin**, with W, S and H, and a speed (as fast as it can go, or a multiple of real time). It plays the log through the session and shows the moving window on the plot (settled, window, forecast, as in the window document's figure), the jump at each move as a series of its own, the real-time factor and the lag. The existing replay, one run unaided from the start, stays as it is, as the hold policy; the two are the two policies of the window document side by side.

## Testing it

The simulated rig gains a `--drift` option that makes the tank's heat loss coefficient change slowly over the run, as insulation that is getting wet would, so there is something for the jumps to find. Then:

- **With the rig's true, constant values** the jumps stay within the thermometer's noise and show no trend, and the forecast an hour ahead agrees with what the log then says.
- **With drift,** the jumps grow in one direction, and the session's trend of them says so before the hold-policy replay of the same log has fallen out of its tolerance.
- **Each cycle reproduces:** rerunning any one cycle from its logged start reproduces its result.
- **The speed figures are honest:** a cycle made artificially slow (a time step a hundred times finer) makes the session report a real-time factor below one, lengthen its stride, and say so.
- **The web edition** runs the same session test in Chrome once its engine is rebuilt.

## Changes to the other documents

When this is agreed, [Digital twin connections](digitalTwinConnections.md) step 2 and "What the engine must do first" are rewritten to this design (input binding during a run, a stepped run and partial state replacement move to "when a stepping engine is needed"), and the [comparison window](predictionActualWindow.md)'s "What it needs" list is shortened to match.

## Open questions

- **Output interval and the stride.** A cycle's anchor must be an output time of the previous cycle's run, so the output interval must divide the stride. Recommended: the session sets the output interval to the time step for the window part, which is what replay does, and checks the stride is a whole number of steps.
- **A provider that cannot checkpoint** cannot restart a cycle. Recommended: the session refuses with the node named, rather than silently starting that node from its initial state each cycle.
- **What the forecast assumes for inputs.** Held at their last value by default; a declared forecast per input (a schedule supplied with the data) later.
- **Where the jump trend's alert threshold comes from.** Recommended: a multiple of the tolerance, shown and editable, with no alert by default until a person sets one.

## Order of work

1. **`WindowSession`, headless,** driven by a finished log: cycles from checkpoints with the measured states replaced, jumps, the bounded checkpoint set, the cycle log, the real-time factor and lag. Tested through the real engine with the rig's log, with and without the new `--drift`.
2. **The live replay in the tuning card:** W, S, H and speed, the moving window on the plot, the jump series, the speed figures.
3. **The first rung of the degrade ladder,** tested with an artificially slow model.
4. Then step 3 of the connections document: the same session fed by a file that is still growing.
