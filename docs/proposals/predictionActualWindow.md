---
type: Proposal
title: "The prediction-actual comparison window"
description: Design for a moving window in which a running model and the real data are compared, how the model is reset to the measurements each time the window moves, how drift is watched, and how the model keeps ahead of the data it is fed.
tags: [proposals, digital-twin, state-estimation, real-time, checkpoints]
status: draft
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# The prediction-actual comparison window

**Status: steps 1 to 6 built: the hold policy over a recording (replaying a data log), the default reset policy over a recording and live, as a live twin ([Live engine session](liveEngineSession.md)), and, per measured signal, a nudge or watching only in place of the reset, with the observed states shown and a state the model computes compared but never set. A node declaring itself conserving is not built (see the open questions). Step 5, a refit over the window with initial states as tunable, is built and proposes what it finds for a person to apply. Step 6, the estimator, is built as a fourth choice per signal ([A state estimator for the live twin](stateEstimator.md)). Steps 7 to 13, the inputs in the forecast (each input carried past now by a choice of its own instead of held at its last reading, every choice scored against what then arrived, a plan by the clock, the model's own controller, and the inputs' uncertainty in the estimator's band), are built; a plan sent as a signal is not.** The idea comes from the review in [Digital twin connections](digitalTwinConnections.md): once measurements reach a running model, something has to decide how far the model is trusted, when it is corrected, and how. This document gives that a name and a shape. A first draft recommended two different windows at once, a fixed one that resets at every move and one that grows while the model is wrong; this version makes the first the default and keeps the second for monitoring only.

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
4. **Run the forecast** from now to the horizon, from the state at now with the measured states set toward their latest readings (a checkpoint at now, restored with them set). The inputs are held at their last reading; [The inputs in the forecast](#the-inputs-in-the-forecast) proposes other choices.

Between moves, as each new batch of data arrives, the model only extends: it carries on from where it was to the time of the new data, and no earlier step is repeated. A late or corrected observation from the source for a time inside the window reruns the window from a checkpoint at or before that time. **Built** for inputs (measured signals are read afresh at every move, so a corrected measurement needs nothing more): an input reading corrected, marked bad or good, or arriving late after the twin sent it to the engine is sent again from that reading on, in place of what the engine held (`replaceFrom`). When it falls before the checkpoint the next move starts from, that checkpoint was taken with the reading as it was, so the twin is run again to the move's anchor from the latest state it logged at or before the reading, with every input sent again from there and each later move's reset at its anchor made again on the way; the move then starts where it would have had the correction come in time. A rebuild never reaches back past a refit or a model change, which restarted the twin from a state of its own, nor past the twin's first move; a twin with the estimator does not rebuild, since its members' past is not run again. Each move records what it did about such readings (`inputCorrections`: `resent`, `rebuilt` with the logged state it ran from, or not applied, with the reason). The moves already made keep their record as they were made. Sending the inputs again from the start of a run also fixed the catch-up after skipping a backlog, which had run its first stride on the reading the engine kept for the move after rather than on the readings applied. [tests/engine/windowInputCorrections.mjs](../../tests/engine/windowInputCorrections.mjs) checks that a twin given a correction late makes the moves after it exactly as one given the corrected reading from the start.

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

## The inputs in the forecast

**Built: Hold, Hold the average, Follow the trend (first and second order), Repeat the last day, Automatic, the score, From a plan (kept with the setup, by the clock), From the model (the engine has the input follow a state), and the inputs' uncertainty in the estimator's band** (`src/inputForecast.mjs`, `WindowSession`, the engine's `AppendInputSamples`, the engineer's view; tests `tests/inputForecast.test.mjs` and `tests/engine/twinInputForecast.mjs`). **Not built: a plan sent as a signal.** Building it showed two things, both on the house. Holding the heaters at their average forecasts the heaters themselves better than holding them (by 2% to 8% over a day), but the rooms' forecasts hardly change: better in some hours, worse in others, 0.561 K against 0.569 K over the day. A thermostat answers its room, so over the next hour it does what the room and its setpoint ask, not what it did on average over the last one; that is what From the model is for. And Automatic deciding by its rules alone came out no better than holding, so once an input's forecasts have been scored it goes by the score (below). Repeating the last day forecasts the outdoor temperature on the house's second day clearly better than holding it (0.38 K against 0.53 K). With the house's thermostats in its model and its setpoints logged, handing each heater to its thermostat past now and each setpoint to its programme brings the rooms' forecasts from 0.569 K to 0.116 K: the gain the average could not give. And the inputs' uncertainty, in the estimator's band, brings the share of later readings inside a 10th-to-90th percentile band from 73% to 82%.

At each move the twin forecasts a horizon past now. The measured states start the forecast where the readings say the system is. The inputs, the shared parameters the source drives, have no readings past now, so each is held at its last reading for the whole horizon (`WindowSession`: the forecast run restores the checkpoint at now and advances to the horizon on the input schedules as the engine holds them, and those hold their last sample).

Holding is a safe default. It never runs away and needs no settings. But it is wrong for three kinds of input:

- **One that is switched back and forth.** The house's heaters are switched by thermostats. A heater that was on when the move was made is forecast on for the whole hour, so the forecast heats the room past the thermostat's setpoint. One that was off is forecast off, so the room cools below it.
- **One that is ramping.** An operator part-way through raising the motor's voltage, or a heater power being brought up over half an hour, usually finishes the ramp. Holding forecasts that the ramp stops at once.
- **One with a pattern.** The house's outdoor temperature and sun follow the day. Holding the noon sun for an hour is a fair guess; holding it overnight is not.

The fix is to choose, per input, how it is carried past now. It is also to show, from the twin's own record, how well each choice would have done, so the choice is not a guess either.

### What the input's past can say

Many inputs are not noisy measurements at all. They are commanded: a setpoint, a voltage an operator sets, a valve's position. They change when someone or something changes them. A forecast of such an input is a guess at what will be done next from what was just done. That is sometimes sound (an operator in the middle of a ramp usually finishes it) and sometimes not (an operator who stepped the voltage once will hold it). Where the plan is known, the plan beats any guess. That is why a known future and the model's own controller are in the list below, and why they come after the choices made from the past only because they need more to build.

Two ways of reading a trend from the past were weighed and set aside:

- **Differences between the last few readings.** A slope from the last two readings, or a curvature from the last three, carries any noise forward by the horizon over the spacing, once for a slope and squared for a curvature. Over the tank's hour, read every minute, a curvature from three readings with a thermometer's noise would be off by hundreds of kelvin. A commanded input has no such noise. But it moves in steps, and a difference taken across a step reads as a slope or a curvature that was never there.
- **A polynomial carried on undamped.** A line keeps going and a parabola speeds up or turns. Real inputs level off, saturate or switch.

So every trend here is **fitted over a span of readings** (least squares, the twin's window by default), which smooths what noise there is and makes the error grow with the horizon over that span rather than over one reading's spacing. It is also **damped**, so it levels off, and **clamped** to the input's limits.

### The choices, per input

Each input gets a setting in the engineer's view (**Each input, in the forecast**), with Hold as the default, so a twin set up before this changes nothing: its moves are what they were, to the bit.

| Choice | What it does past now | Suits |
|---|---|---|
| **Hold** | The last reading, as now. | An input that changes in steps and is held between them. |
| **Hold the average** | The mean over the span (the window by default). | An input switched back and forth faster than the horizon is long: a thermostat's heater, whose average is its duty cycle and about the power it will draw over the hour. |
| **Follow the trend** | A line, or a parabola (**second order**), fitted over the span and carried on from the last reading, damped and clamped. | An input that is ramping. |
| **Repeat the last day** | What it did one period ago (a day by default), moved to start from where it is now. | Weather, sun, a building's occupancy, a plant's daily schedule. |
| **Automatic** | At first Hold, Hold the average or Follow the trend, by what the span shows; once its forecasts have been scored, whichever choice the score says came closest (below). | Most inputs. |
| **From a plan** | A schedule kept with the setup, or another signal that carries the input's planned future. | Setpoint programmes, a planned ramp, a weather forecast published on its own topic. |
| **From the model** | Released from the readings at now: the model's own equation for it decides, such as a thermostat in the model switching the heater. | An input that a controller in the plant sets, where the model has that controller. |

#### Follow the trend, exactly

The fit is least squares over the readings in the span, of degree one or two (`a + bt` or `a + bt + ct²`, `t` the time before now). It is carried on from the last reading, not from the fit's value at now, so the input does not jump at now. It is damped by putting a shortened time in place of the time past now:

```
d(Δ) = τ · (1 − e^(−Δ/τ))
value(now + Δ) = last + b·d + c·d²        (c = 0 for a line)
```

`τ` is how long the trend keeps its pace before it fades. Its default is the horizon, so at the horizon a line has gone 63% of the way it would have gone undamped, and it keeps levelling off past that. It is clamped to the input's limits: its parameter's control range (the motor's voltage, 0 to 12 V) or its tuning bounds. An input with neither is not clamped.

Second order is offered alongside the line. It is fitted over the span like the line, damped by the same `d`, and clamped. It can follow an input that is rising and levelling off, such as a morning's temperature. It is also the choice the score below is most likely to mark down, and it should be.

#### Repeat the last day

With period `P` (24 h by default; another can be typed), the input's value at `now + Δ` is its reading at `now + Δ − P`, shifted by how far it now stands from where it stood a period ago:

```
value(now + Δ) = reading(now + Δ − P) + (last − reading(now − P))
```

Until the twin has a period of the input's readings it holds, and says so. The house's demonstration recording is one day long, so its twin never reaches a full period; the generator runs it on for a second day for the test (`houseDay({ days: 2 })`, the first day the shipped recording to the byte), and the shipped demonstration is left at one day.

#### Automatic

Until an input's forecasts have been scored six times, what its readings over the span look like decides between the first three choices. A change is a reading that differs from the value before it by more than the input's resolution (its control step, else almost nothing).

- **Steady:** no change in the span. Hold.
- **Ramping:** four changes or more, at least two in three of them the way a line fitted over the span goes, and that line moving further over the span than twice the scatter about it. Follow the trend (a line). An operator stepping a voltage up a volt every five minutes is ramping.
- **Cycling:** the input has gone back the way it came at least once. Hold the average, since it may well go back again within the horizon. The house's thermostats switch their heaters once or twice an hour, never more than three times, so a first draft that wanted three changes before calling anything cycling held them every time.
- **Stepping:** changes all one way, too few or too scattered for a ramp. Hold.

After that, Automatic uses whichever choice the score says came closest for that input so far (Hold on a tie). The rules alone held a heater that had just switched on for the whole hour, and on the house came out no better than holding; going by the score, Automatic averaged the heaters nine moves in ten. It stays explainable, since what it says is the score: the engineer's view and the input's strip show which choice Automatic is using and why ("cycling: 2 changes, back and forth", then "hold the average has been closest over 40 forecasts (missed by 612, holding by 1000)").

### Scoring the choices against what arrived

The choices can be judged on the inputs' own readings, with no model run. At each move the twin works out, for every input, what each choice would forecast over the horizon. These are cheap: arithmetic on readings it already holds. Once the horizon has passed, it compares each forecast with the readings that arrived over it. The comparison is the root mean square of the difference over the horizon, at the readings' times, kept as a running figure per input per choice.

The engineer's view shows it beside each input's setting, against Hold:

> Outdoor temperature · Hold · *Repeat the last day would have been 3.1× closer over the last 40 moves*

and "Scored once a forecast's horizon has passed" until then. It is shown, and applied only where a person chose Automatic.

Only the inputs are scored this way, not the states the model forecasts from them. A better input forecast should give a better state forecast, but checking that takes a model run per choice per move. The twin already compares its forecast of the measured states with what then arrives through its jumps, and a choice that helps should show there over time.

### What it changes in the twin

- **The forecast run only.** The projected input values are sent to the engine as input samples past now just before the forecast run (`appendInputSamples`, after the checkpoint at now is restored), and taken out again straight after it in the same batch (`appendInputSamples` with no samples, `replaceFrom` the first projected time), so the engine holds afterwards exactly what it held before, and `WindowSession`'s record of what it holds (`#sent`) never sees them. They never enter the record of readings the twin keeps, the recording, or the readings a refit or a sandbox starts from; the checkpoints the next move uses are all taken at or before now, on real inputs. The test checks that every move's window is the same whatever the forecast assumed. `freshRunFor`, which runs a move again on its own, puts the projection after the readings in the input's schedule.
- **The shape of the samples.** The engine's live input schedules hold between samples. A trend is sent as at most 200 samples, a whole number of time steps apart, each the trend's value half way through its step; an average is one sample; the last day repeated is a sample at each change a period back. The room draws them as they are sent. Whether the engine should take a linear schedule for live inputs (its stored schedules already can) is still open.
- **The estimator.** Its members forecast on the same projected inputs as the twin's own forecast, each moved by a draw of the input's own uncertainty (below).
- **The room.** Each input's strip under **Inputs** draws what the forecast assumed past now, dotted, as the sandbox draws what was tried. Choosing the forecast for an input is the engineer's. The operator sees what it assumed.
- **What is kept.** The setup's `live` gains `inputs { name: { forecast, span, damping, period } }` (src/twinSetup.mjs, docs/projectSchema.md; the second-order trend is a choice of its own, `trend2`), each value checked and dropped when it cannot be used, and only for an input, as the rest of the setup is. A choice is taken when the twin starts again (**Start again with these**), like the other settings, and the event saying so names it.

### From a plan, From the model, and the inputs' uncertainty

**From a plan.** A programme kept with the setup for each input that has one: times of day and values, repeated daily or weekly, each value held until the next, in the plant's time zone (an IANA name, the computer's when the plan is written, kept with it so it means the same anywhere). The twin follows it by the source's clock: a data log's header gives its epoch, and a live source's is when the twin started following it, so a twin's time is a time of day; a source with no clock holds, and says why. The zone's offset is taken at now and held over the horizon, so a forecast across a change of clocks is an hour out from the change on. The engineer writes it as a person would, one point to a line ("06:30 21", weekly "Mon 06:30 21"), in the unit the room reads the input in (°C for a temperature the model keeps in kelvin); one written wrongly is said, and the twin is not started again with it. A plan is scored, as every choice is. A plan sent as a signal (a forecast feed on its own topic) is not built: what such a feed would send needs settling with whoever has one.

**From the model.** The input stays mapped to its shared parameter; past now, the engine has it follow a state of the model, a controller's output. `AppendInputSamples` gained `follow_state_id` and `follow_from`: at the end of every step after `follow_from` the engine adds the state's value as the input's next reading, so the parameter takes it from the next step, as an Update would; a step over the same time again (an estimator member after another, after a restore) replaces what the pass before added; and the command that takes the forecast's projections out after the run stops the following. The controller's state starts from what the input was doing (a thermostat's on or off is its memory): before the step over `follow_from`, in every pass over it, the engine sets the state to the input's value there. Done in the engine, rather than by the session setting the state when it restores now, it reaches the estimator's members too, which run on from their anchor through now; when the session did it, only the twin's own forecast had it, a member's thermostat could start on the other side of its switch, and the forecast left its own band at 149 of 2085 points just after now. A state the model computes from others (an Update) has no memory to set, and is left to the model. With `follow_bounded`, the input takes the state's value within `follow_minimum` and `follow_maximum`, the input's control range or tuning bounds, and what was held within them is said beside the input ("held within its limits for 35% of the forecast, where the state went to 2000"). What the input did is read back from the run (the state is among those the twin infers), within its limits, to draw it and to score it. The engine says at the start of a session that it can do this (`SessionInfo.features`, "followState"); a session asked to follow a state by an engine that does not say so stops, saying the engine is older than the twin, rather than holding the input in silence. The mapping, the sandbox, a refit and replay are as they were.

Only a state that could drive the input is offered: one in the input's unit (the engine gives the input the state's value as it is, so a floor's temperature in kelvin is no heater's watts); never one a signal measures, nor one an input sets (the input would copy that input). Where a unit is missing, on the state or on the input, it cannot be checked, so the state is offered apart and said to be unchecked, and only when nothing could have been checked anyway (the input has no unit) or the state is a controller's output: a state of a node whose type is Controller (the library's PID blocks, a thermostat), less what that node's program reads (a PID block's Measurement) and its error. A floor slab whose unit nobody wrote down is not offered to a heater in watts: followed, it set the rooms' forecasts to 150 °C. A model with none has nothing to hand the input to, and the choice says so ("nothing in the model can drive it") and cannot be made. A setup kept from before these checks that names such a state stops the twin when it starts, saying which and why in the room (what the twin says while it is being made, as this refusal is when a recording's header is read at once, is held until it is made, so it reaches the window that started it rather than failing the start). When what the input follows goes past the input's limits, the input is held at them and the room says so: on the input's strip ("held at its limits for 60% of it", in the warning's colour), and, when that is a quarter of the forecast or more, in place of "In step" ("Forecast held at Living room heater's limits", its tooltip saying how far the state went). Further ahead, the forecast may still leave its own band: it is one run from the members' mean, and a thermostat switching at another time than most members' carries it out of their 10th to 90th percentile (on the house, 1060 of 8340 points over the hour, none in the three minutes after now; none at all with the heaters held). That is the forecast being the mean's run rather than the members' middle, in a model that switches, not a member starting elsewhere; see the open questions.

The model has to have the controller. The house's demonstration does not; `houseProject({ thermostats: true })` adds one per room for the test, with the controller's log of its setpoints (`houseDay({ setpoints: true })`). A thermostat's rule needs its own last value, and a state set outright by an equation may not read itself yet ([Rates and Updates](ratesAndUpdates.md) would allow it), so each is a Rate state driven by a relationship from its room, its rate the gap to what the rule asks over one step, which explicit Euler closes exactly. When Rates and Updates is built it becomes an Update.

**The inputs' uncertainty.** With the estimator, each member forecasts with each input moved by a draw of how far that input's forecasts have been off (the score of the choice in use, as a root mean square), by nothing at now and growing in a straight line to √3 times the draw at the horizon, so the draw is the root mean square over the horizon, within the input's limits. A move of the whole draw from the first step was tried first: the house's band then held 89% of the later readings, where 80% is honest; ramped, 82%. Its own seeded draws, apart from the estimator's, so turning it off changes nothing else; on by default, with a box in the engineer's view, kept with the setup only when off. An input the model follows is not moved. This replaces the range of futures first proposed (several forecasts per move, an input's limits among them), which would have drawn a band too wide to use, and a second band beside the estimator's.

### Open questions about the inputs

1. Should Automatic switch to the choice the score favours once there is enough of a record, or always decide by its rules and leave the score as advice? Proposed: rules. **Answered the other way by the house:** the rules alone did no better than holding, so Automatic goes by the score after six scored forecasts, and says so.
2. Should the engine take linear live input schedules, so a trend is one sample at the horizon rather than many?
3. The damping's default: the horizon, or the span the trend was fitted over? The horizon keeps the forecast's shape the same whatever the window is. The span says a trend lasts about as long as it has been seen.
4. Is the span the window (the default here) or its own setting from the start? Proposed: its own setting, defaulting to the window, since a thermostat that cycles every few minutes and a ramp that lasts an hour want different spans in the same twin. **Built that way.**
5. With the estimator, should the forecast line be the members' median rather than one run from their mean? In a model that switches (a thermostat the forecast hands a heater to) the mean's run switches at its own time and can leave the members' band, by up to 0.3 K on the house. The median is inside the band by construction and, in such a model, likely the better forecast; but it changes the twin's forecast wherever the estimator is on, and the alarm and the sandbox start from it.

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
3. **Built.** **The same, live,** with nothing new in the window itself: a data log followed while it grows. The jump trend is read over the last six moves, and leans to one side only when its mean is clear of the jumps' scatter and at least a fifth of the tolerance, on two moves in a row (once called, a lean holds until its mean falls below half of what called it, and so does the warning).
4. **Nudge,** the observed-state marking, and the consistency and conservation guards. **Built,** with these choices: the correction is a gain per measured signal, 1 resetting it to the reading (the default), 0 watching only, with the model running on unaided after the first move (the hold policy, live), and between, nudging it that fraction of the way from the prediction to the reading. The nudge is applied once at each move, at the anchor, not at every step: the window is rerun from the anchor at each move, so a per-step nudge would mean feeding readings into the run itself, which is what the estimator of step 6 is for. The prediction a correction starts from is the model's own value at the anchor, from the last move's run, never one read off at the reading times (a bad reading at the anchor must not shift it). For consistency, the engine says when a session starts which states it computes from others (a source term that sets a value, an algebraic relationship's output, a provider's set output); such a state is compared with its readings at every move and never set, and the move says so rather than failing. Every move records which states the readings reach and which the model carries alone, and the card shows both. For conservation, the per-signal choice is the guard for now: nudge or watch a state where a reset would put energy in or take it out; a node declaring itself conserving, and refusing a reset on its own, waits for a model that needs it. [tests/engine/windowCorrections.mjs](../../tests/engine/windowCorrections.mjs) checks the nudge to the bit, that a wrong model watched only drifts away from the rig (a mean jump of 1.5 K over the last ten moves, against 0.2 K reset), and a computed state measured.
5. **Initial states as tunable, and refit over the window.** **Built.** A state's initial value is a fitting target when it carries `tuning` bounds, as a parameter does; the engine's fit sets it with the parameters, so any tuning or calibration can find it, and the node editor marks it. A refit takes the latest window as a calibration (the plan made by the session, the fit by the engine's ordinary `fit`, so the same optimisers, limits and progress): time 0 is the anchor, every state starts where the last move left it, a measured state at its reading and not fitted, and the inputs are what was really done. It proposes; nothing moves until a person applies it, which answers the open question below as recommended. Applying starts the twin again from the move the refit was planned on, with the new parameters and the states found at its anchor, and runs it on to where it has got to, because a fit takes seconds and a twin moves on meanwhile; the moves already made keep their record, and the next one records the refit. The parameters can be kept in the model; the states found at an anchor stay with the twin, as they are not the model's start. Two limits: a model whose node programs keep their own state cannot be refitted yet (that state cannot be put into a document), and refitting is on request, not on the drift alarm. [tests/engine/windowRefit.mjs](../../tests/engine/windowRefit.mjs) shows one two-hour window finding the rig's capacitance, heat loss and the unmeasured room within a percent.
6. **The estimator.** **Built** ([A state estimator for the live twin](stateEstimator.md)): an ensemble Kalman filter, as a fourth correction choice per signal, which corrects the states the data does not measure and tracks tunable parameters as they change, shows each one's spread and the forecast's band, and says how honest the spread has been.
7. **Built.** **Hold the average and Follow the trend** (first and second order, fitted over the span, damped, clamped), set per input and kept with the setup, with the projection drawn dotted on the input's strip. Checked by unit tests of the projections on made-up inputs (a step, a ramp, a square wave, noise), including the clamp and that the projection starts at the last reading. Also checked by an engine test that a twin left on Hold makes the same moves as before (the existing engine tests unchanged), that nothing projected reaches a window, that the estimator's members forecast on the projection, and that the heaters at their average leave the rooms' forecasts no worse than holding them beyond a little (they were expected to be better; they are about the same, see above).
8. **Built.** **The score**, per input per choice, in the engineer's view. Checked by unit tests in which the right choice is known (a square wave, where the average must win; a ramp, where the trend must) and by the house's twin, where every heater favours the average.
9. **Built**, going by the score once there is one. **Automatic**, with what it chose and why. Checked by unit tests of each case (a step, raised and lowered again, a ramp and a staircase, noise about a level, a heater that has just switched with and without a score), by the house's twin (the heaters averaged as they cycle, then by the score), and in the room, where the house's living room heater on Automatic says what it is using. Not yet checked on the motor's operator steps and ramps.
10. **Built**, with the house run for two days in the test rather than a second demonstration. **Repeat the last day**. Checked by unit tests of the shift and the level, and by the house's second day, where the outdoor temperature and the sun favour it.
11. **Built**, a schedule; a signal not. **From a plan**. Checked by unit tests of the clock, a time zone, midnight, a weekly plan, a source with no clock, and the plan written and read, and by the house's setpoints, followed to the reading, and in the room with the sun's plan written, one written wrongly refused.
12. **Built**, as an input following a state, the house's thermostats in its model for the test. **From the model**. Checked by the house: the rooms' forecasts 0.116 K against 0.569 K held, the windows unchanged, the thermostats' course read back as on or off, and with the estimator's members, whose thermostats start where the forecast's does (inside its band at every point of the three minutes after now); a heater whose limits are narrower than its thermostat asks for held within them, and said; a kept setup following the floor slab, or the outdoor air, stopped at once with the reason. By unit tests of which states may be followed, and of the session refusing the others and an engine that cannot follow.
13. **Built**, as the inputs' uncertainty in the estimator's band. Checked by the house: the band wider with it than without (2.7 K against 1.1 K at the horizon), holding 81% of the later readings against 73%, and the windows unchanged. The band's honesty in the room ("band honest · 20% outside") judges each reading against the band from before its move's now, so the inputs' uncertainty, which widens only what lies ahead, is not in it; the band's explanation says so.
