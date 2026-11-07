<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Steering a model by hand: gamepads, MIDI controllers and the keyboard

**Status: proposed, with four decisions taken (below).** The last of the four items agreed on 23 October 2026 (a description on nodes and relationships, the PID blocks and the waveform modes are built). Nothing of it is built yet.

A person running a model often wants to steer it while it runs: push a motor's voltage up and down, swing a setpoint, open a valve and watch what happens. Today that is a slider dragged with a mouse, one at a time. A gamepad's sticks and triggers, a MIDI controller's knobs and faders, or a few keys do it with the hands, several at once, without looking away from the plots. Konjugate's main use is reproducible experiments, so whatever is done by hand must be recorded, as precisely as if it had been typed, and a run steered by hand must replay exactly. Live demonstrations are its second use, and the one this makes most visible.

## What is there to build on

- **Live parameters.** A parameter (a shared one, a relationship's or a source term's) in `live` mode has a slider with a range, `control: { minimum, maximum, step }` ([Project schema](../projectSchema.md)). Setting its value while a run goes is one call, `engineSetParameterValue`, which the slider already makes. A controller would make the same call, and nothing in the engine changes.
- **The record.** The engine keeps every parameter change it applies during a run, with its time (`interventions` on the result), so a run's parameter changes panel lists them and a scenario fork can replay them ([src/interventionSchedules.mjs](../../src/interventionSchedules.mjs) turns them into the schedule that gives the same value at every time). A controller's changes land in the same record, so a run steered by hand is replayed by the machinery that exists.
- **The twin's sandbox.** **Try something…** in the twin's control room ([The twin's control room](controlRoom.md)) runs a private copy of the twin ahead of now; what is tried there never reaches the twin and is kept as a draft scenario. Today an input is typed, then run ahead in a chunk.

## Decisions taken

1. **All three kinds of device together:** gamepads and joysticks, MIDI controllers, and the keyboard, behind one way of binding, so a person uses what they have.
2. **A change is recorded by its size,** not at every simulation step: a moving control is recorded when its value has moved by enough to matter since the last value recorded, and once more where it comes to rest, so the record is short and exact.
3. **Bindings live in the app's settings,** not in the project: a person's controller and how they like it set up go with them from one project to the next, and a project sent to a colleague carries no assumption about their hardware.
4. **The twin's sandbox takes controller input in the first round,** running ahead continuously while a control is moved, so a person feels the system respond.

## Reading the devices

One small module, `src/renderer/humanInput.mjs`, reads every kind of device and reports one thing: *this control on this device now has this value*, as a number from 0 to 1 (or −1 to 1 for a centred stick), or a press and a release.

- **Gamepads and joysticks** through the browser's Gamepad API (`navigator.getGamepads()`), read once a frame while the window is in front: each stick's axes from −1 to 1, triggers and pressure-sensitive buttons from 0 to 1, other buttons pressed or not. A device is known by the id the browser gives it (its name and its USB vendor and product), and a control by its axis or button number. Works in Electron and in Chrome; Safari reads gamepads too.
- **MIDI controllers** through Web MIDI (`navigator.requestMIDIAccess()`): a knob or fader's control change (0 to 127, or 0 to 16383 where a controller sends the fine half too), a pad or key's note on and off with its velocity, the pitch wheel. A device is known by its port's name and manufacturer, a control by its channel and number. Electron is given a permission handler that allows MIDI to the app's own windows (and nothing else); Chrome asks the person once. Safari has no Web MIDI, which the web edition says where the choice would be.
- **The keyboard** in the window that has focus, while no text field does: a key held, or pressed and released. A key is known by its physical place (`KeyW`), so a layout's letters do not move it.

What a person cannot press reliably is filtered here: a stick's dead zone around its centre (8% by default), and a jittering knob's last bit (a change of one step in 128 that comes back at once is not a change).

## Binding a control to a parameter

Beside each live parameter's slider (in the project window's live controls and in the twin's sandbox), a small **Bind…** button: press it, move a control or press a key, and that control drives the parameter. What is bound shows as a chip beside the slider ("🎮 Left stick ↕" or "🎛 Knob 3"), and the slider moves with the control, so a person sees the value. The binding's own settings open from the chip:

- **How it maps:** a stick or knob across the parameter's live range (its `minimum` to `maximum`), inverted or not, linear or with a curve (finer near the middle, for a setpoint, or near the bottom, for a throttle), and for a centred stick whether its centre is the middle of the range or the value the parameter had.
- **A button or key:** momentary (one value while held, another when let go: a valve held open), a toggle, or a step up or down by an amount (each press, or repeating while held: a setpoint nudged by half a degree).
- **Two keys as one control:** W and S, or the arrows, ramping a value up and down at a rate while held, for someone with no gamepad.

A control moved while the person is also dragging the slider: the last to move wins, and the chip says the slider took over until the control moves again.

## Where bindings are kept

In the app's settings (decision 3), in its own folder (`inputBindings.json`), never in a project. A binding names the device and control, how it maps, and the parameter it drives by the parameter's **symbol and name**, not its id, since ids differ from one project to the next: binding "Heater power" (`heaterPower`) once drives it in every model that has a live parameter of that symbol, which suits a person who keeps a controller set up for a family of models. A binding whose parameter is not in the open model waits, listed as "not in this model", and a device not plugged in is said so on its chip. A **Controllers** section in the app's settings lists every binding, with the device's state, to rename, change or remove; and offers **Bind a control** for any live parameter of the open model. When two models' parameters share a symbol and mean different things, a binding can be narrowed to one model, by its name.

## Recording what was done

Every value a control gives is sent to the engine as the slider's is, but only when it has moved by enough to matter (decision 2): by default 1% of the parameter's live range since the value last sent, or one step, whichever is larger; and once more when the control comes to rest (no change for a quarter of a second), so the record ends at the value actually held. A button's press and release are always sent. The engine records each with the simulation time it took effect, as it records the slider's, so the run's parameter changes are its record of what the person did. A run steered by hand is then repeated as any other fork is, from its record, and gives the same result to the bit, because the replay uses the recorded values, not the device. The threshold is a setting (finer for an experiment where every wobble matters, coarser for a demonstration); a stick's sixty readings a second become a few dozen values a minute.

## The twin's sandbox, steered by hand

Today the sandbox runs ahead in chunks ("Run ahead 60 min"). With a control bound to one of its inputs (decision 4), it gains **Follow the controls**: the sandbox runs ahead continuously at a pace chosen beside it (a minute of the system a second, by default), each input taking the value its control has as it goes, and the tiles draw the sandbox's course dotted as it grows, beside the twin's own forecast. Turning a knob bound to the house's living room heater shows, within a second or two, where the room would go. The values are recorded by size of change, as above, so what was tried is the sandbox's list of steps, kept as a draft scenario on **Back to live** as today. It runs on the sandbox's own engine, so the live twin is never touched; **Pause** holds it, and the chunked **Run ahead** stays for typing a value.

The bindings are the same ones the project window uses (the twin's inputs are shared parameters, matched by symbol), and the twin's window reads the devices itself, since a gamepad is read only by the window in front.

## Safety and the edges

- A window that is not in front reads no gamepad (the browser stops it), so a control's value is held where it was, and the chip says the window must be in front. MIDI and the keyboard follow the window with focus too, so a knob turned while another application is in front does nothing.
- A device unplugged mid-run holds its parameters at their last values and says so; plugged back in, it takes over again only once a control is moved, so a stick that comes back off-centre does not jump a value.
- A parameter's value never leaves its live range, whatever the device sends.
- Nothing is read until a person binds something: no device is asked for, and Chrome's MIDI permission is asked only on the first **Bind…** with MIDI.

## Demonstrations

- **The house, with a MIDI controller:** three faders on the three rooms' heaters in the sandbox, the tiles answering as they move.
- **The single joint actuator, with a gamepad:** the left stick on the supply voltage, the joint swinging as the stick moves, the run then replayed from its record to the bit.
- **The wheeled robot, with the keyboard:** W and S ramping the drive voltage, for anyone without a controller.

## Order of work

1. **The device module** (gamepads, MIDI, keyboard), with a simulated device for tests: a test cannot plug in a gamepad, so the module takes its readings through a source the tests can feed, and Electron's MIDI permission handler.
2. **Binding and recording in the project window:** **Bind…** on the live controls, the chip, the mapping settings, the threshold, and the Controllers settings section; an interaction test steering a model with a simulated stick and replaying the run from its record to the bit.
3. **The twin's sandbox:** **Follow the controls**, with the same bindings, and its draft scenario.
4. **The web edition:** gamepads and the keyboard in every browser, MIDI where the browser has it, said where it does not.

## Open questions

1. **The threshold's default:** 1% of the range is proposed; a person running careful experiments may want 0.1%, which is still far fewer values than a stick's readings.
2. **Binding by symbol across models:** proposed as above, with narrowing to one model by name when two models' symbols mean different things. The alternative, a binding per model only, is safer but has to be made again for each model.
3. **The sandbox's pace:** a minute a second is proposed; a slow system (a building) may want ten minutes a second, a fast one (a joint) real time.
