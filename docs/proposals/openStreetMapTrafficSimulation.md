<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# OpenStreetMap traffic-network simulation

**Status: proposal.** This document explores a domain extension that imports an OpenStreetMap road network, generates a Konjugate model, simulates traffic and renders the results on a geographic map. It deliberately starts with a mesoscopic road-flow model rather than a vehicle-by-vehicle simulator.

## Goal

A user should be able to:

1. Import an `.osm`, `.pbf` or suitable GeoJSON file, or eventually select an area from a map.
2. Review the roads, inferred attributes and simplification choices.
3. Supply traffic demand, because OpenStreetMap describes infrastructure rather than the number and routes of vehicles using it.
4. Generate an ordinary, inspectable Konjugate graph.
5. Run the model through the normal validation and simulation pipeline.
6. View density, speed, flow and queues on a map synchronized with the result timeline.

The generated graph must remain a Konjugate model, not an opaque traffic solver hidden behind a special-purpose window. Users should be able to inspect components, change parameters, compose the road network with other physical or control models and reproduce the run without contacting OpenStreetMap again.

## Scope decision: mesoscopic first

There are two materially different products behind the phrase "traffic simulation":

| Model | Representation | Fit with Konjugate today |
| --- | --- | --- |
| Mesoscopic | Road cells hold aggregate density, speed, queue and flow | Strong: the road network is a graph of locally coupled state |
| Microscopic | Every vehicle follows, changes lanes, enters and leaves | Weak today: needs dynamic populations, discrete events, lane-level behavior and bulk state |

The first version should use a cell-transmission or comparable link-based model. Microscopic simulation should remain a later decision rather than quietly shaping the first API. Treating each vehicle as a permanent scalar-state node would create a large, mostly transient graph and would work against the engine's current fixed model and scalar-result contracts.

## Extension architecture

The product may feel like one traffic extension, but it crosses Konjugate's existing trust and runtime boundaries and should therefore contain separate contributions:

```text
OSM importer/editor add-on
          |
          | generates validated model operations
          v
Konjugate traffic graph ---- traffic-model plugin
          |
          | produces ordinary results
          v
Traffic map visualizer add-on
```

- The **importer/editor add-on** parses and reviews geographic input, then proposes model operations. It is application-side functionality.
- The **traffic-model plugin** contributes reusable traffic components and numerical behavior. It is engine-side functionality.
- The **map visualizer add-on** renders static road geometry and time-varying results. It is a read-only application-side result view.

This preserves the separation documented in [Add-on development](../addonDevelopment.md) and [Plugin development](../pluginDevelopment.md): installing a user interface must not implicitly grant numerical code execution, and installing a numerical plugin must not grant model-editing, file or network access.

## Mapping a road network to a Konjugate graph

### Road cells

Each directed road is divided into cells. A cell becomes a node with states such as:

- traffic density;
- queue length;
- mean speed;
- optionally accumulated throughput.

Its parameters or namespaced metadata record the normalized infrastructure:

- original OpenStreetMap way and segment identifiers;
- metric geometry and cell length;
- lane count;
- speed limit;
- capacity and jam density;
- road classification and direction;
- permitted turns and the assumptions used for missing tags.

The importer must project latitude and longitude into an appropriate local metric coordinate system before deriving lengths. Geographic coordinates should remain available for rendering and traceability but should not be mistaken for metres in the numerical model.

### Flows and intersections

Relationships transfer vehicles between adjacent cells. In a cell-transmission model, flow is typically bounded by upstream sending capacity and downstream receiving capacity:

```text
flow = min(upstream demand, downstream supply)
```

Intersections add explicit components for signal phases, priority rules, turn ratios, merges, roundabouts and capacity restrictions. Sources and sinks represent network boundaries and trip demand. Demand can initially come from entry-flow schedules or an origin-destination matrix; later adapters could consume measured counts.

Conservation must be explicit: one transfer subtracts flow from an upstream cell and adds it to the downstream cell. The current relationship-provider contract returns one scalar derivative contribution. A prototype can represent the two sides with coordinated directed contributions, but a future conservative multi-output relationship would express the invariant more directly and calculate the flux only once.

### Scale and partitioning

This representation has useful locality. Most cells communicate only with neighboring cells, and geographic regions naturally form partitions. Konjugate's existing communication-aware partitioning is therefore relevant, although performance must be measured rather than inferred from topology alone. Thousands of tiny Python provider calls may cost more than their arithmetic; the first corridor prototype should compare native equations, C++ relationship providers and Python providers before choosing the packaged implementation.

## Import is not available through add-on API version 1

Add-on API version 1 supports only read-only result visualizers and explicitly cannot edit the active model. A real importer therefore needs a new, domain-neutral contribution such as `modelImporter` rather than traffic-specific code in the host:

```json
{
    "kind": "modelImporter",
    "permissions": [
        "model.read",
        "model.write",
        "files.open",
        "storage.namespaced"
    ]
}
```

The names are illustrative, not a committed API. `model.write` should expose validated model operations rather than a mutable project document. The importer would construct operations such as `createNode` and `createRelationship`, show a review step and submit them through the same path used by normal authoring. That preserves validation, stable identity, undo/redo and future schema migrations.

