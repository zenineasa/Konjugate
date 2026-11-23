# Copyright © 2026 Zenin Easa Panthakkalakath

"""Writes benchmarks/showcase/dataCentre/reference.json: the data centre written independently, as one vector ODE.

This is a second implementation of the physics in problem.mjs's header, written from that description alone: no graph, no nodes or
relationships, just the energy balance of every heat capacity assembled into one right-hand side. A mistake in either the Konjugate
model or this one shows up as a disagreement the benchmark run reports.

  temperatures  solve_ivp DOP853 at rtol = 1e-12, atol = 1e-12 K, in pieces between the batch job (300 s) and the coil failure (900 s);
                the cooling units' clamps engage and release inside the pieces, and the error control resolves them
  radau         solve_ivp Radau at rtol = 1e-9, atol = 1e-9 K, the same pieces: a check of the reference by a different method
  heatRemoved   each cooling unit's heat removed over the run (J), integrated with the temperatures

Order of the temperatures: each rack's server then exhaust air (row A racks 1-8, then row B), each row's cold then hot aisle, the plenum,
the room, each cooling unit's coil.

Reproduce, from the repository root, in a virtual environment outside the repository:

  python3 -m venv /tmp/konjugate-benchmarks-venv
  /tmp/konjugate-benchmarks-venv/bin/pip install numpy scipy
  /tmp/konjugate-benchmarks-venv/bin/python benchmarks/showcase/dataCentre/generateReference.py
"""

import json
import platform
from pathlib import Path

import numpy as np
import scipy
from scipy.integrate import solve_ivp

HERE = Path(__file__).resolve().parent

LOADS = [[6e3, 8e3, 10e3, 8e3, 8e3, 10e3, 8e3, 6e3], [8e3, 8e3, 12e3, 12e3, 12e3, 12e3, 8e3, 8e3]]
BOOSTED = [set(), {2, 3, 4, 5}]  # racks of row B (counted from 0) whose load rises by half at 300 s
RECIRCULATION = [0.15, 0.08, 0.03, 0.03, 0.03, 0.03, 0.08, 0.15]
DESIGN_RISE, BYPASS, BOOST, BOOST_AT = 12.0, 0.1, 1.5, 300.0
C_SERVER, UA_SERVER, C_RACK_AIR = 100e3, 2000.0, 2400.0
C_AISLE, C_PLENUM, C_ROOM = 48e3, 120e3, 240e3
UA_ENVELOPE, T_OUTDOOR = 300.0, 303.15
UNITS, C_COIL, T_SET, GAIN, CAPACITY, FAILED, FAILS_AT = 3, 30e3, 291.15, 5000.0, 80e3, 1, 900.0
T_INITIAL = 291.15
TARGET, INTERVAL = 1800.0, 10.0

ROWS, RACKS = len(LOADS), len(LOADS[0])
FLOW = np.array(LOADS) / DESIGN_RISE  # each rack's design flow as m c, W/K
R = np.array(RECIRCULATION)
BYPASS_FLOW = BYPASS * FLOW.sum(axis=1)
COLD_FLOW = ((1 - R) * FLOW).sum(axis=1) + BYPASS_FLOW  # plenum to each cold aisle; also each hot aisle to the room
UNIT_FLOW = COLD_FLOW.sum() / UNITS

# Indices into the state vector.
SERVER = lambda row, rack: 2 * (row * RACKS + rack)
EXHAUST = lambda row, rack: 2 * (row * RACKS + rack) + 1
COLD = lambda row: 2 * ROWS * RACKS + 2 * row
HOT = lambda row: 2 * ROWS * RACKS + 2 * row + 1
PLENUM = 2 * ROWS * RACKS + 2 * ROWS
ROOM = PLENUM + 1
COIL = lambda unit: ROOM + 1 + unit
TEMPERATURES = ROOM + 1 + UNITS
REMOVED = lambda unit: TEMPERATURES + unit  # heat removed by each unit, J


