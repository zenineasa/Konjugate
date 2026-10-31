---
type: Proposal
title: Parameter tuning with a custom objective, and feedback while it runs
description: Design for extending Parameter tuning beyond fitting to a CSV of measurements, to minimising or maximising an objective the user writes in terms of states and parameters, and for showing progress, an estimate and a way to stop and keep the best result while a tuning runs.
tags: [proposals, tuning, optimisation, ux]
status: draft
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Parameter tuning with a custom objective, and feedback while it runs

**Status: draft.** Written down before any code, like [The guided tour](guidedTour.md), so the interface and the engine changes can be reviewed first. The decisions at the end were settled as recommended.

## The decision this rests on

Parameter tuning today answers one question: "which parameter values make my model reproduce this measured data?" People also ask the other kind of question: "which values make my model do the best it can at something?" Keep a temperature close to a target while spending the least energy, maximise the charge left at the end of a run, minimise the settling time of a controller. Both are the same task for the engine: change the tunable parameters, run the model, score the result, repeat. They differ in how the score is written, so they should be one feature with one card and one place to see progress, not two. Nothing about how parameters are marked tunable, bounded or applied changes.

The second problem is that a tuning can take minutes or hours (every trial is a full simulation) and the card says only "there's no progress detail yet". A person cannot tell a slow fit from a stuck one, cannot see whether it is getting anywhere, and the only way to stop is Cancel, which throws away everything found so far. That is fixed first, for both kinds of tuning, because it needs no new idea and helps everyone.

## What exists today

The engine's `fit` command runs the whole optimisation in one process: an optimiser backend (the NLopt ones, chosen by id) proposes parameter values within the bounds each tunable parameter carries (`tuning: { minimum, maximum }`, see [the project schema](../projectSchema.md)), each trial runs a complete simulation into a scratch file, and the loss is the weighted sum of squared differences between the CSV columns mapped to states and the simulated states, paired row by row. The optimiser already reports the iteration, the loss and the parameter values after every trial; they are collected and returned in the final report, and nothing is shown until it ends. The card is a column of sections that appear in turn: choose a CSV, column mapping, tunable parameters and optimiser, progress (a sentence), review.

## One card, five steps

The card, renamed from "Digital twin tuning" to **Parameter tuning**, becomes a short sequence whose sections appear as they become relevant, as today:

1. **Goal.** Two choices, side by side: **Match measured data** (the current flow, unchanged, starting with choosing a CSV) and **Optimise an objective**. Everything after this step is shared.
2. **What to score.**
   - *Match measured data:* the column mapping as today, and a line saying what will be minimised ("the weighted squared error between each mapped column and its state").
   - *Optimise an objective:* the objective editor (below) and a **Minimise / Maximise** switch.
3. **Parameters.** Every numeric parameter in the model in one table with a "Tune" checkbox, its minimum and maximum, and its current value as the starting point. Today a parameter has to be marked tunable in its relationship's or source term's own editor first, and the mapping and parameter sections are read-only here; the table edits the same `tuning` field, so there is still one place the truth lives.
4. **Optimiser and limits.** A sensible default picked from the number of parameters (and said in words: "Global search, because there are 4 parameters"), with the backend and its settings under **Advanced**. Limits are **trials** and **time** ("stop after 10 minutes"), and the default is a small number of trials, so a first tuning cannot run away.
5. **Run, then review.** The progress panel (below), then the review: parameters before and after, the objective before and after, and a comparison plot.

## Writing an objective

The objective is an expression, written in the **same visual equation editor the edge builder uses**, so there is nothing new to learn and it validates the same way. Beside the editor are reference chips in three groups:

- **States:** each state of each node, as in an edge's references, standing for that state's value at one instant.
- **Parameters:** every parameter, standing for its value in the trial.
- **Measured data:** each column of an imported CSV, as `measured:<column>`, when one has been imported.

A state or measured column only has a meaning over a whole run, so the editor adds **summary buttons** that wrap what is selected: `final(…)` (the value at the end), `max(…)`, `min(…)`, `mean(…)`, and `integral(…)` (the expression summed over time, in the units of the expression times seconds). The expression inside a summary may combine states, parameters and measured columns; the result outside it is a plain number made of summaries and parameters. Examples that need nothing else:

| Goal | Objective | Switch |
| --- | --- | --- |
| Hold the block near 320 K, cheaply | `integral((block − 320)²) + 0.1·k²` | Minimise |
| Most charge left | `final(charge)` | Maximise |
| Never overshoot | `max(temperature)` | Minimise |
| Fit data and keep k small | `integral((block − measured:block)²) + 0.01·k²` | Minimise |

The editor says what the expression will mean in a sentence under it ("sum over the run of the squared difference between Block's temperature and 320 K, plus 0.1 × k²") and refuses an expression that is not a number (a state outside a summary, an unknown symbol), by the same diagnostics line an edge uses.

**"Match measured data" is a preset of this,** not a separate engine path in the interface: choosing it writes the squared-error objective for the mapped columns, and **Edit as expression** opens it in the editor, where weights, relative error, or ignoring the first seconds (`integral` over a part of the run) can be written directly. Today's CSV flow keeps working exactly as it does; the preset is only what the card writes for you.

