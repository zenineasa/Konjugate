<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

<p><img src="../../assets/icon.svg" width="96" height="96" alt="Konjugate logo"></p>

# FMI compatibility of Konjugate

This page is provided by Konjugate, not by the Modelica Association or the FMI Project. It says which FMI features [Konjugate](https://github.com/zenineasa/Konjugate) supports, with which tools its FMI import and export have been checked, how to repeat each check, and holds example FMUs exported by Konjugate with their reference results.

| | FMI 1.0 | FMI 2.0 | FMI 3.0 |
|---|---|---|---|
| Import (Co-Simulation) | no | yes | yes |
| Import (Model Exchange, Scheduled Execution) | no | no | no |
| Export (Co-Simulation) | no | yes | yes |
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
| Konjugate (its own FMU export, below) | 3.0 Co-Simulation | a decay model with a live input | the Konjugate engine's run of the model before export | every value identical (bit for bit) from the first step | macOS 26.7.3, Apple Silicon, 2026-11-26 |
| [OpenModelica](https://openmodelica.org) 1.27.1, Modelica Standard Library 4.1.0 | 2.0 Co-Simulation (forward Euler inside), its binaries built from its own C sources | PidController ([its folder](../pidController/)): a PI controller from `Modelica.Blocks.Continuous.LimPID` with two inputs and an output | FMPy 0.3.21, co-simulation of the same FMU against the same input series; and OpenModelica's own simulation of the model | identical to FMPy (bit for bit) at all 1440 communication points; identical to OpenModelica's simulation (largest difference 0) except just after an input change, where the FMU reads its inputs at the start of each step | macOS 26.7.3, Apple Silicon, 2026-11-27 |

How these are checked. Each Reference FMU is installed and imported as the app does it: every input and parameter bound to a constant state holding the test case's value, every output bound to a state of its own; the model is run with one communication step per global step and each output compared with FMPy's co-simulation of the same FMU. The inputs, parameters, step sizes and stop times are in [cases.json](../../tests/engine/fixtures/referenceFmus/cases.json); FMPy's results are recorded in [fmpyReference.json](../../tests/engine/fixtures/referenceFmus/fmpyReference.json), written by [fmpyReference.py](../../tests/engine/fixtures/referenceFmus/fmpyReference.py) with FMPy 0.3.21. Stair asks to end the simulation at t = 9 s; Konjugate terminates it there and holds its output, as FMPy does. The Reference FMUs release zip is downloaded and checked against its SHA-256 (`b6b4a195…63b1e97`); it is not kept in this repository. The FMI 3.0 benchmark uses the four FMUs kept in [benchmarks/fmi/referenceFmus](../../benchmarks/fmi/referenceFmus) (SHA-256 of each checked) and FMPy 0.3.32's results recorded in its [reference.json](../../benchmarks/fmi/referenceFmus/reference.json).

To repeat them, from the repository root with the engine built (`npm run setup`, then `npm run build:engine`):

```sh
node tests/engine/fmiImportFidelity.mjs     # FMI 2.0: Konjugate's own FMU, then the six Reference FMUs
node tests/engine/fmi3ImportFidelity.mjs    # FMI 3.0: a hand-written FMI 3.0 FMU, Konjugate's own FMI 3.0 FMU, then the six Reference FMUs
node tests/engine/pidControllerExample.mjs  # OpenModelica's PidController.fmu against FMPy, and in a closed loop against Konjugate's own PI
node benchmarks/run.mjs --accuracy --only fmi/referenceFmus
```

These import checks were run on Apple Silicon macOS only. The Reference FMUs v0.0.42 carry no binary for Intel Macs (FMI 2.0: `aarch64-darwin`, `aarch64-linux`, `linux64`, `win64`, `win32`; FMI 3.0: `aarch64-darwin`, `aarch64-linux`, `x86_64-linux`, `x86_64-windows`, `x86-windows`, and WebAssembly, which Konjugate does not run). Konjugate looks for a binary under its FMI version's directory names and then under the other version's, and chooses the binary built for the computer it runs on and refuses, naming the binaries it found, an FMU with none.

## Exporting FMUs

Konjugate exports a model as an FMI 2.0 or an FMI 3.0 Co-Simulation FMU (the export dialog's Format: "FMU (FMI 2.0 Co-Simulation)", the default, or "FMU (FMI 3.0 Co-Simulation)") with a compiled binary for the computer it is exported on. Inside `fmi2DoStep`/`fmi3DoStep` the model is stepped as the Konjugate engine steps it, with Euler node by node or, under Stiff, with Rodas4, Rodas5P or BDF, so the FMU gives the engine's numbers; both versions compile the same model code, so an FMI 3.0 FMU gives the FMI 2.0 one's numbers bit for bit. Every state is an output, every parameter a tunable parameter (a live parameter is an input; one that follows a stored schedule is computed inside the FMU), and getting, setting and serializing the FMU state (`fmi2GetFMUstate`/`fmi3GetFMUState` and their kin) are supported except under Stiff and for programs in the older program format.

An FMI 3.0 FMU has the FMI 2.0 one's variables and value references as `<Float64>` variables, declares their units (`<UnitDefinitions>`, each unit by its name as written in the model), adds the independent variable `time` (after the other value references), and states `fixedInternalStepSize`, the step every communication step must be a whole number of. It has no Event Mode, no early return and no intermediate update (`hasEventMode`, `mightReturnEarlyFromDoStep`, `canReturnEarlyAfterIntermediateUpdate` and `providesIntermediateUpdate` are false): `fmi3DoStep` always takes the whole communication step, or refuses it with `fmi3Error` and says why through the logger, as it does any call it refuses.

Importing tools with which FMUs exported by Konjugate have been simulated successfully:

| Importing tool | Platform | FMUs | Result | Date |
|---|---|---|---|---|
| [FMPy](https://github.com/CATIA-Systems/FMPy) 0.3.21 (Python 3.9.6) | macOS 26.7.3, Apple Silicon | the three example FMUs below, each with its `_ref.opt` | valid (FMPy's `validate_fmu`); every output matches the `_ref.csv` (largest relative difference 0, 0 and 2.2e-16) | 2026-11-25 |
| FMPy 0.3.32 (Python 3.12.15) | macOS 26.7.3, Apple Silicon | the three example FMUs below, each with its `_ref.opt` | valid; every output matches the `_ref.csv` (largest relative difference 0, 0 and 2.2e-16) | 2026-11-25 |
| FMPy 0.3.21 | macOS 26.7.3, Apple Silicon | the export check's FMUs (below) | each agrees with the Konjugate engine's run within the check's tolerances | 2026-11-25 |
| FMPy 0.3.32 | Linux x86_64 and aarch64 (Ubuntu 22.04), macOS x86_64 (macOS 15) and arm64, on GitHub Actions | the export check's FMI 2.0 FMUs (below) | each agrees with the Konjugate engine's run within the check's tolerances | 2026-11-25, [Konjugate 2.0.2's release checks](https://github.com/zenineasa/Konjugate/actions/runs/45588073540) |
| FMPy 0.3.21 (Python 3.9.6) and FMPy 0.3.32 (Python 3.12.15) | macOS 26.7.3, Apple Silicon | the three FMI 3.0 example FMUs below, each with its `_ref.opt` | valid (FMPy's `validate_fmu`); every output matches the `_ref.csv` (largest relative difference 0, 2.2e-16 and 0) | 2026-11-26 |
| FMPy 0.3.21 and FMPy 0.3.32 | macOS 26.7.3, Apple Silicon | the FMI 3.0 export check's FMUs (below) | valid; each equals the FMI 2.0 export of the same model bit for bit, and agrees with the Konjugate engine's run within the check's tolerances; FMU state restored mid-run continues to the bit | 2026-11-26 |
| Konjugate's own FMI 3.0 import | macOS 26.7.3, Apple Silicon | a decay model with a live input | identical to the engine's run of the model (above) | 2026-11-26 |

The export check ([fmiExportFidelity.mjs](../../tests/engine/fmiExportFidelity.mjs), `npm run test:fmiExportFidelity`) exports models with a live input, tunable parameters, stored parameter schedules, relationships across nodes, a node in substeps and a C++ program with memory and a clock, under Euler node by node, Verlet, Rodas4, Rodas5P and BDF; FMPy simulates each FMU (setting a tunable parameter through `fmi2SetReal`, and capturing and restoring the FMU state mid-run through FMPy's `FMU2Slave`), and every output at every communication point is compared with the Konjugate engine's own run of the model: to within 1e-6 for the main model, and for the runs under Verlet, Rodas4, Rodas5P and BDF the check prints its largest relative difference, at most 1.8e-12 (Rodas4) on every platform above. It is one of Konjugate's release checks.

The FMI 3.0 export check ([fmi3ExportFidelity.mjs](../../tests/engine/fmi3ExportFidelity.mjs), `npm run test:fmi3ExportFidelity`) exports the three example models, the main model of the check above and that model under Rodas4, Rodas5P and BDF, both as FMI 2.0 and as FMI 3.0. FMPy validates each FMI 3.0 FMU and simulates both; every output at every communication point of the FMI 3.0 FMU must equal the FMI 2.0 FMU's bit for bit, and the Konjugate engine's run: bit for bit for the example models (and for ThermalEquilibrium with its `conductance` changed through `fmi3SetFloat64`), to within 1e-15 for the main model (its scheduled and algebraic states differ from the engine's in the last bit at a few points, the FMI 2.0 FMU's exactly as much), and under Rodas4, Rodas5P and BDF to within 1e-9 (at most 1.8e-12). Through FMPy's `FMU3Slave` an FMU state taken mid-run, serialized and deserialized gives back the outputs and `time` exactly, and the run continued from it repeats the original to the bit; a communication step of 0.15 s against an internal step of 0.1 s is refused with the reason in the log. It is one of Konjugate's release checks, beside the FMI 2.0 one.

Exported FMUs have not been checked on Windows with an FMI tool: Konjugate's release checks compile with GCC/Clang-style flags and do not run there. They have not been checked with tools other than FMPy.

### Validation

The three FMI 2.0 example FMUs were validated on 2026-11-25, and the three FMI 3.0 ones on 2026-11-26, with FMPy's `validate_fmu` (`fmpy validate <file>`), FMPy 0.3.21 (the version behind the FMI Project's online [FMU Check](https://fmu-check.herokuapp.com/)) and FMPy 0.3.32: no problems found. Validation is part of `npm run test:fmiExamples`. The `modelDescription.xml` of each FMI 3.0 example, and of the FMI 3.0 export of every example project under Euler node by node, Rodas4 and BDF (43 in all), was also checked against the FMI 3.0.2 XML schema ([schema/](https://github.com/modelica/fmi-standard/tree/v3.0.2/schema) of the FMI standard) with libxml2 2.9.13's `xmllint --schema fmi3ModelDescription.xsd`: all valid (2026-11-26). They have not been checked with fmusim or VDMCheck.

### Example FMUs

Each folder holds one FMU and the files corresponding to it, the FMI 2.0 examples in a folder of their own and the FMI 3.0 ones in `3.0/`: `{Model_Name}.fmu`, `{Model_Name}_ref.csv` (the reference result computed by Konjugate: the engine's own run of the project the FMU was exported from), `{Model_Name}_ref.opt` and `Readme.txt` (what the model is, which FMI features it tests). None has inputs, so there is no `_in.csv`.

| Folder | Model | FMI features it tests | Experiment |
|---|---|---|---|
| [ThermalEquilibrium](ThermalEquilibrium) | two thermal masses joined by a conductance (the shipped example [thermalEquilibrium.kjt](../thermalEquilibrium.kjt)) | 2 continuous outputs, 2 tunable parameters, state get/set and serialization | 0 to 60 s, step 1 s |
| [SpringMassDamper](SpringMassDamper) | a damped mass on a spring (the shipped example [springMassDamper.kjt](../springMassDamper.kjt)) | 4 continuous outputs, tunable parameters (two of them named by their relationships, `Spring force.mass` and `Damper force.mass`), a node in substeps, state get/set | 0 to 10 s, step 0.05 s |
| [HeatedRoom](HeatedRoom) | a room heated by a digital PID controller, the C++ program [pidController.cpp](../providers/pidController.cpp) | a continuous and a discrete output, 6 tunable parameters, internal discrete state (memory, a clock, a random stream) carried in the FMU state | 0 to 60 s, step 0.5 s |

The same three models as FMI 3.0 FMUs, with the same reference results:

| Folder | Model | FMI features it tests | Experiment |
|---|---|---|---|
| [3.0/ThermalEquilibrium](3.0/ThermalEquilibrium) | two thermal masses joined by a conductance | 2 continuous Float64 outputs, 2 tunable Float64 parameters, declared units, the independent variable `time`, FMU state get/set and serialization | 0 to 60 s, step 1 s |
| [3.0/SpringMassDamper](3.0/SpringMassDamper) | a damped mass on a spring | 4 continuous Float64 outputs, tunable Float64 parameters with units, a node in substeps, FMU state get/set | 0 to 10 s, step 0.05 s |
| [3.0/HeatedRoom](3.0/HeatedRoom) | a room heated by a digital PID controller | 2 Float64 outputs, 6 tunable Float64 parameters with units, internal discrete state carried in the FMU state | 0 to 60 s, step 0.5 s |

What an importing tool should know about them:

- They hold a binary for macOS on Apple Silicon only (`binaries/darwin64/`, arm64, in the FMI 2.0 FMUs; `binaries/aarch64-darwin/` in the FMI 3.0 ones). Konjugate does not cross-compile and does not export source code FMUs; an FMU for another platform is made by exporting the same project on that platform, and single-platform FMUs of the same project can be combined with "Merge platform FMUs…" in the export dialog.
- The communication step must be a whole multiple of the FMU's internal step (0.1 s, 0.01 s and 0.005 s); any other step is refused with `fmi2Error` (`fmi3Error`). The `_ref.opt` step sizes are. An FMI 3.0 FMU states its internal step as `fixedInternalStepSize`.
- `modelDescription.xml` declares the experiment its `_ref.opt` gives as its `<DefaultExperiment>` (start time, stop time and step); the `_ref.opt` files give it as well. The FMI 2.0 FMUs declare no units; the FMI 3.0 ones do.
- The examples are exported with the Konjugate source after 2.0.2: Konjugate 2.0.2 itself gives two parameters with the same symbol the same name (in SpringMassDamper, `mass` twice), which `validate_fmu` reports.

### Regenerating and checking the examples

```sh
npm run generate:fmi-examples    # builds the engine, exports the FMI 2.0 and FMI 3.0 FMUs and writes their files (scripts/generateFmiExamples.mjs)
npm test                         # includes tests/fmiExamples.test.mjs (no compiler or FMI tool needed)
npm run test:fmiExamples         # builds the engine, then tests/engine/fmiExamples.mjs (needs a C++ compiler and FMPy)
```

The examples are defined in [scripts/fmiExamples.mjs](../../scripts/fmiExamples.mjs). `tests/fmiExamples.test.mjs` checks that each folder has the files above and that they follow the FMI tools page's rules, and that each FMU's `modelDescription.xml` is the one the exporter writes today; its guid (FMI 3.0: its instantiationToken) is a hash of the generated C++, so a change to code generation that would change an example fails until the examples are regenerated. `tests/engine/fmiExamples.mjs`, one of the release checks (`npm run test:release`), runs the engine again for each reference result, exports each FMU again, and validates and simulates the committed and the fresh FMU with FMPy against the reference result. When either fails after an intended change to the exporter or the engine's numbers, regenerate the examples and commit the four files of each folder.

**Publishing.** This page is published with the web edition, at [web.konjugate.com/fmi/](https://web.konjugate.com/fmi/), with each release: `.github/workflows/webEdition.yml` renders it with `node scripts/fmiPage.mjs <directory>` ([fmiPage.mjs](../../scripts/fmiPage.mjs)) into `fmi/` beside the built app, with each example's four files to download; links to the rest of the repository become links to it on GitHub, and a link to a file that is not there stops the build. `tests/fmiPage.test.mjs` (in `npm test`) builds it and checks its links.

## Not supported

- Event Mode, early return and intermediate update in an exported FMI 3.0 FMU: `fmi3DoStep` always takes the whole communication step.
- FMI 3.0 clocks, arrays and variable types other than Float64 in an exported FMU: every exported variable is a scalar Float64.
- Model Exchange, for import and export: Konjugate runs an imported FMU in Co-Simulation and exports Co-Simulation FMUs only.
- Scheduled Execution (FMI 3.0), for import and export.
- FMI 1.0, for import and export.
- Source code FMUs: an export holds a compiled binary for one platform.
- Exporting a model under a method other than Euler node by node and Stiff (Rodas4, Rodas5P, BDF), or with a program written in Python: refused at export, saying why.
- On import, String, Binary and Clock variables and arrays are not bound to the model: the FMU keeps its own values for them.
- Layered standards.

## License

The example models are Konjugate's examples (Zero-Clause BSD, [examples/LICENSE](../LICENSE)), except HeatedRoom's controller, [pidController.cpp](../providers/pidController.cpp), which is part of Konjugate. Each FMU's binary also contains code from Konjugate compiled with the model (the FMI functions, `engine/src/fmiGlue.cpp` or `engine/src/fmi3Glue.cpp`, and the program SDK), which is under the Mozilla Public License 2.0 ([LICENSE](../../LICENSE)).
