#!/usr/bin/env python3
# Copyright © 2026 Zenin Easa Panthakkalakath
"""A simulated lab rig that writes a Konjugate data log while it runs.

This is a worked example for anyone connecting their own equipment to Konjugate. It plays the part of a small lab rig: a water
tank with an electric heater that an operator switches on and off, and a thermometer in the tank. Like a real data logger, it
appends one line to a CSV file for each reading, as the reading is taken, so the file grows while the experiment runs.

The format of that file is described in docs/connectingADataSource.md. Everything that makes a file readable by Konjugate is in
the `DataLog` class below; everything that is particular to this pretend rig is in `TankRig`. To connect a real rig, keep
`DataLog` as it is and replace `TankRig` with code that reads your instruments.

Run it, from the repository root:

    python3 examples/dataSources/simulatedTankRig.py tankRun.csv              # six hours, in real time
    python3 examples/dataSources/simulatedTankRig.py tankRun.csv --speed 600  # the same six hours in 36 seconds

Then watch the file grow (`tail -f tankRun.csv`), or check it follows the format:

    node scripts/checkDataLog.mjs tankRun.csv

Only the Python standard library is used, and Python 3.8 or newer is enough.
"""

import argparse
import math
import random
import time
from datetime import datetime, timezone


class DataLog:
    """Writes a Konjugate data log.

    The rules this class keeps, which any program writing a data log must keep:
    - It starts with the marker line, then says what its time column counts from, which signals are inputs (what was done to the
      rig) and which are outputs (what was measured), and then gives the column headings with each signal's unit.
    - It only ever appends. It never rewrites, reorders or removes a line already written, because Konjugate may already have read it.
    - It writes whole lines and flushes after each one, so a reader sees each reading as soon as it is taken. (A reader ignores a line
      until its newline arrives, so a line caught half written is never misread, but flushing keeps the wait short.)
    - Rows go forward in time. An empty cell means "no reading of this signal at this time", so signals sampled at different rates,
      or inputs written only when they change, share one file.
    - A reading's quality (good, uncertain or bad) goes in an optional "<signal> quality" column; empty means good.
    - A correction to a reading already written is a new row repeating the earlier row's time. It is never an edit of that row.
    """

    def __init__(self, path, source, start, inputs, outputs, units, quality_for=()):
        self.signals = list(inputs) + list(outputs)
        self.quality_for = list(quality_for)
        # newline='' keeps the line endings exactly "\n" on every operating system.
        self.file = open(path, "w", encoding="utf-8", newline="")
        start_text = start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        self._write("# konjugate data log: 1")
        self._write("# source: " + source)
        self._write("# time: seconds since " + start_text)
        self._write("# inputs: " + ", ".join(inputs))
        self._write("# outputs: " + ", ".join(outputs))
        headings = ["time"] + ["%s [%s]" % (name, units[name]) for name in self.signals]
        headings += ["%s quality" % name for name in self.quality_for]
        self._write(",".join(headings))

    def row(self, seconds, values, qualities=None):
        """Appends one row. `values` maps a signal to its reading; a signal left out gets an empty cell."""
        qualities = qualities or {}
        cells = [_number(seconds)]
        cells += [_number(values[name]) if name in values else "" for name in self.signals]
        cells += [qualities.get(name, "") for name in self.quality_for]
        self._write(",".join(cells))

    def _write(self, line):
        self.file.write(line + "\n")
        self.file.flush()

    def close(self):
        self.file.close()


def _number(value):
    # Enough digits to keep the value, and no more, so the file stays easy to read.
    return format(value, ".10g")


