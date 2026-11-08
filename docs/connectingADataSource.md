---
type: Specification
title: Connecting a data source
description: The Konjugate data log, a CSV file that a lab's logger or any program appends to while an experiment runs, with the rules for writing and reading one, a simulated rig to copy from, and a checker for your own files.
tags: [data-acquisition, digital-twin, file-format, connectors, specification]
status: draft
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Connecting a data source

This page is for anyone who wants their equipment, logger or script to feed a Konjugate model: a lab rig, a pilot plant, a microcontroller, a program that collects data from the internet. It describes the **Konjugate data log**, a plain CSV file that your program appends to while the experiment runs, and gives a working simulated rig to start from.

**Status: Konjugate replays a finished log, and runs a log as a live twin, played back or followed while a logger writes it.** Both read exactly this format, with the same reader the checker uses ([below](#replaying-a-log-in-konjugate), and [Running a log as a live twin](#running-a-log-as-a-live-twin)). An MQTT broker ([Following an MQTT broker](#following-an-mqtt-broker)) and an OPC UA server ([Following an OPC UA server](#following-an-opc-ua-server)) can be followed too.

## Why a file

Nearly every data logger can write a file, a shared folder is how a lab already shares data, and a file works the same for a recording made last week and for one being written now. Your program needs no network code, no keys and no knowledge of Konjugate: it appends lines and flushes them. Konjugate reads the file from wherever it is, a local disk or a shared folder, so several people can follow one rig from their own computers.

## An example

```
# konjugate data log: 1
# source: Simulated tank rig (examples/dataSources/simulatedTankRig.py)
# time: seconds since 2026-11-06T09:00:00Z
# inputs: heaterPower
# outputs: tankTemperature
time,heaterPower [W],tankTemperature [K],tankTemperature quality
0,1000,293.34,
60,,293.65,
120,,293.73,
5400,,338.33,bad
7200,0,317.78,
```

A tank whose heater the operator switched on at 9:00 and off at 11:00, with a thermometer read every minute. One thermometer reading at 10:30 was nonsense, and the logger marked it bad.

## The format

**Encoding.** UTF-8 text. Lines end with a newline (`\n`); a carriage return before it (`\r\n`) is accepted. Cells are separated by commas and have no quotes, so neither names nor values contain commas.

**The marker.** The first line that is not blank is `# konjugate data log: 1`. The number is the version of this format.

**The description,** in lines of the form `# key: value`, before the column headings:

| Line | Required | Meaning |
| --- | --- | --- |
| `# time: seconds since <date and time>` | Yes | What the time column counts from, as an ISO 8601 date and time with its zone: `2026-11-06T09:00:00Z` or `2026-11-06T10:00:00+01:00`. A time without a zone is refused, because a lab logger's local time is the most common cause of a model looking wrong for no reason. |
| `# time: seconds since start` | Instead of the above | The log has no wall-clock anchor: a recording whose start time is not known or does not matter. |
| `# inputs: a, b` | If there are inputs | The signals that are something done to the system: a valve position, a heater setpoint, a pump switched on. The model is driven by these. |
| `# outputs: c, d` | If there are outputs | The signals that are measured: a temperature, a level, a flow. The model is compared with these. |
| `# source: <text>` | No | What wrote the log, for people. |

Every signal is in exactly one of `inputs` and `outputs`. Other `# key: value` lines are allowed and ignored, so a logger can add its own.

**The column headings.** The first column is `time`. Each signal has a column headed `name [unit]`, where the name starts with a letter and is letters, digits and underscores, and the unit is free text (`K`, `m^3/s`, `-` for none). A signal may also have a column headed `name quality`.

**Rows.**
- `time` is a number of seconds on the log's clock. Each row's time is later than the row before it, except for a correction (below).
- A signal's cell holds its reading, or is empty when there is no reading of it at that time. Signals sampled at different rates, and inputs written only when they change, share one file this way. Between its rows an input holds its last value.
- A quality cell is `good`, `uncertain` or `bad`; empty means good. A reading marked anything but good must have a value: the mark says what the logger thinks of a reading, not that there was none.
- A line starting with `#` after the headings is a note for people (`# operator: refilled the tank`) and is skipped.

**Corrections.** A reading already written is never changed. When a source learns that an earlier reading was wrong, it appends a new row that repeats the earlier row's time, holding the corrected reading. Both are kept; the later one is the reading used, and each repeat is counted as a revision. A row whose time is earlier than the row before it and repeats no earlier row is an error, not a correction.

## Writing a log

Rules for a program that writes one; the `DataLog` class in the simulated rig keeps all of them and can be copied as it is.

1. **Write the marker, the description and the headings first,** before any reading, and flush them.
2. **Only append.** Never rewrite, reorder or remove a line, and never truncate the file while it is in use, because a reader may already have read it. A new experiment is a new file.
3. **Write whole lines and flush after each,** or after each small batch, so a reader sees a reading soon after it is taken. A reader ignores a line until its newline arrives, so a line caught half written is never misread, but a reading not flushed is a reading not seen. On a shared network folder, some file systems also need the file synchronised (`os.fsync` in Python) before another computer sees the new bytes.
4. **Record what was done, not only what was measured.** The model is driven by its inputs, so a valve opened by hand and not logged is a difference between model and rig that nothing can explain. Write each input when it changes, and once at the start.
5. **Stamp the reading when it was taken,** not when it was written, and say what the clock counts from with its zone.
6. **Leave a cell empty for no reading;** never write 0, -999 or NaN in its place.

## Reading a log

Rules for a program that reads one while it grows, which is what [src/dataLog.mjs](../src/dataLog.mjs) does and what Konjugate will do.

1. Read only the bytes added since the last read, and decode them as a stream, since a multi-byte character can be split between two reads.
2. Treat a line as complete only once its newline has arrived. Keep the rest for the next read.
3. Refuse the file, with the line number and the reason, at the first line that breaks a rule above. A file that is half right is not silently half read.
4. When the file is known to be finished (a recording), a last line without its newline is an error, since nothing will complete it.

## The simulated rig

[examples/dataSources/simulatedTankRig.py](../examples/dataSources/simulatedTankRig.py) is a pretend lab rig that writes a data log while it runs: a water tank, a heater the operator switches on and off on a schedule (on for two hours, off for one, on for two, then off), and a thermometer read every minute with a little noise and one glitch, which the logger marks bad. The tank's values are the true ones of the [Tank Calibration](../examples/tankCalibration.md) example, so a model calibrated there should agree with the rig. It needs only Python 3.8 or newer and its standard library.

```bash
python3 examples/dataSources/simulatedTankRig.py tankRun.csv              # six hours, in real time
python3 examples/dataSources/simulatedTankRig.py tankRun.csv --speed 600  # the same six hours in 36 seconds
tail -f tankRun.csv                                                        # in another terminal, to watch it grow
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--duration` | 21600 | How long the experiment lasts, in rig seconds. |
| `--sample` | 60 | Seconds between thermometer readings. |
| `--speed` | 1 | Rig seconds per real second. |
| `--start` | now | The date and time the experiment starts, with its zone. |
| `--seed` | 1 | The noise's seed, so a run can be repeated exactly. |
| `--glitch` | 5400 | A rig time at which the thermometer glitches; give it more than once for several. |
| `--drift` | 0 | How fast the tank's heat loss grows, as a fraction an hour, as wet insulation would: something for a live twin to find. |

**To connect a real rig,** keep the `DataLog` class and replace `TankRig` and the loop in `main` with code that reads your instruments:

```python
log = DataLog("run.csv", source="Bench rig 2", start=datetime.now(timezone.utc),
              inputs=["valveOpen"], outputs=["level"], units={"valveOpen": "-", "level": "m"})
began = time.monotonic()
valve = None
while experiment_running():
    seconds = time.monotonic() - began
    values = {"level": read_level_sensor()}
    position = read_valve_position()
    if position != valve:          # inputs are written when they change
        values["valveOpen"] = valve = position
    log.row(seconds, values)
    time.sleep(1.0)
log.close()
```

If your logger already writes its own CSV and cannot be changed, a short script that follows its file and writes a data log beside it is the bridge; the mapping screen planned in the proposal will later read other layouts directly.

## Replaying a log in Konjugate

Replaying runs the model on what the log says was done to the real system, and shows how long it stays in step with what was measured. It answers the question to settle before connecting anything live: does this model agree with this rig?

1. Open the model, then **Parameter tuning** in the toolbar, and choose **Replay a data log** (a data log chosen under either of the other goals is moved here, since fitting to a data log is not built yet).
2. Choose the log. Each signal is matched to the model by name, and every match can be changed:
   - An **input** drives a **shared parameter**, which follows the log's readings, held between them, as a schedule. Only a shared parameter can follow a schedule, so a parameter that a recording should drive must be made shared first.
   - A **measured signal** is compared with a **state**. The state starts at the signal's first good reading (untick **Start each measured state at its first reading** to start from the model's own initial value instead), and from then on the model runs on its own for the whole recording.
3. Set each measured signal's **tolerance**: how close the model must be to a reading to agree with it. It starts at a twentieth of the range the signal covered, which is only a first guess; set it to what you know about the sensor and the model.
4. Choose **Replay**. The run starts at the log's first time and lasts as long as the log, at a time step no coarser than the readings' spacing.

For each measured signal the card then says whether the model stayed within the tolerance for the whole recording, or for how long before it left it and how long it was out, with the typical and the largest miss. A single reading outside the tolerance on its own is taken as noise; three or more in a row put the model out of step. Bad readings are left out. A plot shows the measured and replayed values, and under them the gap between the two with the tolerance either side. Changing a tolerance judges the same run again without running it.

A replay changes nothing in the model: it runs a copy, so there is nothing to undo and nothing to save.

[examples/dataSources/simulatedTankRig.kjt](../examples/dataSources/simulatedTankRig.kjt) is the simulated rig's model, with its true values and the heater power as a shared parameter, so the rig's logs can be replayed through it straight away. (It is written by `node scripts/generateTankRigModel.mjs`.) Put in the [Tank Calibration](../examples/tankCalibration.md) example's starting guesses (300000 J/K and 10 W/K) and replay again to see a model that is out of step within minutes.

## Reading another logger's file

Most lab loggers write their own CSV and cannot be made to write a data log, and they should not have to. Choose the logger's file under **Replay a data log** as it is: the card sees it is not a data log and offers to read it, with its first guesses filled in (the separator, the decimal mark, which columns hold the date and time and how they are written, and the words a column uses anywhere in the file). Say once:

- which column holds the time, or the date and the time, how it is written (`DD.MM.YYYY HH:mm:ss`, `YYYY-MM-DD HH:mm:ss`, `MM/DD/YYYY HH:mm`…) and the **time zone** the logger's clock keeps (`Europe/Berlin`, `UTC`, `+01:00`; it starts as this computer's own);
- for each column you want, whether it is an input or measured, its name as the model calls it, its unit, a **scale** and an **offset** to turn the logger's number into the model's (°C to K is an offset of 273.15; the percentage of a 3 kW heater to watts is a scale of 30), and for a column of words, the value each word stands for (`OPEN=0.015, CLOSED=0`).

