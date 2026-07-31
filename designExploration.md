<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Konjugate Interface and Modelling Design Exploration

## Purpose of This Document

This document records the product and interface exploration undertaken after
creating the initial Konjugate Electron application shell. It explains the ideas
behind the current interactive prototype, the modelling concepts that influenced
it, and the direction those ideas suggest for future development.

This work is deliberately exploratory. The current interface is not a commitment
to a finished architecture or feature set. Its purpose is to make abstract ideas
tangible, expose interaction and modelling questions early, and provide something
that can be evaluated before substantial simulation-engine development begins.

---

## Starting Point

Konjugate began with a broad objective: create an open-source, graph-native
simulation engine for composable engineering simulations and digital twins.

In this view of a system:

- nodes represent stateful components;
- relationships represent the transport, transformation, or constraint of
  quantities between components;
- node-local processes represent sources, sinks, and internal dynamics;
- a complete system model is composed from these smaller elements rather than
  written as one monolithic formulation.

The first application implementation contained an Electron window, custom title
bar, packaging support, and a welcome screen. The design exploration initially
considered a conventional engineering application layout containing a component
library, graph canvas, inspector, results panel, menus, and a toolstrip.

That conventional layout was useful as a visual experiment, but the discussion
gradually revealed a more distinctive direction for Konjugate.

---

## What This Activity Means

The current activity is best understood as **interaction prototyping and
conceptual modelling**.

We are using an interactive HTML, CSS, and JavaScript prototype to investigate
questions such as:

- What should a component look like?
- What information should remain visible on the canvas?
- How should users create and edit components and relationships?
- How can two-dimensional and three-dimensional modelling coexist?
- How should states, equations, parameters, and live controls relate to one
  another?
- How can a complex multiphysics model remain legible?

The prototype intentionally uses mocked model data and simulation behaviour. It
does not yet represent a production simulation kernel, project format, CAD
pipeline, equation compiler, or complete graph editor.

This approach is valuable because it:

1. tests the mental model before implementation becomes expensive;
2. exposes architectural requirements hidden inside interface decisions;
3. helps distinguish foundational concepts from attractive but unnecessary UI;
4. provides a shared visual language for future discussion;
5. allows features to be removed or reshaped without migration costs.

The objective is therefore not to preserve every visible feature. It is to learn
which concepts deserve to become real features.

---

## The Canvas-First Direction

The initial panel-based prototype included:

- a component-library sidebar;
- a central two-dimensional graph canvas;
- a permanent property inspector;
- a results and problems area;
- menus and a larger command toolbar.

The interface was subsequently simplified around the idea that the canvas should
be self-sufficient.

In the current direction:

- the canvas is the primary modelling environment;
- permanent sidebars are not required initially;
- nodes are edited by right-clicking them;
- relationships are edited by right-clicking their paths or labels;
- right-clicking empty canvas space opens a component-creation palette;
- detailed editors appear contextually and disappear when no longer needed;
- only commands without an obvious direct manipulation remain in the toolstrip.

This produces an environment that behaves more like an editable engineering
scene than a diagram surrounded by application chrome.

The minimal permanent interface currently consists of:

- the application title bar;
- an Add command;
- selection, connection, and deletion tools;
- access to the equation workbench;
- view controls;
- detail-visibility controls;
- model status;
- Run and Stop controls.

---

## Two-Dimensional and Three-Dimensional Modelling

A central design belief is that three-dimensional modelling may eventually
become a preferred way to understand and interact with sufficiently complex
engineering systems. Two-dimensional modelling remains important because it is
familiar, efficient, and often easier to read.

Konjugate should therefore avoid treating 2D and 3D as unrelated editors.
Instead, they can be different projections of the same scene and engineering
model:

```text
Shared engineering model
        |
        +-- Top orthographic view
        +-- Isometric or 2.5D view
        +-- Perspective spatial view
```

The third dimension may carry several valid meanings:

- spatial placement of physical components;
- layers representing subsystems or physical domains;
- graph hierarchy and subsystem expansion;
- separation of otherwise dense relationship paths;
- placement of imported engineering geometry;
- spatial visualization of simulation states and results.

The current prototype is not a true WebGL or CAD scene. It uses styled HTML and
SVG to explore the visual and interaction language. Nevertheless, its model
should ultimately separate:

- engineering data;
- scene position and orientation;
- visual representation;
- camera state;
- selection state;
- contextual interface state.

This separation will allow a future renderer to replace the prototype without
changing the meaning of the model.

---

## Components as Shapes Rather Than Rectangles

Traditional block-diagram nodes are rectangles containing text. The explored
direction treats a node as an engineering object with an independent external
label.

A component may be represented by:

1. a primitive shape, such as a cuboid, sphere, cylinder, capsule, cone, or
   plane;
