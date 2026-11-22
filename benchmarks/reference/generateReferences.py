# Copyright © 2026 Zenin Easa Panthakkalakath

"""Writes the benchmarks' numerical reference data (each problem's reference.json) with NumPy and SciPy.

These are independent implementations: the constants and equations are written out again here, from the problem descriptions, rather
than read from the JavaScript, so a mistake in either shows up as a disagreement the benchmark run reports.

  thermal/rcNetwork        scipy.linalg.expm of the augmented linear system (exact, to rounding)
  electrical/rlcCircuits   scipy.linalg.expm, and the energy dissipated from the energy balance (exact, to rounding)
  mechanical/pendulum      scipy.special.ellipj (exact, to rounding), and solve_ivp DOP853 at rtol = atol = 1e-12 (numerical)
  population/lotkaVolterra solve_ivp DOP853 at rtol = atol = 1e-12 (numerical: there is no closed form)

A numerical reference is a high-accuracy solution by another method, not absolute truth; its own error is recorded with it where it can
be measured (the drift of a conserved quantity).

Reproduce, from the repository root, in a virtual environment outside the repository:

  python3 -m venv /tmp/konjugate-benchmarks-venv
  /tmp/konjugate-benchmarks-venv/bin/pip install numpy scipy
  /tmp/konjugate-benchmarks-venv/bin/python benchmarks/reference/generateReferences.py
"""

import json
import math
import platform
from pathlib import Path

import numpy as np
import scipy
from scipy.integrate import solve_ivp
from scipy.linalg import expm
from scipy.special import ellipj, ellipk

BENCHMARKS = Path(__file__).resolve().parent.parent
RTOL = 1e-12
ATOL = 1e-12


def times(target, interval):
    count = round(target / interval)
    return [index * interval for index in range(count + 1)]


def affine(matrix, forcing, initial, sample_times, offset=None):
    """x' = A x + b, solved for z = x - offset (forcing b + A offset) so an offset near the solution keeps the exponential well scaled."""
    size = len(initial)
    offset = np.zeros(size) if offset is None else np.asarray(offset, dtype=float)
    augmented = np.zeros((size + 1, size + 1))
    augmented[:size, :size] = matrix
    augmented[:size, size] = np.asarray(forcing, dtype=float) + np.asarray(matrix) @ offset
    start = np.append(np.asarray(initial, dtype=float) - offset, 1.0)
    return [(expm(augmented * t) @ start)[:size] + offset for t in sample_times]


def provenance(method, **extra):
    return {
        "generator": "benchmarks/reference/generateReferences.py",
        "method": method,
        "python": platform.python_version(),
        "numpy": np.__version__,
        "scipy": scipy.__version__,
        **extra,
    }


def write(problem, content):
    path = BENCHMARKS / problem / "reference.json"
    path.write_text(json.dumps(content, indent=1) + "\n")
    print(f"Wrote benchmarks/{problem}/reference.json.")


def thermal():
    capacitance = {"A": 5.0e4, "B": 2.0e4, "C": 8.0e4, "D": 3.0e4}
    initial = {"A": 293.15, "B": 295.15, "C": 290.15, "D": 300.15}
    conductances = [("A", "B", 20.0), ("B", "C", 15.0), ("C", "D", 10.0), ("A", "C", 5.0)]
    to_ambient = {"B": 4.0, "D": 8.0}
    ambient, power = 293.15, 500.0
    keys = ["A", "B", "C", "D"]
    n = len(keys)
    matrix = np.zeros((n + 1, n + 1))
    forcing = np.zeros(n + 1)
    for left, right, g in conductances:
        i, j = keys.index(left), keys.index(right)
        matrix[i, j] += g / capacitance[left]
        matrix[i, i] -= g / capacitance[left]
        matrix[j, i] += g / capacitance[right]
        matrix[j, j] -= g / capacitance[right]
    for key, g in to_ambient.items():
        i = keys.index(key)
        matrix[i, i] -= g / capacitance[key]
        forcing[i] += g * ambient / capacitance[key]
        matrix[n, i] += g  # heat lost to ambient, dQ/dt = G (T - T_amb)
        forcing[n] -= g * ambient
    forcing[0] += power / capacitance["A"]
    sample_times = times(16384, 256)
    states = affine(matrix, forcing, [initial[k] for k in keys] + [0.0], sample_times, offset=[ambient] * n + [0.0])
    write("thermal/rcNetwork", {
        "description": "Thermal RC network: temperatures of masses A, B, C, D (K) and heat lost to ambient (J).",
        "provenance": provenance("scipy.linalg.expm of the augmented matrix [[A, b], [0, 0]], in temperatures above ambient"),
        "cases": {"transient": {"columns": ["T_A", "T_B", "T_C", "T_D", "Q_lost"], "times": sample_times, "states": [list(map(float, s)) for s in states]}},
    })