**Read the file** says what it found: how many rows, how many failed readings (`ERR`, `NaN`, blanks) were left out, a header written again after a restart, the gaps, and whether the clocks changed. Local time with no zone is the usual trap: the night the clocks go back an hour of timestamps repeats, and it is put in order, since time only goes forward; the night they go forward an hour is missing, and a reading written in it is left out. An input is passed on only when its value changes, since a logger writes it on every row. The settings are kept with the project, so the same logger's next file is read the same way, and the live twin can follow such a file while the logger writes it, or play it back. `src/loggerCsv.mjs` does the reading; [tests/loggerCsv.test.mjs](../tests/loggerCsv.test.mjs) has a test for each of these.

## Calibrating to a log

Under **Calibrate on a stretch**, choose a stretch of the log (from and to, in hours) and **Calibrate**: the model's tunable parameters are fitted so that, driven by what the log says was done, it matches what was measured over that stretch. Choose a stretch without long gaps (a gap of more than three steps is refused, with where it is), keep a later stretch back, and replay that one first (**From** and **To** under the signals) to check the result on data it was not calibrated on. **Apply calibrated values** puts them in the model as one undoable step. A measured state starts at its first reading in the stretch; the initial value of a state no reading reaches can be fitted with the parameters, once marked with ◎ beside it in its node's editor. The log's readings are put on a regular grid for the engine's fit: each step gets the mean of its readings, and a short run of empty steps is filled in a straight line (`src/dataLogFit.mjs`).

