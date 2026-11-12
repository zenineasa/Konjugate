---
type: Proposal
title: Tutorials
description: Design for a searchable list of short, checked, in-app tutorials, opened from a Tutorials button just above Help & feedback, most of which start from an example Konjugate already ships, built by turning the guided tour into one tutorial among many.
tags: [proposals, onboarding, tutorials, examples, tour]
status: stable
implementation: complete
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Tutorials

**Status: built**, in the desktop and web editions, with the first wave of three tutorials. Written down before any code, like [A guided first-model tour](guidedTour.md), so the entry point, the shape of a tutorial and the first few could be reviewed first; the decisions at the end were settled as recommended, and what changed while building it is said in place.

## The decision this rests on

The guided tour takes a new person from an empty canvas to a first run, and it works because it checks what the person did instead of trusting that they pressed Next. Everything after that first run was unguided: parameter tuning, controllers, data sources, the live twin, causal inference and the rest are explained in the docs and the example guides, but nothing in the app walked a person through them and confirmed they got there.

Tutorials are that tour, made general: many short, checked walkthroughs, each about one feature, found in one searchable list. Most do not start from an empty canvas. They start from an example Konjugate already ships, because a person learning parameter tuning should be tuning a model, not first building one, and because a shipped example is already reviewed, documented and tested.

Three rules shape everything below. A tutorial is **found from one plainly named button**, always in the same place. A tutorial **teaches one feature in a few minutes** and leaves the person with a model they can keep. And a tutorial is **played by an interaction test**, so a change to the interface that breaks one fails the build, not a user.

## Where people find them

A **Tutorials** button on the left rail, directly above Help & feedback, with its own icon and label, in both editions; on a phone, where the rail is hidden, the menu lists Tutorials and Help & feedback (which it had been missing). Help & feedback stays as it is: it is for reporting a problem, and folding tutorials into it would bury them in a dialog people open for something else.

The button opens a dialog with a search field at the top, focused, and the list below it.

- **Each entry** shows the title, one sentence on what the person will be able to do afterwards, roughly how many minutes it takes, and where it starts: "From an empty canvas" or "Starts from the Tank Calibration example". A tutorial the person has finished shows a "Done" tick; finishing one never hides or moves it.
- **With nothing typed,** the list is grouped: *Start here* (the first-model tour) first, then one group per area (Modelling, Results, Tuning and calibration, Control, Data and twins), in a fixed order, leaving out areas with no tutorial yet.
- **Searching** matches, locally and as the person types, against each tutorial's title, sentence, tags and the name of the example it starts from; every word typed must match, and a match in the title ranks above one in the tags, which ranks above one elsewhere. So "PID", "calibrate", "measured data" and "Tank Calibration" all find the right tutorial. Enter does nothing (it would otherwise submit the dialog and close it). Nothing is sent anywhere.
- **A tutorial only one edition can play** is shown in the other edition too, with "In the desktop app" in place of its Start button, so the list is the same everywhere. All three tutorials so far play in both.

The first-model tour is the first entry of this list. The Welcome window's "Take the 3-minute tour" card and the first-launch start stay exactly as they were; they are two more ways into one tutorial.

## What a tutorial is

A tutorial is a module under `src/tutorials/`, shared by both editions and by the main process, and `src/tutorials/index.mjs` lists them, with the search and the grouping. The tour's steps moved there as `firstModel.mjs`; the logic every tutorial shares (which step a person is on, whether an earlier one has been undone, how the card is labelled, and helpers for asking a project about a relationship's parameter) is in `steps.mjs`. Each tutorial module exports one frozen object:

| Field | What it holds |
| --- | --- |
| `id` | A stable name, used for the Done tick and in tests |
| `title`, `summary`, `minutes`, `area`, `tags` | What the list shows and searches |
| `start` | `{ from: 'empty', fileName }` or `{ from: 'example', example: 'tankCalibration.kjt' }` (an example by its file name, as the Examples dialog names it) |
| `data` | Optional: files beside the examples the tutorial reads, such as measurements |
| `editions` | `['desktop', 'web']`, or one of them |
| `steps` | The steps, in the shape the tour's steps already had: `id`, `title`, `text`, `target`, `done`, an optional `fill` (with an optional `fillLabel` for its button, and whatever values the fill needs, such as `runSeconds`), and `advance: 'next'` for the steps with nothing to do |

