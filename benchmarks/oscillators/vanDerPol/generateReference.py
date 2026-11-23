# Copyright © 2026 Zenin Easa Panthakkalakath

"""Writes benchmarks/oscillators/vanDerPol/reference.json: the Van der Pol oscillator at mu = 1, 10 and 1000, from x = 2, y = 0.

    dx/dt = y        dy/dt = mu (1 - x^2) y - x

The equations are written out again here, independently of problem.mjs.

Trajectories: SciPy's solve_ivp with Radau (implicit, order 5, suited to the stiff mu = 1000) at rtol = atol = 1e-12, and, for mu = 1 and 10,
DOP853 at the same tolerances as an independent check. The limit cycle's period and amplitude: event location on the same solutions, after a
transient of several periods, the period from successive upward zero crossings of x and the amplitude from the largest x (where y = 0).
mu = 1000 is stiff; its data is here so that a stiff method can be benchmarked against it when Konjugate has one.

Reproduce, from the repository root, in a virtual environment outside the repository:

  python3 -m venv /tmp/konjugate-benchmarks-venv
  /tmp/konjugate-benchmarks-venv/bin/pip install numpy scipy
  /tmp/konjugate-benchmarks-venv/bin/python benchmarks/oscillators/vanDerPol/generateReference.py
"""

import json
import platform
from pathlib import Path

import numpy as np
import scipy
from scipy.integrate import solve_ivp

RTOL = ATOL = 1e-12
START = [2.0, 0.0]
CASES = {
    "mu1": {"mu": 1.0, "targetTime": 40.0, "outputInterval": 1 / 16, "cycleTime": 120.0, "check": True},
    "mu10": {"mu": 10.0, "targetTime": 64.0, "outputInterval": 1 / 32, "cycleTime": 400.0, "check": True},
    "mu1000": {"mu": 1000.0, "targetTime": 3200.0, "outputInterval": 0.5, "cycleTime": 8000.0, "check": False},
}


def times(target, interval):
    count = round(target / interval)
    return [index * interval for index in range(count + 1)]


def system(mu):
    def rhs(_t, state):
        x, y = state
        return [y, mu * (1 - x * x) * y - x]

    def jacobian(_t, state):
        x, y = state
        return [[0.0, 1.0], [-2 * mu * x * y - 1, mu * (1 - x * x)]]

    return rhs, jacobian


def solve(mu, method, target, sample_times=None, events=None):
    rhs, jacobian = system(mu)
    extra = {"jac": jacobian} if method == "Radau" else {}
    return solve_ivp(rhs, (0, target), START, method=method, t_eval=sample_times, events=events, rtol=RTOL, atol=ATOL, **extra)


def limit_cycle(mu, method, target):
    upward = lambda _t, state: state[0]
    upward.direction = 1
    turning = lambda _t, state: state[1]
    turning.direction = -1
    solution = solve(mu, method, target, events=[upward, turning])
    crossings = solution.t_events[0]
    peaks = solution.y_events[1][:, 0]
    # The last few cycles, well past the transient.
    periods = np.diff(crossings[-4:])
    return {"period": float(periods.mean()), "periodSpread": float(periods.max() - periods.min()), "amplitude": float(peaks[-3:].mean()),
            "cycles": int(len(crossings)), "evaluations": int(solution.nfev)}


def main():
    cases = {}
    for key, case in CASES.items():
        mu = case["mu"]
        sample_times = times(case["targetTime"], case["outputInterval"])
        radau = solve(mu, "Radau", case["targetTime"], sample_times)
        entry = {
            "mu": mu, "columns": ["x", "y"], "times": sample_times, "states": [list(map(float, row)) for row in radau.y.T],
            "radauEvaluations": int(radau.nfev), "limitCycle": limit_cycle(mu, "Radau", case["cycleTime"]),
        }
        if case["check"]:
            dop853 = solve(mu, "DOP853", case["targetTime"], sample_times)
            entry["dop853States"] = [list(map(float, row)) for row in dop853.y.T]
            entry["dop853LimitCycle"] = limit_cycle(mu, "DOP853", case["cycleTime"])
        cases[key] = entry
        print(f"mu = {mu:g}: period {entry['limitCycle']['period']:.10f} s, amplitude {entry['limitCycle']['amplitude']:.10f}")
    content = {
        "description": "The Van der Pol oscillator from x = 2, y = 0 at mu = 1, 10 and 1000: x and y = dx/dt, and the limit cycle's period and amplitude.",
        "provenance": {
            "generator": "benchmarks/oscillators/vanDerPol/generateReference.py",
            "method": "solve_ivp Radau with the exact Jacobian; DOP853 as a check for mu = 1 and 10; event location for the period and amplitude",
            "python": platform.python_version(),
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "rtol": RTOL,
            "atol": ATOL,
        },
        "cases": cases,
    }
    path = Path(__file__).resolve().parent / "reference.json"
    path.write_text(json.dumps(content, indent=1) + "\n")
    print(f"Wrote {path.relative_to(Path(__file__).resolve().parents[3])}.")


if __name__ == "__main__":
    main()
