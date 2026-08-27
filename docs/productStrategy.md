# Product strategy

## Purpose

Konjugate already has the foundations of a serious engineering tool: a graph-native model, a native execution engine, a shared GUI and CLI contract, extensible providers, structured AI proposals and regression-tested examples.

This document describes how to turn those foundations into a product that feels beyond excellent. It is a product direction, not a promise that every detail will be implemented unchanged.

## Product north star

Konjugate should be the best environment for answering this question:

> What happens to this physical system if I change this?

The complete workflow is:

1. Start from a reusable physical component or an understandable example.
2. Compose the system visually.
3. Receive precise, actionable validation feedback.
4. Run the model with visible numerical confidence.
5. Inspect the result spatially on the graph.
6. Fork the result at a point in time.
7. Change a parameter or intervention.
8. Compare the new branch with the original.
9. Export a reproducible explanation of the result.

The canvas remains the spatial center of this workflow before, during and after execution. Model construction, simulation, result exploration and scenario comparison should feel like parts of one environment rather than separate applications.

## Product promise

Konjugate is an open, graph-native engineering simulation workspace for composing physical systems, running them reproducibly and exploring design decisions through explainable simulation branches.

This positioning emphasizes four things:

- **Graph-native:** physical systems are composed from identifiable states and relationships.
- **Engineering-focused:** the product helps users formulate, inspect and validate models, not only draw diagrams.
- **Reproducible:** models, providers, numerical settings and result metadata can be inspected and repeated.
- **Explorable:** users can compare interventions and alternatives without overwriting the baseline.

## What is already strong

The current architecture provides a valuable base for this direction:

- The native validator remains the source of truth for model correctness.
- The GUI and CLI execute the same project contract.
- Subsystems preserve a flat simulation graph while providing hierarchy for authors.
- Results include samples and restart checkpoints rather than treating display values as restart state.
- C++ and Python providers use explicit bindings and share engine execution semantics with equations.
- The assistant produces reviewed, structured proposals instead of directly mutating a model.
- Bundled examples and numerical tests provide a foundation for teaching and regression coverage.

These capabilities should now be made visible through a smaller number of complete, polished workflows.

## Strategic priorities

### 1. Make model creation immediate

A new user should be able to build a meaningful model without authoring every common equation by hand.

The component library should provide reusable node and relationship templates for common thermal, electrical, mechanical and fluid primitives. Templates should use the existing model creation, binding, validation and undo mechanisms so a component created from the library behaves exactly like one created manually.

**Shipped.** [Component library](proposals/componentLibrary.md) — the sidebar, templates (thermal mass, conduction, resistor, voltage source, battery, motor and others), symbol-based auto-binding for edge templates, and bundled-plus-user-installed/plugin-contributed discovery are all implemented and test-covered.

The first library should favor a small, coherent vocabulary over a large catalog. Example primitives include thermal mass, thermal conductor, resistor, capacitor, voltage source, spring, damper, mass, pump, tank and controller. Each should have clear units, sensible defaults, a useful visual representation and a short explanation of its assumptions.

### 2. Make validation an engineering tutor

Validation should explain not only that a model is invalid, but what physical or structural decision needs attention.

High-value diagnostics include:

- incompatible or missing units;
- missing bindings and output states;
- ambiguous direction or sign conventions;
- disconnected or inert parts of the graph;
- parameters outside meaningful ranges;
- possible conservation violations;
- timestep or substep settings that may be numerically unsafe;
- providers whose source, toolchain or artifact cannot be reproduced.

Every blocking diagnostic should identify the affected entity, explain the consequence and offer the nearest corrective action. Advisory findings should be clearly separated from errors that prevent execution.

### 3. Establish numerical confidence

A result should communicate how it was produced and what limitations apply. A run report should include the solver, timestep, substeps, execution backend, provider metadata, model version, engine version and relevant warnings.

The engine currently provides a deterministic snapshot-coupled execution foundation. The next step is to expose that contract clearly and add at least one higher-confidence integration path with appropriate solver metadata and convergence or timestep-sensitivity checks.

Numerical confidence is not a decorative report. It should help a user decide whether a result is suitable for exploration, regression testing or an engineering decision.

### 4. Make branching the signature experience

A conventional simulator shows a result. Konjugate should let users explore decisions against a result without destroying the baseline.

