# Copyright © 2026 Zenin Easa Panthakkalakath

"""Writes benchmarks/electrical/switchedCircuits/reference.json: independent references for the switching circuits.

The constants and equations are written out again here from the problem description (problem.mjs's header), not read from the
JavaScript, so a mistake in either shows up as a disagreement the benchmark run reports.

  Synchronous buck, switched    scipy.linalg.expm, interval by interval between the switching instants (exact, to rounding); and ngspice
                                with two voltage-controlled switches (Ron 20 mOhm, Roff 1e9 Ohm) driven by a 1 ns-edged PULSE gate
  Synchronous buck, averaged    scipy.linalg.expm (exact)
  Half-wave rectifier           solve_ivp DOP853 at rtol = atol = 1e-12, restarted at every diode switching instant located by its event
                                function (numerical; there is no closed form); and ngspice with a switch controlled by its own voltage

ngspice is a cross-check of the circuits as SPICE reads them; its own error (timestep control, the gate's 1 ns edges, interpolation onto
the samples) is recorded by how closely it agrees.

Reproduce, from the repository root, in a virtual environment outside the repository, with ngspice on the PATH:

  python3 -m venv /tmp/konjugate-benchmarks-venv
  /tmp/konjugate-benchmarks-venv/bin/pip install numpy scipy
  brew install ngspice            # or your platform's package
  /tmp/konjugate-benchmarks-venv/bin/python benchmarks/electrical/switchedCircuits/generateReference.py
"""

import json
import math
import platform
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import scipy
from scipy.integrate import solve_ivp
from scipy.linalg import expm

HERE = Path(__file__).resolve().parent

# Synchronous buck converter: 12 V in, 20 kHz, duty 0.4; L = 100 uH with 50 mOhm winding resistance, each switch 20 mOhm on; C = 100 uF
# into a 2 Ohm load. Both switches have the same on-resistance, so the loop resistance is the same in both switch states.
BUCK = dict(vin=12.0, frequency=20e3, duty=0.4, inductance=100e-6, winding=0.05, switch=0.02, capacitance=100e-6, load=2.0)
BUCK_TARGET, BUCK_INTERVAL = 2.0 ** -7, 2.0 ** -17
# Half-wave rectifier: 10 V peak, 50 Hz, a piecewise-linear diode (1 Ohm forward, 1 MOhm reverse), 470 uF and a 100 Ohm load.
RECTIFIER = dict(amplitude=10.0, frequency=50.0, on=1.0, off=1e6, capacitance=470e-6, load=100.0)
RECTIFIER_TARGET, RECTIFIER_INTERVAL = 2.0 ** -3, 2.0 ** -11


def times(target, interval):
    return [index * interval for index in range(round(target / interval) + 1)]


def buck_matrices(on):
    p = BUCK
    r = p["winding"] + p["switch"]
    a = np.array([
        [-r / p["inductance"], -1 / p["inductance"], 0, 0],
        [1 / p["capacitance"], -1 / (p["load"] * p["capacitance"]), 0, 0],
        [p["vin"] if on else 0.0, 0, 0, 0],  # energy drawn from the input, d/dt = s vin i
        [0, 0, 0, 0],
    ])
    b = np.array([p["vin"] / p["inductance"] if on else 0.0, 0, 0, 0])
    augmented = np.zeros((5, 5))
    augmented[:4, :4] = a
    augmented[:4, 4] = b
    return augmented


def buck_switched(sample_times):
    """[i, v, energy in] at each sample, exactly: propagate by expm across each on and off interval in turn."""
    period = 1 / BUCK["frequency"]
    on_length = BUCK["duty"] * period
    state = np.array([0.0, 0.0, 0.0, 0.0, 1.0])
    edges = []
    cycle = 0
    while cycle * period <= sample_times[-1]:
        edges.append((cycle * period, True))
        edges.append((cycle * period + on_length, False))
        cycle += 1
    edges.append((math.inf, None))
    on_matrix, off_matrix = buck_matrices(True), buck_matrices(False)
    result = []
    edge_index = 0
    now = 0.0
    on = True
    for t in sample_times:
        while edges[edge_index + 1][0] <= t:
            next_time = edges[edge_index + 1][0]
            state = expm((on_matrix if on else off_matrix) * (next_time - now)) @ state
            now = next_time
            edge_index += 1
            on = edges[edge_index][1]
        sample = expm((on_matrix if on else off_matrix) * (t - now)) @ state
        result.append(sample[:3].tolist())
    return result


def buck_averaged(sample_times):
    p = BUCK
    r = p["winding"] + p["switch"]
    augmented = np.zeros((4, 4))
    augmented[:3, :3] = [[-r / p["inductance"], -1 / p["inductance"], 0], [1 / p["capacitance"], -1 / (p["load"] * p["capacitance"]), 0], [p["duty"] * p["vin"], 0, 0]]
    augmented[:3, 3] = [p["duty"] * p["vin"] / p["inductance"], 0, 0]
    start = np.array([0.0, 0.0, 0.0, 1.0])
    return [(expm(augmented * t) @ start)[:3].tolist() for t in sample_times]


def rectifier_source(t):
    return RECTIFIER["amplitude"] * math.sin(2 * math.pi * RECTIFIER["frequency"] * t)


