---
type: Proposal
title: "Steering a model by hand"
description: Design for steering live parameters with gamepads and joysticks, MIDI controllers and the keyboard, every change recorded by its size so a run steered by hand repeats exactly from its record, bindings kept in the app's settings and matched by symbol, and the twin's sandbox following the controls.
tags: [proposals, live-control, devices, reproducibility, digital-twin]
status: draft
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Steering a model by hand: gamepads, MIDI controllers and the keyboard

**Status: built,** all four steps of the order of work below, with the four decisions taken. One thing differs from what was proposed: repeating a run from its record needed a small change in the engine (a command held until a time), described under [Repeating a run from its record](#repeating-a-run-from-its-record). How it is used is in [Result exploration](../resultExploration.md#steering-by-hand).

A person running a model often wants to steer it while it runs: push a motor's voltage up and down, swing a setpoint, open a valve and watch what happens. Before this, that was a slider dragged with a mouse, one at a time. A gamepad's sticks and triggers, a MIDI controller's knobs and faders, or a few keys do it with the hands, several at once, without looking away from the plots. Konjugate's main use is reproducible experiments, so whatever is done by hand must be recorded, as precisely as if it had been typed, and a run steered by hand must replay exactly. Live demonstrations are its second use, and the one this makes most visible.

## What there was to build on

- **Live parameters.** A parameter (a shared one, a relationship's or a source term's) in `live` mode has a slider with a range, `control: { minimum, maximum, step }` ([Project schema](../projectSchema.md)). Setting its value while a run goes is one call, `engineSetParameterValue`, which the slider makes. A controller makes the same call. The live range is worked out in one place, `liveRange` in [src/inputBindings.mjs](../../src/inputBindings.mjs), which the slider, a controller's mapping and the twin's sandbox all use.
- **The record.** The engine keeps every parameter change it applies during a run, with the time of the step it took effect at (`interventions` on the result), so a run's parameter changes panel lists them. A controller's changes land in the same record.
- **The twin's sandbox.** **Try something…** in the twin's control room ([The twin's control room](controlRoom.md)) runs a private copy of the twin ahead of now; what is tried there never reaches the twin and is kept as a draft scenario. Before this, an input was typed, then run ahead in a chunk.

## Decisions taken

1. **All three kinds of device together:** gamepads and joysticks, MIDI controllers, and the keyboard, behind one way of binding, so a person uses what they have.
2. **A change is recorded by its size,** not at every simulation step: a moving control is recorded when its value has moved by enough to matter since the last value recorded, and once more where it comes to rest, so the record is short and exact.
3. **Bindings live in the app's settings,** not in the project: a person's controller and how they like it set up go with them from one project to the next, and a project sent to a colleague carries no assumption about their hardware.
4. **The twin's sandbox takes controller input in the first round,** running ahead continuously while a control is moved, so a person feels the system respond.

The open questions were settled as proposed: the threshold is 1% of the live range by default, a setting a careful experiment can make finer; a binding follows a parameter's symbol across models, and can be narrowed to one model by its name; and the sandbox's pace is chosen beside it, a minute a second by default.

## Reading the devices

One small module, [src/renderer/humanInput.mjs](../../src/renderer/humanInput.mjs), reads every kind of device and reports one thing: *this control on this device now has this value*, as a number from 0 to 1 (or −1 to 1 for a centred stick), or a press and a release.

- **Gamepads and joysticks** through the browser's Gamepad API (`navigator.getGamepads()`), read once a frame while the window is in front: each stick's axes from −1 to 1, triggers and pressure-sensitive buttons from 0 to 1, other buttons pressed or not. A device is known by the id the browser gives it (its name and its USB vendor and product), and a control by its axis or button number. A pad seen for the first time, or again after it was unplugged, only sets where its controls are, so a stick that comes back off-centre does not move a value until it is moved.
- **MIDI controllers** through Web MIDI (`navigator.requestMIDIAccess()`, never with system-exclusive messages): a knob or fader's control change (0 to 127, or 0 to 16383 where a controller sends the fine half too), a pad or key's note on and off with its velocity, the pitch wheel. A device is known by its port's manufacturer and name, a control by its channel and number. Electron is given a permission handler (`installMidiPermission` in [src/main.mjs](../../src/main.mjs)) that allows MIDI to the app's own project and twin windows, their own page and not a frame inside them such as an add-on's, and nothing else; every other permission is decided as before. Chrome asks the person once. Safari has no Web MIDI, which Settings › Controllers says.
- **The keyboard** in the window that has focus, while no text field does: a key held, or pressed and released. A key is known by its physical place (`KeyW`), so a layout's letters do not move it. Only the keys a binding uses are taken from the rest of the window.

What a person cannot press reliably is filtered here: a stick's dead zone around its centre (8%), and a knob's jitter (a change of one step in 128 that comes back within 60 ms is not a change). Nothing is read until something is bound, and MIDI is asked for on the first **Bind…** or once a binding names a MIDI device. For tests, the module takes readings from simulated devices (`simulated`: a gamepad, a MIDI controller), since a test cannot plug in a gamepad.

## Binding a control to a parameter

Beside each live parameter's slider (in the project window's live controls and in the twin's sandbox), a **Bind…** button: press it, move a control or press a key (Escape stops), and that control drives the parameter. What is bound shows as a chip beside the slider ("🎮 Left stick ↕", "🎛 Control 3", "⌨ W / S"), and the slider moves with the control, so a person sees the value. The chip says when its device is not plugged in. The binding's settings open from the chip:

- **How it maps:** a stick, knob or trigger across the parameter's live range (its `minimum` to `maximum`), inverted or not, linear or with a curve (finer near the middle, for a setpoint, or near the bottom, for a throttle), and for a centred stick whether its centre is the middle of the range or the value the parameter had when the stick left it (it goes back to that value when let go).
- **A button or key:** momentary (one value while held, another when let go: a valve held open), a toggle between two values, or a step up or down by an amount (each press, and repeating while held).
- **Two keys as one control:** **Add a key for down…** on a key's settings makes it and the next key pressed one control, ramping a value up and down at a rate while held (the whole range in five seconds unless set), for someone with no gamepad.
- **Its name,** shown on the chip, and **only in this model**, which narrows it to the open model by its name.

A control moved while the person is also dragging the slider: the last to move wins, and the chip says the slider took over until the control moves again. A value never leaves the live range and is put on the parameter's steps, as the slider would have it.

The rules (what a binding is, how a reading becomes a value, when a value is sent) are in [src/inputBindings.mjs](../../src/inputBindings.mjs), with no DOM; joining them to the window's targets, the chips and a binding's settings is [src/renderer/inputSteering.mjs](../../src/renderer/inputSteering.mjs), shared by the project window and the twin's window.

## Where bindings are kept

In the app's settings (decision 3), in their own file (`inputBindings.json` in the user's data folder, [src/inputBindingsStore.mjs](../../src/inputBindingsStore.mjs); the browser's own storage in the web edition), never in a project. A binding names the device and control, how it maps, and the parameter it drives by the parameter's **symbol and name**, not its id, since ids differ from one project to the next: binding "Heater power" (`heaterPower`) once drives it in every model that has a live parameter of that symbol, which suits a person who keeps a controller set up for a family of models. Every project window and twin window is told when the bindings change, so one made in the twin's window drives in the project window too.

Bindings are listed in **Settings** ([Settings](../settings.md), ⚙ in the titlebar or ⌘,), on its **Controllers** page: every binding, with its device's state and whether the open model has its parameter ("not in this model"), to change or remove; **Bind a control** (choose the parameter, then **Bind**) for any live parameter of the open model, before a run as well as during one; and the threshold. They are kept as they are made, as everything in Settings is.

## Recording what was done

Every value a control gives is sent to the engine as the slider's is, but only when it has moved by enough to matter (decision 2): by default 1% of the parameter's live range since the value last sent, or one step, whichever is larger; and once more when the control comes to rest (no change for a quarter of a second), so the record ends at the value actually held. A button's press and release are always sent. The engine records each with the simulation time it took effect, as it records the slider's, so the run's parameter changes are its record of what the person did. The threshold is a setting (finer for an experiment where every wobble matters, coarser for a demonstration); a stick's sixty readings a second become a few dozen values a minute.

## Repeating a run from its record

**Repeat from the record**, at the foot of the parameter changes panel for a finished run, starts a new branch from the run's first checkpoint with every recorded change made again, with no controller attached, and gives the same result to the bit.

Sending the record back as schedules at the recorded times, which the proposal expected to be enough, is not: a value set by hand becomes a step at its time exactly, but a ramp or waveform from the live controls starts at the latest sample time, a little before it reaches the engine, and from the start of a run the engine would follow it from that earlier time, where the original run had followed the value before it until it arrived. So the engine was given one thing: a command can carry `apply_at` (`EngineCommand` in [protocol/engineProtocol.proto](../../protocol/engineProtocol.proto)), and a run holds it until it reaches that time, then carries it out at the first step at or after it, as if it had arrived then, in the order held commands arrived ([engine/src/simulationRunner.cpp](../../engine/src/simulationRunner.cpp)). `recordAsCommands` in [src/interventionSchedules.mjs](../../src/interventionSchedules.mjs) sends each recorded value and schedule back as it was, held until its recorded time, and the repeat is started held so every change is in before its first step. The repeat goes through the same changes at the same steps, so its own record is the same as the original's, and so are its samples, bit for bit. The engine reports `heldCommands` in its capabilities, and the button is offered only by an engine that does. A run that was continued after it stopped began again from the model's values partway through, which no command repeats, so it is not offered.

## The twin's sandbox, steered by hand

The sandbox ran ahead in chunks ("Run ahead 60 min"). With a control bound to one of its inputs (decision 4), it gains **Follow the controls**: the sandbox runs ahead continuously at a pace chosen beside it (real time, a minute, ten minutes or an hour a second; a minute by default), each input taking the value its control has as it goes, and the tiles draw the sandbox's course dotted as it grows, beside the twin's own forecast. Turning a knob bound to the house's living room heater shows, within a second or two, where the room would go. The values are sent by size of change, as above, so what was tried is the sandbox's short list of steps, kept as a draft scenario on **Back to live** as before. It runs on the sandbox's own engine, so the live twin is never touched; **Pause** holds it, and **Run ahead** stays for typing a value. A model slower than the pace falls behind and runs as fast as it can, rather than leaping ahead to catch up.

The bindings are the same ones the project window uses (the twin's inputs are shared parameters, matched by symbol, with the shared parameter's live range), and the twin's window reads the devices itself, since a gamepad is read only by the window in front.

## Safety and the edges

- A window that is not in front reads no gamepad (the browser stops it), so a control's value is held where it was. MIDI and the keyboard follow the window with focus too, so a knob turned while another application is in front does nothing. Keys held when the window loses focus are let go.
- A device unplugged mid-run holds its parameters at their last values and its chip says it is not plugged in; plugged back in, it takes over again only once a control is moved, so a stick that comes back off-centre does not jump a value.
- A parameter's value never leaves its live range, whatever the device sends.
- Nothing is read until a person binds something: no device is asked for, and the browser's MIDI permission is asked only on the first **Bind…**, or once a binding names a MIDI device.

## Demonstrations

- **The house, with a MIDI controller:** three faders on the three rooms' heaters in the sandbox, the tiles answering as they move.
- **The single joint actuator, with a gamepad:** the left stick on the supply voltage, the joint swinging as the stick moves, the run then repeated from its record to the bit.
- **The wheeled robot, with the keyboard:** W and S ramping the drive voltage, for anyone without a controller.

## Order of work, and how each is checked

1. **The device module** (gamepads, MIDI, keyboard), with simulated devices for tests, and Electron's MIDI permission handler. The rules it feeds are checked in [tests/inputBindings.test.mjs](../../tests/inputBindings.test.mjs).
2. **Binding and recording in the project window:** **Bind…** on the live controls, the chip, the mapping settings, the threshold, Settings › Controllers, and Repeat from the record. The interaction tests steer a model with a simulated stick and repeat the run from its record to the bit, and bind keys before a run in Settings; [tests/engine/handSteeredReplay.mjs](../../tests/engine/handSteeredReplay.mjs) checks the repeat against the engine for values, a ramp and a waveform sent after their start, and two values at one step, an algebraic state included.
3. **The twin's sandbox:** **Follow the controls**, with the same bindings, and its draft scenario. An interaction test binds a simulated MIDI fader to the rig's heater and follows it.
4. **The web edition:** gamepads and the keyboard in every browser, MIDI where the browser has it, said where it does not; the bindings in the browser's storage. Steering needs a live run, which only the threaded build has (it can send commands while a run goes). Repeat from the record is not offered there: it is a fork from the run's start, and the web engine keeps no checkpoints to read back, so a web result cannot be forked yet. The live twin, and so its sandbox, is a desktop feature.
