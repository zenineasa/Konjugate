#!/usr/bin/env python3
# Copyright © 2026 Zenin Easa Panthakkalakath
"""An invented lab experiment, logged the way a real lab's logger logs it.

A 120-litre water vessel in a university lab: a 3 kW heater switched by a thermostat around a setpoint the operator changes, a
cold-water inlet valve the operator opens now and then, a room whose temperature wanders through the day, and two thermometers: TC1
in the water, and TC2 in a pocket in the wall, which is slow and reads 0.6 K high. Late in the run the heater's element scales up
and gives less heat for the same setting, the kind of slow change a digital twin is for.

The logger is not Konjugate's. It writes its own CSV, as such loggers do: semicolons and decimal commas, local time with no zone
(Europe/Berlin, and the run crosses the night the clocks go back, so an hour of timestamps repeats), degrees Celsius, the heater as a
percentage, the valve as OPEN or CLOSED, a reading every five seconds or so, ERR where a reading failed, and a restart part way
through that repeats the header and leaves a gap. docs/connectingADataSource.md, "Reading another logger's file", shows Konjugate
reading it as it is; tests/engine/labTrial.mjs works through the whole experiment.

    python3 examples/dataSources/labVessel.py vessel.csv              # eight hours, in real time
    python3 examples/dataSources/labVessel.py vessel.csv --speed 600  # the same eight hours in 48 seconds
"""

import argparse
import math
import random
import time
from datetime import datetime, timedelta, timezone

# The vessel as it really is (the model's starting guesses are different: see scripts/generateLabVesselModel.mjs).
CAPACITANCE = 120 * 4180.0       # J/K: 120 kg of water
HEAT_LOSS = 15.0                 # W/K to the room
HEATER_POWER = 3000.0            # W at 100 %
INFLOW = 0.015                   # kg/s through the open valve
INLET = 285.15                   # K: the cold water, not logged (the lab knows it)
WATER_CP = 4180.0                # J/(kg K)

# What the operator does, in hours from the start: setpoints (°C) and the valve.
SETPOINTS = [(0.0, 57.0), (3.5, 47.0), (6.25, 52.0)]
VALVE_OPEN = [(2.0, 2.5), (5.5, 5.75)]
HYSTERESIS = 0.5                 # K either side of the setpoint
SCALING_STARTS = 5.0             # hours: from then the heater gives less and less
SCALING_RATE = 0.10              # of its heat lost per hour

LOGGER_START = datetime(2026, 10, 25, 0, 30, 0)   # local wall-clock time in Berlin, CEST (UTC+2) until 03:00, then CET (UTC+1)
RESTART_AT = 4 * 3600 + 600      # seconds: the logger restarts here
RESTART_GAP = 420                # and is gone for seven minutes


def berlin_wall_clock(utc):
    """Europe/Berlin local time for a UTC instant, around the October 2026 change (03:00 CEST becomes 02:00 CET at 01:00 UTC)."""
    change = datetime(2026, 10, 25, 1, 0, 0, tzinfo=timezone.utc)
    return (utc + (timedelta(hours=2) if utc < change else timedelta(hours=1))).replace(tzinfo=None)


def setpoint_at(hours):
    value = SETPOINTS[0][1]
    for start, setting in SETPOINTS:
        if start <= hours:
            value = setting
    return value + 273.15


def valve_open_at(hours):
    return any(start <= hours < end for start, end in VALVE_OPEN)


def ambient_at(seconds):
    return 291.15 + 1.5 * math.sin(2 * math.pi * (seconds / 86400.0 - 0.1))


def heater_efficiency_at(hours):
    return 1.0 - SCALING_RATE * max(0.0, hours - SCALING_STARTS)


def number(value, places):
    return f"{value:.{places}f}".replace(".", ",")


def main():
    parser = argparse.ArgumentParser(description="An invented lab vessel, logged by a logger that is not Konjugate's.")
    parser.add_argument("output", help="the logger's file; replaced if it exists")
    parser.add_argument("--hours", type=float, default=8.0)
    parser.add_argument("--speed", type=float, default=1.0, help="rig seconds per real second")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    utc_start = LOGGER_START.replace(tzinfo=timezone(timedelta(hours=2))).astimezone(timezone.utc)
    duration = args.hours * 3600
    header = "Datum;Uhrzeit;TC1 (°C);TC2 (°C);Heizung (%);Ventil;Raum (°C)"

    water = 288.15          # filled from the cold supply
    pocket = water          # TC2's slow pocket
    heating = True
    next_log = 0.0
    began = time.monotonic()
    restarted = False
    with open(args.output, "w", encoding="utf-8", newline="") as log:
        log.write(header + "\r\n")
        log.flush()
        seconds = 0.0
        step = 1.0
        while seconds <= duration:
            hours = seconds / 3600
            # The thermostat switches on the water's own temperature.
            target = setpoint_at(hours)
            if heating and water > target + HYSTERESIS:
                heating = False
            elif not heating and water < target - HYSTERESIS:
                heating = True
            power = HEATER_POWER * heater_efficiency_at(hours) if heating else 0.0
            flow = INFLOW if valve_open_at(hours) else 0.0
            ambient = ambient_at(seconds)
            if seconds >= next_log:
                in_gap = RESTART_AT <= seconds < RESTART_AT + RESTART_GAP
                if not in_gap:
                    if seconds >= RESTART_AT + RESTART_GAP and not restarted:
                        restarted = True
                        log.write(header + "\r\n")   # a restarted logger writes its header again
                    wall = berlin_wall_clock(utc_start + timedelta(seconds=round(seconds)))
                    tc1 = "ERR" if rng.random() < 0.002 else number(water - 273.15 + rng.gauss(0, 0.08), 2)
                    tc2 = "ERR" if rng.random() < 0.002 else number(pocket - 273.15 + 0.6 + rng.gauss(0, 0.05), 2)
                    row = [wall.strftime("%d.%m.%Y"), wall.strftime("%H:%M:%S"), tc1, tc2, "100" if heating else "0",
                           "OPEN" if flow else "CLOSED", number(ambient - 273.15 + rng.gauss(0, 0.05), 1)]
                    delay = began + seconds / args.speed - time.monotonic()
                    if delay > 0:
                        time.sleep(delay)
                    log.write(";".join(row) + "\r\n")
                    log.flush()
                next_log += 5.0 + rng.uniform(-0.4, 0.4)
            # The vessel, one second on.
            gain = power + HEAT_LOSS * (ambient - water) + flow * WATER_CP * (INLET - water)
            water += step * gain / CAPACITANCE
            pocket += step * (water - pocket) / 90.0
            seconds += step


if __name__ == "__main__":
    main()