The target interaction is:

1. Run a baseline.
2. Scrub to a synchronization boundary.
3. Choose `Fork here`.
4. Add a parameter intervention, such as a higher coolant flow or a changed controller setpoint.
5. Continue the child branch from the exact engine checkpoint.
6. Compare branches on the canvas, timeline, inspector and plots.

Completed branches remain immutable. Every branch identifies its parent, model version, run configuration, intervention history and checkpoint. The design direction is documented in [Result exploration](resultExploration.md).

### 5. Make the first ten minutes memorable

The bundled examples should become guided, interactive learning paths rather than only files to open.

A flagship example should guide the user through:

- understanding the physical question;
- identifying states and relationships;
- changing one parameter;
- running the model;
- inspecting a result on the graph;
- forking a scenario;
- comparing the outcome;
- exporting the model and result.

This path should work without an AI provider. AI can accelerate authoring, but the core product must remain understandable and useful on its own.

### 6. Treat reproducibility as a user-facing feature

The CLI, project format and provider boundaries make automation possible. Build on them deliberately.

A reproducible result should record, where applicable:

- model and schema versions;
- engine version;
- run configuration;
- operating system and architecture;
- provider source and artifact hashes;
- compiler or interpreter identity;
- dependency and execution backend metadata;
- parent branch and intervention history.

The same model should be easy to validate in CI, run headlessly for parameter sweeps and inspect later in the desktop application.

## Suggested sequence

### Foundation phase

- Implement the first small component library. **Shipped.**
- Improve validation messages and entity highlighting.
- Make one flagship example a guided workflow.
- Add first-run diagnostics for engine and provider prerequisites.
- Make run metadata visible in the result interface.

### Trust phase

- Add unit compatibility and dimensional-analysis diagnostics.
- Add solver metadata and timestep-sensitivity reporting.
- Record provider and toolchain identity in results.
- Make cross-platform CI required for pull requests.
- Add packaged-build smoke tests to release verification.

### Differentiation phase

- Implement checkpoint-based `Fork here`.
- Add parameter interventions and branch history.
- Add synchronized branch comparison across canvas, timeline and plots.
- Export a compact reproducibility report alongside simulation data.
- Define a versioned contribution format for reusable components and providers.

## Detailed opportunity tracks

The following tracks expand the strategy into concrete product directions. Each
track starts with a narrow, useful vertical slice. Broader integrations should
follow only after the first slice has a stable data model, clear ownership and
automated verification.

### Digital twin tuning and data comparison

**Status: the first release described below is implemented.** CSV import,
column-to-state mapping, bounded parameter fitting (the `parameters[].tuning`
schema field — see [Project document schema](projectSchema.md)) and a choice
of NLopt optimizer backends (derivative-free and gradient-based) run natively
in the engine via a `fit` CLI subcommand, driven from a "Tuning" panel in the
authoring UI. Not yet built: measured-versus-simulated plots with residuals,
and the source-data hash/objective/weights/engine-version provenance record
this section calls for — the review UI shows the column mapping and the
tunable parameters' before/after values, but not that fuller provenance set,
and none of it is persisted into the saved result. IPOPT was
evaluated as a second backend family and dropped: the vcpkg build available
to this project ships with no usable linear solver (no HSL/MUMPS/PARDISO),
so it links but cannot actually solve. The rest of this section is retained
as the original, still-accurate design intent, including the parts (state
estimation, validation, monitoring, live acquisition) that remain unbuilt.

Digital twin work should begin with offline measured-data comparison rather
than live acquisition. This keeps the first implementation deterministic and
makes it useful for experiments, test benches and historical data.

The initial workflow should be:

1. Import a CSV file containing timestamps and measured signals.
2. Map columns to model states or derived signals.
3. Select tunable parameters and define bounds or fixed values.
4. Choose an objective function, such as weighted least-squares error.
5. Run the fitting process through the same engine and CLI contract as normal
	 simulation.
6. Review measured and simulated signals together, including residuals.
7. Save the fitted parameter set as a new model or result branch.

The data model should distinguish:

- **calibration:** estimating model parameters from observations;
- **state estimation:** estimating hidden state values from observations;
- **validation:** testing a model against data that was not used for fitting;
- **monitoring:** comparing an active system against a model over time;
- **prediction:** running future scenarios from an accepted state estimate.

