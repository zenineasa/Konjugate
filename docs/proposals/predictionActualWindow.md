---
type: Proposal
title: "The prediction-actual comparison window"
description: Design for a moving window in which a running model and the real data are compared, how the model is reset to the measurements each time the window moves, how drift is watched, and how the model keeps ahead of the data it is fed.
tags: [proposals, digital-twin, state-estimation, real-time, checkpoints]
status: draft
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# The prediction-actual comparison window

**Status: steps 1 to 6 built: the hold policy over a recording (replaying a data log), the default reset policy over a recording and live, as a live twin ([Live engine session](liveEngineSession.md)), and, per measured signal, a nudge or watching only in place of the reset, with the observed states shown and a state the model computes compared but never set. A node declaring itself conserving is not built (see the open questions). Step 5, a refit over the window with initial states as tunable, is built and proposes what it finds for a person to apply. Step 6, the estimator, is built as a fourth choice per signal ([A state estimator for the live twin](stateEstimator.md)).** The idea comes from the review in [Digital twin connections](digitalTwinConnections.md): once measurements reach a running model, something has to decide how far the model is trusted, when it is corrected, and how. This document gives that a name and a shape. A first draft recommended two different windows at once, a fixed one that resets at every move and one that grows while the model is wrong; this version makes the first the default and keeps the second for monitoring only.

## The idea

Time splits into three zones around the present moment.

```
 settled                    comparison window                forecast
 ───────────────────────────┤◄────────────────────────────►│◄──────────────────────►
                         anchor                          now                    horizon
 the model was brought      the model has run forward from  the model alone: what
 to the actual data and     the anchor on the actual        happens next, from the
 this part is kept          inputs; its output and the      state it reached at now
                            data are compared here
```

