# Copyright © 2026 Zenin Easa Panthakkalakath

"""Writes benchmarks/modelica/standardLibrary/reference.json: the Modelica Association's reference results for four Modelica Standard
Library examples, and an exact solution of each.

  published  the reference results of the Modelica Standard Library 4.1.0, from the Modelica Association's repository
             github.com/modelica/MAP-LIB_ReferenceResults, branch v4.1.0 (generated with Dymola 2020x, DASSL, tolerance 1e-6, as each
             example's creation.txt records). Downloaded here, not copied by hand: only the compared signals are kept, the extra rows written
             at event instants are dropped (the compared signals are continuous there), and every `stride`-th sample of the output grid
             is kept. These results
             are part of the Modelica Standard Library and are distributed under its BSD 3-Clause licence, copyright the Modelica
             Association and contributors.
  exact      scipy.linalg.expm of each example's linear equations (written out again here from the Modelica sources, not read from the
             JavaScript), with sinusoidal forcing carried as two extra states (s' = w c, c' = -w s) and the Cauer filter's step at 1 s
             by starting the exponential there.

Reproduce, from the repository root, in a virtual environment outside the repository (it fetches the published results over HTTPS):

  python3 -m venv /tmp/konjugate-benchmarks-venv
  /tmp/konjugate-benchmarks-venv/bin/pip install numpy scipy
  /tmp/konjugate-benchmarks-venv/bin/python benchmarks/modelica/standardLibrary/generateReference.py
"""

import csv
import hashlib
import io
import json
import math
import platform
import urllib.request
from pathlib import Path

import numpy as np
import scipy
from scipy.linalg import expm

HERE = Path(__file__).resolve().parent
SOURCE = "https://raw.githubusercontent.com/modelica/MAP-LIB_ReferenceResults/v4.1.0/Modelica"

EXAMPLES = {
    "twoMasses": {"path": "Thermal/HeatTransfer/Examples/TwoMasses", "signals": ["mass1.T", "mass2.T"], "stride": 4},
    "cauerLowPass": {"path": "Electrical/Analog/Examples/CauerLowPassAnalog", "signals": ["C1.v", "C3.v", "C5.v", "L1.i", "L2.i"], "stride": 5},
    "first": {"path": "Mechanics/Rotational/Examples/First", "signals": ["damper.phi_rel", "damper.w_rel", "inertia3.phi", "inertia3.w"], "stride": 4},
    "oscillator": {"path": "Mechanics/Translational/Examples/Oscillator", "signals": ["mass1.s", "mass1.v", "damper1.s_rel", "damper1.v_rel"], "stride": 4},
}


def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()


def published(name, example):
    stem = example["path"].rsplit("/", 1)[1]
    raw = fetch(f"{SOURCE}/{example['path']}/{stem}.csv")
    creation = fetch(f"{SOURCE}/{example['path']}/creation.txt").decode("utf-8", "replace")
    rows = list(csv.reader(io.StringIO(raw.decode("utf-8"))))
    header = rows[0]
    columns = [header.index("time")] + [header.index(signal) for signal in example["signals"]]
    tool = next((line.split("=", 1)[1].strip().strip('"') for line in creation.splitlines() if line.startswith("generationTool=")), "unknown")
    tolerance = next((line.split("=", 1)[1].split("//")[0].strip() for line in creation.splitlines() if line.startswith("Tolerance=")), "unknown")
    interval = float(next(line.split("=", 1)[1].split("//")[0].strip() for line in creation.splitlines() if line.startswith("Interval=")))
    # Dymola also writes a row at each event instant, twice, on the grid or off it (the Cauer filter's step at 1 s is not on its 0.012 s
    # grid). Only the rows on the output grid are kept, one per instant; the compared signals are continuous at the events.
    by_index = {}
    for row in rows[1:]:
        values = [float(row[column]) for column in columns]
        index = round(values[0] / interval)
        if abs(values[0] - index * interval) <= 1e-9 * max(1.0, abs(values[0])):
            by_index[index] = values[1:]
    indexes = sorted(by_index)
    if indexes != list(range(len(indexes))):
        raise RuntimeError(f"{name}: the published samples are not every multiple of {interval} s.")
    kept = indexes[:: example["stride"]]
    times = [index * interval for index in kept]
    return {
        "modelName": f"Modelica.{example['path'].replace('/', '.')}",
        "url": f"{SOURCE}/{example['path']}/{stem}.csv",
        "sha256": hashlib.sha256(raw).hexdigest(),
        "generationTool": tool,
        "tolerance": tolerance,
        "signals": example["signals"],
        "interval": example["stride"] * interval,
        "times": times,
        "values": [by_index[index] for index in kept],
    }


