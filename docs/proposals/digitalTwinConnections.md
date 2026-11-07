---
type: Proposal
title: "Digital twin connections: reading a lab's live data"
description: Design for connecting a running model to the data a lab already records, with Konjugate as a client of the lab's own files, broker or server, the engine work that has to come first, detaching into a sandbox, and the order in which to prove it on real data.
tags: [proposals, digital-twin, connectors, data-acquisition, security]
status: draft
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Digital twin connections: reading a lab's live data

**Status: steps 1 to 5 built: a data log replayed, a live twin run from a log (Konjugate's own or another logger's, played back or followed as it grows), an MQTT broker or an OPC UA server, a long-lived engine session keeping it in step, and detaching into a sandbox with draft scenarios. The push service, step 6, waits for a lab that needs it.** Written down after a review of the project against its own claim. Konjugate describes itself as a platform for simulations and digital twins, but what it has today is a model that is calibrated offline from a file. This document sets out what is missing, who it is for first, and how a running model reads the data they already have. The companion [Prediction-actual comparison window](predictionActualWindow.md) describes how a running model stays in step with that data. A first draft of this document designed a server that labs would push into and that other copies of Konjugate would subscribe to; a review found that this rebuilt a message broker and a historian that labs already have, and that its defaults worked against the main use. This version replaces it.

## What is true today

A twin needs measurements in, a model kept in step with the real system, calibration, validation, monitoring, prediction, and a way for other programs to read and drive it. This is where the project stands against that list.

| Need | State today |
| --- | --- |
| Measurements flow in, timestamped and mapped | Offline CSV only. [Parameter tuning](parameterTuningObjectives.md) and [causal inference](../causalInference.md) read a file. Nothing feeds a running simulation. [Product strategy](../productStrategy.md) defers live acquisition on purpose, until offline comparison is reliable. |
| The model stays in step with the real system | Not built. The strategy document names state estimation as its own mode, separate from calibration, but no code exists. |
| Calibration | Built: bounded fitting with a choice of optimisers, an objective written in the equation editor, limits, progress and stop-and-keep-best. |
| Validation on data not used for fitting | Partial. Causal inference holds out a validation split; `fit` does not. |
| Monitoring: the model against the live system, with alerts | Not built. |
| Prediction from the current state | A primitive exists: a run can restart from a full state vector (`startCheckpoint`, [project schema](../projectSchema.md)), and result branches exist. Nothing connects them to data. |
| Other programs drive or read the model | Weak. See below. |

The interfaces that exist today:

- The command line (`run`, `fit`, `validate`, [engine CLI](../engineCli.md)): headless, file in and file out, stable exit codes. Right for batch pipelines, not for a live system.
- The run protocol ([engine job protocol](../jobProtocol.md)): framed protobuf commands on the engine's stdin and events on its stdout. The only inbound commands are pacing, run state, a parameter value and a parameter schedule. A measurement cannot be pushed into a state, and the engine runs a job from start to end; it cannot run to a time, report, and wait for more data.
- Exports ([code export](../codeExport.md)): CSV, standalone C++ or Python, and FMI 2.0 and 3.0 Co-Simulation FMUs, plus FMU import into a node.
- Add-ons ([add-on development](../addonDevelopment.md)): read-only result viewers; launchers that build a model from files or a URL once, with no stream behind them.
- Providers (C++ and Python code in a relationship or node): they can run any code, including reading a socket. That works by accident, is not deterministic, and is not a supported way to connect.

[Plugin development](../pluginDevelopment.md) already sketches a "Connectors" capability with the right policies (clocks, buffering, stale data, units, reconnect, read-only against command authority, recording raw observations). None of it is built, and its first milestone, offline CSV import, is what exists.

## Who it is for first

Two kinds of user, and the design is shaped for them:

- **Small lab and pilot-plant teams**, five or six people around a rig. Their automated equipment already writes sensor readings and the inputs the operators gave (opening or closing a valve, setting a heater temperature) into a computer, through a data logger, a PLC, or a small server.
- **Students and researchers** working with recorded or public data.

Neither needs the twin to control anything. They need it to read what is already recorded, as it is recorded, compare it with the model, and show what would happen next. So the first version is read only, and it must not depend on knowing which brand of equipment a lab has. These are expectations to check with real users, not findings from them; the first step of the order of work is a real lab's recording for exactly that reason.

What people from instrumentation and control will expect, kept here so the design does not rule it out:

- Tags with meaning: engineering units, scaling, and a quality flag (good, bad, uncertain) on every value, with the time the source stamped it kept apart from the time it arrived. States here have a unit string but no quality and one timestamp.
- The protocols they already run, OPC UA first among them; a tool that speaks none of them is a spreadsheet to this audience.
- Connections made outward from the control network, no inbound port opened by default, credentials in the operating system's keychain.
- A ladder of authority, climbed on purpose: replay, then watching alongside the plant, then advising a person, then writing. The twin is never part of a safety function. Only the first two are in scope here.

Other audiences (traders, co-simulation, virtual commissioning) are at the end, under [Later](#later).

## Konjugate is a client

**The lab's data already lives somewhere: a file the logger appends to, a broker, a PLC's server, a database. Konjugate reads it from there, connecting outward, and does not become a second home for it.** This is the decision the rest follows from.

- It needs no open port, no keys handed out, and no certificates of Konjugate's own, so it works the same in a university network as on a laptop.
- Several people watching the same rig is free: each person's Konjugate is its own client of the same source, a shared folder, the same broker topic, the same OPC UA server. There is nothing to host and nothing to fail for everyone at once.
- The lab's own store stays the record of what was measured. Konjugate does not duplicate it (see [The record](#the-record)).

A lab with nothing to read from, where a script reads an instrument and has nowhere to put the numbers, has the [push service](#the-push-service-a-fallback), which comes last and only if a lab needs it. For that lab the simpler answer is often to have the script append to a file or publish to a broker, both of which take a few lines.

## Signals have a role

Each signal brought in is one of two things, and the role decides what the model does with it.

- A **measured output** (a temperature, a level, a flow) is compared with a model state, in the [comparison window](predictionActualWindow.md).
- An **applied input** (a valve position, a heater setpoint, a pump on or off) drives the model: it is bound to a parameter or an input node, and the model runs on what was actually done, not on what the model would have chosen. Inputs are often steps or on-off values, so they are held between samples, not interpolated.

## Adapters

Each kind of source is an adapter, and every adapter produces the same `Observation` and answers the same two questions, so one mapping screen works for all of them: what fields do you offer (`describe`), and what are their values since a given time (`read`).

| Adapter | Covers | How it connects |
| --- | --- | --- |
| File | A logger that keeps appending to a CSV or text file, which is most lab data loggers; a folder that new files land in; a recording to replay | Reads a local or shared folder |
| MQTT | Microcontrollers, Raspberry Pi, Node-RED, and any lab that already runs a broker | Subscribes to the lab's broker |
| OPC UA | PLCs and the gateways in front of instruments | Client of the lab's server |
| Database and HTTP | A logger that stores to SQLite, InfluxDB or a web service | Queries it |
| Modbus and serial | Older instruments and meters, with registers or fields entered by hand since they carry no names | Polls the device |

A CSV offers its column headings, an OPC UA server its tag tree, MQTT the topics heard in a few seconds of listening, and a source that cannot list its fields (Modbus) is filled in by hand. The person drags a field onto a model state or parameter, chooses its role, and sets its unit, scale and offset, and its time zone or clock offset, since lab loggers often record local time with no zone, or seconds since the start. Matching by name, as the tuning card does with CSV columns, makes the first guess.

The file adapter covers the most labs with the least, because nearly every logger can write a file and a shared folder is how a lab already shares data; it is also how a recording is replayed, so it is the same adapter offline and live. Its format, the Konjugate data log, is already fixed in [Connecting a data source](../connectingADataSource.md), with its reader (`src/dataLog.mjs`), a checker, and a simulated rig that writes one as it runs, so sources can be built before the adapter is. MQTT covers the next most, and gives several readers of one live source for free.

**What a small lab needs from OPC UA.**
- Browse the server's tags as a tree and drag one onto a state, instead of typing node identifiers.
- Take the unit, range and quality flag the server already provides.
- Offer "no security", "sign" and "sign and encrypt", with a dialog to trust the server's certificate, rather than demanding a certificate setup.
- Subscribe to changes and reconnect on its own when the PLC restarts.

Adapters run in their own processes, never inside the integration loop. The engine sees only clean, timestamped, validated values through a narrow interface, and an adapter that crashes cannot stop a run.

## The shape in code

Adapters differ in how they behave, so they are a family of classes; sessions differ only in a few settings, so a session is put together from parts instead of being a subclass for each combination.

```
Observation                 { time, arrived, signal, value, quality, revision }: the one contract every adapter produces
Port                        a signal on the model: role, unit, quality, how it is held between samples
Endpoint                    the outside world, one per source; owns reconnect, timeouts, secrets, describe and read
├── FileEndpoint            a file or folder, read once (replay) or followed as it grows (live)
├── MqttEndpoint            subscribes to topics on a broker
├── OpcUaEndpoint           subscribes to tags on a server
├── QueryEndpoint           SQLite, InfluxDB, HTTP
└── PollEndpoint            Modbus and serial
Session                     one run kept in step with data, made of:
  clock                     virtual (replay, as fast as it can) or wall (live)
  authority                 observe (the only one built here); advise and command are later
  endpoints                 the sources it reads; a sandbox has none
  window policy             what happens when the model and the data disagree (the comparison window)
```

A replay is a session with a virtual clock and a file endpoint. A live twin is a wall clock with any endpoints. A sandbox is a virtual clock with no endpoints at all. None of them needs its own class, and adding the advising or commanding authority later adds a value, not three classes.

The time-alignment layer is what every session shares: it holds or interpolates between observations (parameter schedules already do this with hold and linear modes), decides when a value is stale, bins samples that arrive faster than the engine step so a coarse step does not alias them, and resamples irregular samples to the step.

## What the engine must do first

The hard part of a live twin is not the network. Today the engine runs a job from start to end on inputs it was given at the start. A session needs it to:

- **Run in steps.** Run to a time, report, and wait for the next instruction, with the run kept alive between them: an incremental run call on the existing protocol.
- **Take inputs as they arrive.** An observation drives a parameter or an input node during a run. This is the input binding deferred in the controller plan, and nothing can be connected without it.
- **Replace some states.** Restart from a state where only the measured states are set and the rest keep the model's own values, which the comparison window's default needs.
- **Keep a rolling set of checkpoints** at a set spacing, bounded, so a stretch can be rerun.
- **Report how fast it is going:** model seconds computed per wall second, and how far behind the data it is.

Replaying a recording needs none of these at first: its applied inputs can become parameter schedules held between samples, which the engine already runs, and its measured outputs can be compared with the result afterwards. That is why the first step of the order of work can use real data before any engine work.

## The record

**The lab's store is the record of what was measured, and nothing in Konjugate changes it.**

- **Not duplicated.** A session keeps a pointer to its source (the file, the topic, the server and tags) and only what the source cannot give back: when each observation arrived, which ones the session used, revisions it saw, and every decision it made (each reset, the values it applied, each change of step). This session log is small, and a replay of the source through the log reproduces the session exactly.
- **Kept when the source forgets.** An MQTT broker without retention and an OPC UA server keep no history, so for those the session also stores the raw observations it received, in a compressed file beside the project, never inside it, with its size shown and a limit the person can change. Where those files go is chosen once, in settings, with a sensible default; nobody is asked per session.
- **Never edited.** Received observations are not edited or deleted from the app, and there is no interface that offers to. The one way a value is superseded is a new record from the source itself, such as a logger resending a corrected reading, which carries a revision mark; both are kept, and the later one is used.
- **Cleaning is a flag, not a change.** Excluding a bad sensor stretch from a comparison or a refit is a marker kept in the analysis, so the stored value is still there and the exclusion can be undone.
- **Trying things is the sandbox.** Changing inputs and controls on the simulated side is [detaching](#detaching-to-try-things), which works on simulated inputs, stores them apart from measurements, and marks them as not measured wherever they are shown.

## Detaching to try things

A person watching the live twin should be able to step out of it, try their own inputs and controls on the model, and step back, without ever touching the real system.

- **Detach.** One button forks the live session at the present moment. The sandbox starts from the model's state at now (the estimate the [comparison window](predictionActualWindow.md) holds), and from then on it has nothing to do with the live data: the person applies their own setpoints, parameter changes, disturbances and schedules, and sees what the model does. The engine already has the pieces: live parameter commands, the step, ramp, pulse and waveform schedules, and scenario forks that apply them from a chosen time.
- **It runs ahead of real time.** The sandbox uses a virtual clock and runs as fast as the machine allows, with a speed control, so a person can see an hour of consequences in moments.
- **Live carries on underneath.** Reading, the session log and the comparison window keep running while the person is detached, so nothing is lost and the live state is current when they return. Live always has priority: the sandbox uses spare capacity, and when the live cycle needs the time, the sandbox slows first.
- **It cannot reach anything outside.** A sandbox has no endpoints, so nothing it does can leave it. This is structural, not a switch that could be left on.
- **One button back.** Returning to live ends the sandbox and puts the view back on the live screen as it now is. Nothing the person did reaches the live session or its record; the actions they took are kept only as a draft scenario, below.
- **It is always clear which is which.** A banner and a change of colour say the view is detached, the clock shows sandbox time against live time, and the plots overlay three things: the live actuals (carrying on, faded), the forecast with no action taken, and the forecast with the person's actions. The comparison between the last two is the point.

A variation worth having: detach from a past moment instead of now, to ask what would have happened had an action been taken an hour ago, and compare it with what actually happened.

**Scenarios are kept in the project without asking.** A sandbox in which the person did something is saved automatically when they return, as a draft scenario in the project file, so there is no save button and no place to choose. A sandbox in which nothing was done is not kept. Later, a Scenarios area lists what was tried, and the person keeps, renames or deletes each one; deleting is how a scenario is discarded. A scenario stores the moment it started and the state at that moment, the controls applied and when, the speed and the assumptions about the other inputs, and a fingerprint of the model, so it can be rerun and can say when the model has changed since. It does not store results, which are recomputed. Like the tuning setup, it sits beside the model, not in it, and never reaches the engine, validation or undo. Drafts have a limit, and when it is reached the person is told and asked, never silently overwritten.

One consequence, accepted on purpose: returning from a sandbox in which something was done leaves the project with unsaved changes, even though the model was not touched. The banner on return says so ("1 scenario kept as a draft"), so the unsaved marker is never a mystery.

Open question: what the sandbox assumes for the inputs it is not controlling, with a default of holding their last measured values.

## The push service, a fallback

For a lab whose instrument script has nowhere to put its numbers and cannot write a file or publish to a broker, Konjugate can listen for observations itself: JSON over HTTP or WebSocket, from any script. It comes last in the order of work, and only if a lab needs it. The design to build from is [The push service](pushService.md).

- **Started and stopped from the app.** A Connections panel with one Start / Stop switch and its state: stopped, or listening on an address and port with the number of clients and the rate of data. It shows how to connect, with a short copyable example in Python and in JavaScript. Opening a project never starts it.
- **Visible while on.** A toolbar chip, like the one for a running tuning, says "Listening on 127.0.0.1:PORT, 2 clients".
- **A key for each client,** named after the rig or script that uses it, allowed to push only the signals it is given, and revocable on its own.
- **Local or network, said plainly.** It listens on the loopback address by default, which is right when the script runs on the same computer. Listening on the network is a separate, warned choice, and it is offered only with an encrypted connection, since keys sent in plain HTTP can be read by anyone on the lab network.
- **Stopping is clean.** Stop ends each client's connection with a reason and finishes writing what was received, and if a live session is reading from it, says so first.
- **Desktop only.** A web page cannot listen on a port.

The app and a command-line `konjugate serve`, for a lab computer with no screen, are two front ends to one `ConnectionService` with `start`, `stop` and `status`, run as a separate process that the app starts and watches. Recommended: a Node module beside the code that already talks to the engine, not inside the engine.

It is not a hub. It does not fan data out to other copies of Konjugate and does not serve history; a lab that wants several people on one live feed points their scripts at a broker, and each person's Konjugate subscribes to it.

## Security

- By default Konjugate opens no port: every connection is made outward to the lab's own source. The push service is the only exception, off until a person starts it, local by default, a named key for every client, and encrypted when it listens on the network.
- Each adapter declares what it reads, and each grant is its own decision. Nothing here writes to a device.
- Secrets (broker passwords, OPC UA credentials, database logins) live in the operating system's keychain, never in a project file.
- The record of what was measured cannot be edited from the app.

## Open decisions

1. **Where the first lab's data lives.** Whether its logger appends to a file, publishes to a broker, or serves OPC UA decides which live adapter comes first after the file adapter. Unknown, and the first thing to ask.
2. **Where raw observations are kept** for sources that keep no history: a folder chosen once in settings, with a default beside the project. Recommended.
3. **Whether to soften the product's "digital twin" wording** until the first live session works.
4. **Where the push service's code lives,** if it is built: a Node module. Recommended.

## Order of work

Each step is proved on real data before the next starts.

1. **Replay a real lab recording.** The `Observation` contract, the `Endpoint` base and the file endpoint reading a recording once, a session with a virtual clock, applied inputs turned into held parameter schedules, and the measured outputs compared with the result as the comparison window's hold policy would. No engine changes. This is the test of the whole idea: if the model does not agree with a real rig's recording, nothing live is worth building yet, and the work goes into the model and its calibration instead. **Built**, as the third goal of the Parameter tuning card ([Connecting a data source](../connectingADataSource.md#replaying-a-log-in-konjugate)): the `Observation` is what `src/dataLog.mjs` produces, and `src/dataLogReplay.mjs` plans the run and judges it. Simpler than designed in two ways, both to revisit once a real recording has been through it: agreement is a tolerance per signal, not a limit written in the equation editor, and the model is anchored once, at the start, and then runs unaided. The `Endpoint` and session classes were not made yet, since one file read once does not yet show what they must share; they come with step 3, when there is a second way in. No real lab's recording was available, so an invented one stands in for it ([An invented lab trial](../connectingADataSource.md#an-invented-lab-trial)): a vessel with a thermostat, an operator, a drifting heater and a logger with every habit real ones have. Working through it added reading another logger's own file, replaying a stretch, and calibrating on a stretch of a log; and it showed that a held-input forecast is poor for an input a thermostat switches.
2. **The engine runs in steps.** The incremental run, input binding during a run, replacing measured states, rolling checkpoints, and speed reporting. Then the comparison window's default (reset at each stride) run over the same recording, as fast as it will go. **Built**, as a long-lived engine session rather than an incremental run ([Live engine session](liveEngineSession.md)): input readings drive shared parameters as they arrive, a move goes back to a kept checkpoint with the measured states replaced, checkpoints are kept only where a move will go back to, and the session reports its speed and lag.
3. **Live.** The file endpoint following a growing file, then MQTT, with a wall clock, the time-alignment layer, the session log, and raw recording for sources without history. Several people on one rig works from here on, each a client of the same source. **Built**, for data log files and MQTT: `src/dataLogFollower.mjs` follows a log while a logger writes it, `src/mqttSource.mjs` listens to a broker and follows its topics, and the live twin runs from either in the app; the time-alignment layer is the held input readings and the readings each move compares. What a broker sends is recorded as a data log in a `recordings` folder beside the project, with nobody asked where (the settings choice of folder is not built).
4. **The sandbox and scenarios.** **Built:** a sandbox is a separate engine started from the live twin's latest move; what was tried is kept with the project as a draft scenario when the person goes back to live (`scenarios`, [project schema](../projectSchema.md)).
5. **OPC UA,** with the tag browser and certificate trust described above. **Built** (`src/opcuaSource.mjs`, with the `node-opcua-client` library): tags browsed with their engineering units and range, security of none, sign, or sign and encrypt with a server's certificate trusted only when the person confirms it, subscriptions timed by source timestamps with each status as the reading's quality, reconnection, and recording as for MQTT. Testing it showed three things now handled for every live source: a server's notifications group tags rather than times (each batch is put in time order); readings of several signals for one instant arrive one after another (a move waits until the data has gone past its now, and a source that has finished says so); and a repeated value is still a reading (the subscription asks for timestamp changes). Serving the model's own states as tags remains under [Later](#later).
6. **The push service,** only if a lab needs it. Designed in [The push service](pushService.md).

## Demonstrations that need no hardware

- A recorded tank run, replayed through the Tank Calibration model, with the comparison window showing where the model and the recording part.
- The simulated tank rig ([Connecting a data source](../connectingADataSource.md)) writing its log into a shared folder, with two copies of Konjugate following it; later, the same rig publishing to a local Mosquitto broker.
- A software OPC UA test server feeding the Tank Calibration model, with the comparison window running.

## Later

Kept short on purpose, so that the first users' needs set the design and these follow from it.

- **Advising and commanding.** A twin that proposes setpoints for a person to apply, then one that writes them, within per-tag limits (minimum, maximum, rate of change), with a watchdog, a heartbeat the device can fall back on, a log of every write, and a kill switch. Each is a new value of a session's authority, not a new kind of session.
- **Virtual commissioning.** The model serving its states as OPC UA tags, so a PLC can be tested against it as a stand-in plant, paced to the wall clock. This is the one case where Konjugate must be a server, and it is a separate decision when someone asks for it.
- **Co-simulation.** FMU export and import exist, with rollback verification for FMI 2.0. A network peer, so a program that is not an FMU can step Konjugate or be stepped by it, and a written account of the master algorithm, belong in their own proposal.
- **Trading.** A continuous-time graph engine is not a tick-level backtester, but it fits energy and commodity models driven by a price signal: a battery, a tank or a turbine. Prices would come in through a query or file endpoint, with care for irregular timing, revised history and avoiding look-ahead; a backtest is an objective evaluated over a replay, and walk-forward optimisation is tuning over a moving window. Konjugate would never place orders.