The first release should support CSV import, explicit signal mapping, bounded
parameter fitting and measured-versus-simulated plots. It should record the
source data hash, mapping, objective function, weights, parameter bounds,
engine version and fitting configuration. A fitted result must never silently
overwrite the original model.

Live acquisition can follow through a connector boundary. Candidate sources
include MQTT, WebSocket, serial and organization-specific adapters, but these
should remain outside the numerical engine. The engine should consume timestamped
and validated observations through a narrow interface rather than knowing about
transport protocols.

### Add-ons, plugins and components

Konjugate should make extension development approachable while preserving the
trust boundaries already described in the architecture documentation. These
terms should remain separate:

| Extension kind | Primary purpose | Typical authority |
| --- | --- | --- |
| Add-on | UI, visualization or application workflow | Presentation APIs and declared read permissions |
| Provider/plugin | Numerical behavior or external-system integration | Engine execution APIs and explicit project references |
| Component library entry | Reusable model construction | Declarative node and relationship templates |

Installing one kind must not implicitly grant the authority of another. Each
kind needs its own manifest, API version, compatibility declaration, permission
model, installation location and failure behavior.

The first ecosystem milestone should be a local installation workflow rather
than a public marketplace:

- discover bundled and user-installed contributions;
- inspect identity, version, author, license and permissions;
- install, enable, disable and remove a contribution;
- report incompatibility before activation;
- keep project references explicit and versioned;
- make failures visible without corrupting the host application or model.

**Shipped.** `src/packageArchive.mjs` (install/enable/disable/uninstall), `src/pluginResolver.mjs` (version-pinned resolution, incompatibility errors), and `src/extensionStateStore.mjs` implement this local-installation workflow; the component library's discovery already merges bundled and plugin-contributed entries. Deeper trust (publisher signatures, artifact hashes) remains future work — see [Plugin development](pluginDevelopment.md).

### Hello World contribution set

The repository should ship three intentionally small contribution examples:

- **Hello World add-on:** adds one toolstrip action or read-only panel.
- **Hello World provider:** evaluates a simple relationship through the public
	provider protocol.
- **Hello World component:** inserts one reusable node or relationship template.

Each example should be complete and runnable. Its documentation should show
the manifest, source layout, build command, installation path, permissions,
API version, debugging workflow, failure behavior and license. The examples
should be tested in CI so they remain executable documentation rather than
static snippets.

The contributor path should be task-oriented:

1. Copy the example.
2. Change one visible behavior.
3. Build or reload it.
4. Verify the permission boundary.
5. Package it for another user.

This is more valuable initially than a sophisticated registry because it gives
potential contributors a clear proof that the extension model is real.

### Visualization add-on

The visualization add-on should demonstrate the value of the extension system
through synchronized analysis, not simply provide a larger chart menu.

An initial release could provide:

- 2D point, line and trajectory layers;
- 3D points and paths for spatial or geographic data; **shipped** — `addons/poseVisualizer`, a full Three.js scene for bodies/links.
- Plotly-backed time-series, scatter and distribution charts; **time-series shipped** — `addons/resultPlotViewer`; scatter/distribution still open.
- signal-to-color, signal-to-size and signal-to-label mappings; still open.
- a shared time cursor with the simulation result player; **shipped**.
- selection synchronization between a plotted entity and its graph node; **shipped**.
- legends that include signal, unit, branch and timestamp; **partially shipped** (signal legends exist; unit/branch/timestamp not confirmed as part of them).
- export of the current view and selected data; still open.

The add-on should consume a stable, read-only visualization context. It should
not reach into private result storage or duplicate simulation playback logic.
That context should expose stable signal references, time samples, branches,
units and selection events. A map-specific view can then be added without
changing the engine or the core renderer.

### Python comparison notebooks

Python notebooks should serve as both education and numerical compatibility
checks. Each notebook should define a small physical system independently,
construct the equivalent Konjugate model, execute both and compare aligned
signals.

The first set should cover:

- spring-mass-damper;
- thermal equilibrium;
- an RC circuit;
- a simple two-body or rigid-link system.

Every comparison should state its assumptions and report:

- solver and timestep used by each implementation;
- timestamp alignment rules;
- maximum absolute error;
- relative error where meaningful;
- expected tolerance;
- known reasons for disagreement.

These notebooks should be versioned artifacts, not informal demonstrations.
Where practical, a headless notebook or equivalent Python script should run in
CI and detect numerical drift. The notebook should use the public CLI or a
documented interchange format rather than reaching into private Electron APIs.

### Reusable subsystems from other models

Importing a subsystem from another `.kjt` should be treated as model
composition, not file copying hidden behind a canvas gesture.

The import operation should:

- let the user select a source file and subsystem;
- show the subsystem name, ports and source provenance before import;
- copy or remap entity IDs according to an explicit policy;
- remap all internal references atomically;
- preserve only declared boundary ports at the parent level;
- create one undoable transaction;
- record the source file, subsystem identity and import timestamp;
- offer detach semantics if later refresh is not supported.

Double-clicking an imported or local subsystem should open its focused view in
a new project window. The new window should retain the parent context and
breadcrumb, while edits should use the same document and undo ownership model
as the parent. A live external reference should not be implied unless the
product later defines explicit refresh, conflict and offline behavior.

### Deterministic report generation

Report generation should follow a predefined structure as much as possible.
The report engine should consume model, validation, run and result data and
produce a stable HTML report without requiring an AI provider.

A first report should contain:

1. Project identity and report metadata.
2. Model overview and subsystem graph.
3. State, parameter and relationship tables.
4. Assumptions, units and source/provider information.
5. Validation findings and their severity.
6. Numerical configuration and execution metadata.
7. Selected result plots and key values.
8. Measured-versus-simulated comparisons when data is present.
9. Branch and intervention history.
10. Reproducibility information and warnings.

The generator should support a user-selected report template, signal list,
plot ranges and conclusion fields. The same input should produce materially
the same output, apart from explicitly identified timestamps or generated
file metadata.

AI may optionally draft a short summary from the structured report facts, but
it must not invent measurements, conclusions, missing validation results or
engineering recommendations. The generated draft should be visibly marked,
editable and separate from the deterministic report sections. Report creation
must remain fully functional with AI disabled.

### Release trust and installer identity

Platform security warnings are part of the adoption experience. Release work
should establish a consistent publisher identity and verify every artifact
before publication.

For Windows, the release pipeline should eventually:

- obtain and protect an Authenticode signing certificate;
- sign the application and installer artifacts;
- apply a trusted timestamp;
- verify the signature and publisher identity in CI;
- preserve consistent product metadata across releases;
- submit releases to the relevant reputation and malware-reporting processes.

Signing does not guarantee that SmartScreen warnings disappear immediately;
reputation is accumulated over time. The same release discipline should cover
macOS Developer ID signing and notarization. Unsigned alpha builds may remain
available for contributors, but public release artifacts should make their
trust state explicit.

The phases are ordered by user value and trust. A larger feature should not move ahead if it makes the core compose, validate, simulate and compare loop harder to understand.

## Decision filter

A proposed feature should be prioritized when it does at least one of the following:

- reduces the effort required to create a physically meaningful model;
- makes a modeling or numerical assumption more visible;
- improves reproducibility or engineering confidence;
- enables comparison of design decisions;
- strengthens the shared GUI, CLI and project contract;
- creates a reusable foundation for components, providers or analysis.

Features that add breadth without improving this loop should wait.

## Explicit non-goals for the near term

- Expanding into many additional physics domains before the core workflow is polished.
- Building a marketplace before component and provider formats stabilize.
- Adding AI providers as a substitute for better model authoring.
- Treating the canvas as the product without strong validation and analysis.
- Hiding numerical limitations behind visualization.
- Adding broad external integrations before reproducibility and trust boundaries are mature.
- Supporting live data acquisition before offline import and comparison are reliable.
- Building an extension marketplace before local installation and contribution examples work.
- Making AI necessary for report generation, calibration or model interpretation.

## Success criteria

Konjugate is moving beyond excellent when a technically capable new user can open an example, understand its physical intent, modify it, validate it, run it, fork it and explain the difference between two scenarios without consulting the source code.

For experienced users, the same workflow should be scriptable through the CLI, inspectable through recorded metadata and repeatable on another machine. The product should make the model easier to understand without making the underlying engineering less rigorous.
