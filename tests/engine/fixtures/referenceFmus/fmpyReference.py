# Copyright © 2026 Zenin Easa Panthakkalakath
#
# Writes fmpyReference.json: what FMPy computes for each case in cases.json, run in Co-Simulation on the FMI Reference
# FMUs, communication step = the case's stepSize, every value in the case's values set as a start value. The fidelity
# tests (tests/engine/fmiImportFidelity.mjs, fmi3ImportFidelity.mjs) compare Konjugate's imported runs with it.
#
#   python3 -E fmpyReference.py <directory with 2.0/ and 3.0/ from Reference-FMUs.zip> <output json>
#
# Run with FMPy 0.3.21 for the committed file. The FMI 2.0 Reference FMUs carry their Apple Silicon binary only under
# FMI 3.0's name, aarch64-darwin, where FMPy 0.3.21 does not look (it looks in darwin64), so on Apple Silicon each FMU is
# extracted and that same binary copied to darwin64 for FMPy to find.

import json
import platform
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

import fmpy
from fmpy import read_model_description, simulate_fmu

here = Path(__file__).resolve().parent
cases = json.loads((here / 'cases.json').read_text())
root = Path(sys.argv[1])
results = {'fmpy': fmpy.__version__, 'release': cases['release'], 'runs': []}

for fmi_version in ['2.0', '3.0']:
    for case in cases['cases']:
        path = Path(tempfile.mkdtemp()) / case['name']
        with zipfile.ZipFile(root / fmi_version / f"{case['name']}.fmu") as archive:
            archive.extractall(path)
        apple_silicon = path / 'binaries' / 'aarch64-darwin'
        if fmi_version == '2.0' and sys.platform == 'darwin' and platform.machine() == 'arm64' and apple_silicon.is_dir():
            shutil.copytree(apple_silicon, path / 'binaries' / 'darwin64', dirs_exist_ok=True)
        description = read_model_description(str(path))
        variables = {variable.name: variable for variable in description.modelVariables}
        start_values = {}
        for name, value in case['values'].items():
            if name not in variables:
                continue
            start_values[name] = bool(value) if variables[name].type == 'Boolean' else value
        outputs = [variable.name for variable in description.modelVariables
                   if variable.causality == 'output' and variable.type not in ('String', 'Binary')]
        result = simulate_fmu(str(path), fmi_type='CoSimulation', start_time=0, stop_time=case['stopTime'],
                              step_size=case['stepSize'], output_interval=case['stepSize'],
                              start_values=start_values, output=outputs)
        results['runs'].append({
            'fmiVersion': fmi_version, 'name': case['name'],
            'time': [float(value) for value in result['time']],
            'outputs': {name: [float(value) for value in result[name]] for name in outputs}
        })

Path(sys.argv[2]).write_text(json.dumps(results, indent=1) + '\n')