The first step is always `welcome` and the last `finish`; both wait for Next and neither is numbered (the tour's closing card is still its "Bonus step"). The renderer's controller in `src/renderer/tour.mjs` changed only in being handed a tutorial to play instead of importing the one step list; card placement, the highlight ring, the fill button, the offer to go back to a step that no longer holds, and the card moving into an open dialog all carry over. "Skip tour" became "Leave tutorial", and leaving says the tutorial can be taken again from Tutorials.

## Starting from an example

Pressing Start on a tutorial that starts from an example loads that example the way the Examples dialog does: the usual question if the open project has unsaved changes, then the example as an unsaved copy, so the shipped file is never touched and the person keeps whatever they make. Then the tutorial's first card appears. If that example is already open and untouched (it was just opened, and the person pressed "Take the tutorial" in its guide), it starts from it as it is, without asking about discarding a copy nobody has changed.

- **The example guide does not open by itself** while a tutorial is running, so the screen has one thing telling the person what to do. The Example guide button still appears in the toolbar, as after any example loads, and each tutorial's first card mentions it.
- **The other direction too:** on the desktop, an example with a tutorial shows a card at the top of its guide, "Take the tutorial", which starts it in the guide's project window and closes the guide. The web edition opens an example's guide as its raw `.md` file, so there is no page to put that card on; its Tutorials list is the way in there.
- **Checks are about the change, not the model.** The tour's checks could ask "do two nodes exist", because its model starts empty and only grows. An example starts full, so a check asks about what the step was for, comparing the model with how the tutorial found it: every check is handed `done({ document, start, ui })`, and `edgeParameterChanged(document, start, relationship, symbol)` says whether a relationship's parameter (or the shared parameter it links to) differs. The rule from the tour still holds: every check, once true, stays true unless the person undoes what the step asked for, which is what lets the controller notice and offer to go back.
- **The facts only the interface knows** grew with the new tutorials: whether Parameter tuning is open, has measurements and has a fit; which relationship's editor is open; whether the close-results question is showing; which nodes' plots have been on screen, and which of those since the latest run; and the model the latest finished run was started from (`runModel`), which is kept when the results are closed, so "ran it again with the new gain" survives closing the results.
- **The model is locked while results are on screen,** which the draft had not allowed for: a tutorial that changes the model after a run needs a step that closes the results first. The controller tutorial has one ("Back to editing"), which first has the person close the node's editor left open from the step before, since it covers the end of the timeline where "Close and edit" is; the ring points at the editor's × while it is open, then at "Close and edit". A "you have run it" check asks for a finished run, not a result on screen, so closing the results does not undo it.
- **When an example changes,** its tutorial's tests fail until the tutorial is updated with it: the unit tests read the shipped example and check the names, ids and starting values the tutorial's cards and fills rely on. The example and its tutorial are one piece of content in two files.

## Skipping a step

Every step with something to do has a "Skip this step" link beside "Leave tutorial". A tutorial walks through the whole of a task, the tedious parts included (downloading a file and choosing it, setting up a run), because that is what a person will have to do with their own model; skipping is for the person who already knows a step, or is stuck on one. A skip does not just move the card on: it does the step, through the page's own fields and buttons as the person would (creates the node, runs the model, loads the measurements, closes the results), so the steps after it find what they expect. Each step names its skip (`skip`, with whatever values it needs, such as `runSeconds` or the node to plot), the renderer supplies what each one does, and a unit test fails if a step that asks for something has no skip, or names one the renderer does not have. A skipped step is not reported as undone afterwards, since it was not the person's to redo. The first-model tour keeps its "Fill this in for me" buttons, which type a step's values and leave the person to press the builder's own button; the newer tutorials have the skip alone.

## Data a tutorial brings

The calibration tutorial needs measurements, and a person following it has no file of their own. Choosing a CSV file in Parameter tuning is part of what the tutorial teaches, so the card does not load the measurements for them. Its text has a link, "Download the measurements (tankCalibrationMeasured.csv)", which downloads the copy that ships beside the example (`examples/tankCalibrationMeasured.csv`) to the Downloads folder, and the ring stays on "Choose CSV file", where they then pick it as they would their own data. On the desktop the file is saved straight to the Downloads folder, as a browser saves a download, under a new name ("… (1).csv") if one is already taken, and the card says where it went; only names some tutorial lists in its `data` are served, and in the interaction tests the Downloads folder is the test's own. In the web edition the browser downloads it, as it would any file. The step is done when the measurements are in the card, not when the file is downloaded; "Skip this step" loads them directly. The card also says what the file holds (a time column in seconds and a tankTemperature column) and that columns are matched to states by name, which is what a person needs to know when they come back with their own data.

## Remembering what was done

Only one fact is kept: which tutorials a person has finished, for the ticks. On the desktop it is a `tutorialsCompleted` list in `welcomeState.json`, beside the tour's `tourOffered` and `tourCompleted`; finishing the first-model tutorial also sets `tourCompleted`, and a tour finished before tutorials existed counts as `firstModel` finished. The main process accepts only ids of shipped tutorials. In the web edition it is the same list in the browser's local storage, or, where storage is blocked, only until the page closes. Leaving a tutorial part-way records nothing, and nothing about tutorials is sent anywhere.

## How it is kept from rotting

- **An interaction test per tutorial** plays it the whole way in the real interface, in both editions' suites, using the fill buttons where a step has one: the first-model tour's existing test, the calibration tutorial (the fit must find the values the measurements were made with, within 5 %), and the controller tutorial (including that the card never covers the relationship editor). Another skips every tutorial from its first step to its end, in both editions, and checks that the model is what the tutorial builds. Two more test the list (grouping, search, Enter, starting a tutorial without opening the guide, leaving) and, on the desktop, the guide's "Take the tutorial" card.
- **Unit tests over the whole list** (`tests/tutorials.test.mjs`) check that ids are unique; that every tutorial has a title, a sentence, a known area, a welcome and a closing card and at least one step to do; that every fixed target's first id is in `src/renderer/index.html`; that every fill a step names is supplied by the renderer; that every starting example is shipped and in `examples/manifest.json`, and named in the list as the Examples dialog names it; that every data file is shipped; the search and grouping; and each new tutorial's checks played over a sequence of situations, including the ones that must not count (applying only one fitted value, a plot from before the second run).
- **The wording lives with the steps,** one file per tutorial.

## Which tutorials, and which came first

A tutorial earns its place when the feature is one people would not find, or would not get working, on their own. The first wave is three:

| Tutorial | Starts from | The person… |
| --- | --- | --- |
| Build and run your first model | An empty canvas | Does the existing tour, unchanged |
| Calibrate a model against measured data | *Tank Calibration* | Opens Parameter tuning, downloads the example's measurements and chooses them with "Choose CSV file", runs the fit, applies the fitted values (close to 209,000 J/K and 20 W/K), runs the calibrated model for the eight hours and plots the tank's temperature |
| Tune a controller | *Position Controlled Joint* | Runs it for 10 s and plots the joint's angle, closes the results, opens the controller's relationship, raises its gain from 5 to 10, runs it again and compares |

The controller tutorial's numbers come from running the example: with the shipped gain of 5 the angle reaches 95 % of its 1.2 rad target after about 5.7 s without overshoot; with 10 it gets there in about 1.3 s, overshoots to about 1.28 rad and has settled by about 7 s; at 15 it overshoots to about 1.58 rad and takes most of 20 s to settle; at 20 the loop is unstable. The closing card suggests trying 15 and 20, and raising the rate gain.

Candidates for the second wave, once the first has been used for a while: a relationship that acts both ways (*Thermal Equilibrium*), reading and comparing results across runs (*Two Room Building*), and connecting a recorded data source (the *Simulated Tank Rig* under `examples/dataSources/`, which first needs to be loadable the way the examples in the manifest are).

## Later, not now

- **"Show me how" links where a feature lives,** such as on Parameter tuning's empty state, opening the list already searched for that feature. Worth adding once there are enough tutorials for a feature to have one; until then the Tutorials button is the single place.
- **Tutorials shipped by packages.** A domain package could bring tutorials for its own components, alongside the examples it can already ship. That needs checks written as data the app evaluates rather than as functions, since package code does not run in the renderer. It waits until a package actually wants one.
- **The tutorial card in the web edition's example guide,** once the web edition renders guides as pages.

## Decisions (settled)

1. **The button's name:** "Tutorials".
2. **The example guide while a tutorial runs:** kept closed, with its toolbar button visible.
3. **The first wave:** the three above.
4. **Finished tutorials in the list:** kept in place, with a tick.

## Order of work

1. **The tour becomes a tutorial:** its steps moved to `src/tutorials/`, the controller handed a tutorial, the list-wide unit tests added. The tour's interaction test passed unchanged.
2. **The Tutorials button and the searchable list,** in both editions, with the Done ticks and the phone menu entries.
3. **Starting from an example:** loading through `loadExample` without the guide, the starting model handed to checks, the guide's card back to its tutorial, and a tutorial's data served by name.
4. **The calibration and controller tutorials,** each with its interaction test.

All four stages are built.