def rlc():
    source = 10.0

    def series():
        r, l, c = 2.0, 10e-3, 100e-6
        matrix = np.array([[-r / l, -1 / l, 0], [1 / c, 0, 0], [1, 0, 0]])
        sample_times = times(2 ** -5, 2 ** -11)
        rows = []
        for i, v, q in affine(matrix, [source / l, 0, 0], [0, 0, 0], sample_times):
            rows.append([float(i), float(v), float(source * q - 0.5 * l * i * i - 0.5 * c * v * v)])
        return {"columns": ["i", "v_C", "E_dissipated"], "times": sample_times, "states": rows}

    def coupled():
        r1, l1, c1 = 2.0, 10e-3, 100e-6
        r2, l2, c2 = 1.0, 20e-3, 50e-6
        rc = 20.0
        # x = [i1, v1, q1, i2, v2]
        matrix = np.array([
            [-r1 / l1, -1 / l1, 0, 0, 0],
            [1 / c1, -1 / (rc * c1), 0, 0, 1 / (rc * c1)],
            [1, 0, 0, 0, 0],
            [0, 0, 0, -r2 / l2, -1 / l2],
            [0, 1 / (rc * c2), 0, 1 / c2, -1 / (rc * c2)],
        ])
        sample_times = times(2 ** -5, 2 ** -11)
        rows = []
        for i1, v1, q1, i2, v2 in affine(matrix, [source / l1, 0, 0, 0, 0], [0] * 5, sample_times):
            stored = 0.5 * (l1 * i1 * i1 + c1 * v1 * v1 + l2 * i2 * i2 + c2 * v2 * v2)
            rows.append([float(i1), float(v1), float(i2), float(v2), float(source * q1 - stored)])
        return {"columns": ["i1", "v1", "i2", "v2", "E_dissipated"], "times": sample_times, "states": rows}

    write("electrical/rlcCircuits", {
        "description": "RLC circuits from rest under a 10 V step: currents (A), capacitor voltages (V) and total energy dissipated (J).",
        "provenance": provenance("scipy.linalg.expm of the augmented matrix, energy dissipated from the energy balance V q - stored"),
        "cases": {"series": series(), "coupled": coupled()},
    })


def pendulum():
    g, length, theta0 = 9.81, 1.0, 2.0
    omega0 = math.sqrt(g / length)
    k = math.sin(theta0 / 2)
    quarter = float(ellipk(k * k))
    sample_times = times(16, 2 ** -4)
    elliptic = []
    for t in sample_times:
        sn, cn, _dn, _ph = ellipj(quarter - omega0 * t, k * k)
        elliptic.append([float(2 * math.asin(k * sn)), float(-2 * k * omega0 * cn)])

    def rhs(_t, y):
        return [y[1], -(g / length) * math.sin(y[0])]

    solution = solve_ivp(rhs, (0, sample_times[-1]), [theta0, 0.0], method="DOP853", t_eval=sample_times, rtol=RTOL, atol=ATOL)
    numeric = [[float(a), float(b)] for a, b in zip(solution.y[0], solution.y[1])]
    energy = [0.5 * length ** 2 * w * w - g * length * math.cos(th) for th, w in numeric]
    write("mechanical/pendulum", {
        "description": "Pendulum released from rest at 2 rad: angle (rad) and angular velocity (rad/s).",
        "provenance": provenance("scipy.special.ellipj (exact), and solve_ivp DOP853", rtol=RTOL, atol=ATOL,
                                 solveIvpEnergyDrift=max(abs(e - energy[0]) for e in energy) / (energy[0] + g * length),
                                 solveIvpEvaluations=int(solution.nfev)),
        "cases": {
            "elliptic": {"columns": ["theta", "omega"], "times": sample_times, "states": elliptic},
            "solveIvp": {"columns": ["theta", "omega"], "times": sample_times, "states": numeric},
        },
    })


def lotka_volterra():
    alpha, beta, delta, gamma = 1.1, 0.4, 0.1, 0.4
    start = [10.0, 10.0]
    sample_times = times(512, 0.5)

    def rhs(_t, y):
        x, p = y
        return [alpha * x - beta * x * p, delta * x * p - gamma * p]

    solution = solve_ivp(rhs, (0, sample_times[-1]), start, method="DOP853", t_eval=sample_times, rtol=RTOL, atol=ATOL)
    states = [[float(a), float(b)] for a, b in zip(solution.y[0], solution.y[1])]
    phase_times = times(32, 2 ** -4)
    phase = solve_ivp(rhs, (0, phase_times[-1]), start, method="DOP853", t_eval=phase_times, rtol=RTOL, atol=ATOL)

    def invariant(x, p):
        return delta * x - gamma * math.log(x) + beta * p - alpha * math.log(p)

    scale = invariant(*start) - invariant(gamma / delta, alpha / beta)
    values = [invariant(x, p) for x, p in states]
    write("population/lotkaVolterra", {
        "description": "Lotka–Volterra prey and predator populations over 512 s.",
        "provenance": provenance("solve_ivp DOP853", rtol=RTOL, atol=ATOL, evaluations=int(solution.nfev),
                                 invariantDrift=max(abs(v - values[0]) for v in values) / scale),
        "cases": {
            "longRun": {"columns": ["prey", "predator"], "times": sample_times, "states": states},
            "phase": {"columns": ["prey", "predator"], "times": phase_times, "states": [[float(a), float(b)] for a, b in zip(phase.y[0], phase.y[1])]},
        },
    })


if __name__ == "__main__":
    thermal()
    rlc()
    pendulum()
    lotka_volterra()
