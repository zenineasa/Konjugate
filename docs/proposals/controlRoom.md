---
type: Proposal
title: "The twin's control room"
description: Design for presenting a live twin as a control room would expect it, a short setup that names the model, the source and how the incoming signals map to the model (with suggestions and unit conversions proposed), then a window of its own with a tile for every measured signal, the health of the twin and its source at a glance, an operator view by default and an engineer's to take over.
tags: [proposals, digital-twin, user-interface, mapping, units]
status: draft
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# The twin's control room

**Status: agreed, with the four open decisions taken as recommended. Step 1, the unit catalogue, is built (`src/units.mjs`, tested in `tests/units.test.mjs`): it reads every unit the example models use, and building it settled three things. An angle is a dimension of its own, so rad/s and Hz are not taken for one another; between an angular speed and a frequency one revolution is taken as one cycle (60 rpm is 1 Hz and 2π rad/s), and an angle onto a model's plain number is taken as radians, each conversion saying so. As engineers write them, everything after a slash is below it (W/m2K is W/(m²·K)), and symbols written together are split (kgK, Nm). And units that look alike are kept apart where they differ: a torr is 1/760 of an atmosphere, a millimetre of mercury a little more; a bare C on its own is read as degrees Celsius, as instrument tags mean it, and says so.** Everything a live twin does is built ([Digital twin connections](digitalTwinConnections.md), [the comparison window](predictionActualWindow.md), [the estimator](stateEstimator.md), [the push service](pushService.md)); what is not right yet is how it is presented. Today a twin is set up and watched in one side card that was made for parameter tuning: cramped, setup and watching mixed together, and only the first measured signal is plotted, so a twin with five sensors shows one. This document designs what a person sitting in a control room expects instead: a short setup once, and then a full window of graphs for every quantity they want to evaluate.

## Who sits in front of it

Two people, often the same one at different moments.

- **An operator** watches: is the real system doing what the model says, is anything drifting, is the data coming in. They need to read the room at a glance and must not be able to break the twin with a stray click. The operator view is the default.
- **An engineer** takes over when something is off: refits, tracks a parameter, sets a tunable parameter to a new value, or goes back to the model and changes it. The engineer's controls are one switch away, not a login.

## One twin, one window, three steps to it

A twin has its own window, one twin per window. A twin compares a model with a running system, where several controllable quantities come in as inputs to the simulation and several sensors' outputs are compared with the model's states; all of them belong to the one twin. The model is always the open project: the twin's window belongs to a project window, and the model can be read, and changed, there beside it.

The Live twin button in the project window opens the twin's window: at its setup the first time, at its control room once it is set up. The setup is three steps, saved with the project, and opened again only to change something.

1. **Model.** The open project, with what it offers a twin: its states (with units and descriptions) to compare with sensors, and its shared parameters to drive with inputs. A model with nothing to compare against says so here, with what to add.
2. **Source.** The four ways in (a data log, an MQTT broker, an OPC UA server, readings a script sends), and Konjugate connects and discovers what comes in: the file's columns, the topics a broker carries in a few seconds, the server's tags with their units and ranges, the signals the push service's keys may send. Each incoming signal is listed with its latest value and its unit, when the source gives one.
3. **Mapping.** Each incoming signal against the model, in one table:
   - its **role**: an input (driving a shared parameter), measured (compared with a state), or not used;
   - **the model quantity** it maps to, with **a suggestion**, its confidence and its reason ("*TT101.PV* → *Water tank · Temperature*, 92%: T and PV in the tag, °C is a temperature, its range fits the tank's");
   - **the unit conversion**, proposed for the person to confirm (below);
   - **a preview** for each mapped pair: a few minutes of the signal against the model's run on the inputs mapped so far, as a sparkline, so a wrong sensor or a wrong unit is seen before the twin starts;
   - for a large source (a server with two hundred tags), **accept every confident suggestion** at once, and a search box for the rest.

Then **Open the control room**.

## Finding the matches: rules and memory

The names a source uses rarely match a model's (`TT101.PV`, `Tank1_Temp`, `ns=2;s=Line3/Heater/Pwr` against "Water tank · Temperature"). Suggestions come from evidence that can be explained, cheapest first, and the person confirms.

