# Copyright © 2026 Zenin Easa Panthakkalakath

"""Writes benchmarks/fluid/pipeNetwork/reference.json: the pumped fluid network by SciPy.

The constants and equations are written out again here from the problem description (problem.mjs's header), not read from the
JavaScript, so a mistake in either shows up as a disagreement the benchmark run reports.

  states   solve_ivp DOP853 at rtol = 1e-13, atol = 1e-15, integrated in pieces between the valve's kinks (300 s and 305 s), so the solver
           never steps across one (numerical: there is no closed form). The suite's usual rtol = atol = 1e-12 leaves the throttled valve
           pipe's flow good only to about 1e-8 of its range, which Runge-Kutta 4's finer steps reach; at these tolerances it agrees with a
           run at rtol = 3e-14 to about 1e-11 of range.
  radau    solve_ivp Radau at rtol = 1e-10, atol = 1e-12, the same pieces: a check of the reference by a different method

Reproduce, from the repository root, in a virtual environment outside the repository:

  python3 -m venv /tmp/konjugate-benchmarks-venv
  /tmp/konjugate-benchmarks-venv/bin/pip install numpy scipy
  /tmp/konjugate-benchmarks-venv/bin/python benchmarks/fluid/pipeNetwork/generateReference.py
"""

import json
import math
import platform
from pathlib import Path

import numpy as np
import scipy
from scipy.integrate import solve_ivp

HERE = Path(__file__).resolve().parent
RHO, G = 1000.0, 9.81
PIPE_AREA = math.pi * 0.1 ** 2 / 4
INERTANCE = RHO * 50.0 / PIPE_AREA
FRICTION = 0.02 * (50.0 / 0.1) * RHO / (2 * PIPE_AREA ** 2)
VALVE = 20.0 * RHO / (2 * PIPE_AREA ** 2)
BASE = {"upper": 10.0, "middle": 0.5, "sump": 0.0}
AREA = {"upper": 0.5, "middle": 0.25, "sump": 0.75}
LEVEL = {"upper": 2.0, "middle": 3.0, "sump": 4.0}
SHUTOFF_HEAD, RATED_FLOW = 14.0, 0.05
TARGET, INTERVAL = 600.0, 2.0
KINKS = [300.0, 305.0]


def opening(t):
    if t < 300.0:
        return 1.0
    if t < 305.0:
        return 1.0 - 0.7 * (t - 300.0) / 5.0
    return 0.3


def rhs(t, y):
    hu, hm, hs, qp, qv, qr = y
    head = {"upper": BASE["upper"] + hu, "middle": BASE["middle"] + hm, "sump": BASE["sump"] + hs}
    pump = RHO * G * SHUTOFF_HEAD * (1 - qp * abs(qp) / RATED_FLOW ** 2)
    dqp = (RHO * G * (head["sump"] - head["upper"]) + pump - FRICTION * qp * abs(qp)) / INERTANCE
    dqv = (RHO * G * (head["upper"] - head["middle"]) - (FRICTION + VALVE / opening(t) ** 2) * qv * abs(qv)) / INERTANCE
    dqr = (RHO * G * (head["middle"] - head["sump"]) - FRICTION * qr * abs(qr)) / INERTANCE
    return [(qp - qv) / AREA["upper"], (qv - qr) / AREA["middle"], (qr - qp) / AREA["sump"], dqp, dqv, dqr]


def solve(method, rtol, atol):
    samples = [index * INTERVAL for index in range(round(TARGET / INTERVAL) + 1)]
    edges = [0.0, *KINKS, TARGET]
    state = [LEVEL["upper"], LEVEL["middle"], LEVEL["sump"], 0.0, 0.0, 0.0]
    values = {}
    for start, end in zip(edges[:-1], edges[1:]):
        solution = solve_ivp(rhs, (start, end), state, method=method, rtol=rtol, atol=atol, dense_output=True)
        for t in samples:
            if start <= t <= end:
                values[t] = solution.sol(t).tolist()
        state = solution.y[:, -1].tolist()
    return [values[t] for t in samples]


def main():
    content = {
        "provenance": {
            "generator": "benchmarks/fluid/pipeNetwork/generateReference.py",
            "method": "solve_ivp DOP853, rtol = 1e-13, atol = 1e-15, in pieces between the valve's kinks; Radau at rtol = 1e-10 as a check",
            "python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__,
        },
        "states": solve("DOP853", 1e-13, 1e-15),
        "radau": solve("Radau", 1e-10, 1e-12),
    }
    (HERE / "reference.json").write_text(json.dumps(content, indent=1) + "\n")
    print("Wrote benchmarks/fluid/pipeNetwork/reference.json.")


if __name__ == "__main__":
    main()
