# Copyright © 2026 Zenin Easa Panthakkalakath

"""Writes benchmarks/chaos/lorenz/reference.json: the Lorenz system's reference trajectory and its attractor's statistics.

    dx/dt = sigma (y - x)    dy/dt = x (rho - z) - y    dz/dt = x y - beta z,    sigma = 10, rho = 28, beta = 8/3, from (1, 1, 1).

The constants and equations are written out again here, independently of problem.mjs.

Trajectory. A chaotic trajectory cannot be followed further than its reference is accurate, and an error grows like e^(0.906 t), so the
reference is a Taylor series method in 50-digit arithmetic (mpmath): order 30, step 1/128 s. Its own error is measured by solving again at
order 40, step 1/256 s, in 70 digits, and recorded (provenance.taylorSelfAgreement). SciPy's solve_ivp (DOP853, rtol = atol = 1e-12) is
solved too, as an independent check and to show where even that loses the trajectory.

Statistics. Long-run properties do not depend on following one trajectory: they are averages over the attractor. They are computed from an
ensemble of trajectories started at points on the attractor, solved together by solve_ivp (DOP853, rtol = atol = 1e-10), each averaged over a
window as long as the benchmark's own run, so the scatter across the ensemble is the scatter one run of that length should show. The largest
Lyapunov exponent is found the same way, from the tangent equations with renormalisation every time unit (Benettin's method).

Reproduce, from the repository root, in a virtual environment outside the repository:

  python3 -m venv /tmp/konjugate-benchmarks-venv
  /tmp/konjugate-benchmarks-venv/bin/pip install numpy scipy mpmath
  /tmp/konjugate-benchmarks-venv/bin/python benchmarks/chaos/lorenz/generateReference.py
"""

import json
import platform
from pathlib import Path

import mpmath
import numpy as np
import scipy
from scipy.integrate import solve_ivp

SIGMA, RHO, BETA = 10.0, 28.0, 8.0 / 3.0
START = [1.0, 1.0, 1.0]
HORIZON = 40.0          # the trajectory reference's length (s)
OUTPUT_INTERVAL = 1 / 64
TRANSIENT = 20.0        # discarded before every statistic, as the benchmark's run does
WINDOW = 500.0          # each statistic's averaging window (s), as the benchmark's run
ENSEMBLE = 200


def times(target, interval):
    count = round(target / interval)
    return [index * interval for index in range(count + 1)]


def taylor(order, steps_per_sample, digits):
    """The Lorenz system by its Taylor series, with the recurrences for the coefficients of the products x z and x y."""
    with mpmath.workdps(digits):
        sigma, rho, beta = mpmath.mpf(10), mpmath.mpf(28), mpmath.mpf(8) / 3
        h = mpmath.mpf(OUTPUT_INTERVAL) / steps_per_sample
        x, y, z = (mpmath.mpf(value) for value in START)
        samples = [[x, y, z]]
        for _sample in range(round(HORIZON / OUTPUT_INTERVAL)):
            for _step in range(steps_per_sample):
                cx, cy, cz = [x], [y], [z]
                for k in range(order):
                    xz = mpmath.fsum(cx[i] * cz[k - i] for i in range(k + 1))
                    xy = mpmath.fsum(cx[i] * cy[k - i] for i in range(k + 1))
                    cx.append(sigma * (cy[k] - cx[k]) / (k + 1))
                    cy.append((rho * cx[k] - cy[k] - xz) / (k + 1))
                    cz.append((xy - beta * cz[k]) / (k + 1))
                x, y, z = (mpmath.polyval(coefficients[::-1], h) for coefficients in (cx, cy, cz))
            samples.append([x, y, z])
        return samples


def rhs(_t, state):
    x, y, z = state
    return [SIGMA * (y - x), x * (RHO - z) - y, x * y - BETA * z]


def ensemble_rhs(_t, flat):
    x, y, z = flat.reshape(3, -1)
    return np.concatenate([SIGMA * (y - x), x * (RHO - z) - y, x * y - BETA * z])


def tangent_rhs(_t, flat):
    x, y, z, dx, dy, dz = flat.reshape(6, -1)
    return np.concatenate([SIGMA * (y - x), x * (RHO - z) - y, x * y - BETA * z,
                           SIGMA * (dy - dx), (RHO - z) * dx - dy - x * dz, y * dx + x * dy - BETA * dz])


def attractor_points():
    """Starting points on the attractor: one long trajectory, past its transient, sampled every 7 s."""
    solution = solve_ivp(rhs, (0, 100 + 7 * ENSEMBLE), START, method="DOP853", t_eval=[100 + 7 * k for k in range(ENSEMBLE)], rtol=1e-10, atol=1e-10)
    return solution.y