**Maximise** is minimising the negative inside the engine. Everything a person sees (the plot, the best value, the review) shows the real value, rising when maximising; the negation is never visible.

## Feedback while it runs

The progress panel replaces the one-sentence section and is the same for both goals.

**Before the first real trial,** one baseline simulation is timed and shown: "One simulation takes 0.8 s, so 200 trials is about 2 min 40 s." That baseline is also the starting objective value everything is compared with. If the estimate is long the person can change the limits before it starts, which is the only moment the estimate is useful.

**While it runs:**
- **A convergence plot** of the objective against trial number: a dot per trial, a line for the best so far, and a log-scale toggle, because objectives often span orders of magnitude. It redraws when a new best is found and at most once a second otherwise.
- **Numbers beside it:** trials done, elapsed time, trials per second, the best value and how far it is from the starting value, and the best parameters so far.
- **Progress** as a bar and an ETA only when a trial or time limit is set; otherwise just the rate. An ETA computed for something with no known end would be a guess.
- **Plain warnings:** "No improvement in the last 50 trials" with a suggestion to stop, and "3 trials failed: the model was unstable with those values". A failed trial (a simulation that diverges or errors) scores as the worst possible value and the search goes on, instead of ending the whole tuning.
- **Updates are driven by time and by new bests, not by a fixed interval.** Trials range from milliseconds to many minutes, so any fixed interval (every 30 seconds, every 10 trials) would be too slow for some models and a flicker for others.

**Controls:**
- **Stop and use best so far** ends the search and goes to the review with the best found. This replaces Cancel as the main way out; **Discard** remains for throwing it all away.
- **Apply best so far** while it is still running, for someone who sees a good enough value early.
- **The card can be closed while it runs.** A chip in the toolbar status area ("Tuning · trial 142 · best 0.013") reopens it, and a system notification says when it has finished if the window is not in front. The model is not locked, since the engine works on a copy, but **Apply** checks the model has not changed since the tuning started and says so if it has, because parameter values found for a different model would be wrong.

**The review** shows the parameters before and after, the objective before and after ("0.84 → 0.52, 38% lower"), the optimiser's random seed (stochastic backends give a different answer each time, so it is recorded to reproduce one), and, for fitting, the existing measured-versus-simulated plot. For an objective with no data, it plots the states the objective mentions with the starting and the tuned parameters, so the change is visible and not only a number.

## Saved with the project

The setup (the goal, the objective expression and direction, the mapping, the limits, the optimiser) is saved in the project as an optional top-level `tuningSetup`, so a tuning can be reopened and run again after the model changes, instead of being rebuilt each time. The bounds stay on the parameters, where they are today. The imported CSV itself is not stored unless the person chooses to embed it, as large data does not belong in the model by default; the setup remembers the file name and the card asks for it again when it is needed.

## What changes in the engine

- **Progress streaming.** `fit` moves from one-shot to the streamed events a run already uses: a framed protobuf `FittingProgress` event per trial (the same `iteration`, `loss` and `parameter_values` the optimiser already reports), a final `FittingReport` event, and a stop command on the existing control stream that ends the search and returns the best found. `fitWithEngine` becomes a streaming call like `startEngineRun`.
- **The objective.** `fit` takes an objective: the MathJSON of the expression, the direction, and the list of summaries it uses. Each trial's samples are reduced to those summaries (the existing run already produces the samples) and the expression is evaluated with the same evaluator equations use. The fitting loss is the preset objective evaluated the same way, with its current residual loop kept as the reference the tests compare it against.
- **Summaries are computed from the recorded samples,** so their precision is the run's output interval; `integral` uses the trapezoid rule over it. A later refinement is running accumulators inside the step for exact values, which changes nothing for the person writing the objective.
- **Failed trials** are caught per trial and scored as the worst value, with a count in the progress events.
- **Time limit and seed** join the trial limit and backend as `fit` options, and the seed is in the report.

## Decisions (settled)

1. **Objective as an expression** in the equation editor, with summary buttons, not a "cost node" the person builds in the canvas. (Building the accumulator by hand still works today for anyone who prefers it.)
2. **Progress updates on time and on new bests,** at most once a second, not on a fixed 30-second interval.
3. **The setup is saved in the project** as `tuningSetup`.
4. **Stop keeps the best.** Cancel becomes Discard, and "Stop and use best so far" is the main button while running.

## Order of work

1. **Progress and control for the tuning that exists:** streamed progress events, the baseline estimate, the convergence plot, "Stop and use best so far", failed trials scored as the worst value, and the toolbar chip. Both kinds of tuning use it, and it can ship by itself.
2. **The objective:** summaries and the expression in the engine, the `fit` option, and the objective editor with the Minimise / Maximise switch, with the fitting preset written through it.
3. **The unified card:** the Goal choice, reference data in the editor, and the single parameter table with inline bounds.
4. **Saved setup and the review's before/after,** then **constraints** (for example "max temperature ≤ 350 K", entered as a list beside the objective and applied as penalties) as a follow-up.

Each stage leaves tuning working, and the first needs no new concept for the person using it.
