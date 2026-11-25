<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

<p><img src="../../assets/icon.svg" width="96" height="96" alt="Konjugate logo"></p>

# FMI compatibility of Konjugate

This page is provided by Konjugate, not by the Modelica Association or the FMI Project. It says which FMI features [Konjugate](https://github.com/zenineasa/Konjugate) supports, with which tools its FMI import and export have been checked, how to repeat each check, and holds example FMUs exported by Konjugate with their reference results.

| | FMI 1.0 | FMI 2.0 | FMI 3.0 |
|---|---|---|---|
| Import (Co-Simulation) | no | yes | yes |
| Import (Model Exchange, Scheduled Execution) | no | no | no |
| Export (Co-Simulation) | no | yes | no |
| Export (Model Exchange, Scheduled Execution) | no | no | no |

FMI import and export are in the desktop app (macOS, Linux and Windows). The web edition neither imports nor exports FMUs. How import and export work is described in [Exporting a simulation as standalone code](../../docs/codeExport.md) (sections "Exporting as an FMU" and "Importing an FMU").

## Importing FMUs

Konjugate imports an FMU as a node of a model: the FMU is run in Co-Simulation, one `fmi2DoStep`/`fmi3DoStep` per substep of the node, its inputs and parameters bound to states or parameters of the model and its outputs setting states. An FMU that offers only Model Exchange is refused when installed, saying so, and so is an FMU with no Co-Simulation (one with Scheduled Execution only, say).

FMUs from these exporters have been imported and simulated successfully:

| Exporter | FMI | FMUs | Checked against | Result | Platform, date |
|---|---|---|---|---|---|
| [Reference FMUs](https://github.com/modelica/Reference-FMUs) v0.0.42 (Modelica Association) | 2.0 Co-Simulation | BouncingBall, Dahlquist, VanDerPol, Stair, Resource, Feedthrough | FMPy 0.3.21, co-simulation of the same FMU at the same communication step | every output at every communication point identical (bit for bit) | macOS 26.7.3, Apple Silicon (arm64), 2026-11-25 |
| Reference FMUs v0.0.42 | 3.0 Co-Simulation | BouncingBall, Dahlquist, VanDerPol, Stair, Resource, Feedthrough | FMPy 0.3.21, as above | every output at every communication point identical (bit for bit) | macOS 26.7.3, Apple Silicon, 2026-11-25 |
| Reference FMUs v0.0.42 | 3.0 Co-Simulation | Dahlquist, VanDerPol, BouncingBall, Stair, each at its own DefaultExperiment | FMPy 0.3.32, as above | largest difference 0 | macOS 26.7.3, Apple Silicon, 2026-11-25 |
| Konjugate (its own FMU export, below) | 2.0 Co-Simulation | a decay model with a live input | the Konjugate engine's run of the model before export | equal to within 1e-9 | macOS 26.7.3, Apple Silicon, 2026-11-25 |

How these are checked. Each Reference FMU is installed and imported as the app does it: every input and parameter bound to a constant state holding the test case's value, every output bound to a state of its own; the model is run with one communication step per global step and each output compared with FMPy's co-simulation of the same FMU. The inputs, parameters, step sizes and stop times are in [cases.json](../../tests/engine/fixtures/referenceFmus/cases.json); FMPy's results are recorded in [fmpyReference.json](../../tests/engine/fixtures/referenceFmus/fmpyReference.json), written by [fmpyReference.py](../../tests/engine/fixtures/referenceFmus/fmpyReference.py) with FMPy 0.3.21. Stair asks to end the simulation at t = 9 s; Konjugate terminates it there and holds its output, as FMPy does. The Reference FMUs release zip is downloaded and checked against its SHA-256 (`b6b4a195…63b1e97`); it is not kept in this repository. The FMI 3.0 benchmark uses the four FMUs kept in [benchmarks/fmi/referenceFmus](../../benchmarks/fmi/referenceFmus) (SHA-256 of each checked) and FMPy 0.3.32's results recorded in its [reference.json](../../benchmarks/fmi/referenceFmus/reference.json).

To repeat them, from the repository root with the engine built (`npm run setup`, then `npm run build:engine`):

```sh
node tests/engine/fmiImportFidelity.mjs     # FMI 2.0: Konjugate's own FMU, then the six Reference FMUs
node tests/engine/fmi3ImportFidelity.mjs    # FMI 3.0: a hand-written FMI 3.0 FMU, then the six Reference FMUs
node benchmarks/run.mjs --accuracy --only fmi/referenceFmus
```

These import checks were run on Apple Silicon macOS only. The Reference FMUs v0.0.42 carry no binary for Intel Macs (FMI 2.0: `aarch64-darwin`, `aarch64-linux`, `linux64`, `win64`, `win32`; FMI 3.0: `aarch64-darwin`, `aarch64-linux`, `x86_64-linux`, `x86_64-windows`, `x86-windows`, and WebAssembly, which Konjugate does not run). Konjugate looks for a binary under its FMI version's directory names and then under the other version's, and chooses the binary built for the computer it runs on and refuses, naming the binaries it found, an FMU with none.

## Exporting FMUs

Konjugate exports a model as an FMI 2.0 Co-Simulation FMU with a compiled binary for the computer it is exported on. Inside `fmi2DoStep` the model is stepped as the Konjugate engine steps it, with Euler node by node or, under Stiff, with Rodas4, Rodas5P or BDF, so the FMU gives the engine's numbers. Every state is an output, every parameter a tunable parameter (a live parameter is an input; one that follows a stored schedule is computed inside the FMU), and `fmi2GetFMUstate`/`fmi2SetFMUstate` and `fmi2SerializeFMUstate` are supported except under Stiff and for programs in the older program format.

Importing tools with which FMUs exported by Konjugate have been simulated successfully:

| Importing tool | Platform | FMUs | Result | Date |
|---|---|---|---|---|
| [FMPy](https://github.com/CATIA-Systems/FMPy) 0.3.21 (Python 3.9.6) | macOS 26.7.3, Apple Silicon | the three example FMUs below, each with its `_ref.opt` | valid (FMPy's `validate_fmu`); every output matches the `_ref.csv` (largest relative difference 0, 0 and 2.2e-16) | 2026-11-25 |
| FMPy 0.3.32 (Python 3.12.15) | macOS 26.7.3, Apple Silicon | the three example FMUs below, each with its `_ref.opt` | valid; every output matches the `_ref.csv` (largest relative difference 0, 0 and 2.2e-16) | 2026-11-25 |
| FMPy 0.3.21 | macOS 26.7.3, Apple Silicon | the export check's FMUs (below) | each agrees with the Konjugate engine's run within the check's tolerances | 2026-11-25 |
| FMPy 0.3.32 | Linux x86_64 and aarch64 (Ubuntu 22.04), macOS x86_64 (macOS 15) and arm64, on GitHub Actions | the export check's FMUs (below) | each agrees with the Konjugate engine's run within the check's tolerances | 2026-11-25, [Konjugate 2.0.2's release checks](https://github.com/zenineasa/Konjugate/actions/runs/45588073540) |

The export check ([fmiExportFidelity.mjs](../../tests/engine/fmiExportFidelity.mjs), `npm run test:fmiExportFidelity`) exports models with a live input, tunable parameters, stored parameter schedules, relationships across nodes, a node in substeps and a C++ program with memory and a clock, under Euler node by node, Verlet, Rodas4, Rodas5P and BDF; FMPy simulates each FMU (setting a tunable parameter through `fmi2SetReal`, and capturing and restoring the FMU state mid-run through FMPy's `FMU2Slave`), and every output at every communication point is compared with the Konjugate engine's own run of the model: to within 1e-6 for the main model, and for the runs under Verlet, Rodas4, Rodas5P and BDF the check prints its largest relative difference, at most 1.8e-12 (Rodas4) on every platform above. It is one of Konjugate's release checks.

Exported FMUs have not been checked on Windows with an FMI tool: Konjugate's release checks compile with GCC/Clang-style flags and do not run there. They have not been checked with tools other than FMPy.

### Validation

The three example FMUs were validated on 2026-11-25 with FMPy's `validate_fmu` (`fmpy validate <file>`), FMPy 0.3.21 (the version behind the FMI Project's online [FMU Check](https://fmu-check.herokuapp.com/)) and FMPy 0.3.32: no problems found. Validation is part of `npm run test:fmiExamples`. They have not been checked with fmusim or VDMCheck.

### Example FMUs

Each folder holds one FMU and the files corresponding to it: `{Model_Name}.fmu`, `{Model_Name}_ref.csv` (the reference result computed by Konjugate: the engine's own run of the project the FMU was exported from), `{Model_Name}_ref.opt` and `Readme.txt` (what the model is, which FMI features it tests). None has inputs, so there is no `_in.csv`.

| Folder | Model | FMI features it tests | Experiment |
|---|---|---|---|
| [ThermalEquilibrium](ThermalEquilibrium) | two thermal masses joined by a conductance (the shipped example [thermalEquilibrium.kjt](../thermalEquilibrium.kjt)) | 2 continuous outputs, 2 tunable parameters, state get/set and serialization | 0 to 60 s, step 1 s |
| [SpringMassDamper](SpringMassDamper) | a damped mass on a spring (the shipped example [springMassDamper.kjt](../springMassDamper.kjt)) | 4 continuous outputs, tunable parameters (two of them named by their relationships, `Spring force.mass` and `Damper force.mass`), a node in substeps, state get/set | 0 to 10 s, step 0.05 s |
| [HeatedRoom](HeatedRoom) | a room heated by a digital PID controller, the C++ program [pidController.cpp](../providers/pidController.cpp) | a continuous and a discrete output, 6 tunable parameters, internal discrete state (memory, a clock, a random stream) carried in the FMU state | 0 to 60 s, step 0.5 s |

What an importing tool should know about them:

- They hold a binary for macOS on Apple Silicon only (`binaries/darwin64/`, arm64). Konjugate does not cross-compile and does not export source code FMUs; an FMU for another platform is made by exporting the same project on that platform, and single-platform FMUs of the same project can be combined with "Merge platform FMUs…" in the export dialog.
- The communication step must be a whole multiple of the FMU's internal step (0.1 s, 0.01 s and 0.005 s); any other step is refused with `fmi2Error`. The `_ref.opt` step sizes are.
- `modelDescription.xml` declares no `DefaultExperiment` and no units; the `_ref.opt` files give the experiment.
- The examples are exported with the Konjugate source after 2.0.2: Konjugate 2.0.2 itself gives two parameters with the same symbol the same name (in SpringMassDamper, `mass` twice), which `validate_fmu` reports.

### Regenerating and checking the examples

```sh
npm run generate:fmi-examples    # builds the engine, exports the FMUs and writes their files (scripts/generateFmiExamples.mjs)
npm test                         # includes tests/fmiExamples.test.mjs (no compiler or FMI tool needed)
npm run test:fmiExamples         # builds the engine, then tests/engine/fmiExamples.mjs (needs a C++ compiler and FMPy)
```

The examples are defined in [scripts/fmiExamples.mjs](../../scripts/fmiExamples.mjs). `tests/fmiExamples.test.mjs` checks that each folder has the files above and that they follow the FMI tools page's rules, and that each FMU's `modelDescription.xml` is the one the exporter writes today; its guid is a hash of the generated C++, so a change to code generation that would change an example fails until the examples are regenerated. `tests/engine/fmiExamples.mjs`, one of the release checks (`npm run test:release`), runs the engine again for each reference result, exports each FMU again, and validates and simulates the committed and the fresh FMU with FMPy against the reference result. When either fails after an intended change to the exporter or the engine's numbers, regenerate the examples and commit the four files of each folder.

**Publishing.** This page is published with the web edition, at [web.konjugate.com/fmi/](https://web.konjugate.com/fmi/), with each release: `.github/workflows/webEdition.yml` renders it with `node scripts/fmiPage.mjs <directory>` ([fmiPage.mjs](../../scripts/fmiPage.mjs)) into `fmi/` beside the built app, with each example's four files to download; links to the rest of the repository become links to it on GitHub, and a link to a file that is not there stops the build. `tests/fmiPage.test.mjs` (in `npm test`) builds it and checks its links.

## Not supported

- FMI 3.0 export (Konjugate exports FMI 2.0 only).
- Model Exchange, for import and export: Konjugate runs an imported FMU in Co-Simulation and exports Co-Simulation FMUs only.
- Scheduled Execution (FMI 3.0), for import and export.
- FMI 1.0, for import and export.
- Source code FMUs: an export holds a compiled binary for one platform.
- Exporting a model under a method other than Euler node by node and Stiff (Rodas4, Rodas5P, BDF), or with a program written in Python: refused at export, saying why.
- On import, String, Binary and Clock variables and arrays are not bound to the model: the FMU keeps its own values for them.
- Layered standards.

## License

The example models are Konjugate's examples (Zero-Clause BSD, [examples/LICENSE](../LICENSE)), except HeatedRoom's controller, [pidController.cpp](../providers/pidController.cpp), which is part of Konjugate. Each FMU's binary also contains code from Konjugate compiled with the model (the FMI functions, `engine/src/fmiGlue.cpp`, and the program SDK), which is under the Mozilla Public License 2.0 ([LICENSE](../../LICENSE)).