def statistics():
    starts = attractor_points()
    window_times = np.arange(0, TRANSIENT + WINDOW + OUTPUT_INTERVAL / 2, 1 / 16)
    solution = solve_ivp(ensemble_rhs, (0, window_times[-1]), starts.reshape(-1), method="DOP853", t_eval=window_times, rtol=1e-10, atol=1e-10)
    x, _y, z = solution.y.reshape(3, ENSEMBLE, -1)
    kept = window_times >= TRANSIENT
    per_member = {
        "meanZ": z[:, kept].mean(axis=1),
        "standardDeviationZ": z[:, kept].std(axis=1),
        "rmsX": np.sqrt((x[:, kept] ** 2).mean(axis=1)),
    }
    # The largest Lyapunov exponent: tangent vectors from (1, 0, 0), renormalised every time unit, their logarithmic growth summed over
    # the same window.
    state = np.concatenate([starts.reshape(-1), np.ones(ENSEMBLE), np.zeros(ENSEMBLE), np.zeros(ENSEMBLE)])
    growth = np.zeros(ENSEMBLE)
    evaluations = int(solution.nfev)
    for unit in range(int(TRANSIENT + WINDOW)):
        step = solve_ivp(tangent_rhs, (unit, unit + 1), state, method="DOP853", rtol=1e-10, atol=1e-10)
        evaluations += int(step.nfev)
        state = step.y[:, -1].copy()
        tangent = state.reshape(6, -1)[3:]
        norms = np.sqrt((tangent ** 2).sum(axis=0))
        if unit >= TRANSIENT:
            growth += np.log(norms)
        tangent /= norms
        state.reshape(6, -1)[3:] = tangent
    per_member["lyapunovExponent"] = growth / WINDOW
    summary = {name: {"mean": float(values.mean()), "windowStandardDeviation": float(values.std(ddof=1)),
                      "standardErrorOfMean": float(values.std(ddof=1) / np.sqrt(ENSEMBLE))} for name, values in per_member.items()}
    return summary, evaluations


def main():
    sample_times = times(HORIZON, OUTPUT_INTERVAL)
    coarse = taylor(order=30, steps_per_sample=2, digits=50)
    fine = taylor(order=40, steps_per_sample=4, digits=70)
    self_agreement = max(float(abs(a - b)) for row, other in zip(coarse, fine) for a, b in zip(row, other))
    states = [[float(value) for value in row] for row in fine]

    dop853 = solve_ivp(rhs, (0, HORIZON), START, method="DOP853", t_eval=sample_times, rtol=1e-12, atol=1e-12)
    dop853_states = [list(map(float, row)) for row in dop853.y.T]

    summary, evaluations = statistics()
    content = {
        "description": "The Lorenz system (sigma = 10, rho = 28, beta = 8/3) from (1, 1, 1): x, y, z over 40 s, and its attractor's statistics.",
        "provenance": {
            "generator": "benchmarks/chaos/lorenz/generateReference.py",
            "method": "Taylor series in multiple precision (mpmath): order 40, step 1/256 s, 70 digits; checked against order 30, step 1/128 s, 50 digits. "
                      "Statistics: an ensemble solved by solve_ivp DOP853 at rtol = atol = 1e-10; the Lyapunov exponent by Benettin's method.",
            "python": platform.python_version(),
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "mpmath": mpmath.__version__,
            "taylorSelfAgreement": self_agreement,
            "dop853Rtol": 1e-12,
            "dop853Atol": 1e-12,
            "statisticsRtol": 1e-10,
            "ensemble": ENSEMBLE,
            "transient": TRANSIENT,
            "window": WINDOW,
            "statisticsEvaluations": evaluations,
            "literatureLyapunovExponent": 0.9056,
            "literature": "Viswanath, D. (1998). Global errors of numerical ODE solvers and Lyapunov's theory of stability (PhD thesis, Cornell): 0.905630 to six figures.",
        },
        "cases": {
            "trajectory": {"columns": ["x", "y", "z"], "times": sample_times, "states": states},
            "dop853": {"columns": ["x", "y", "z"], "times": sample_times, "states": dop853_states},
        },
        "statistics": summary,
    }
    path = Path(__file__).resolve().parent / "reference.json"
    path.write_text(json.dumps(content, indent=1) + "\n")
    print(f"Wrote {path.relative_to(Path(__file__).resolve().parents[3])}; Taylor self-agreement {self_agreement:.2e}.")
    for name, values in summary.items():
        print(f"  {name}: {values['mean']:.6f} (one window's scatter {values['windowStandardDeviation']:.4f})")


if __name__ == "__main__":
    main()
