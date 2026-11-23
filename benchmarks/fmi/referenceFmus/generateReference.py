# Copyright © 2026 Zenin Easa Panthakkalakath

"""Writes benchmarks/fmi/referenceFmus/reference.json: FMPy's simulations of four FMI 3.0 Reference FMUs.

The FMUs in fmus/ are the Modelica Association's Reference FMUs v0.0.42 (github.com/modelica/Reference-FMUs, release v0.0.42,
Reference-FMUs.zip, 3.0/), unchanged; their SHA-256 is recorded here and checked by the benchmark. For each, at its own
DefaultExperiment (stop time and step):

  coSimulation   FMPy's co-simulation of the FMU, one fmi3DoStep per communication step of the experiment's step size: the same FMU,
                 driven the way Konjugate drives an imported FMU (once per global step), so an import should give these numbers exactly
  modelExchange  FMPy's model exchange of the same FMU with CVODE at a relative tolerance of 1e-10, events located: the FMU's equations
                 solved accurately, against which the co-simulation's own fixed-step solver error is measured
  exact          the closed form where there is one: Dahlquist x = e^(-k t); Stair, which counts the seconds, floor(t) + 1

Reproduce, from the repository root, in a virtual environment outside the repository (FMPy 0.3.32 or later carries CVODE for Apple
Silicon; 0.3.21 does not):

  uv venv -p 3.12 /tmp/konjugate-fmpy-venv
  VIRTUAL_ENV=/tmp/konjugate-fmpy-venv uv pip install fmpy numpy
  /tmp/konjugate-fmpy-venv/bin/python benchmarks/fmi/referenceFmus/generateReference.py
"""

import hashlib
import json
import math
import platform
from pathlib import Path

import fmpy
import numpy as np
from fmpy import read_model_description, simulate_fmu

HERE = Path(__file__).resolve().parent
FMUS = ["Dahlquist", "VanDerPol", "BouncingBall", "Stair"]


def exact(name, times):
    if name == "Dahlquist":
        return [[math.exp(-t)] for t in times]
    if name == "Stair":
        return [[float(math.floor(t + 1e-9) + 1)] for t in times]
    return None


def main():
    content = {
        "provenance": {
            "generator": "benchmarks/fmi/referenceFmus/generateReference.py",
            "method": "FMPy co-simulation at each FMU's DefaultExperiment step; FMPy model exchange with CVODE, rtol 1e-10",
            "fmus": "Modelica Association Reference FMUs v0.0.42 (3.0), https://github.com/modelica/Reference-FMUs/releases/tag/v0.0.42; 2-Clause BSD",
            "python": platform.python_version(), "numpy": np.__version__, "fmpy": fmpy.__version__,
        },
        "fmus": {},
    }
    for name in FMUS:
        path = HERE / "fmus" / f"{name}.fmu"
        description = read_model_description(str(path))
        experiment = description.defaultExperiment
        stop, step = float(experiment.stopTime), float(experiment.stepSize)
        outputs = [variable.name for variable in description.modelVariables if variable.causality == "output"]
        co = simulate_fmu(str(path), fmi_type="CoSimulation", stop_time=stop, output_interval=step, step_size=step, output=outputs)
        me = simulate_fmu(str(path), fmi_type="ModelExchange", solver="CVode", relative_tolerance=1e-10, stop_time=stop, output_interval=step,
                          output=outputs, record_events=False)
        times = [round(float(t) / step) * step for t in co["time"]]
        entry = {
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "fmiVersion": description.fmiVersion,
            "stopTime": stop, "stepSize": step, "outputs": outputs,
            "variables": [{"name": v.name, "causality": v.causality, "variability": v.variability, "type": v.type} for v in description.modelVariables
                          if v.causality in ("input", "output", "parameter")],
            "times": times,
            "coSimulation": [[float(row[name_]) for name_ in outputs] for row in co],
            "modelExchange": [[float(row[name_]) for name_ in outputs] for row in me],
        }
        closed = exact(name, times)
        if closed is not None:
            entry["exact"] = closed
        content["fmus"][name] = entry
        print(f"{name}: {len(times)} samples, outputs {outputs}, {len(entry['modelExchange'])} model-exchange samples")
    (HERE / "reference.json").write_text(json.dumps(content, indent=1) + "\n")
    print("Wrote benchmarks/fmi/referenceFmus/reference.json.")


if __name__ == "__main__":
    main()