## An invented lab trial

[examples/dataSources/labVessel.py](../examples/dataSources/labVessel.py) is a harder rig than the tank, made to behave like a real lab: a 120-litre vessel with a 3 kW heater switched by a thermostat around a setpoint the operator changes, a cold-water valve the operator opens now and then, a room that warms and cools through the day, a good thermometer and a slow one that reads 0.6 K high, and late in the run a heater that scales up and gives less heat for the same setting. Its logger writes what such loggers write: semicolons and decimal commas, local Berlin time across the night the clocks go back, °C, the heater as a percentage, the valve as `OPEN` or `CLOSED`, `ERR` for a failed reading, and a restart that repeats the header and leaves a seven-minute gap. [examples/dataSources/labVessel.kjt](../examples/dataSources/labVessel.kjt) is the model a lab would build of it, starting from first guesses.

[tests/engine/labTrial.mjs](../tests/engine/labTrial.mjs) works through it as a lab would: the logger's file read as it is (14 324 readings, through the change of clocks and the restart); the first guesses out of step within minutes; calibrated on the first three and a half hours to within half a per cent of the vessel's capacitance and heat loss; in step on the stretch after it; then live, following the logger's file while it writes, in step until the heater starts scaling up and the drift called about two and a half hours after it began, when the heater had lost some fifteen per cent, and never before. The thermostat is why it takes that long: it keeps a weakened heater on longer, so a single ten-minute jump goes up or down with how long the heater happened to be on. The trial also found that a forecast which holds every input at its last value is many kelvin wrong for a thermostat's switching and the operator's valve: a forecast here needs the thermostat in the model, which is left as a model's own choice.