class TankRig:
    """The pretend rig: a heated water tank losing heat to the room.

    Its values are the "true" ones of the Tank Calibration example (examples/tankCalibration.md), so a model calibrated there
    should agree with this rig's readings.
    """

    capacitance = 209000.0  # J/K: how much heat it takes to warm the water by one kelvin
    heat_loss = 20.0        # W/K: how fast the tank loses heat to the room, per kelvin of difference
    heater_power = 1000.0   # W
    ambient = 293.15        # K: the room
    noise = 0.15            # K: how much the thermometer wanders

    # What the operator does: (time in seconds, heater power in watts). On for two hours, off for one, on for two, then off.
    schedule = [(0, heater_power), (7200, 0.0), (10800, heater_power), (18000, 0.0)]

    def __init__(self, seed, glitches):
        self.temperature = self.ambient
        self.random = random.Random(seed)
        self.glitches = set(glitches)

    def heater_at(self, seconds):
        power = 0.0
        for start, value in self.schedule:
            if start <= seconds:
                power = value
        return power

    def advance(self, seconds, power):
        # The tank's temperature after `seconds` with the heater held at `power`. With the heater constant over the stretch, the
        # tank's equation C dT/dt = P + h (T_room - T) has an exact answer, so the pretend rig carries no numerical error of its own.
        settled = self.ambient + power / self.heat_loss
        self.temperature = settled + (self.temperature - settled) * math.exp(-self.heat_loss * seconds / self.capacitance)

    def read_thermometer(self, seconds):
        """A reading and its quality. At a glitch time the sensor reads nonsense, and the logger marks it bad, as many do."""
        if seconds in self.glitches:
            return round(self.temperature + 25.0, 2), "bad"
        return round(self.temperature + self.random.gauss(0.0, self.noise), 2), ""


def main():
    parser = argparse.ArgumentParser(description="A simulated heated-tank rig that writes a Konjugate data log as it runs.")
    parser.add_argument("output", help="the log file to write; it is replaced if it exists")
    parser.add_argument("--duration", type=float, default=21600, help="how long the experiment lasts, in rig seconds (default: six hours)")
    parser.add_argument("--sample", type=float, default=60, help="seconds between thermometer readings (default: 60)")
    parser.add_argument("--speed", type=float, default=1, help="rig seconds per real second: 1 is real time, 600 runs an hour in six seconds")
    parser.add_argument("--start", help="the date and time the experiment starts, with its zone (default: now)")
    parser.add_argument("--seed", type=int, default=1, help="the thermometer noise's seed, so a run can be repeated exactly")
    parser.add_argument("--glitch", type=float, action="append", help="a rig time at which the thermometer glitches (default: 5400)")
    args = parser.parse_args()

    start = datetime.fromisoformat(args.start.replace("Z", "+00:00")) if args.start else datetime.now(timezone.utc).replace(microsecond=0)
    rig = TankRig(args.seed, args.glitch if args.glitch is not None else [5400])
    log = DataLog(
        args.output,
        source="Simulated tank rig (examples/dataSources/simulatedTankRig.py)",
        start=start,
        inputs=["heaterPower"],
        outputs=["tankTemperature"],
        units={"heaterPower": "W", "tankTemperature": "K"},
        quality_for=["tankTemperature"],
    )

    # Everything that happens, in time order: each thermometer reading and each time the operator touches the heater.
    readings = [index * args.sample for index in range(int(args.duration // args.sample) + 1)]
    changes = [moment for moment, _ in rig.schedule if moment <= args.duration]
    moments = sorted(set(readings) | set(changes))

    began = time.monotonic()
    now = 0.0
    power = rig.heater_at(0)
    try:
        for moment in moments:
            rig.advance(moment - now, power)
            now = moment
            # Wait until this moment comes round on the wall clock, so the file grows at the speed asked for, as a real one would.
            delay = began + moment / args.speed - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            values, qualities = {}, {}
            if moment in changes:
                # Inputs are written when they change; between rows a reader holds the last value.
                power = rig.heater_at(moment)
                values["heaterPower"] = power
            if moment in readings:
                values["tankTemperature"], qualities["tankTemperature"] = rig.read_thermometer(moment)
            log.row(moment, values, qualities)
    finally:
        log.close()


if __name__ == "__main__":
    main()