2. a simplified parametric engineering shape, such as a tank, valve, pump,
   motor, heat exchanger, or battery module;
3. imported geometry, such as STEP, STL, or a prepared runtime mesh.

The component's physical or mathematical meaning must remain independent of its
representation. Replacing a cuboid with detailed battery geometry must not
change the component's states, equations, parameters, ports, or identity.

A conceptual component representation may resemble:

```js
{
  id: "battery-1",
  modelType: "battery.cell",
  representation: {
    source: "primitive",
    shape: "cuboid",
    dimensions: [0.14, 0.02, 0.09]
  },
  transform: {
    position: [1.2, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1]
  }
}
```

Imported geometry introduces additional future requirements:

- converting source geometry to a render-friendly internal format;
- retaining the original source asset;
- establishing and correcting units;
- placing ports on points, faces, or attachment frames;
- simplifying detailed geometry for interactive rendering;
- separating visual geometry from simulation meshes when necessary.

STEP and STL should not be treated as equivalent. STEP can preserve structured
CAD geometry, while STL is primarily an unstructured triangle surface and often
lacks dependable unit and assembly information.

---

## External Labels and Progressive Disclosure

Text has been moved outside component geometry so that the object carries visual
identity while the label carries semantic information.

However, permanently expanded labels can dominate the scene and obscure the
geometry. The current prototype therefore uses progressive disclosure:

- node labels display only the component name by default;
- hovering or focusing a node expands its type and state values;
- relationship labels display a compact summary by default;
- hovering expands the individual relationships;
- an individual relationship bundle can be pinned open;
- separate toolstrip toggles expand all node details or all relationship
  details.

This establishes an information hierarchy:

```text
Geometry first
    |
    +-- Name
          |
          +-- Type, states, equations, and parameters on demand
```

As the camera moves farther away, labels could eventually reduce further to an
icon, count, warning, or disappear entirely. At closer distances, they may reveal
additional states, units, and live results.

Future labels may:

- face the camera;
- use leader lines;
- avoid collisions;
- allow users to pin selected states;
- remain fixed in screen space or attached to world space;
- change their detail level based on zoom and selection.

---

## Nodes and States

A node represents a component that can own one or more states. A node is not
equivalent to a single scalar state.

For example, a battery component might own:

- temperature;
- state of charge;
- polarization voltage;
- degradation;
- a discrete protection mode.

It is useful to distinguish:

- **parameters**: values describing the model;
- **states**: values remembered and evolved by the system;
- **inputs and outputs**: values exchanged with the environment through ports;
- **observables**: calculated results that are not independently integrated.

A possible state definition is:

```js
{
  id: "temperature",
  name: "Temperature",
  symbol: "T",
  kind: "continuous",
  unit: "K",
  initialValue: 353.15
}
```

State identifiers should remain stable even if users change display names.
State kinds may eventually include:

- continuous;
- discrete;
- Boolean or enumerated;
- algebraic or solver-managed.

Complex components may group states by domain, such as Thermal, Electrical, and
Aging. A component may eventually be entered or expanded to reveal an internal
scene containing subcomponents and relationships.

States can also drive visual mappings. Temperature may control material colour,
pressure may control deformation, state of charge may control a fill display,
and a discrete failure state may control an outline or warning annotation.
These mappings should be explicit presentation definitions rather than implicit
properties of every state.

---

## Ports

Ports form the contract between a component's internal model and its
relationships.

A relationship should generally exchange a quantity through a port instead of
reaching directly into arbitrary node internals. A thermal relationship, for
example, calculates heat flow; each connected component determines how that
contribution affects its temperature states.

Ports may be visually distinguished by physical domain:

- thermal;
- electrical;
- fluid;
- mechanical;
- signal.

In a spatial scene, ports must be anchored in the component's local coordinate
system so that they follow its position, rotation, and scale. Imported geometry
may require users to place ports on surfaces or attachment frames.

---

## Relationships, Direction, and Multiple Edges

Relationships are first-class modelling objects, not decorative arrows.

Direction includes several different ideas:

- structural source and destination;
- permitted transfer direction;
- instantaneous flow direction;
- computational causality.

The current conceptual vocabulary is:

- **undirected**: there is no meaningful source or destination;
- **directed**: influence or transfer is permitted from source to destination;
- **bidirectional**: transfer or influence is permitted in both directions.

The selected physical relationship should determine which directionality choices
are valid. A user should be able to reverse a directed signal relationship.
They should not be able to make ordinary thermal conduction physically
one-directional merely by changing an arrow; that would require choosing a model
that represents directional thermal transport.

Structural direction and instantaneous flow must remain separate. A
bidirectional thermal relationship can display the direction and magnitude of
current heat flow without changing its underlying directionality.

