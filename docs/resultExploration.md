<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Result Exploration, Branching, and Paced Simulation

## Status and purpose

This document records the product and technical direction discussed for
exploring Konjugate simulation results. It is a design proposal, not a promise
that every idea will be implemented unchanged. Its purpose is to preserve the
coherent experience behind the ideas, distinguish agreed decisions from open
questions, and provide an incremental implementation path.

The central product opportunity is to avoid separating model construction,
execution, post-processing, and scenario exploration into unrelated
workspaces. The canvas should remain the spatial center of the workflow before,
during, and after simulation.

The proposed north star is a **spatial, branchable simulation player**.

## Design principles

- The model and its results are separate. Playing a result must never overwrite
  model initial conditions.
- A displayed value always has an identifiable result branch and simulation
  time.
- Names are presentation; node, state, parameter, run, and branch references
  use UUIDs.
- The canvas, timeline, inspector, and plots share one active time cursor.
- Units guide honest presentation but never prevent arbitrary signal
  comparison.
- Completed runs and parent branches are immutable. New decisions create new
  branches.
- Playback rate and simulation pacing are different concepts and must have
  separate controls.
- Engine checkpoints, not rounded UI values, are the basis of resumed runs.
- The first implementation should remain useful without committing to every
  advanced analysis feature.

## Result values on the canvas

When a result is active, node labels show state values at the selected time.
Scrubbing or playing the timeline updates those values together.

The interface must distinguish these concepts:

- model initial value;
- current value from the active result and time;
- final result value;
- value arriving from a live or paced run.

Compact labels should show pinned or primary states. Hovering or expanding a
label may reveal every state, recent direction of change, and a small sparkline.
Selecting a node opens its complete result inspector.

The user may select a compatible state or unit group to color nodes on the
canvas. A legend, unit, branch, and current simulation time accompany any color
mapping. Unrelated quantities are not silently combined into one color scale.

## Simulation transport

After results exist, a transport bar appears along the bottom of the canvas.
The initial transport contains:

- play and pause;
- previous and next output sample;
- jump to beginning and end;
- a time scrubber;
- current and final simulation time;
- playback-rate selection;
- reset to the initial result sample.

Later versions may add:

- movement by one global synchronization step;
- looped intervals;
- intervention and branch markers;
- solver warning and discontinuity markers;
- a `Fork here` action;
- synchronized branch comparison.

Scrubbing must be immediate. Node labels, canvas colors, plots, inspector values,
and controller displays all follow the same cursor.

## Node inspection and plotting

Plotting should use progressive disclosure:

1. Hovering a node provides a lightweight sparkline and present value.
2. Clicking a node opens its result inspector in the contextual sidebar.
3. Pinning a state adds it to a persistent signal tray.
4. Expanding the tray opens a larger analysis dock for multi-signal work.

The contextual inspector is for the selected node. The analysis dock persists
across selections and holds signals from multiple nodes and branches.

Each plotted signal is identified by a stable reference resembling:

```text
SignalRef
├── nodeId
├── stateId
├── displayName
└── unit
```

Selecting a curve highlights its node on the canvas. Hovering a node emphasizes
its curves. Plot cursors and the simulation transport remain synchronized.

## Cross-domain comparison

Users may compare any signals, including quantities with incompatible units.
For example, pressure may respond to temperature and both should be available
in the same analysis without restriction.

Units control the default presentation, not eligibility:

- one unit group defaults to one shared axis;
- two groups may use dual axes;
- several groups default to aligned, stacked lanes;
- users may explicitly overlay incompatible quantities;
- normalization and percentage change allow shape comparison;
- every cursor tooltip retains the original values and units.

Supported analysis views may eventually include:

- shared-time plots;
- pressure-versus-temperature and other X–Y plots;
- normalized overlays;
- phase and hysteresis plots;
- time-shifted comparisons for response lag;
- derivatives such as `dP/dt` and `dT/dt`;
- correlation and lag estimation;
- comparison of the same signal across branches.

No fixed two-axis limit should prevent analysis. When additional axes would
become illegible, the interface reorganizes signals into synchronized lanes and
allows the user to override that choice.

## Branchable simulation

A user should be able to select a result time, create a fork, change future
decisions, and continue from the captured system state. The parent result remains
immutable.

A typical workflow is:

1. Scrub to a global synchronization time.
2. Choose `Fork here`.
3. Select or edit parameter interventions after that time.
4. Continue execution from the engine checkpoint.
5. Compare the child branch with its parent or another branch.

Branches form a result tree rather than overwriting one another:

```text
Baseline
├── Increase coolant flow at 4.2 s
│   └── Reduce heater power at 7.0 s
└── Disable pump at 5.0 s
```

Initial branching should permit parameter decisions. Expert state overrides may
be considered later because arbitrary state changes can produce physically
inconsistent scenarios.

Comparison modes may show parent and child values, absolute or percentage
difference, deviation color maps, and overlaid curves. Branch colors remain
consistent across the transport, canvas, inspector, and plots.

## Checkpoints and reproducibility

A fork begins from an engine checkpoint at a global synchronization boundary.
A checkpoint needs enough information to resume deterministically:

- exact state vector;
- global simulation time;
- active run configuration;
- current parameter values;
- pending intervention events;
- node substep settings;
- random-generator state when stochastic models exist;
- model, schema, and engine versions;
- parent run and branch UUIDs.

Result output samples already occur at global synchronization boundaries. A
sample becomes forkable only when the result carries the complete checkpoint
information required by the engine. Display values rounded for labels are never
used to resume execution.

## Parameter interventions

Live changes should be recorded as events rather than transient UI mutations.
An intervention identifies its time, parameter UUID, value, and transition
mode. Possible modes include:

- step;
- ramp;
- pulse;
- piecewise schedule;
- enable or disable;
- controller setpoint;
- externally sampled input.

Interventions appear as markers or tracks on the timeline. A child branch keeps
the parent event history before its fork and owns a distinct future event
sequence.

The engine applies accepted interventions at global synchronization boundaries.
The UI distinguishes a requested intervention from one acknowledged and applied
by the engine.

## Playback rate and simulation pacing

Playback rate controls the presentation of existing samples. Simulation pacing
controls how quickly the engine is permitted to advance relative to wall-clock
time. They are independent.

Implemented engine pacing modes are:

- **Fastest:** run as quickly as computation permits.
- **Real time:** target one simulation second per wall-clock second.
- **Limited ratio:** run at no more than `n` simulation seconds per wall-clock second.

Manual stepping remains a future extension. Pausing is already implemented (see below).

A pacing cap is a maximum, not a guarantee; expensive models may advance more
slowly. Pausing occurs at a safe synchronization boundary. Pacing belongs in the
C++ runner so Electron and command-line execution share the same semantics.

During a paced run, confirmed samples stream to the UI, the transport cursor
advances, and node labels update at output intervals. Cancellation and pausing
are sent as live protobuf control-stream commands rather than renderer delays or
a file-based mechanism — see [Engine job protocol](jobProtocol.md).

The implemented execution lifecycle is `running ↔ paused`, followed by either
`completed` or `stopped`. Stop captures the current synchronization boundary and
retains a partial result. The current UI can continue a stopped result from its
latest checkpoint. Earlier-checkpoint restart and branch navigation remain part
of the proposed branching phase rather than the live transport.

## Proposed result-session model

The working conceptual structure is:

```text
ResultSession
├── projectUuid
├── runConfigurations
├── branches
└── activeBranchUuid

ResultBranch
├── branchUuid
├── parentBranchUuid
├── forkTime
├── checkpoint
├── interventions
├── samples
├── diagnostics
└── completionState
```

Results are immutable records. View state—active time, selected signals, canvas
color variable, plot layout, and active comparison—is presentation data and
should not mutate the engineering model.

## Proposed screen organization

The experience uses four coordinated regions:

- **Canvas:** spatial values, highlights, result colors, and branch differences.
- **Bottom transport:** time, playback, event markers, branching, and execution
  state.
- **Right inspector:** selected-node values, compact plots, and contextual
  controls.
- **Expandable analysis dock:** pinned multi-node signals, arbitrary
  cross-domain plots, and branch comparison.

The analysis dock should remain collapsed until needed so result exploration
does not undermine the canvas-first modelling direction.

## Incremental delivery

### Phase 1: result playback foundation

- Retain the complete sampled result in renderer state.
- Add the bottom transport and active time cursor.
- Update node-label values from the selected sample.
- Mark the canvas clearly as displaying results.
- Keep model initial values unchanged.

### Phase 2: signal inspection

- Add node-hover sparklines.
- Add a selected-node result inspector.
- Introduce the persistent signal tray.
- Add synchronized multi-signal time plots.
- Preserve arbitrary cross-domain comparison.

### Phase 3: spatial result mapping

- Select a state or compatible unit group for node coloring.
- Add legends and explicit branch/time context.
- Add branch-difference coloring.

### Phase 4: checkpoints, interventions, and branches

- Extend embedded result storage with resumable engine checkpoints.
- Add immutable result branches and a branch tree.
- Add parameter intervention tracks.
- Resume C++ execution from a synchronization boundary.
- Add synchronized parent/child comparison.

### Phase 5: paced execution

- Extend the job protocol for streaming status and result samples.
- Add fastest, real-time, capped, and manual-step modes.
- Add safe pause, resume, cancellation, and intervention acknowledgement.

## Open questions

- How multiple immutable result sessions should be represented inside one project.
- How many samples and branches remain resident before results are paged from
  disk.
- Whether hover sparklines show every state or only primary and pinned states.
- How users choose a primary state for compact labels.
- How plot layouts are serialized and shared.
- Which checkpoint fields are required for future stochastic and external-input
  models.
- Whether branch comparison permits more than two active branches on the canvas.
- How intervention conflicts and late-arriving live commands are resolved.
- Which derived-signal operations belong in the engine versus the analysis UI.

## Immediate next implementation

The recommended first vertical slice is Phase 1: retain the sampled result,
add a bottom transport with playback and scrubbing, and project the
selected sample onto node labels. This establishes the result session and time
cursor required by every later plotting, branching, comparison, and pacing
feature without prematurely implementing the entire vision.
