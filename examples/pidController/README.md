<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# A controller from another tool: PidController.fmu

A PI controller for a heated room, drawn in OpenModelica from the Modelica Standard Library's blocks (`Modelica.Blocks.Continuous.LimPID`, in its PI form, with its output limits and anti-windup), exported as an FMI 2.0 Co-Simulation FMU, and connected to a room in Konjugate ([Ports at the top level](../../docs/proposals/rootPorts.md), stage 7).

| File | What it is |
|---|---|
| `PidController.mo` | The model: two inputs, `setpoint` and `measurement` (°C), one output, `command` (0 to 1), and the parameters `k` (1/K) and `Ti` (s), which the FMU offers as tunable. |
| `PidController.fmu` | The FMU, with forward Euler inside, its C sources, and binaries for macOS on Apple Silicon (`binaries/darwin64`), Linux on x86_64 (`binaries/linux64`) and Linux on arm64 (`binaries/aarch64-linux`). |
| `HeatedRoomPid.kjt` | A Konjugate project: a room whose heater is set by the FMU's command, the FMU reading the room's temperature and a setpoint that steps from 18 °C to 21 °C at an hour, and beside it the same room controlled by the same PI controller written in Konjugate, to compare. The FMU is kept in the project's file, so the project opens and runs where the FMU is not in the library yet. |
| `PidController_inputs.csv`, `PidController_ref.csv` | The check's input series (setpoint and measurement, each changing 5 s into a 10 s step) and FMPy's run of the FMU against it, every 10 s. |
| `build.json` | What made the FMU, as `generate.mjs` recorded it. |
| `generate.mjs` | Makes the FMU again (needs Docker). |
| `buildProject.mjs` | Writes `HeatedRoomPid.kjt` from the FMU (needs no Docker). |

## How the FMU was made

`generate.mjs`, run by hand on a Mac with Docker running, never in CI or by the app:

1. In OpenModelica's Docker image pinned by digest (the image Konjugate's benchmarks use, `benchmarks/comparisons/tools.mjs`), for arm64: installs the Modelica Standard Library at a pinned version (`installPackage(Modelica, "4.1.0+maint.om", exactMatch = true)`), checks the model, simulates it with OpenModelica's own forward Euler against the input series, and exports the FMU with `buildModelFMU(PidController, version = "2.0", fmuType = "cs", platforms = {"static"})` after `--fmiFlags=s:euler`. Euler is chosen so the FMU needs no SUNDIALS sources and steps as Konjugate's default method does. OpenModelica, run on arm64, names its aarch64 Linux binary `linux64`; it is kept under `aarch64-linux` instead, since FMI 2.0 tools read `linux64` as x86_64.
2. In the same image for amd64: builds the FMU's own sources with the image's gcc and CMake (`cmake -S sources -B build -D RUNTIME_DEPENDENCIES_LEVEL=modelica`) into the x86_64 Linux binary, `linux64`.
3. On the Mac: builds the same sources with CMake and Apple clang into the arm64 macOS binary, `darwin64`, which links only to the system's own library.
4. Merges the three into one FMU (entries in name order, fixed timestamps), has FMPy validate it (no problem found) and simulate it against the input series, and compares FMPy's run with OpenModelica's own simulation: the FMU's command and OpenModelica's agree exactly (largest difference 0) at every 10 s point but the 20 just after an input change, where the FMU, which reads its inputs at the start of each step, uses the value from before the change by design.

It refuses to start Docker, and labels its containers `konjugate.example=pid-controller` and removes them at the end. Run again, it gives an FMU that runs to the same numbers but is not byte for byte the same: OpenModelica writes a new `guid` and generation time into each FMU it makes. After making the FMU again, run `buildProject.mjs` so the project keeps the new one.

The FMU committed here was made with:

| | |
|---|---|
| Docker image | `openmodelica/openmodelica:v1.27.1-minimal@sha256:ac9a0223e69b8055d444b42f58ccb9680342b56848c68b81385bf83d7c0ba824` (OpenModelica 1.27.1) |
| Modelica Standard Library | 4.1.0 (`4.1.0+maint.om`, OpenModelica package manager revision `8df0769a9cee6ad04ddfff95faee64cd70f662ec`) |
| Linux compiler and CMake | gcc 11.4.0 (Ubuntu 11.4.0-1ubuntu1~22.04.3), CMake 3.22.1, both in the image |
| macOS compiler and CMake | Apple clang 21.0.0 (clang-2100.3.34.2), CMake 4.4.4 |
| FMPy | 0.3.21 |
| FMU SHA-256 | `c78818ad1ef7d5f6c50e4b297141ad714cb430d914a6584a5a0371572d8fcf14` (1 518 114 bytes) |

Binaries for other platforms (macOS on Intel, Windows) are added by running the script on those machines; until then the FMU runs on the three platforms above, and Konjugate says so when it cannot load it elsewhere.

## How it is checked

`tests/engine/pidControllerExample.mjs` (`npm run test:pidControllerExample`, and among the release checks), with Konjugate's own engine:

- The committed FMU, run in Konjugate with its setpoint and measurement read from states following the committed input series, gives FMPy's command (`PidController_ref.csv`) at every one of the 1440 communication points, bit for bit.
- `HeatedRoomPid.kjt`, run as it is: the room the FMU controls and the room Konjugate's PI controls both reach 21 °C, and their temperatures differ by at most 0.05 K over the four hours (0.035 K, just after the setpoint's step, where the FMU reads the new setpoint a step later).

## Licences

The model and the scripts are Konjugate's. The FMU also carries, in its sources and compiled into its binaries, code under the licences reproduced in [`thirdPartyLicenses/pidControllerFmu.txt`](../../thirdPartyLicenses/pidControllerFmu.txt) and listed in [ThirdPartyNotices.md](../../ThirdPartyNotices.md): the Modelica Standard Library (BSD 3-Clause, Modelica Association); OpenModelica's simulation runtime, which its files offer under the BSD 3-Clause licence, AGPL 3 or the OSMC Public License 1.8 at the recipient's choice, here taken under the BSD 3-Clause licence; the FMI 2.0 headers (BSD 2-Clause, Modelica Association Project "FMI"); and, among OpenModelica's solvers, CLAPACK and BLAS (BSD 3-Clause, University of Tennessee and others), the f2c runtime routines (AT&T, Lucent and Bellcore's notice), cminpack (the Minpack licence, University of Chicago) and uthash (BSD, Troy D. Hanson). OpenModelica also puts among the sources a header of libcsv, which no source includes and no binary compiles; the FMU leaves it out.