### Parallel relationships

Two components can share more than one relationship. A battery and cooling
system might exchange:

- thermal energy;
- coolant flow;
- measurement signals;
- control commands;
- mechanical constraints.

Parallel relationships remain independent in the model but may be presented as
a visual bundle.

The bundle can:

- collapse to a relationship count;
- expand on hover;
- list the type and direction of every relationship;
- display different parameters and live values;
- allow individual relationships to be selected and edited;
- separate into individual paths when greater detail is needed.

An overall bundle should not display one arrow if its members have different
directions. Direction remains visible on each relationship row.

Automatic bundling may consider both the connected component pair and the
locations of their ports. Relationships between spatially distant ports may be
more meaningful when rendered separately.

---

## Node and Relationship Equations

Konjugate needs a place where users can define reusable equations.

The current conceptual distinction is:

- **node equations**: internal processes, source terms, sinks, or state
  evolution belonging to a component;
- **relationship equations**: interaction and transport between connected
  components.

For thermal conduction:

\[
\dot Q = G(T_A - T_B)
\]

The equation definition declares its inputs, outputs, parameters, units, and
expression. Each relationship instance stores its own bindings and parameter
values. This allows the same conduction equation to use different conductance
values on different relationships.

```js
{
  equation: "thermal.conduction",
  bindings: {
    temperatureA: "battery.temperature",
    temperatureB: "cooler.temperature"
  },
  parameterValues: {
    conductance: 12
  }
}
```

A node equation can contribute a source term:

\[
\dot Q_\text{loss} = I^2 R
\]

The complete temperature equation can then be composed from relationship and
node contributions:

\[
m c_p \frac{dT}{dt}
=
\sum_j \dot Q_{ij}
+
\dot Q_\text{source}
\]

A node may own multiple node-equation instances. A relationship initially uses
one primary relationship definition; more complicated formulations can later be
represented through composite definitions.

The prototype contains an equation workbench demonstrating:

- an equation library;
- node and relationship equation classification;
- mathematical presentation;
- inputs, parameters, and outputs;
- units and basic validation feedback.

Future equations should be parsed into a structured mathematical
representation, not executed as arbitrary JavaScript strings. This is important
for:

- symbol validation;
- unit checking;
- detecting missing bindings;
- interpreted execution;
- automatic differentiation where appropriate;
- code generation;
- eventual optimized JavaScript or C++ execution.

Additional future equation behaviours may include:

- derivative contributions;
- algebraic constraints;
- source and sink terms;
- events and discrete transitions;
- observables.

---

## Live Values and Controls

Users need to adjust selected values while a simulation is running. Examples
include:

- heater power;
- flow rate;
- pump command;
- inlet temperature;
- valve position;
- controller setpoints.

It is useful to distinguish a model parameter from a model input:

- a parameter describes the model, such as mass or conductance;
- an input represents an externally controlled or imposed quantity, such as
  heater power or a pump command.

Some parameters may be safely tunable during execution, while others require the
model to restart or rebuild. A value can therefore declare an update mode:

- `live`;
- `step-boundary`;
- `restart`;
- `structural`.

A control widget does not own its value. It binds to a parameter, input, command,
state, or observable:

```js
{
  type: "slider-number",
  binding: {
    object: "heater-1",
    value: "power"
  },
  presentation: {
    minimum: 0,
    maximum: 1000,
    step: 10,
    displayUnit: "W"
  }
}
```

Possible controls include:

- numeric entry;
- slider;
- toggle;
- momentary button;
- dropdown;
- knob;
- vector input;
- setpoint editor;
- time profile;
- composite controls combining multiple widgets and readings.

The prototype demonstrates a composite heater control containing:

- an enabled toggle;
- a slider;
- a synchronized numeric input;
- units;
- a value bound to the heat-source node;
- mocked live effects on displayed temperatures.

Controls may eventually be:

- anchored to their component or relationship;
- placed in world space;
- pinned to the screen;
- collected into a dashboard.

The phrase **control widget** should remain distinct from a model **controller**,
such as a PID controller, state machine, or optimizer.

Manual controls, schedules, model controllers, and external data connections may
all target the same input, but only one source should ordinarily have authority
at a time. The active source should be visible.

Live changes should eventually be recorded against simulation time. This permits
reproducible experiments, input histories, undoable actions, and conversion of a
manually operated session into a reusable input profile.

---

## Contextual Interaction Summary

The prototype explores the following interaction language.

### Node

- left-click to select;
- drag to move;
- right-click to open the node editor;
- hover or focus to expand its label;
- Delete or Backspace to remove it eventually;
- drag from a port to create a relationship eventually.

### Relationship