- **Settled.** Before the anchor, the model has been brought into agreement with the actual data. This part is a record and is not recomputed unless a late correction arrives from the source.
- **Comparison window.** From the anchor to now, the model runs forward from its anchored state, driven by what the real system actually did (measured inputs and the operators' actions), and its output is compared with what was measured. This is where the model and the data are allowed to disagree.
- **Forecast.** From now to the horizon, there is no data, only the model, starting from the state at now with each measured state set toward its latest reading, as the anchor's are (by the signal's gain; not for a signal watched only, computed by the model, or estimated, whose band is its forecast). Started from where the model's run reached at now instead, a system drifting from the model had its forecast begin a window's drift away from where it was: with the rig drifting, 3.5 °C off the reading at the end of six hours. The move records where it started (`forecastFrom`: the model at now, the reading, the value set), and the room draws the forecast from there. A [sandbox](digitalTwinConnections.md#detaching-to-try-things) is a forecast in which the person chooses the inputs.

This is a well-known structure under other names: moving-horizon estimation and receding-horizon control use a window like this, and data assimilation in weather forecasting does the same with a cycle of "analysis" and "forecast". The name here keeps to what the person sees.

## The default: reset at each move

The default is the one a person would describe in a sentence: the measured values at the anchor become the model's state there, and the window simulates forward from it; when the window moves, the measured values at the new anchor become the state again, and the next window is simulated.

The window has a fixed length W and moves by a stride S. Each time the data has advanced by S:

1. **Record the jump.** Before anything is reset, note how far the model's prediction at the new anchor is from the measurement there. This is the measure of how wrong the model was over the stride it just ran unaided.
2. **Reset at the new anchor.** Each measured state is set to its measured value (or a short average of it, so one noisy sample does not become a step in the state); every other state keeps the value the model reached there.
3. **Run the window,** from the new anchor to now, on the actual inputs, and record the difference from the measurements.
4. **Run the forecast** from now to the horizon, from the state at now with the measured states set toward their latest readings (a checkpoint at now, restored with them set).

Between moves, as each new batch of data arrives, the model only extends: it carries on from where it was to the time of the new data, and no earlier step is repeated. A late or corrected observation from the source for a time inside the window reruns the window from a checkpoint at or before that time.

Two consequences should be understood.

- **The jumps are the health signal.** Each reset hides the drift that came before it, so a model that is slowly going wrong shows up not as a growing window error but as jumps that keep growing in one direction. Their trend is what monitoring watches and what an alert is set on.
- **The cost is set directly.** A window of length W moved by a stride S is simulated W/S times over, so the model needs to run at least W/S times faster than the data arrives, plus the forecast. A stride equal to the window (no overlap) costs the least; a short stride gives a smoother, more current forecast at proportionally more cost.

## Monitoring without resetting

For a person who wants to know how long the model stays right on its own, without being corrected, there is a **hold** policy: nothing is reset, the model runs unaided from the last time it agreed, and the window is the stretch since then. Its length is then itself the finding: how long the model has been wrong.

Whether the model agrees is written the way a tuning limit is written, in the same equation editor: for example "the largest difference between the tank temperature and its measurement over the window stays at most 0.5 K". The engine evaluates it with the same code as an objective and a limit. Two more numbers shape the hold window, each with a default and each visible:

- **Minimum time in agreement** before the anchor moves up to now, so a tolerance near the noise level does not move it on every sample.
- **Maximum length:** when the model has been out of step this long, the window is closed, the anchor is forced forward, and the stretch is marked as unsynchronised, not silently accepted.

The same written limit is also how the default policy raises an alert: it is evaluated on each window before its reset, and on the trend of the jumps.

## Other ways to bring the model back in step

The reset is the default. The others, from least to most invasive, are choices made per signal:

1. **Hold.** Record the disagreement and change nothing, as above.
2. **Reset the measured states.** The default.
3. **Nudge.** Move each measured state part of the way toward its measurement every step, with a gain per signal. Gentler than a reset and the usual choice for noisy data.
4. **Refit over the window.** Treat the window as a small tuning problem: find the parameters, and the initial state at the anchor, that make the window's output match the measurements. This is [Parameter tuning](parameterTuningObjectives.md) run on a moving window, with the same optimisers, objective, limits and progress, and it is also what moving-horizon estimation does. It needs one thing tuning lacks: initial states as tunable quantities, not only parameters.
5. **A proper estimator** (a Kalman-type filter) that weighs the model's uncertainty against the sensors', for models where that matters. Later, and not required for the rest.

A state with no measurement cannot be compared and cannot be reset. It is carried by the model, and refitting is the only way the data reaches it, through the parameters and the measured states it is tied to. The window says which states are observed, so no one believes an unobserved state has been checked.

## What a reset can break

Setting a state by hand is the bluntest of these, and it can leave the model in a condition its own equations would never have reached:

- **Consistency.** Where states are tied together by an algebraic relation or a value derived from them, setting one alone leaves the others inconsistent with it. The reset must either set the whole group consistently or refuse, and say which.
- **Conservation.** Setting one temperature injects or removes energy. A node marked as conserving can refuse a reset, and nudging is the safer default there.
- **Noise.** A single sample becomes a step in the state. A short average, and quality flags that keep a bad sample out, are the guard.
- **Hidden drift.** As above, resets hide drift; the jump trend is what reveals it, so it is always recorded and shown.

## The speed assumption

The working assumption is that the model can be run faster than the data arrives, and that when it cannot, the time step is adjusted. This holds often and needs to be made explicit.

A cycle must finish inside the interval between batches of data. Its cost is about the number of steps in (window + horizon) divided by the step, times the cost of a step, and that cost is large for models with Python providers or FMUs. So the session measures and reports its **real-time factor** (how many seconds of model time it computes per second of wall time) and its **lag** (how far the model's present is behind the data's), and keeps both on screen.

When the budget is short, the model degrades in a fixed order, tells the person at each step, and never changes anything silently:

1. Lengthen the stride, so the window is rerun less often.
2. Compute the forecast less often, or not at all until asked.
3. Run the forecast with a coarser step than the window.
4. Shorten the horizon, then the window.
5. Combine observations that arrived while it was busy (take the latest, or their average) instead of working through each one.
6. Run the whole cycle at a coarser step, as a last resort.

Adjusting the time step is the last resort because it is the one that changes answers. A larger step is less accurate and, for a stiff model, can be unstable; the engine's stability monitoring and its substep convergence check say how far a step can grow, and the degrade ladder stops there and reports instead of crossing it. A step larger than the sampling interval also needs the observations to be averaged into it, since picking one sample out of several aliases the signal. When the data arrives more slowly than the model runs, the spare time goes to sandboxes or a refit.

## What is recorded

The source is the record of what was measured ([The record](digitalTwinConnections.md#the-record)). What the session adds is a small log of its own decisions: when each observation arrived and which it used, the stride and window, every reset with the values it applied and the jump before it, every nudge, every refit and the parameters it chose, and every change of step or horizon. Replaying the source through the log produces the same states.

## Detaching from live

The window is what a [sandbox](digitalTwinConnections.md#detaching-to-try-things) starts from. When a person detaches to try their own controls, the sandbox is forked from the model's state at now, which is the best estimate the window has produced, and runs ahead on a virtual clock. Meanwhile the live session keeps extending, resetting and recording, so its window is current when the person returns, and nothing the sandbox did is carried back. Detaching from a past anchor instead uses the settled record, where both the model's state and the actuals are known. The degrade ladder protects live first: when the speed budget is short, the sandbox slows or pauses before the live cycle gives anything up.

## Where else it applies

Replay is the window run at unlimited speed over a recording, so the logic of a live twin is tested on history before it goes near a lab's equipment, and it is the first thing built. A monitor that only alerts is the hold policy with its limit raising the alert. A walk-forward test, for anyone using Konjugate on price data later, is a refit window moved through history and scored on the stretch after it.

## Open questions

- How are algebraic ties between states known to the reset: derived from the model's relations, or declared on the node? Answered for states computed outright (derived, by the engine); a tie between two integrated states, such as two masses whose sum is fixed, is not yet known to it.
- How are conserved quantities declared on a node, and does nudging keep them?
- Does a refit move parameters automatically or propose them for a person to accept, as tuning does? Recommended: propose. Built that way.
- Should the jump trend raise an alert by default, and at what size?
- Which states count as observed: derived from the signal mapping, or declared? Recommended: derived, shown, and overridable. Built as derived and shown; overriding waits for a case that needs it.
- For a model with providers that cannot checkpoint, is the window limited to extending, with late corrections ignored and said to be?

## Order of work

These follow the steps of [Digital twin connections](digitalTwinConnections.md#order-of-work).

1. **The hold policy over a real recording, offline.** Run the recording's applied inputs as held parameter schedules, compare the measured outputs with the result, and show how long the model stays within its written limit. This needs no engine changes and is the first test of whether a model is worth connecting at all. **Built** as replaying a data log ([Connecting a data source](../connectingADataSource.md#replaying-a-log-in-konjugate)), with a tolerance per signal in place of a written limit and three readings in a row outside it as the minimum to count as out of step. It anchors once, at the recording's start, so it reports when the model first left the tolerance and every stretch it was out, not yet a window that moves.
2. **Built.** **The default reset policy over the same recording,** once the engine runs in steps and can replace the measured states: the jumps and their trend, rolling checkpoints, and the real-time factor and lag, with the recording replayed faster than the model can follow so the degrade ladder is tested.
3. **Built.** **The same, live,** with nothing new in the window itself: a data log followed while it grows. The jump trend is read over the last six moves, and leans to one side only when its mean is clear of the jumps' scatter and at least a tenth of the tolerance.
4. **Nudge,** the observed-state marking, and the consistency and conservation guards. **Built,** with these choices: the correction is a gain per measured signal, 1 resetting it to the reading (the default), 0 watching only, with the model running on unaided after the first move (the hold policy, live), and between, nudging it that fraction of the way from the prediction to the reading. The nudge is applied once at each move, at the anchor, not at every step: the window is rerun from the anchor at each move, so a per-step nudge would mean feeding readings into the run itself, which is what the estimator of step 6 is for. The prediction a correction starts from is the model's own value at the anchor, from the last move's run, never one read off at the reading times (a bad reading at the anchor must not shift it). For consistency, the engine says when a session starts which states it computes from others (a source term that sets a value, an algebraic relationship's output, a provider's set output); such a state is compared with its readings at every move and never set, and the move says so rather than failing. Every move records which states the readings reach and which the model carries alone, and the card shows both. For conservation, the per-signal choice is the guard for now: nudge or watch a state where a reset would put energy in or take it out; a node declaring itself conserving, and refusing a reset on its own, waits for a model that needs it. [tests/engine/windowCorrections.mjs](../../tests/engine/windowCorrections.mjs) checks the nudge to the bit, that a wrong model watched only drifts away from the rig (a mean jump of 1.5 K over the last ten moves, against 0.2 K reset), and a computed state measured.
5. **Initial states as tunable, and refit over the window.** **Built.** A state's initial value is a fitting target when it carries `tuning` bounds, as a parameter does; the engine's fit sets it with the parameters, so any tuning or calibration can find it, and the node editor marks it. A refit takes the latest window as a calibration (the plan made by the session, the fit by the engine's ordinary `fit`, so the same optimisers, limits and progress): time 0 is the anchor, every state starts where the last move left it, a measured state at its reading and not fitted, and the inputs are what was really done. It proposes; nothing moves until a person applies it, which answers the open question below as recommended. Applying starts the twin again from the move the refit was planned on, with the new parameters and the states found at its anchor, and runs it on to where it has got to, because a fit takes seconds and a twin moves on meanwhile; the moves already made keep their record, and the next one records the refit. The parameters can be kept in the model; the states found at an anchor stay with the twin, as they are not the model's start. Two limits: a model whose node programs keep their own state cannot be refitted yet (that state cannot be put into a document), and refitting is on request, not on the drift alarm. [tests/engine/windowRefit.mjs](../../tests/engine/windowRefit.mjs) shows one two-hour window finding the rig's capacitance, heat loss and the unmeasured room within a percent.
6. **The estimator.** **Built** ([A state estimator for the live twin](stateEstimator.md)): an ensemble Kalman filter, as a fourth correction choice per signal, which corrects the states the data does not measure and tracks tunable parameters as they change, shows each one's spread and the forecast's band, and says how honest the spread has been.
