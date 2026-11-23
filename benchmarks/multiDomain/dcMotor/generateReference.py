# Copyright © 2026 Zenin Easa Panthakkalakath

"""Writes benchmarks/multiDomain/dcMotor/reference.json: the PID-controlled DC motor by SciPy.

The constants and equations are written out again here from the problem description (problem.mjs's header), not read from the
JavaScript, so a mistake in either shows up as a disagreement the benchmark run reports.

  states   [i, omega, measured omega, error integral, derivative filter, winding T, housing T, supply energy] by solve_ivp DOP853 at
           rtol = 1e-13, atol = 1e-15, in pieces between the setpoint step (4 s) and the load step (8 s) so the solver never steps across
           either (numerical: there is no closed form). The voltage clamp's kinks fall inside the pieces; the error control resolves them.
  radau    solve_ivp Radau at rtol = 1e-10, atol = 1e-12, the same pieces: a check of the reference by a different method

Reproduce, from the repository root, in a virtual environment outside the repository:

  python3 -m venv /tmp/konjugate-benchmarks-venv
  /tmp/konjugate-benchmarks-venv/bin/pip install numpy scipy
  /tmp/konjugate-benchmarks-venv/bin/python benchmarks/multiDomain/dcMotor/generateReference.py
"""

import json
import platform
from pathlib import Path

import numpy as np
import scipy
from scipy.integrate import solve_ivp

HERE = Path(__file__).resolve().parent
R0, T0, ALPHA, L, KM, J, B = 1.0, 293.15, 0.00393, 2e-3, 0.05, 1e-4, 1e-5
CW, CH, RWH, RHA, TA = 5.0, 50.0, 1.0, 2.0, 293.15
TS, TD, KP, KI, KD, VMAX = 1e-3, 5e-3, 0.05, 1.0, 2e-4, 24.0
TARGET, INTERVAL = 12.0, 2.0 ** -6
STEPS = [4.0, 8.0]


def setpoint(t):
    return 200.0 if t < 4.0 else 400.0


def load(t):
    return 0.0 if t < 8.0 else 0.1


def rhs(t, y):
    i, w, wm, xi, xd, tw, th, _energy = y
    v = min(max(KP * (setpoint(t) - wm) + KI * xi - KD * (wm - xd) / TD, -VMAX), VMAX)
    r = R0 * (1 + ALPHA * (tw - T0))
    return [
        (v - r * i - KM * w) / L,
        (KM * i - B * w - load(t)) / J,
        (w - wm) / TS,
        setpoint(t) - wm,
        (wm - xd) / TD,
        (r * i * i - (tw - th) / RWH) / CW,
        ((tw - th) / RWH + B * w * w - (th - TA) / RHA) / CH,
        v * i,
    ]


def solve(method, rtol, atol):
    samples = [index * INTERVAL for index in range(round(TARGET / INTERVAL) + 1)]
    edges = [0.0, *STEPS, TARGET]
    state = [0.0, 0.0, 0.0, 0.0, 0.0, TA, TA, 0.0]
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
            "generator": "benchmarks/multiDomain/dcMotor/generateReference.py",
            "method": "solve_ivp DOP853, rtol = 1e-13, atol = 1e-15, in pieces between the setpoint and load steps; Radau at rtol = 1e-10 as a check",
            "python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__,
        },
        "states": solve("DOP853", 1e-13, 1e-15),
        "radau": solve("Radau", 1e-10, 1e-12),
    }
    (HERE / "reference.json").write_text(json.dumps(content, indent=1) + "\n")
    print("Wrote benchmarks/multiDomain/dcMotor/reference.json.")


if __name__ == "__main__":
    main()
