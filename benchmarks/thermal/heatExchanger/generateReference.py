# Copyright © 2026 Zenin Easa Panthakkalakath

"""Writes benchmarks/thermal/heatExchanger/reference.json: independent references for the segmented heat exchanger.

The constants and equations are written out again here from the problem description (problem.mjs's header), not read from the
JavaScript, so a mistake in either shows up as a disagreement the benchmark run reports.

  steady states   numpy.linalg.solve of the discretised model's equilibrium, for each arrangement and segment count
  effectiveness   the effectiveness-NTU relations of the continuous exchanger
  transient       scipy.linalg.expm of the augmented linear system at each sample (counterflow, 10 segments)

Reproduce, from the repository root, in a virtual environment outside the repository:

  python3 -m venv /tmp/konjugate-benchmarks-venv
  /tmp/konjugate-benchmarks-venv/bin/pip install numpy scipy
  /tmp/konjugate-benchmarks-venv/bin/python benchmarks/thermal/heatExchanger/generateReference.py
"""

import json
import math
import platform
from pathlib import Path

import numpy as np
import scipy
from scipy.linalg import expm

HERE = Path(__file__).resolve().parent
CP = 4180.0
HOT = dict(flow=0.5 * CP, holdup=20 * CP, inlet=360.0)
COLD = dict(flow=1.0 * CP, holdup=40 * CP, inlet=290.0)
UA = 4000.0
INITIAL = 290.0


def system(arrangement, n):
    """Rows 0..n-1 hot segments (flowing 0 -> n-1); rows n..2n-1 cold segments (counterflow: n-1 -> 0; parallel: 0 -> n-1)."""
    a = np.zeros((2 * n, 2 * n))
    b = np.zeros(2 * n)
    g = UA / n
    for k in range(n):
        ch, cc = HOT["holdup"] / n, COLD["holdup"] / n
        h, c = k, n + k
        a[h, h] = -(HOT["flow"] + g) / ch
        a[h, c] = g / ch
        if k == 0:
            b[h] = HOT["flow"] * HOT["inlet"] / ch
        else:
            a[h, h - 1] = HOT["flow"] / ch
        a[c, c] = -(COLD["flow"] + g) / cc
        a[c, h] = g / cc
        upstream = (k + 1 if k < n - 1 else None) if arrangement == "counterflow" else (k - 1 if k > 0 else None)
        if upstream is None:
            b[c] = COLD["flow"] * COLD["inlet"] / cc
        else:
            a[c, n + upstream] = COLD["flow"] / cc
    return a, b


def effectiveness_ntu(arrangement):
    cmin, cmax = min(HOT["flow"], COLD["flow"]), max(HOT["flow"], COLD["flow"])
    cr, ntu = cmin / cmax, UA / cmin
    if arrangement == "counterflow":
        return (1 - math.exp(-ntu * (1 - cr))) / (1 - cr * math.exp(-ntu * (1 - cr)))
    return (1 - math.exp(-ntu * (1 + cr))) / (1 + cr)


def transient(arrangement, n, interval, count):
    a, b = system(arrangement, n)
    size = 2 * n
    augmented = np.zeros((size + 1, size + 1))
    augmented[:size, :size] = a
    augmented[:size, size] = b + a @ np.full(size, INITIAL)
    start = np.append(np.zeros(size), 1.0)
    return [((expm(augmented * (k * interval)) @ start)[:size] + INITIAL).tolist() for k in range(count)]


def main():
    steady = {}
    for arrangement in ("counterflow", "parallel"):
        for n in (10, 40):
            a, b = system(arrangement, n)
            steady[f"{arrangement}{n}"] = np.linalg.solve(a, -b).tolist()
    content = {
        "provenance": {
            "generator": "benchmarks/thermal/heatExchanger/generateReference.py",
            "method": "numpy.linalg.solve for the discretised equilibria; the effectiveness-NTU relations; scipy.linalg.expm for the transient",
            "python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__,
        },
        "steadyStates": steady,
        "effectivenessNtu": {arrangement: effectiveness_ntu(arrangement) for arrangement in ("counterflow", "parallel")},
        "transient": {"arrangement": "counterflow", "segments": 10, "interval": 4.0, "temperatures": transient("counterflow", 10, 4.0, 65)},
    }
    (HERE / "reference.json").write_text(json.dumps(content, indent=1) + "\n")
    print("Wrote benchmarks/thermal/heatExchanger/reference.json.")


if __name__ == "__main__":
    main()
