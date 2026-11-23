# Copyright © 2026 Zenin Easa Panthakkalakath

"""Writes benchmarks/mechanical/doublePendulum/reference.json: a double pendulum released from rest with both arms at 2 rad.

Two point masses m1 = m2 = 1 kg on massless rods L1 = L2 = 1 m, g = 9.81 m/s^2, angles from the downward vertical, d = theta1 - theta2:

    dtheta1/dt = omega1        dtheta2/dt = omega2
    domega1/dt = (-g (2 m1 + m2) sin theta1 - m2 g sin(theta1 - 2 theta2) - 2 sin d m2 (omega2^2 L2 + omega1^2 L1 cos d)) / (L1 (2 m1 + m2 - m2 cos 2d))
    domega2/dt = 2 sin d (omega1^2 L1 (m1 + m2) + g (m1 + m2) cos theta1 + omega2^2 L2 m2 cos d) / (L2 (2 m1 + m2 - m2 cos 2d))

The equations are written out again here, independently of problem.mjs. The motion is chaotic, so the reference is SciPy's solve_ivp with
DOP853 at rtol = atol = 1e-13, and its own error is estimated by solving again at 1e-12 (the difference is recorded at every sample, so the
benchmark compares only where it is negligible). The same is done from theta1 + 1e-9 rad, for the sensitivity to initial conditions.

Reproduce, from the repository root, in a virtual environment outside the repository:

  python3 -m venv /tmp/konjugate-benchmarks-venv
  /tmp/konjugate-benchmarks-venv/bin/pip install numpy scipy
  /tmp/konjugate-benchmarks-venv/bin/python benchmarks/mechanical/doublePendulum/generateReference.py
"""

import json
import math
import platform
from pathlib import Path

import numpy as np
import scipy
from scipy.integrate import solve_ivp

M1 = M2 = 1.0
L1 = L2 = 1.0
G = 9.81
START = [2.0, 2.0, 0.0, 0.0]
PERTURBATION = 1e-9
TARGET = 20.0
OUTPUT_INTERVAL = 1 / 64


def times(target, interval):
    count = round(target / interval)
    return [index * interval for index in range(count + 1)]


def rhs(_t, state):
    theta1, theta2, omega1, omega2 = state
    d = theta1 - theta2
    denominator = 2 * M1 + M2 - M2 * math.cos(2 * d)
    alpha1 = (-G * (2 * M1 + M2) * math.sin(theta1) - M2 * G * math.sin(theta1 - 2 * theta2)
              - 2 * math.sin(d) * M2 * (omega2 ** 2 * L2 + omega1 ** 2 * L1 * math.cos(d))) / (L1 * denominator)
    alpha2 = 2 * math.sin(d) * (omega1 ** 2 * L1 * (M1 + M2) + G * (M1 + M2) * math.cos(theta1) + omega2 ** 2 * L2 * M2 * math.cos(d)) / (L2 * denominator)
    return [omega1, omega2, alpha1, alpha2]


def energy(state):
    theta1, theta2, omega1, omega2 = state
    kinetic = 0.5 * (M1 + M2) * L1 ** 2 * omega1 ** 2 + 0.5 * M2 * L2 ** 2 * omega2 ** 2 + M2 * L1 * L2 * omega1 * omega2 * math.cos(theta1 - theta2)
    return kinetic - (M1 + M2) * G * L1 * math.cos(theta1) - M2 * G * L2 * math.cos(theta2)


def solve(start, tolerance, sample_times):
    solution = solve_ivp(rhs, (0, sample_times[-1]), start, method="DOP853", t_eval=sample_times, rtol=tolerance, atol=tolerance)
    return [list(map(float, row)) for row in solution.y.T], int(solution.nfev)


def main():
    sample_times = times(TARGET, OUTPUT_INTERVAL)
    perturbed_start = [START[0] + PERTURBATION, *START[1:]]
    states, evaluations = solve(START, 1e-13, sample_times)
    check, _ = solve(START, 1e-12, sample_times)
    perturbed, _ = solve(perturbed_start, 1e-13, sample_times)
    perturbed_check, _ = solve(perturbed_start, 1e-12, sample_times)
    scale = energy(START) + (M1 + M2) * G * L1 + M2 * G * L2
    drift = max(abs(energy(state) - energy(START)) for state in states) / scale
    own_error = [max(abs(a - b) for a, b in zip(row, other)) for row, other in zip(states, check)]
    perturbed_own_error = [max(abs(a - b) for a, b in zip(row, other)) for row, other in zip(perturbed, perturbed_check)]
    content = {
        "description": "A double pendulum released from rest with both arms at 2 rad: theta1, theta2 (rad), omega1, omega2 (rad/s), over 20 s, and from theta1 + 1e-9 rad.",
        "provenance": {
            "generator": "benchmarks/mechanical/doublePendulum/generateReference.py",
            "method": "solve_ivp DOP853 at rtol = atol = 1e-13; its own error estimated against 1e-12",
            "python": platform.python_version(),
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "rtol": 1e-13,
            "atol": 1e-13,
            "evaluations": evaluations,
            "energyDrift": drift,
            "perturbation": PERTURBATION,
        },
        "cases": {
            "trajectory": {"columns": ["theta1", "theta2", "omega1", "omega2"], "times": sample_times, "states": states, "ownError": own_error},
            "perturbed": {"columns": ["theta1", "theta2", "omega1", "omega2"], "times": sample_times, "states": perturbed, "ownError": perturbed_own_error},
        },
    }
    path = Path(__file__).resolve().parent / "reference.json"
    path.write_text(json.dumps(content, indent=1) + "\n")
    print(f"Wrote {path.relative_to(Path(__file__).resolve().parents[3])}; energy drift {drift:.2e}.")


if __name__ == "__main__":
    main()
