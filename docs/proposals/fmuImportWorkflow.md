---
type: Proposal
title: The FMU round trip
description: "Proposed, design only. Fixing the Co-Simulation round trip from a person's side: export a model as an FMU, bring it back (or any FMU) into a project as a node that runs with no wiring, connect FMUs to each other, run and compare with the original. Today it works and is exact (bit for bit, measured in the app) but takes about forty actions, two dead ends and knowledge nobody is told. The proposal: an Add › FMU… entry point and drag-and-drop; the node built from the FMU (its outputs as states, its parameters and inputs at the FMU's own start values, units and descriptions shown); connections picked by name and drawn on the canvas; step rules checked before the run; failures said on screen; an export dialog and notice that lead into the round trip and a comparison; the FMU kept inside the project so a shared file runs elsewhere; a tutorial. Nine small stages; SSP, Model Exchange and FMUs on the web left for later."
tags: [proposals, fmi, fmu, import, export, ux, tutorials]
status: draft
implementation: none
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# The FMU round trip

**Status: proposed 26 November 2026, design only. Co-Simulation only, FMI 2.0 and 3.0, desktop. Nothing here changes the numbers an FMU gives. The evidence is a walk through the real app (the walkthrough and its screenshots are a session deliverable, not in the repository); the [open questions](#open-questions) each carry a recommendation.**

## In short

- **Today the round trip works and is exact, but a person can barely get through it.** A model exported as an FMI 3.0 FMU, imported into a new project and run gave 404 of 404 values identical to the original run. Getting there took about 40 actions, two dead ends, a failure explained only in a tooltip, and the knowledge that an FMU is a node's "Program" whose every parameter must be bound to a hand-made state.
- **One entry point, one step to a running node.** Add › **FMU…** (and dropping a `.fmu` on the canvas) places a node built from the FMU: a state for each output, with its name, unit and start value; parameters and inputs at the FMU's own start values, editable on the card. It runs with no wiring.
- **Connections are picked by name and seen.** An input's **Connect to…** lists other nodes' states with units; the connection is drawn on the canvas. A parameter can be made shared (live, tunable) in one click.
- **The step and the failures are said in words, before and during the run.**
- **The export leads into the round trip.** The export dialog speaks of an FMU when an FMU is chosen, and its notice offers **Try it as a node** (a new project with the FMU placed) and **Compare with this run**.
- **The FMU travels with the project.** It is kept inside the `.kjt`, so a shared file runs on another computer; the library stays as a cache and a list of recent FMUs.
- **A tutorial** walks the whole round trip, then connects two FMUs.

## Today

### What the walk found

The walk drove the desktop app at `905caf4` with real mouse clicks (the interaction driver): the shipped Spring mass damper example exported as FMI 3.0, imported into a new project, run and compared; then FMI Reference FMUs v0.0.42 (Dahlquist twice, feeding Feedthrough). Exporting took 7 actions; importing about 40. The numbers were exact: 404 of 404 values identical to the original run.

| Where | What a person meets | Why it hurts |
|---|---|---|
| Export dialog | the `</>` icon "Export simulation code", "Generate a standalone program…", a Language row with only C++ | nothing says what becomes an output (each state), a parameter (each constant parameter, tunable) or an input (each live parameter), the step a host must use (whole multiples of 0.01 s), or that the binary is for this platform only |
| Exported FMU | units and start values, no `<DefaultExperiment>` | a host does not know the step or stop time |
| After export, Close and edit | "Exported springMassDamper.fmu"; "Close and remove results?" | no next step; the original run must be exported as CSV first or it cannot be compared |
| Empty canvas, Add menu | Node, Relationship, Component from file… | no FMU anywhere; the way in is Extensions › FMUs › Install…, a dialog titled "Install Konjugate package" |
| Install | "guid: {32b96ce7-…} … Runs binaries/aarch64-darwin/springMassDamper.dylib"; then "Installed {32b96ce7-…} 1.0.0. It's ready to reference from a node's implementation"; "Permissions: None requested" | an id for a name, a made-up version, nothing about what the FMU contains, no Add to model |
| Node › Program › Installed FMU | 4 input and 4 output rows, all "Choose…" in red; **8 model errors**; keys cut to "suspendedMassDi…"; the default state `x` left behind | the FMU's own values (stiffness 4, mass 1) are neither shown nor used |
| Binding a parameter | a state or a shared parameter; the Parameters table is empty | **dead end**: a shared parameter can only be made "from this row" of an existing relationship parameter. The workaround (the one the [FMI compatibility page](../../examples/fmi/README.md) uses) is a hand-made state per parameter holding its value: about 30 actions for 8 ports; Feedthrough needs 29 such states |
| First run | "Simulation failed"; the reason only in the Run button's tooltip: "The FMU 'springMassDamper' refused fmi3DoStep (a step of 0.01) at t = 0: … A contribution produced a non-finite derivative." | **dead end**: a mass left at a new state's 0, said nowhere visible. Feedthrough failed the same way: "0 is not a legal value for Enumeration_input" (its start is 1) |
| Results, comparing | parameter states listed as results; CSV headers "New node — Suspended mass.Displacement" without units | comparing means a CSV per window and a tool outside the app |
| Two FMUs | both Dahlquist instances correct; Feedthrough's output equals Dahlquist's `x` exactly **one step late**, and 0 at t = 0 | the connection is invisible: "3 nodes · 0 relationships", nothing drawn |

### Why it is built this way

An FMU is a `kind: "fmi"` node implementation referring to an installed package by `fmuId` and `fmuVersion` ([Project schema](../projectSchema.md)); `src/fmiResolver.mjs` turns it into a generated C++ node program before validation, so the engine knows nothing of FMI. The resolver demands a binding for every input and parameter ("there is no well-defined default … for an arbitrary vendor variable") and an entry for every output. But the FMU does declare a default: its inputs and its exact parameters carry a `start` value, which `src/fmiModelDescription.mjs` already parses and nothing uses. Units, descriptions, min and max and `<DefaultExperiment>` are dropped by the parser.

## Proposed: one FMU

### Entry points

- **Add › FMU…** ("A model from another tool, or exported from Konjugate, as a node"). A file picker, then the node is placed and selected, ready to run. The FMU is kept in the project and in the library (see [Library and project](#library-and-project)).
- **Drop a `.fmu` on the canvas**: the same, at the drop point.
- **Add › FMU › Recent**: FMUs already in the library, so the same FMU is placed again in two clicks.
- **Extensions › FMUs** stays for managing the library, and its detail pane gains **Add to model** and the FMU's real description.
- **Web edition**: Add › FMU… says "FMUs run in the desktop app" and links to the download page; it does not hide the entry.

### The node an FMU becomes

```
┌ springMassDamper ─────────────────────────────────── FMU ┐
│ FMI 3.0 Co-Simulation · generated by Konjugate            │
│ runs here (aarch64-darwin) · steps of 0.01 s              │
│                                                           │
│ Outputs (states)                                          │
│   Suspended mass.Displacement   0.1  m      set by FMU ›  │
│   Suspended mass.Velocity       0    m/s    set by FMU ›  │
│   Fixed support.Displacement    0    m      set by FMU ›  │
│   Fixed support.Velocity        0    m/s    set by FMU ›  │
│ Parameters                                                │
│   stiffness           [ 4   ]  N/m     tunable   Share    │
│   Spring force.mass   [ 1   ]  kg      tunable   Share    │
│   dampingCoefficient  [ 0.4 ]  N·s/m   tunable   Share    │
│   Damper force.mass   [ 1   ]  kg      tunable   Share    │
│ Inputs                                                    │
│   none                                                    │
│ ▸ About this FMU                                          │
└───────────────────────────────────────────────────────────┘
```

- **Outputs are states, made for you.** Choosing the FMU writes one state per output, named by the FMU variable (dots kept in the name, the sanitized key as its symbol), with its unit and its start value as the initial value; each shows "set by FMU ›", as a program's states show "set by program ›" ([One editor](unifiedEntityEditors.md)). The untouched default `x` is removed. Changing to another FMU keeps states whose names match.
- **Parameters show the FMU's own value**, unit, description (on hover) and whether it is fixed or tunable, and are typed in place. A value left as the FMU's start is not written to the file. **Share** turns a row into a project shared parameter (live, or fitted by Parameter tuning when the FMU says tunable), which also closes the dead end of a project with no shared parameters. The Parameters table lists FMU parameters too, under their node.
- **Inputs** show "not connected · uses 0 (the FMU's start)" until connected (next section). An unconnected input is not an error.
- **About this FMU** (folded): FMI version, model name, generation tool and author, description, platforms in the file and which runs here, the step it requires (`fixedInternalStepSize`, FMI 2.0's `canHandleVariableCommunicationStepSize`), its default experiment, rollback support, and the variables not exposed with why.
- **Model Exchange** is later; the card's first line names the interface so a choice can join it there.

### The run

- **Steps are checked before the run.** One `doStep` is one substep of the node. When the substep is not a whole multiple of the FMU's required step, the Run dialog says so and offers to fix it: "springMassDamper takes steps that are whole multiples of 0.01 s; this run steps it by 0.005 s. Use 0.01 s". A new project's first FMU suggests its default experiment's step and stop time.
- **A failure is said on screen**, in a message under the status chip that stays until dismissed, naming the node, the FMU's call, the time, and, for a parameter or input, its name and value: "The FMU in 'springMassDamper' refused its first step at t = 0 (A contribution produced a non-finite derivative). Its parameters: Spring force.mass = 0 kg, …". This helps every run failure, not only FMUs.
- **Results** list the outputs only; parameters are not states any more, so they are not plotted as results.

## Proposed: several FMUs

```
┌ Dahlquist A ──────────┐                ┌ Feedthrough ──────────────────────────────┐
│ x   0.9   set by FMU ›│ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄▶│ Float64_continuous_input  ← Dahlquist A.x │
└───────────────────────┘ one step late  │ Boolean_input             uses false      │
                                         │ …14 more inputs at the FMU's start values │
                                         └───────────────────────────────────────────┘
```

- **Connect to…** on an input lists every other node's states, by node and name, with units, searchable. A different unit is warned, not converted ("Dahlquist A.x has no unit; this input is in m"). The same picker reaches Konjugate's own nodes, so an FMU can be driven by an equation and drive one.
- **The connection is drawn** as a thin dashed arrow from the state to the FMU node, labelled with the input on hover; clicking it opens the input's row. This draws an existing binding and adds nothing to the file. It applies to every program's inputs, so the web edition shows it for C++ and Python programs.
- **Timing in plain words.** Every FMU reads the others' values from the start of the step (a Jacobi master, as Konjugate reads every node from the step's snapshot). It is deterministic and never iterates an algebraic loop, so a ring of FMUs with direct feedthrough always runs. The price is a one-step delay on each connection, which the arrow's label and the Connect row say ("read at the start of each step: one step late"). A smaller step shrinks it. Ordering within a step (Gauss–Seidel) for a chain with no ring is a later option ([question 4](#open-questions)).
- **Instances.** The same FMU in several nodes is several instances, which works today. An FMU that says `canBeInstantiatedOnlyOncePerProcess="true"` is refused at the second node by name, and one that says `needsExecutionTool="true"` is refused when added; neither is checked today.
- **Steps.** The Run dialog checks every FMU node's step rule; when no global step and substeps fit them all, it names the FMUs that disagree. It never changes a saved project's steps on its own.

## Library and project

**Today** the FMU lives only in the computer's library (`userData/packages/fmus/<id>/<version>/`); the project names it by id and a made-up version. Consequences seen or read in the code: a `.kjt` sent to a colleague shows "(not installed here)" and does not run until they find and install the same `.fmu`; a re-exported, edited model has a new id, so its node keeps pointing at the old FMU; installing an identical export twice fails with "That FMU version is already installed."; and uninstalling an FMU breaks every project using it (the notice warns, without naming them). The last two are read from the code (`src/fmuPackage.mjs`), not walked.

**Proposed: both, with the project authoritative.** The `.fmu` bytes are kept inside the project file, in a new attachments segment of the [KJT container](../kjtFormat.md) beside the model and the result, keyed by content hash and compressed. The library becomes a cache keyed by the same hash: opening a project extracts any FMU the computer lacks, so a shared file runs at once, and Add › FMU › Recent lists what the library holds. The id-and-version reference stays readable; a project that uses attachments says so with `requires`, so an older Konjugate refuses it by name rather than misreading it. **Replace FMU…** on the card swaps in a newer export, keeping matching states, values and connections. A size cap (64 MB, as installs have today) with **Link instead of keeping in the project** for larger FMUs is [question 6](#open-questions).

## Proposed: export, and closing the loop

- When Format is an FMU, the dialog's title and sentence become "Export as an FMU: one run of this model as a Functional Mock-up Unit other tools can run", the Language row hides, and three lines say what the host gets: "Outputs: 4 states · Parameters: 4 (tunable) · Inputs: 0 live parameters · Steps: whole multiples of 0.01 s · Runs on: this computer (aarch64-darwin); use Merge platform FMUs… for others". The `</>` button's tooltip becomes "Export code or FMU".
- The export writes `<DefaultExperiment startTime stopTime stepSize>` from the run configuration, so a host starts with the right step and stop time. It changes `modelDescription.xml` only; the id is a hash of the source and stays the same.
- The notice after export offers **Try it as a node**: a new window with the FMU placed and ready, the original's latest result attached as a comparison. After the run there, **Compare with original** overlays the two runs per output and gives the largest difference ("largest difference 0: identical"), matching outputs by the exported name (`Suspended mass.Displacement`). Without it, comparing needs a CSV from each project and a tool outside Konjugate.
- **Close and edit** says the results can be kept for comparison ("Keep them to compare" beside "Close and remove"), since a round trip is the moment people need them.

## SSP, later

SSP (System Structure and Parameterization, Modelica Association, 1.0 since 2019, version 2.0 aligning with FMI 3.0) is a zip of FMUs, their connections and parameter sets. OMSimulator imports and exports it, Dymola imports it as a Modelica package, Altair Twin Activate imports SSP 1.0, and Cameo exports it ([SSP specification](https://ssp-standard.org/docs/main/), [prostep ivip fact sheet](https://www.prostep.org/fileadmin/fact-sheets/Fact_Sheet__System_Structure_and_Parameterization__SSP_.pdf), [Twin Activate import tools](https://help.altair.com/twinactivate/help/en_us/topics/math_solutions/import_tools_c.htm), [Modelica conference paper on SSP in tools](https://ecp.ep.liu.se/index.php/modelica/article/download/982/890/1003)); tools disagree in practice (that paper found some still on pre-1.0 drafts). Its shape maps cleanly onto what this proposal builds: components as FMU nodes, connections as the drawn connections, parameter sets as values and shared parameters. **Recommendation: no SSP until the stages below ship; then SSP import first (a system of FMUs placed and connected in one step), export only if users ask.**

## What other tools do

Simulink's FMU block reads the FMU when it is chosen, lays out one port per input and output, and lists parameters with their start values as defaults, editable in the block ([MathWorks, FMU block](https://www.mathworks.com/help/simulink/ref_extras/fmu.html)). FMPy's GUI opens an FMU to a table of its variables with start values, edits them and simulates and plots in one click ([FMPy](https://pypi.org/project/FMPy/), [LearnModelicaFMI tutorial](https://dr-clementcoic.github.io/LearnModelicaFMI/019-fmpySimulation.html)). OMSimulator adds FMUs as submodels, connects them, and sets start values on parameters before initialisation ([OMSimulator user guide](https://openmodelica.org/doc/OpenModelicaUsersGuide/1.18/omsimulator.html)); co-simulation masters choose between Jacobi and Gauss–Seidel orders ([MasterSim, algorithms](https://sourceforge.net/p/mastersim/wiki/MathAlgorithms/)). What people expect, then: the FMU is the block, its start values are the defaults, its ports are there without wiring, and connections are lines.

## Staged plan

Each stage ships with its entry point, its tests, and every FMI fidelity check (`test:fmiImportFidelity`, `test:fmi3ImportFidelity`, `test:fmiExportFidelity`, `test:fmi3ExportFidelity`) unchanged. Desktop interaction tests install real Reference FMUs (the zip the fidelity tests already cache) through the driver's dialog answering; web tests cover what the web shows.

1. **Failures on screen.** The run failure message under the status chip (any failure), naming the FMU's call and the offending parameter. Tests: unit test of the wording; desktop interaction test with Feedthrough's enumeration at 0; web interaction test with a model whose own equations fail (no FMU).
2. **Start values as defaults.** The resolver no longer requires bindings for parameters and inputs: an absent binding keeps the FMU's start value; a typed value is stored as `{ key, kind: "value", value }`, with `requires` written only when used. Tests: resolver unit tests; engine check that every Reference FMU with no bindings equals FMPy's default run, to the bit; files written before still load and give the same numbers.
3. **The node built from the FMU.** Outputs as states with names, units and starts, "set by FMU ›", the stray `x` removed, the parameter rows with value, unit, description and Share, About this FMU (the parser keeps units, descriptions, min/max, the default experiment and the capability flags), the squeezed rows fixed, parameters out of the results. Tests: `nodeProgram` unit tests; desktop interaction: Dahlquist placed and run with zero wiring, plotted.
4. **Entry points.** Add › FMU… with Recent, drag-and-drop, Add to model in Extensions, a plain-worded install notice, the web's "desktop only" entry. Tests: desktop from file to plot in at most five actions; web test of the entry and its message.
5. **Connections.** Connect to… with units and warnings, arrows for every program's inputs, the timing sentence, once-per-process and execution-tool refusals. Tests: desktop: Dahlquist → Feedthrough connected by picker, arrow present, Feedthrough equals Dahlquist one step late; web: a C++ program node's input arrow (drawn without running).
6. **Steps.** The Run dialog's step check and fix; the first FMU's default experiment suggested. Tests: unit tests of the rule; desktop interaction with a 0.005 s step offered 0.01 s.
7. **Export that leads on.** FMU wording and summary in the export dialog, `<DefaultExperiment>`, Try it as a node, Compare with original, Keep results to compare. Tests: FMPy validates both versions and the numbers are unchanged; desktop interaction: export, Try it as a node, run, "largest difference 0".
8. **The FMU inside the project.** The attachments segment, the hash-keyed cache, Replace FMU…, the size cap. Tests: KJT format unit tests (round trip, older reader refusal by `requires`); desktop: a project saved with an FMU opens in a fresh user-data folder and runs.
9. **Tutorial: "Take a model out as an FMU and back".** Export Spring mass damper, Try it as a node, run, compare; then add two Reference-style FMUs and connect them. It ships its own small FMUs (Konjugate's own exports, so no third-party binaries). Desktop only; listed on the web as desktop-only, as other desktop tutorials are. Tests: the tutorial's skip-through and full interaction tests.

**Later, one line each.** SSP import (above). Model Exchange: the card's interface line is where the choice goes. FMUs on the web: the Reference FMUs 0.0.42 already carry a `wasm32-wasip2` binary, which a WASI host could run. Gauss–Seidel ordering for chains without rings.

## Risks

- **Defaults change meaning for old files.** Stage 2 only relaxes a refusal: a file written before has every binding, so it runs as before. A file using the relaxed form is refused by older versions through `requires`, not run differently.
- **Third-party start values can be wrong or missing.** A parameter with no start (allowed for `initial="calculated"`) gets no default; the card asks for it, and that one is an error.
- **Embedding makes projects large.** 64 MB FMUs in a project hurt saving and git; the cap and Link instead of keeping are the answer, and opening shows what is attached.
- **Drawing bindings for every program** adds lines to busy models; they follow the relationship-label detail setting.
- **Compare with original** needs the original's result. It is carried at export time in memory; a saved project without results cannot be compared, which the button says.
- **Cost**: stages 1, 4, 6 small; 2, 3, 5, 7 medium; 8 the largest (container format); 9 medium.

## Open questions

1. **Where an FMU's parameter values live.** (a) In the binding as `kind: "value"`, absent meaning the FMU's start; (b) as hidden constant states, as the workaround does today; (c) always as shared parameters. **Recommendation: (a)**: nothing in the file for an untouched value, no fake states, and Share for when it must be live or tuned.
2. **Do outputs always become states?** (a) Every output, automatically; (b) a checklist on placing; (c) none until asked. **Recommendation: (a)**, with "hide" per output on the card later: the short path to a plot needs them, and a 14-output FMU is still one click.
3. **How connections appear.** (a) Draw existing bindings as arrows, no schema change; (b) make each connection a relationship in the file; (c) leave them in the card. **Recommendation: (a)**: it shows what exists and keeps relationships meaning equations.
4. **Master algorithm.** (a) Keep Jacobi (start-of-step values) and say the delay; (b) Gauss–Seidel order for chains without rings, opt-in per project; (c) Gauss–Seidel by default. **Recommendation: (a) now, (b) later** if users ask: it keeps every result independent of order, as the rest of Konjugate is, and a default change would change numbers of saved files.
5. **The round trip's comparison.** (a) Compare with original from Try it as a node, matching by exported name; (b) a general "Compare with a results CSV…"; (c) leave it to CSV and outside tools. **Recommendation: (a)**, with (b) as its later generalisation.
6. **Library or project.** (a) Inside the project, the library as a cache, with Link for large FMUs; (b) library only, as today, with a "missing FMU: locate…" prompt; (c) project only. **Recommendation: (a)**: a shared file must run elsewhere, and Recent still needs the library.
7. **The size cap for keeping an FMU in the project.** (a) 64 MB, today's install limit; (b) 16 MB, Link above; (c) none. **Recommendation: (b)**, overridable per FMU, so a normal project stays small enough to mail and commit.
8. **The tutorial's FMUs.** (a) Konjugate's own exports, made by the tutorial and shipped; (b) the Reference FMUs bundled (BSD-2-Clause); (c) downloaded on demand. **Recommendation: (a)** for the round trip and (b) for connecting two FMUs, as the Reference FMUs are the standard's own examples; bundle only the binaries for the platforms Konjugate ships.
9. **SSP.** (a) Later, import first, after these stages; (b) now; (c) never. **Recommendation: (a)**.