def rectifier_rhs(conducting):
    p = RECTIFIER
    resistance = p["on"] if conducting else p["off"]

    def rhs(t, y):
        v = y[0]
        across = rectifier_source(t) - v
        diode = across / resistance
        return [(diode - v / p["load"]) / p["capacitance"], rectifier_source(t) * diode, across * diode, v * v / p["load"]]

    return rhs


def rectifier(sample_times):
    """[v, energy from source, energy in diode, energy in load] by DOP853, restarted at each diode switching instant.

    The diode conducts while the voltage across it, source - v, is positive. At t = 0 both are 0 V and the source is rising, so it starts
    conducting. Each segment's event looks only for the crossing that ends it (falling while conducting, rising while blocking), so the
    zero it starts on is never found again."""
    end = sample_times[-1]
    t0, y0, conducting = 0.0, [0.0, 0.0, 0.0, 0.0], True
    values = {}
    switchings = 0
    while True:
        def across(t, y):
            return rectifier_source(t) - y[0]

        across.terminal = True
        across.direction = -1 if conducting else 1
        solution = solve_ivp(rectifier_rhs(conducting), (t0, end), y0, method="DOP853", rtol=1e-12, atol=1e-12, events=across, dense_output=True)
        stop = solution.t_events[0][0] if solution.status == 1 else end
        for t in sample_times:
            if t0 <= t <= stop and t not in values:
                values[t] = solution.sol(t).tolist()
        if solution.status != 1:
            break
        t0, y0, conducting = stop, solution.y_events[0][0].tolist(), not conducting
        switchings += 1
    return [values[t] for t in sample_times], switchings


def ngspice(netlist, columns):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "circuit.cir"
        output = Path(directory) / "out.txt"
        path.write_text(netlist.replace("OUTPUT", str(output)))
        subprocess.run(["ngspice", "-b", str(path)], check=True, capture_output=True)
        data = np.loadtxt(output)
    # wrdata writes a time column before each vector.
    return data[:, 0], [data[:, 2 * index + 1] for index in range(columns)]


def ngspice_version():
    text = subprocess.run(["ngspice", "--version"], capture_output=True, text=True).stdout
    for line in text.splitlines():
        if "ngspice-" in line:
            return line.strip(" *")
    return "unknown"


def buck_ngspice(sample_times):
    p = BUCK
    period = 1 / p["frequency"]
    netlist = f"""Synchronous buck converter
Vin in 0 DC {p['vin']}
Vgate gate 0 PULSE(0 1 0 1n 1n {p['duty'] * period - 1e-9} {period})
Vgaten gaten 0 PULSE(1 0 0 1n 1n {p['duty'] * period - 1e-9} {period})
S1 in sw gate 0 swmod
S2 sw 0 gaten 0 swmod
.model swmod sw vt=0.5 vh=0 ron={p['switch']} roff=1e9
Rw sw a {p['winding']}
L1 a b {p['inductance']} ic=0
Vsense b out 0
C1 out 0 {p['capacitance']} ic=0
Rload out 0 {p['load']}
.options reltol=1e-7 abstol=1e-12 vntol=1e-9 method=gear maxord=2
.control
tran {BUCK_INTERVAL} {sample_times[-1]} 0 2e-9 uic
linearize v(out) i(Vsense)
wrdata OUTPUT i(Vsense) v(out)
.endc
.end
"""
    grid, (current, voltage) = ngspice(netlist, 2)
    return [[float(np.interp(t, grid, current)), float(np.interp(t, grid, voltage))] for t in sample_times]


def rectifier_ngspice(sample_times):
    p = RECTIFIER
    netlist = f"""Half-wave rectifier, piecewise-linear diode
Vs in 0 SIN(0 {p['amplitude']} {p['frequency']})
S1 in out in out dmod
.model dmod sw vt=0 vh=0 ron={p['on']} roff={p['off']}
C1 out 0 {p['capacitance']} ic=0
Rload out 0 {p['load']}
.options reltol=1e-7 abstol=1e-12 vntol=1e-9 method=gear maxord=2
.control
tran {RECTIFIER_INTERVAL} {sample_times[-1]} 0 1e-6 uic
linearize v(out)
wrdata OUTPUT v(out)
.endc
.end
"""
    grid, (voltage,) = ngspice(netlist, 1)
    return [float(np.interp(t, grid, voltage)) for t in sample_times]


def main():
    buck_times = times(BUCK_TARGET, BUCK_INTERVAL)
    rectifier_times = times(RECTIFIER_TARGET, RECTIFIER_INTERVAL)
    rectifier_states, switchings = rectifier(rectifier_times)
    content = {
        "provenance": {
            "generator": "benchmarks/electrical/switchedCircuits/generateReference.py",
            "method": "Buck: scipy.linalg.expm interval by interval (exact); rectifier: solve_ivp DOP853, rtol = atol = 1e-12, restarted at each diode switching instant; ngspice transient runs of both as a cross-check",
            "python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__, "ngspice": ngspice_version(),
            "rectifierSwitchings": switchings,
        },
        "buck": {
            "times": buck_times,
            "switched": buck_switched(buck_times),
            "averaged": buck_averaged(buck_times),
            "ngspice": buck_ngspice(buck_times),
        },
        "rectifier": {
            "times": rectifier_times,
            "states": rectifier_states,
            "ngspice": rectifier_ngspice(rectifier_times),
        },
    }
    (HERE / "reference.json").write_text(json.dumps(content, indent=1) + "\n")
    print("Wrote benchmarks/electrical/switchedCircuits/reference.json.")


if __name__ == "__main__":
    main()