## Running a log as a live twin

Replaying runs the model once, unaided, from the start of the log. A live twin keeps it in step instead, the way it would be kept beside a running rig ([The prediction-actual comparison window](proposals/predictionActualWindow.md)): every time the data has moved on by a stride, it goes back to the start of the window, sets each measured state to its reading there, runs the window on what was really done, and forecasts what comes next. The **jump** at each move, how far the model's prediction was from the reading it is replaced by, is how far it had drifted: jumps that stay at the noise mean the model is right, and jumps that keep to one side mean something in the real system is moving away from it.

**The twin's own window.** **Live twin** in the toolbar (the pulse beside Parameter tuning) opens the twin in a window of its own, maximized, to keep on a second screen beside the model ([The twin's control room](proposals/controlRoom.md)). It sets the twin up in three steps on one page: the model (the open project, with the states it can compare and the shared parameters it can drive); where the readings come from (a log file, an MQTT broker, an OPC UA server or a script sending readings, each discovering what it offers: the file's columns, the broker's topics, the server's tags, the push keys' signals); and how each signal maps to the model. Each signal is suggested its role, its model quantity and its unit conversion, with a confidence and the reasons ("the name shares tank, temperature; °C converts to K; temperature instrument tag; declared measured by the source"): names are read for their words, abbreviations and ISA instrument tags (TT101 a temperature transmitter, JI101 a power indicator), units for their kind, values for their size, and a match confirmed before is remembered for the next time, in any project. Suggestions at 75% or more are filled in; the others wait for **Use**, or **Use every suggestion**. **Open the control room** keeps the setup with the project and starts the twin. Along the top is its health: live, its moves, and whether it keeps up with the data ("keeping up easily", or how far behind it is; the engine's own speed is in the tooltip); the source; and the drift (in step, leaning, or past the warning). Each measured signal's drift is judged on its own, so the room says which one is drifting. Below is a tile for every measured signal, with a legend (measured, model, forecast) and its unit, its border green in step, amber leaning and red past the warning. Temperatures are shown in °C, though the model keeps them in kelvin; the °C / K button along the top switches, and the choice is kept with the layout. Under the tiles are three panels. **Inputs** shows each input as a step line of what it was set to and when, as the twin received it. **What the twin infers** lists every state no sensor measures, at now, with its trend over the last hour of data (steady, rising, falling) and its course; with the estimator, its spread too, and the parameters it tracks. **Events** is one timed list, newest first: the twin starting and going live, the drift leaning and passing the warning and coming back, moves skipped to keep up, the engine started again, what the source says (an OPC UA server's sampling limit), and the end. While the twin runs, the project window's toolbar chip says so, turns amber with **Live twin: drifting** when the warning trips, and brings the twin's window to the front. The tiles can be arranged to suit the room: dragged by their ⋮⋮ onto another's place, drawn twice as wide (⇔), pinned first (📌) or hidden (✕, and **Show hidden tiles** brings them back); the layout is kept with the project, and so is where the window was (on a second screen, say), so the next shift opens the same room. The slider beside **Following now** scrubs back through the moves the twin has made, drawing the tiles, the inputs and what it infers as they were then (dashed), and **Follow now** comes back; the last run's events are kept with the project too. Signals that do not come in Konjugate's own form are read as well: another logger's table (its separator, decimal mark and time column found as they seem to be, each column of numbers offered as a signal, with a unit written in its name as "(°C)" or "[K]"; one that needs more saying, such as words for values, is described in the tuning card's **Replay a data log**, whose **Open the live twin** brings it here as the card read it). **Try it without equipment** offers the simulated rig, a rig that drifts, and **a house** (three rooms, each with its heater, thermostat and thermometer, the weather outside, the sun through the living room's windows and a floor slab no sensor measures: a day in a minute and a bit, with the bedroom window left open in the afternoon, so the bedroom drifts past the warning while the other rooms stay in step), each one click into the control room (with another model open, the rig's model is opened in the project window first), and **a plant's names**: the rig's recording as a plant's logger would keep it (TK1_TT101_PV in °C, TK1_JI101_PV in kW), to see the names matched and the units converted.


**Try something…** (the operator's, since it never changes the twin) starts a sandbox: a copy of the twin, from the latest move, in an engine of its own. Set an input to a value of your own (the heater off, say), **Run ahead**, and the tiles show what would happen beside the live forecast, dotted. The live twin carries on underneath, and nothing done in the sandbox reaches it or its record. **Back to live** ends the sandbox; if anything was tried, it is kept with the project as a draft scenario, with no question asked, and **Scenarios** above the events renames or deletes it.

**The engineer's view.** **Engineer** opens, beside the tiles, what changes the twin ([The twin's control room](proposals/controlRoom.md), "The engineer's view"):