1. **The name, normalised:** case, separators, camelCase, and the common decorations (`.PV`, `_meas`, `Value`, a path's last part).
2. **Abbreviations and synonyms:** temp, T and TT for temperature, pwr and P for power, lvl and LT for level, FT and Q for flow, PT for pressure, and the ISA letter codes of instrument tags (the first letter the quantity, TT a temperature transmitter, TC a controller). A small dictionary, built in, and extended by the person or a domain package.
3. **The unit's dimension:** a temperature can map to a temperature in any of its units, never to a pressure; a source's unit, and an OPC UA tag's engineering unit and range, are evidence on their own.
4. **Plausible values:** the signal's range against what the state takes (its initial value, its tuning bounds, a quick run of the model).
5. **Behaviour:** after a minute of data, a signal that steps (what an operator does) is likely an input, a smooth one a measurement; and optionally a candidate pair's correlation over the preview, the strongest evidence of all.
6. **Memory:** every match confirmed is remembered for that source, by its own name for the signal (`TT101.PV` → the tank's temperature), and offered first the next time, and to the next rig whose tags follow the same scheme. Kept in the app's own folder, as well as in the project.

Semantic matching (similarity of the names, paths and descriptions as meanings, not strings) is left for later and would run locally only: tag names can be confidential plant information, and a lab may be offline. Rules and memory may well be enough; it is built only if they are not.

## Units, converted and proposed

Every mapping carries a conversion, proposed when the units differ and confirmed by the person: °C and °F to K, kPa, bar and psi to Pa, L/min and gpm to m³/s, kW and hp to W, % to a fraction, rpm to rad/s, mA to A, and the compound units models use (W/K, J/(kg·K), m³/h). A conversion is a scale and an offset, as reading another logger's file already uses (`src/loggerCsv.mjs`), so nothing downstream changes. A raw transmitter signal (a 4–20 mA loop, counts from an ADC) is scaled through the range the source gives for it (an OPC UA tag's instrument and engineering ranges) or the person enters. Two dimensions that cannot match (a pressure against a temperature) are not proposed, and a mapping made by hand across them is flagged.

This needs a catalogue of units that parses what people write (`degC`, `°C`, `deg C`, `W/(m·K)`, `m3/h`) into dimensions and factors. Whether to write a small one or take an established library is open decision 1. Model units are free text today ([project schema](../projectSchema.md)), so the catalogue also lets the model editor say when a unit is not one it knows.

## The control room

The twin's window, maximized in the workspace, or moved to a second screen.

- **Health, along the top:** the twin (live, how far behind the data, how many times faster than real time it runs), the source (connected, readings a second, the age of the latest reading, reconnections), the drift warning, and the model's name and when it last changed.
- **A tile for every measured signal**, in a grid that fills the window by itself and can be rearranged, resized and pinned: the measured readings against the model, the window shaded, the forecast with its band; the latest value, the residual, the tolerance; the jumps as a sparkline; and a border that reads across the room: green in step, amber leaning, red past the warning.
- **The inputs** as a timeline under the tiles: what was done, when, as the twin received it.
- **What the twin infers:** the states no sensor measures and the parameters it tracks, each with its value, spread and trend ("heat loss 27 W/K, rising").
- **Events:** warnings, reconnections, readings out of time order, a source's sampling limit, refits applied, changes to the model; one list, timed, kept with the twin's record.
- **Time:** following now, and scrubbed back through the record to see what happened.

The layout is saved with the project, so the next shift opens the same room.

## The engineer's view, and changing the model

The **Engineer** switch in the control room shows what the operator view keeps out of the way: refit on the latest window, the estimator's settings, which parameters it tracks, and the tunable parameters themselves, as sliders within their bounds.

Every change, small or large, is a change to the model, applied to the twin from its latest move, so there is one model and one way changes reach the twin:

- **From the control room:** moving a tunable parameter's slider, or accepting a refit, changes that value in the model, and the twin starts again from its latest move with it (as applying a refit already does).
- **From the project window:** an engineer changes anything there (an equation, a relationship, a new state), and the control room says the model has changed, with **Apply to the twin**. Applied, the twin starts again from its latest move, carrying the states that still exist across, with the new ones at their initial values, and checks the mapping still holds: a mapped state that was removed is said, not dropped in silence. When the states changed too much to carry across, the recent window is run again from the recording instead.
- **Every change is an event** in the twin's record, saying what changed, from what to what, and when, so a twin's history can be followed and repeated.

## What moves where

The setup and the control room replace the live twin's part of the tuning card. Replaying a log once and calibrating on it stay in the tuning card, which goes back to being about tuning; the twin's setup offers both for its own source. The sandbox (detach and try), scenarios, the estimator, refit and the push service's Connections panel are reached from the control room, the first two in the operator view (trying something does not change the twin), the rest in the engineer's.

## Demonstrations

- The simulated rig as now, one click from the Live twin button, opening straight into its control room.
- **A rig named as a plant would name it:** the simulated rig's recording with plant-style tag names and units (`TT101.PV` in °C, `JI101.PV` for the heater's power in kW), so the mapping step's suggestions and proposed conversions can be seen working on a source whose names match nothing in the model.
- Two screens: the project window on one, the control room on the other, an equation changed in the model and applied to the running twin.

## Order of work

1. **The unit catalogue**, with conversions proposed and dimensions checked, and its tests.
2. **The setup in the twin's own window:** model, source with discovery, and the mapping table with rule-based suggestions, memory, conversions and previews; the plant-named rig demonstration.
3. **The control room, operator view:** health, a tile for every measured signal, inputs, inferred quantities, events.
4. **The engineer's view and changes to the model** applied from the latest move, from the control room and from the project window, recorded as events.
5. **The layout** arranged, pinned, saved, on a second screen, and time scrubbed back.
6. **Semantic matching, locally**, only if rules and memory fall short.

## Decisions

Taken as recommended when the design was agreed.

1. **The unit catalogue:** a small one written for Konjugate (a few hundred units and the compound forms models use, fully under our control and easy to check), or an established library. Proposed: written here, with its tests, since the units of engineering signals are a bounded set and a library would bring more than is needed.
2. **What the operator view may do:** proposed, watch, scrub through time and detach to try something (which never changes the twin); everything that changes the twin is the engineer's.
3. **Where remembered matches live:** proposed, the app's own folder, shared across projects, as well as the project's own mapping.
4. **A model change that cannot be carried across** (states removed that were mapped): proposed, say so and refuse to apply until the mapping is fixed in the setup, rather than apply part of it.
