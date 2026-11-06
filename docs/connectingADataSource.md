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

**Status: the format is fixed, and Konjugate does not read it yet.** The format, its reader and its checker exist now, so a source can be built and checked before the app can use it. Replaying a finished log through a model, and then following a log as it grows, are the first and third steps of [Digital twin connections](proposals/digitalTwinConnections.md); both will read exactly this format, with the same reader the checker uses.

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

## Checking your log

```bash
node scripts/checkDataLog.mjs tankRun.csv
```

It reads the file with the same reader Konjugate will use, and either says what is in it (each signal, its unit and role, how many readings, how many were not good and how many were corrected) or names the first line that breaks a rule and why. It treats the file as finished, so on a log still being written, a line caught half written is reported as having no newline at its end; run it again, or on a finished log.

The rules are tested in [tests/dataLog.test.mjs](../tests/dataLog.test.mjs), and [tests/simulatedTankRig.test.mjs](../tests/simulatedTankRig.test.mjs) runs the rig sped up and follows its file while it grows: it checks that what was read along the way is exactly what the finished file holds, that the file grew over the run rather than appearing at the end, that the heater changes are where the schedule puts them, and that the temperatures are the true tank's plus noise. When Konjugate can follow a log, the receiving side joins that test.

## Not yet covered

- **Long experiments split over several files.** Likely: a folder of logs read in name order, each with its own description and headings.
- **Text and on-off signals** such as an operator's note or a state name. For now an on-off input is written as 0 and 1.
- **Units.** A unit is free text, and Konjugate will compare it with the unit of the model state or parameter a signal is mapped to, but there is no fixed list.