1. **Tunable parameters**, each as a slider within its bounds and a number: set one, and the twin runs on with it from its latest move, and the model keeps it (Undo in the project window takes it back), so there is one model. The events say what changed, from what to what.
2. **Refit on the latest window**, below.
3. **The warning**: how far the model's corrections may keep to one side, on average a move, in the first measured signal's unit, before the room warns. It starts at a quarter of that signal's tolerance, is taken at once, and empty means none.
4. **Each measured signal**: what a move does with its reading: **reset to the reading** (the default), **nudge toward it** by a fraction you give (gentler on noisy readings, and on a state a sudden change would throw out of balance with the rest, such as one that holds energy), **watch only**, which corrects nothing after the first move, so you see how long the model stays right on its own, or **estimate**, described below. A state the model computes from others is compared and never set, whatever you choose; **What the twin infers** says which states the readings do not reach.
5. **Timing**: the window (how far back each move compares), how often it moves, how far ahead it forecasts, and the time step.

What a move does, the estimator's settings and the timing are taken when the twin starts again (**Start again with these**: a recording is played again from its start, a live source followed from now), and kept with the project. A change made to the model in the project window (an equation, a relationship, a new state) is offered at the top of the room, saying what changed; **Apply to the twin** starts the twin again from its latest move with it, each state still in the model carried across and a new one at its initial value. A change that removes a state a signal is compared with, or a shared parameter an input drives, is refused until the mapping is fixed in the setup, rather than applied in part. Every change is an event. [tests/engine/twinModelChange.mjs](../tests/engine/twinModelChange.mjs) checks that a parameter changed in the model runs the twin exactly as the same value applied as a refit, that a node added is carried in at its initial values with every other state carried across, and that removing a measured state is refused.

