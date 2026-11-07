---
type: Proposal
title: "A state estimator for the live twin"
description: Design for step 6 of the prediction-actual window, an ensemble Kalman filter that lets the readings correct the states nobody measures, weighs the model against the sensors, and shows how sure the twin is.
tags: [proposals, digital-twin, state-estimation, real-time, engine]
status: draft
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# A state estimator for the live twin

**Status: built, steps 1 to 4: an ensemble Kalman filter, the noise read from the readings, and tunable parameters tracked with the states** Built differently from the design in three ways, each found while building. The members run one after another in the session's one engine, with the commands it already has (each goes back to its own state at the last anchor, runs to the new one and reports its state from a checkpoint there), not side by side on worker threads, so no engine change was needed and the cost is the members' runs in sequence. The model's uncertainty is added once at each move, over the stride (a random walk), not at every step. And two defaults changed: a measured state's drift is as far over one stride as its readings' noise, since a percentage of its value buries what an unmeasured state does to it when the state has a large offset (a level of 10,000); and the readings' noise is read from their second differences over the first window, which a smooth course hardly affects (a fast transient between readings still can, so it can be given). The share of readings outside the band counts each reading once, at the move whose last stride it is in, against the readings the twin expected (each member plus its sensor's noise). Step 4, parameters, showed two more things. The filter at first used only the reading at each anchor; a slowly changing parameter hardly shows in one reading (a heat loss 4 W/K wrong moves a tank's temperature about 0.1 K over a ten-minute stride, under the sensor's noise), so the analysis now uses every reading since the last anchor, each against what each member predicted at its time, read off the member's own run (an asynchronous filter), which sharpens the states too. And with a measured state left as free as its sensor, every disagreement was taken as the state's own wandering and the parameter learnt nothing, so when parameters are tracked a measured state's default drift is a tenth of that, and a parameter may wander 20% of its value an hour by default; the drifting rig's heat loss, growing from 20 to 32 W/K, is followed to 27.4 W/K by the end with an honest band, a lag a refit does not have. A parameter tracked is made live in the twin's own copy of the model, within its tuning bounds, so each member runs with its own value. Code: `src/stateEstimator.mjs` (the filter, the seeded generator, the noise and the share of a state's uncertainty a reading removes, by which a state is said to be reached), `WindowSession` (the analysis, the band and the figures) and the live twin card; tests: `tests/stateEstimator.test.mjs` (against the exact filter, repeatable, bounds, a state that is only read) and `tests/engine/windowEstimator.mjs` (the tank's unmeasured inflow found where reset leaves it wrong, the band and its honesty, repeatable). Step 6 of the [prediction-actual window](predictionActualWindow.md#order-of-work), "a proper estimator that weighs the model's uncertainty against the sensors'". Everything before it is built: at each move a measured state is reset to its reading, nudged part of the way, or only watched, and a refit over the window proposes new parameters and starting states for a person to apply.

## What the reset and the nudge cannot do

They correct only what is measured. A state nobody measures keeps whatever the model reached, even when the readings say clearly that it is wrong. In the invented lab trial ([An invented lab trial](../connectingADataSource.md#an-invented-lab-trial)) the vessel's temperature is measured and the heater's drift is not; each reset puts the temperature right and leaves the drift where it was, so the jumps keep growing in one direction and the twin never learns why. The refit can find the drift, but only by fitting the whole window again, and only when a person asks.

They also treat every reading as the truth (a reset) or as a fixed fraction of it (a nudge), whatever the sensor's noise and however sure the model is at that moment. And the twin says nothing about how sure it is: its forecast is one line.

A Kalman-type filter answers all three. It keeps, beside each state, how uncertain it is and how states move together; a reading then corrects the measured state by an amount set by the two uncertainties, and corrects every state that moves with it, measured or not, through those relationships.

## Which filter

Konjugate's models are not written for a filter. They mix equations, C++ and Python providers, FMUs, thermostats that switch and states set by other states. A filter that needs the model's derivatives (the extended Kalman filter) gets them by running the model once per state with one state moved, and goes wrong where the model has a corner, which is where labs' models have them (a thermostat, a valve at its stop).

Proposed: an **ensemble Kalman filter**. It runs the model as it is, a few dozen times side by side from slightly different states, and reads the uncertainties and their relationships off how those runs spread. It needs nothing from the model but the ability to run it, which the engine session already has. Its cost is the ensemble's size times one run of the window, which the session's speed figures show before it is turned on. The alternative worth naming is the unscented filter: a fixed set of 2n+1 runs for n states, with no randomness, better for a small model and worse past a few dozen states. Open decision 1.

## How it fits the window

The estimator is a fourth choice for each measured signal, beside reset, nudge and watch only: **estimate**. When any signal is set to estimate, the move works like this:

1. **Forecast.** Each member runs from its own state at the last anchor to the new anchor on the actual inputs, with a small random push to its states each step (the model's uncertainty, below).
2. **Analysis at the anchor.** The members' spread gives the uncertainty of every state and how each moves with each measured signal; the readings at the anchor, with their noise, give the correction. Every member is moved toward the readings by that gain, measured states and the rest alike. A state the model computes from others (an algebraic output, a set value) is never moved, as now; it follows from the states that are.
3. **Window and forecast** run from the corrected members' mean as now, so the comparison, the jumps and the refit are unchanged, and the members also run the forecast, which gives it a band.

Signals left on reset, nudge or watch keep doing that, so a person can estimate the noisy thermocouple and reset the level gauge they trust.

## What a person sets

- **Each estimated signal's noise:** a standard deviation in its unit, proposed default the scatter of its last minute of readings about a straight line, shown and editable in the card.
- **How far the model is trusted:** for each state, how much it may drift a second beyond what the model says, in its unit. Proposed default: one percent of the state's range in the window, a second. A state marked ◎ tunable (already used for refit) is the natural place for this setting too.
- **Parameters estimated as they go:** a tunable parameter can be marked to be estimated with the states, as a state that does not change by itself. This is how the heater's drift is found live. Proposed in a later step; open decision 3.
- **Ensemble size:** proposed default 32, set in the live twin card, with the speed it costs shown.

Members are kept inside each state's bounds (a level is never pushed below zero), and the random numbers have a seed kept with the session, so a replayed recording gives the same estimates every time.

## On the screen

- The correction choice per measured signal gains **Estimate**.
- Each state the readings reach shows its estimate and ± its spread; an unmeasured state the estimator is correcting is listed as reached, with "through" and the signals that reach it.
- The forecast is drawn as a band (the members' 10th to 90th percentile) around its line.
- The jumps are now the corrections the filter made, and their trend is still the health signal; the card adds the share of readings that fell outside the spread the twin expected, which should be about a fifth for the 10–90 band, and is a plain test of whether the noise settings are honest.

## Where it runs

In the engine, inside the long-lived session: the members share the compiled model and differ only in their state vectors, so one session holds them all, runs them on its worker threads, and keeps one checkpoint per member at the anchor in place of one. The analysis step is a few small matrix operations with Eigen, already used by the engine. A new session command, the members' count and seed in the session's start-up settings, and the per-signal noise and per-state drift in the move's settings; the move's answer gains each state's spread and the forecast band. The protobuf messages grow accordingly ([Live engine session](liveEngineSession.md)).

The web edition gets it with the engine; its speed there decides the ensemble size it offers.

## Tests

- **Against the exact answer.** For a linear model with Gaussian noise the Kalman filter is exact; a two-state model (a level and its unmeasured inflow) is run through the estimator with a large ensemble and compared with the closed-form filter, mean and spread, within the error expected of the ensemble's size.
- **An unmeasured state found.** The invented trial's drifting heater, estimated as a parameter, converges to the drift that was put in, where reset leaves the jumps growing.
- **Repeatable.** The same recording and seed give the same estimates to the bit.
- **Honest spread.** Over a long replay, the share of readings outside the 10–90 band is near one fifth.

## Order of work

1. The ensemble in the session, the analysis step, and the test against the exact filter.
2. Estimate as a correction choice in `WindowSession` and the host, the spread and band in the move, and the trial test.
3. The card: the choice, the noise and drift settings, the spread, the band and the honesty figure.
4. Parameters estimated with the states.

## Open decisions

1. **Ensemble or unscented.** Proposed: ensemble, for models with corners and more than a handful of states; the unscented filter could be added later as an option for small smooth models.
2. **Defaults for noise and drift.** Proposed as above, both shown where they are used.
3. **Parameters in the first version.** Proposed: a later step. Built as step 4 once the state-only filter was checked against the exact answer.
