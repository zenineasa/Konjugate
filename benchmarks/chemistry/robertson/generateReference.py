# Copyright © 2026 Zenin Easa Panthakkalakath

"""Writes benchmarks/chemistry/robertson/reference.json: Robertson's chemical kinetics from y1 = 1, y2 = y3 = 0.

    dy1/dt = -0.04 y1 + 1e4 y2 y3
    dy2/dt =  0.04 y1 - 1e4 y2 y3 - 3e7 y2^2
    dy3/dt =  3e7 y2^2

The equations are written out again here, independently of problem.mjs.

The concentrations at t = 0.4, 4, 40, ..., 4e10 (Hairer and Wanner's checkpoints) and at 1e11 (the end of the IVP test set's problem
ROBER), from SciPy's solve_ivp with Radau (implicit, order 5) and the exact Jacobian at rtol = 1e-12 with an absolute tolerance per
species (1e-20 for y1 and y3, 1e-26 for y2, which falls to 1e-13); and from BDF at the same tolerances as an independent check. The IVP
test set's published values at 1e11 (Mazzia and Magherini, Test Set for IVP Solvers, release 2.4, problem ROBER) are recorded beside
them as a third.

Reproduce, from the repository root, in a virtual environment outside the repository:

  python3 -m venv /tmp/konjugate-benchmarks-venv
  /tmp/konjugate-benchmarks-venv/bin/pip install numpy scipy
  /tmp/konjugate-benchmarks-venv/bin/python benchmarks/chemistry/robertson/generateReference.py
"""

import json
import platform
from pathlib import Path

import numpy as np
import scipy
from scipy.integrate import solve_ivp

RTOL = 1e-12
ATOL = [1e-20, 1e-26, 1e-20]
START = [1.0, 0.0, 0.0]
CHECKPOINTS = [0.4 * 10 ** k for k in range(11)] + [1e11]
# The IVP test set's reference solution of ROBER at t = 1e11.
TEST_SET = [0.2083340149701255e-07, 0.8333360770334713e-13, 0.9999999791665050e00]


def rhs(_t, y):
    return [-0.04 * y[0] + 1e4 * y[1] * y[2], 0.04 * y[0] - 1e4 * y[1] * y[2] - 3e7 * y[1] ** 2, 3e7 * y[1] ** 2]


def jacobian(_t, y):
    return [[-0.04, 1e4 * y[2], 1e4 * y[1]], [0.04, -1e4 * y[2] - 6e7 * y[1], -1e4 * y[1]], [0.0, 6e7 * y[1], 0.0]]


def solve(method):
    solution = solve_ivp(rhs, (0, CHECKPOINTS[-1]), START, method=method, jac=jacobian, t_eval=CHECKPOINTS, rtol=RTOL, atol=ATOL)
    if not solution.success:
        raise RuntimeError(solution.message)
    return solution.y.T.tolist(), int(solution.nfev), int(solution.njev)


def main():
    radau, radau_evaluations, radau_jacobians = solve("Radau")
    bdf, bdf_evaluations, _ = solve("BDF")
    agreement = max(abs(a - b) / max(abs(b), 1e-300) for ra, rb in zip(radau, bdf) for a, b in zip(ra, rb))
    data = {
        "description": "Robertson's chemical kinetics from y1 = 1, y2 = y3 = 0: the three concentrations at Hairer and Wanner's checkpoints and at 1e11.",
        "provenance": {
            "generator": "benchmarks/chemistry/robertson/generateReference.py",
            "method": "solve_ivp Radau with the exact Jacobian; BDF as a check; the IVP test set's published values at 1e11",
            "python": platform.python_version(),
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "rtol": RTOL,
            "atol": ATOL,
        },
        "columns": ["y1", "y2", "y3"],
        "times": CHECKPOINTS,
        "states": radau,
        "bdfStates": bdf,
        "radauBdfAgreement": agreement,
        "radauEvaluations": radau_evaluations,
        "radauJacobians": radau_jacobians,
        "bdfEvaluations": bdf_evaluations,
        "testSetAt1e11": TEST_SET,
    }
    path = Path(__file__).with_name("reference.json")
    path.write_text(json.dumps(data, indent=1) + "\n")
    print(f"wrote {path}: Radau against BDF {agreement:.2e} (relative, worst species and time); Radau at 1e11 {radau[-1]}, test set {TEST_SET}")


if __name__ == "__main__":
    main()