**Estimate** weighs a signal's readings against the model instead of trusting either outright ([A state estimator for the live twin](proposals/stateEstimator.md)). The twin runs copies of the model (32 unless you choose under **Ensemble members** in the engineer's view) from slightly different states, and at each move moves them toward the readings by as much as the readings' noise and the model's own uncertainty say they should, so a reading corrects every state that moves with it, measured or not: a tank's level read every minute finds the inflow nobody measures, where a reset leaves it wrong for good. Give the readings' noise beside the signal, or leave it empty to have it read from the readings' own scatter. **What the twin infers** shows each state with its estimate and spread, and the engineer's view lets you say how far each may drift in an hour beyond what the model says (by default, a measured state as far over one move as its readings' noise, and any other 1% of its value, shown faintly once it has run): more drift trusts the readings more. The forecast is drawn on its tile with a band, the copies' 10th to 90th percentile, and the tile says how many readings fell outside the band: about one in five means the settings are honest, far fewer that they are more cautious than they need to be, far more that the twin is surer than it should be. **Track as it goes** lists the model's tunable parameters (not the inputs the readings drive), ticked unless you untick them: the estimator follows each from the readings as a quantity that changes slowly, a heat loss that grows as insulation gets wet, a pump that wears, and shows it with its estimate, spread and trend among what the twin infers ("Heat loss coefficient 26.8 ± 0.4 W/K, rising"). It follows a change with a lag (by default a parameter may wander 20% of its value an hour); **Refit on the latest window** gives the value over a window exactly. The drifting rig shows it: when the room warns of the drift it says what an engineer can do, and with the tank's temperature estimated the heat loss is found rising. Signals left on reset, nudge or watch keep doing that. The copies are run one after another in the same engine, so a move costs about as many runs of a stride as there are copies, plus each copy's forecast; the health strip shows how many times faster than real time the twin runs. [tests/engine/windowEstimator.mjs](../tests/engine/windowEstimator.mjs) checks the tank and its inflow, and [tests/stateEstimator.test.mjs](../tests/stateEstimator.test.mjs) checks the filter against the exact Kalman filter.

**Refit on the latest window** treats the window the twin has just run as a small calibration: the parameters marked tunable, and the initial values marked with ◎ (a state no reading reaches, such as the room around a tank), are fitted so the window's run matches its readings, each state starting where the last move left it. What it found is listed, with the states' values at the window's anchor, and nothing changes until you choose: **Apply to the twin** starts the twin again from the move the refit was planned on, with those values, and runs it on the real inputs to where it has got to (so a twin that moved on while the fit ran takes it too, and the moves already made keep their record); **Apply, and keep in the model** also sets the parameters in the model, as one undoable step. The initial values found are the states at that anchor, not at the start of the model, so they stay with the twin. The next move says a refit was applied. [tests/engine/windowRefit.mjs](../tests/engine/windowRefit.mjs) runs the rig's twin with the first guesses and the room 10 K off, refits one two-hour window, and finds the capacitance, the heat loss and the room within a percent; from then on the model follows each window to within the rig's noise (0.2 K) where the same twin left alone is 1.3 K off.

The engine stays running for the whole twin ([Live engine session](proposals/liveEngineSession.md)), so a move costs well under a millisecond for a model like the tank and no start-up at all; if it dies, a new one is started from the last move's state and the twin carries on as if nothing happened. The live twin is a desktop feature: a web page cannot keep an engine running or read a file as it grows. [tests/engine/liveTwin.mjs](../tests/engine/liveTwin.mjs) runs the simulated rig, follows its log as it grows and checks all of this, drift included.

## Following an MQTT broker

Many labs already have a broker that their instruments, a Raspberry Pi or a Node-RED flow publish to. Konjugate connects to it like any other client, so it needs no port of its own, and several people can follow the same rig from their own computers.

1. In the twin's window, choose **An MQTT broker**, give its address (`mqtt://host:1883`) and **Listen for 3 seconds**. The topics heard are offered in the mapping, with their last value.
2. Each topic is suggested what it is from its words (`lab/rig/tank/temperature` the tank's temperature); confirm the suggestions, or choose, and give a unit conversion where the topic's unit differs from the model's.
3. **Open the control room.** The moves are made as readings arrive.

A payload can be a plain number (`301.2`), or JSON: a number, or an object with `value` and, optionally, `time` (seconds or milliseconds since 1970, or an ISO 8601 date and time) and `quality` (`good`, `uncertain` or `bad`). Give the reading's own `time` when you can: one stamped when it arrives carries the network's delays with it. A payload that is none of these is skipped.

A broker keeps no history, so what arrives is also written to a data log as it comes, in a `recordings` folder beside the project (or in the app's own folder for a project not yet saved), named after the broker and the time. Stopping says where it is among the events, with **Replay this recording**, which brings it back to the setup as the twin's log, mapped as it was, and **Show in folder**. [tests/engine/liveTwinMqtt.mjs](../tests/engine/liveTwinMqtt.mjs) runs a broker, publishes the simulated rig's six hours to it, and checks that the moves are the same, to the bit, as from the rig's own log.

## Following an OPC UA server

A PLC, or the gateway in front of a lab's instruments, often serves its readings over OPC UA. Konjugate connects to it as a client, as the lab's own screens do, so the server needs nothing new.

1. In the twin's window, choose **An OPC UA server**, give its address (`opc.tcp://host:4840/…`) and the security it uses: **None**, **Sign**, or **Sign and encrypt**. With security, a server whose certificate this computer has not seen is not trusted until you say so: the window asks, and remembers the answer. Konjugate's own certificate, and the servers it trusts, are kept in the app's own folder.
2. **Browse the tags.** The server's tags are offered in the mapping by their path, with the value, the unit and the range the server gives for each (an analog item's engineering units and range), so a tag is matched by its name and unit, not its node identifier.
3. Confirm what each tag is, and **Open the control room**.

Each reading is timed by the server's source timestamp, when it was measured, and carries the server's quality: a status that is Good, Uncertain or Bad. The connection reconnects by itself when the PLC restarts. A server keeps no history, so what arrives is recorded as a data log beside the project, as for a broker.

Two things about OPC UA worth knowing, both found by testing: a subscription reports what the server samples, at the sampling interval it grants (often 50 to 1000 ms), not every change, so a tag that changes faster than that has changes no client sees (Konjugate asks for the fastest the server allows, reads back what it granted, and the live twin says it: "The server samples these tags every 50 ms or faster"); and a server sends the readings of several tags together, grouped by tag rather than by time, so Konjugate puts each batch back in time order, and makes a move only once the data has gone past it, never on one tag's reading while another tag's reading for the same moment is still on its way. [tests/engine/liveTwinOpcUa.mjs](../tests/engine/liveTwinOpcUa.mjs) runs a server, reports the simulated rig's six hours through its tags, and checks that the moves are the same, to the bit, as from the rig's own log. A tag holding text is not a reading, even text that looks like a number. When a source sends readings out of time order (a PLC sending what it buffered), the twin uses them all, but a data log's rows only go forward, so the recording cannot hold one that comes after a later one; stopping says how many there were. [tests/engine/opcuaSource.mjs](../tests/engine/opcuaSource.mjs) simulates a PLC against a real server and checks, reading by reading, that everything given to the server at its sampling pace arrives exactly once, timed and in order: a steady feed of tags changing together, a value repeated, good, uncertain and bad quality, true/false and text tags, readings out of order, forty tags at once, an encrypted connection, the server restarting (the client reconnects by itself), a machine with every core busy, and stopping; and that changes faster than the server samples are never reported faster than it samples, the first and the last always seen.

## Taking readings a script sends

For a lab whose script reads an instrument and has nowhere to put the numbers: no logger writing a file, no broker, no OPC UA server. The script sends them to Konjugate itself, to the push service. If the script can append to a file or publish to a broker, do that instead: it keeps a record without Konjugate. The design is in [The push service](proposals/pushService.md).

1. Open **Settings › Push service** (⚙ in the title bar, or ⌘,), choose a port (8737 unless you say otherwise; gRPC uses the next one), and **Start**. It listens only until you stop it or quit, and a chip in the toolbar says so while it does, with the number of scripts sending. It listens on this computer only, unless you tick **On the network, encrypted** (below).
2. **Make a key** for each rig or script, naming the signals it may send. The key is shown once: copy it into the script. Konjugate keeps only a hash of it, in its own folder, never in a project. **Revoke** stops a key at its next message.
3. Copy an example from the panel. JSON needs nothing installed: `POST /v1/readings` with `Content-Type: application/json` and `Authorization: Bearer <key>`, and a body like `{"readings": [{"signal": "tankTemperature", "value": 341.2, "time": 1794046502.25}]}`. The same message can be sent as protobuf (`application/x-protobuf`, defined in [protocol/pushReadings.proto](../protocol/pushReadings.proto)), over a WebSocket at `/v1/stream` (a text frame for JSON, a binary frame for protobuf), or as a gRPC stream (`ReadingPush.Push` on the next port), which holds a script back when it sends faster than the twin takes the readings.
4. In the twin's window, choose **A script sending readings** and **Use the keys' signals**: the signals the keys may send are offered in the mapping. Confirm what each is, and **Open the control room**.

A reading's `time` is seconds since 1970 or an ISO 8601 date and time with its zone; left out, the reading is stamped when it arrives, which carries the delay with it. `quality` is `good` (the default), `uncertain` or `bad`. Every message is answered with a status and, if refused, the reason: `400` for something wrong in it (the reason says what), `401` for an unknown or revoked key, `403` for a signal the key may not send, `429` after ten wrong keys in a minute from one address. A message with one bad reading is refused whole. What arrives is recorded as a data log beside the project, as for a broker; stopping the service with a twin following it asks first, and the twin then says why it stopped and where the readings are.

**From another computer.** Tick **On the network, encrypted** before starting. The service then listens on every network address of this computer, but only encrypted: HTTPS, secure WebSockets and gRPC over TLS, since a key sent in the clear could be read by anyone on the network. The certificate is one Konjugate makes for this computer the first time (kept in its own folder with the keys, its private key readable by you only, and made again if this computer's addresses change), or your own (**Use my own…**, a certificate and its key in PEM files). The panel shows its fingerprint and the addresses it is for; **Save certificate…** writes it to a file to give to the scripts, which trust exactly that certificate, so they know they are talking to this Konjugate. Starting asks first, and the examples change to `https://` and the saved file (`ssl.create_default_context(cafile="konjugate-push.pem")` in Python, `--cacert` for curl, `NODE_EXTRA_CA_CERTS` for Node, `grpc.ssl_channel_credentials` for gRPC); none turns checking off. A firewall may ask whether to let Konjugate accept connections: allow it for the network you mean.

**Try it** with the simulated rig, on two computers or on one (sending to this computer's own network address still goes through its network stack and TLS):

1. Open `examples/dataSources/simulatedTankRig.kjt`. In Settings › Push service, tick **On the network, encrypted**, **Start**, make a key named, say, `tank rig` that may send `heaterPower, tankTemperature`, and **Save certificate…** as `konjugate-push.pem`.
2. **Live twin** in the toolbar, **A script sending readings**, **Use the keys' signals** (both are matched to the rig's model by name), and **Open the control room**.
3. **Save the demo scripts…** in the panel writes `pushTankRig.py` and the rig it drives into a folder you choose (they are also in `examples/dataSources` in the repository). There, with the certificate beside them, run the command the panel shows under **Try it**, which has the address and the key filled in: `python3 pushTankRig.py https://192.168.1.8:8737 --key kjp_… --certificate konjugate-push.pem --speed 600`. It runs the rig's six hours in about a minute, and the live twin follows it.

[tests/engine/liveTwinPushNetwork.mjs](../tests/engine/liveTwinPushNetwork.mjs) does exactly this to this computer's network address, checks the moves against the rig's own log to the bit, and checks that the script refuses an `https://` address without a certificate and will not talk to a Konjugate whose certificate it was not given.

On a computer with no screen, `konjugate --cli serve` runs the same service in the foreground and writes what arrives to a data log (`--record <file.csv>`, `--inputs` naming the signals that are inputs), which a Konjugate elsewhere can follow as it grows (`--network` listens on the network, encrypted, and prints the certificate's fingerprint and file); `konjugate --cli serve keys add <name> --signals a,b`, `keys list` and `keys revoke <name>` manage the same keys ([engineCli.md](engineCli.md#the-push-service-from-the-command-line)). [tests/engine/liveTwinPush.mjs](../tests/engine/liveTwinPush.mjs) pushes the simulated rig's six hours over HTTP, a WebSocket and gRPC in turn, and checks that the moves are the same, to the bit, as from the rig's own log.

## Checking your log

```bash
node scripts/checkDataLog.mjs tankRun.csv
```

It reads the file with the same reader Konjugate will use, and either says what is in it (each signal, its unit and role, how many readings, how many were not good and how many were corrected) or names the first line that breaks a rule and why. It treats the file as finished, so on a log still being written, a line caught half written is reported as having no newline at its end; run it again, or on a finished log.

The rules are tested in [tests/dataLog.test.mjs](../tests/dataLog.test.mjs), and [tests/simulatedTankRig.test.mjs](../tests/simulatedTankRig.test.mjs) runs the rig sped up and follows its file while it grows: it checks that what was read along the way is exactly what the finished file holds, that the file grew over the run rather than appearing at the end, that the heater changes are where the schedule puts them, and that the temperatures are the true tank's plus noise. [tests/engine/dataLogReplay.mjs](../tests/engine/dataLogReplay.mjs) replays the rig's log through its model with the real engine: with the true values the model stays in step for all six hours, and with the wrong ones it leaves the tolerance within the hour. When Konjugate can follow a log as it grows, that is added to the same tests.

## Not yet covered

- **Long experiments split over several files.** Likely: a folder of logs read in name order, each with its own description and headings.
- **Text and on-off signals** such as an operator's note or a state name. For now an on-off input is written as 0 and 1.
- **Units.** A unit is free text, and Konjugate will compare it with the unit of the model state or parameter a signal is mapped to, but there is no fixed list.