def it_load(row, rack, t):
    base = LOADS[row][rack]
    return base * BOOST if rack in BOOSTED[row] and t >= BOOST_AT else base


def cooling(unit, t, y):
    available = 0.0 if unit == FAILED and t >= FAILS_AT else CAPACITY
    demand = UNIT_FLOW * (y[ROOM] - T_SET) + GAIN * (y[COIL(unit)] - T_SET)
    return min(max(demand, 0.0), available)


def rhs(t, y):
    d = np.zeros_like(y)
    for row in range(ROWS):
        cold, hot = y[COLD(row)], y[HOT(row)]
        for rack in range(RACKS):
            ts, tx = y[SERVER(row, rack)], y[EXHAUST(row, rack)]
            m, r = FLOW[row, rack], R[rack]
            d[SERVER(row, rack)] = (it_load(row, rack, t) - UA_SERVER * (ts - tx)) / C_SERVER
            d[EXHAUST(row, rack)] = ((1 - r) * m * (cold - tx) + r * m * (hot - tx) + UA_SERVER * (ts - tx)) / C_RACK_AIR
        d[COLD(row)] = COLD_FLOW[row] * (y[PLENUM] - cold) / C_AISLE
        d[HOT(row)] = (sum(FLOW[row, rack] * (y[EXHAUST(row, rack)] - hot) for rack in range(RACKS)) + BYPASS_FLOW[row] * (cold - hot)) / C_AISLE
    d[PLENUM] = sum(UNIT_FLOW * (y[COIL(unit)] - y[PLENUM]) for unit in range(UNITS)) / C_PLENUM
    d[ROOM] = (sum(COLD_FLOW[row] * (y[HOT(row)] - y[ROOM]) for row in range(ROWS)) + UA_ENVELOPE * (T_OUTDOOR - y[ROOM])) / C_ROOM
    for unit in range(UNITS):
        q = cooling(unit, t, y)
        d[COIL(unit)] = (UNIT_FLOW * (y[ROOM] - y[COIL(unit)]) - q) / C_COIL
        d[REMOVED(unit)] = q
    return d


def solve(method, rtol, atol):
    samples = [index * INTERVAL for index in range(round(TARGET / INTERVAL) + 1)]
    edges = [0.0, BOOST_AT, FAILS_AT, TARGET]
    state = np.concatenate([np.full(TEMPERATURES, T_INITIAL), np.zeros(UNITS)])
    tolerance = np.concatenate([np.full(TEMPERATURES, atol), np.full(UNITS, atol * 1e6)])
    values = {}
    for start, end in zip(edges[:-1], edges[1:]):
        solution = solve_ivp(rhs, (start, end), state, method=method, rtol=rtol, atol=tolerance, dense_output=True)
        for t in samples:
            if start <= t <= end:
                values[t] = solution.sol(t)
        state = solution.y[:, -1]
    return [values[t] for t in samples]


def main():
    states = solve("DOP853", 1e-12, 1e-12)
    radau = solve("Radau", 1e-9, 1e-9)
    content = {
        "provenance": {
            "generator": "benchmarks/showcase/dataCentre/generateReference.py",
            "method": "An independently written vector ODE of the same physics; solve_ivp DOP853 at rtol = atol = 1e-12 in pieces between the batch job and the failure; Radau at rtol = 1e-9 as a check",
            "python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__,
        },
        "temperatures": [sample[:TEMPERATURES].tolist() for sample in states],
        "radau": [sample[:TEMPERATURES].tolist() for sample in radau],
        "heatRemoved": states[-1][TEMPERATURES:].tolist(),
    }
    (HERE / "reference.json").write_text(json.dumps(content, indent=1) + "\n")
    print("Wrote benchmarks/showcase/dataCentre/reference.json.")


if __name__ == "__main__":
    main()