def linear(matrix, forcing, start, times, begin=0.0):
    """x' = A x + b from x(begin) = start; x = start before begin."""
    size = len(start)
    augmented = np.zeros((size + 1, size + 1))
    augmented[:size, :size] = matrix
    augmented[:size, size] = forcing
    initial = np.append(np.asarray(start, dtype=float), 1.0)
    return [(expm(augmented * (t - begin)) @ initial)[:size] if t > begin else np.asarray(start, dtype=float) for t in times]


def two_masses(times):
    c1 = c2 = 15.0
    g = 10.0
    states = linear([[-g / c1, g / c1], [g / c2, -g / c2]], [0, 0], [373.15, 273.15], times)
    return [x.tolist() for x in states]


def cauer(times):
    l1, l2 = 1.304, 0.8586
    c1, c3, c5 = 1.072, 1.682, 0.7262
    c2 = 1 / (1.704992 ** 2 * l1)
    c4 = 1 / (1.179945 ** 2 * l2)
    r1 = r2 = 1.0
    capacitance = np.array([[c1 + c2, -c2, 0], [-c2, c2 + c3 + c4, -c4], [0, -c4, c4 + c5]])
    inverse = np.linalg.inv(capacitance)
    # x = [v1, v2, v3, i1, i2]; node currents q = [(V - v1)/R1 - i1, i1 - i2, i2 - v3/R2]; V = 1 from t = 1 s.
    q = np.array([[-1 / r1, 0, 0, -1, 0], [0, 0, 0, 1, -1], [0, 0, -1 / r2, 0, 1]])
    a = np.zeros((5, 5))
    a[:3, :] = inverse @ q
    a[3, :] = [1 / l1, -1 / l1, 0, 0, 0]
    a[4, :] = [0, 1 / l2, -1 / l2, 0, 0]
    b = np.zeros(5)
    b[:3] = inverse @ np.array([1 / r1, 0, 0])
    return [x.tolist() for x in linear(a, b, np.zeros(5), times, begin=1.0)]


def first(times):
    amplitude, frequency, j_motor, j_load, ratio, damping, j2, stiffness = 10.0, 5.0, 0.1, 2.0, 10.0, 10.0, 2.0, 1e4
    w = 2 * math.pi * frequency
    j = j2 + ratio ** 2 * j_motor  # the motor's inertia seen through the rigid gear
    # x = [phi2, w2, phi3, w3, sin, cos]
    a = np.zeros((6, 6))
    a[0, 1] = 1
    a[1, :] = [-stiffness / j, -damping / j, stiffness / j, 0, ratio * amplitude / j, 0]
    a[2, 3] = 1
    a[3, :] = [stiffness / j_load, 0, -stiffness / j_load, 0, 0, 0]
    a[4, 5] = w
    a[5, 4] = -w
    states = linear(a, np.zeros(6), [0, 0, 0, 0, 0, 1], times)
    return [[-x[0], -x[1], x[2], x[3]] for x in states]  # damper.phi_rel = -phi2, damper.w_rel = -w2


def oscillator(times):
    mass, stiffness, damping, frequency = 1.0, 10000.0, 10.0, 15.9155
    w = 2 * math.pi * frequency
    # x = [s1, v1, s2, v2, sin, cos]; each spring is relaxed with its mass's centre at -0.5 m.
    a = np.zeros((6, 6))
    a[0, 1] = 1
    a[1, :] = [-stiffness / mass, 0, 0, 0, 1 / mass, 0]
    a[2, 3] = 1
    a[3, :] = [0, 0, -stiffness / mass, -damping / mass, 1 / mass, 0]
    a[4, 5] = w
    a[5, 4] = -w
    b = np.array([0, -0.5 * stiffness / mass, 0, -0.5 * stiffness / mass, 0, 0])
    states = linear(a, b, [-0.5, 0, -0.5, 0, 0, 1], times)
    return [[x[0], x[1], 0.5 - x[2], -x[3]] for x in states]  # damper1.s_rel = 0.5 - s2, damper1.v_rel = -v2


EXACT = {"twoMasses": two_masses, "cauerLowPass": cauer, "first": first, "oscillator": oscillator}


def main():
    examples = {}
    for name, example in EXAMPLES.items():
        entry = published(name, example)
        entry["exact"] = EXACT[name](entry["times"])
        examples[name] = entry
        print(f"{name}: {len(entry['times'])} samples every {entry['interval']} s from {entry['generationTool']}")
    content = {
        "provenance": {
            "generator": "benchmarks/modelica/standardLibrary/generateReference.py",
            "method": "The Modelica Association's published reference results (MSL 4.1.0); scipy.linalg.expm for the exact solutions",
            "source": "https://github.com/modelica/MAP-LIB_ReferenceResults (branch v4.1.0); BSD 3-Clause, Modelica Association and contributors",
            "python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__,
        },
        "examples": examples,
    }
    (HERE / "reference.json").write_text(json.dumps(content, indent=1) + "\n")
    print("Wrote benchmarks/modelica/standardLibrary/reference.json.")


if __name__ == "__main__":
    main()