- left-click to select eventually;
- right-click the path or relationship row to edit;
- hover over the bundle to expand it;
- pin an expanded bundle when persistent detail is needed;
- independently display direction, equation, parameters, and live flow.

### Empty canvas

- right-click to open the creation palette;
- scroll to zoom;
- use camera tools to change view;
- eventually drag to orbit, pan, or marquee-select depending on the active view
  and gesture.

Right-click has a potential conflict with common 3D camera controls. A future
interaction implementation should distinguish a stationary right-click from a
right-drag using a movement threshold. Trackpad, touch, and accessibility
equivalents will also be required.

Thin relationship lines need a larger invisible picking region so they remain
easy to select in both 2D and 3D.

---

## What the Current Prototype Demonstrates

The current renderer demonstrates:

- a canvas-first desktop interface;
- a compact toolstrip;
- 3D-styled primitive component shapes;
- external labels;
- multiple states on a component;
- ports belonging to different domains;
- several relationships between the same components;
- relationship direction indicators;
- compact and expanded relationship bundles;
- progressive node and relationship detail;
- independent global detail toggles;
- contextual node editing;
- contextual relationship editing;
- a contextual component-creation palette;
- a dedicated equation workbench;
- a live heater control;
- mocked Run and Stop behaviour;
- mocked state evolution;
- top and orbit view presentation;
- node dragging and canvas zoom.

The prototype has been run in Electron and visually inspected at default and
maximized window sizes. That inspection led to improvements in wide-window
composition, label readability, slider feedback, relationship-label placement,
and default information density.

---

## What Is Not Yet Implemented

The following visible concepts are prototypes or placeholders rather than
complete features:

- a simulation engine and numerical solver;
- a graph-domain data model;
- persistence and project files;
- undo and redo;
- real validation;
- a safe equation parser and compiler;
- unit algebra;
- true three-dimensional rendering;
- CAD or mesh import;
- port placement on geometry;
- relationship routing in 3D;
- graph creation through port dragging;
- production selection and deletion;
- camera orbit and pan;
- a results system;
- dashboards;
- reproducible control histories;
- controller models;
- external data connections;
- generated C++ simulation code.

Mock interactions should not be confused with implementation commitments. They
exist to support evaluation.

---

## Proposed Foundational Model

The discussion suggests a model with the following major concepts:

```text
Project
├── Components
│   ├── States
│   ├── Parameters and inputs
│   ├── Ports
│   ├── Node equation instances
│   ├── Visual representation
│   └── Scene transform
├── Relationships
│   ├── Connected ports
│   ├── Directionality
│   ├── Relationship equation instance
│   ├── Per-instance parameters
│   └── Presentation and bundle metadata
├── Equation definitions
│   ├── Inputs
│   ├── Parameters
│   ├── Outputs or contributions
│   ├── Units
│   └── Structured expressions
├── Control bindings
│   ├── Target
│   ├── Widget presentation
│   └── Update behaviour
└── Views
    ├── Camera
    ├── Geometry representations
    ├── Labels
    ├── Visual state mappings
    └── Dashboard or screen-pinned controls
```

The guiding separation is:

> The engineering model defines meaning; the scene defines representation; the
> controls define interaction; the renderer presents all three.

---

## Suggested Implementation Discipline

Future implementation should preserve the distinction between prototype and
product.

A useful next phase would not attempt to implement everything visible. It would
select a narrow vertical slice, such as two thermal masses connected by thermal
conduction and affected by a controllable heat source.

That slice could establish:

1. component, state, and port definitions;
2. node and relationship equation definitions;
3. per-instance parameters;
4. graph validation;
5. a simple numerical solver;
6. live input updates;
7. one persistent project representation;
8. a renderer driven by model data rather than hard-coded markup.

Only after this foundation works should more component types, imported geometry,
advanced controls, richer solvers, dashboards, and optimized code generation be
added.

The interface can continue to evolve alongside the vertical slice, but every
permanent visible capability should increasingly correspond to functioning
model behaviour.

---

## Current Design Principles

The exploration has produced the following working principles:

1. **Canvas first.** The engineering scene is the primary workspace.
2. **Geometry first, detail on demand.** Labels should not overwhelm objects.
3. **2D and 3D are views of the same model.**
4. **Components own collections of states.**
5. **Ports define interaction contracts.**
6. **Relationships are first-class and may be parallel.**
7. **Directionality follows physics, not decoration.**
8. **Node and relationship equations are reusable definitions with
   per-instance bindings and parameters.**
9. **Controls bind to values but do not own model semantics.**
10. **Engineering data and visual representation remain independent.**
11. **Contextual editing is preferred over permanent interface panels.**
12. **The prototype is a question made interactive, not yet the final answer.**

These principles should remain open to revision as real models and users expose
their strengths and limitations.