An offline file import should ship before direct map downloading. Local `.osm`, `.pbf` or GeoJSON input avoids making outbound network authority, tile-provider policy, API limits and caching part of the first add-on security design. A later online mode should use an explicit network permission with constrained hosts rather than unrestricted renderer networking.

## OpenStreetMap normalization

OpenStreetMap data is not directly a simulation network. Import must at least:

- split and join ways at real intersections;
- respect `oneway`, access and turn-restriction tags;
- avoid false intersections where bridges or tunnels cross;
- interpret lanes, speed limits and road classes;
- simplify geometry without changing connectivity;
- infer missing attributes through visible, configurable defaults;
- preserve source identifiers and import provenance;
- identify disconnected or ambiguous sections before materialization.

The project should record the source hash or revision, bounding box, importer version, simplification settings and every applied default. It should also retain the attribution needed for OpenStreetMap data and surface applicable ODbL obligations in the import and export workflow.

## Demand and routing

OSM supplies the network, not a traffic scenario. The importer must not make an apparently live city from roads alone without explaining where its vehicles came from. Initial demand inputs can be:

- constant or scheduled entry flows;
- an origin-destination matrix;
- a trip table with departure times;
- CSV traffic counts used to calibrate boundary flows.

Route choice can begin as fixed turn ratios or precomputed routes. Dynamic route choice is a separate behavioral model and should not be conflated with parsing OpenStreetMap. Keeping demand, routing and road physics as separate components also lets users replace one without rebuilding the other two.

## Map visualizer

The result visualizer should render normalized road geometry rather than reuse the editor's graph layout. A browser-ready WebGL, Canvas or SVG library can be packaged inside the sandboxed add-on. The view should be able to:

- color road cells by density, speed or volume-to-capacity ratio;
- show queues and signal states at intersections;
- animate directional flow without implying individual vehicle trajectories;
- follow the Konjugate result timeline and seek it;
- highlight the road cell corresponding to a selected model node;
- show charts and metadata for a selected segment;
- compare scenarios in a later version.

The existing visualizer API can discover scalar signals and read bounded time series, which is enough for a small prototype. A city network exposes two missing scale-oriented capabilities:

1. access to static, namespaced network geometry without duplicating it across result signals;
2. a bulk `readSnapshot(signalIds, time)`-style operation, so the map can color many cells at one time without requesting every cell's complete history.

Semantic state metadata would also let the viewer identify density, speed and flow without depending on mutable display names. Such metadata should be optional and domain-neutral.

## Plugin implications

The current plugin system can contribute static component templates and packaged relationship providers. It cannot yet package the Python computational-node provider that now works for inline node implementations. A first traffic model may not need stateful computational nodes, but signal controllers, demand generators and advanced routing will make packaged computational-node providers useful.

Potential general-purpose improvements exposed by this work are:

- plugin-packaged computational-node providers;
- conservative multi-output relationship contributions;
- explicit discontinuities or scheduled events for traffic lights and demand changes;
- vector or bulk values if scalar ports become a measured bottleneck;
- result provenance for plugin identity, version and artifact hash.

These should be justified independently. A traffic extension should exercise general extension contracts, not cause traffic-specific concepts to enter the engine core.

## Proposed delivery sequence

### 1. Numerical corridor prototype

Manually author one road corridor with several cells, a source, a sink and one signalized intersection. Use synthetic demand and verify conservation, queue formation, free-flow behavior and jam propagation. Compare provider implementations and timestep sensitivity.

### 2. Read-only map visualizer

Render the corridor's static geometry and synchronize cell colors with result playback. This can use known metadata before a general importer API exists and will reveal whether bulk result reads are needed immediately.

### 3. Offline OSM importer API

Introduce the domain-neutral `modelImporter` contribution, host-mediated file selection, namespaced persistence and reviewed model operations. Import a small `.osm` or GeoJSON extract with explicit normalization diagnostics.

### 4. Reusable traffic plugin

Package cells, junctions, sources, sinks and signals as components with versioned numerical providers. Projects explicitly pin the plugin version through the existing resolver.

### 5. Larger networks and online selection

Add PBF support, controlled map access, region selection, geometry-level-of-detail, bulk result snapshots and benchmarks on realistically sized networks.

### 6. Reassess microscopic simulation

Only after the mesoscopic workflow is useful should the project decide whether to add dynamic entity populations, event scheduling, lane-level topology and vehicle trajectories. Those are engine-level capabilities with uses beyond traffic, but they should not be introduced through a nominally small add-on project.

## Success criteria for the first end-to-end version

The first complete version is successful when it can:

- import a small offline road extract reproducibly;
- report rather than hide missing or ambiguous map attributes;
- generate a normal Konjugate model through reviewed, undoable operations;
- conserve vehicles across cells and intersections within a documented tolerance;
- run without network access after import;
- render density, speed and queues in a timeline-synchronized map;
- preserve OpenStreetMap attribution and source provenance;
- remain usable without adding traffic-specific behavior to the Konjugate engine core.

The corridor prototype is the next concrete step. It tests the numerical fit and result shape before committing to the larger importer API, map-data pipeline or microscopic runtime.
