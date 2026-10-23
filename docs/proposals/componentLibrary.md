---
type: Proposal
title: "Component library: reusable node and edge templates"
description: "RFC for a declarative library of reusable component templates and standard physical ports."
tags: [proposals, components, templates]
status: implemented
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Component library: reusable node and edge templates

**Status: shipped.** Kept below in its original planning phrasing, since the design it argues for is what was actually built — templates on disk at `assets/componentLibrary/*.json`, discovery and merging of bundled + user-installed templates in `src/main.mjs`, the sidebar UI (`#componentLibraryPanel`) and application logic in `src/renderer/index.html`/`renderer.mjs`, and interaction-test coverage in `tests/interactionRunner.mjs` ("component library places node templates and connects them with an auto-bound edge template"). One deviation from this document as originally written: node-template placement shipped as **click-to-place** (the same fixed-position/cascading-offset default "Add node" uses), not drag-and-drop from the sidebar as "Applying a node template" below describes — see that section's own note.

## Problem

Building a model from scratch means authoring every node's states and every edge's equation by hand. Edges are the expensive part: a programmable relationship requires writing an equation or inline C++/Python implementation, which is real engineering work even for a component (a resistor, a thermal conductor, a spring) whose behavior is well-known and reusable across many models.

## Proposal

A library of pre-configured node and edge templates a user can pull into their model directly, skipping the authoring step entirely for well-known components.

- **Node templates** carry states (symbols, units, initial values), numerics defaults, and appearance — close to a full node record minus `id`. Appearance can reference the existing shape library (`assets/shapes/`) directly.
- **Edge templates** carry the equation or provider `implementation` (source, parameters with defaults) and a small **ports** declaration instead of concrete node/state IDs — see "Applying an edge template" below. This is the higher-value half: it is what eliminates equation/code authoring for the user.

Both are governed by the same `implementation`/`expressionModel` JSON shape already documented in [Project schema](../projectSchema.md); a template is essentially that shape with concrete node/state IDs replaced by symbolic names.

## Applying a node template

Drag from the library sidebar, drop at a canvas position — the same shape of interaction as today's node placement, just pre-filled instead of starting from the "Add node" dialog's blank defaults.

**As shipped, this is click-to-place instead**: clicking a node template places it at a fixed position with the same cascading offset "Add node" already uses for its own blank-default placement, rather than drag-and-drop. See `applyNodeTemplate`'s own comment in `src/renderer/renderer.mjs` for why drag-to-position was left for later rather than built here.

A node template can also carry `sourceTerms`: each names one of the template's own states, an `expression`, optional `parameters` and an optional `setsValue` (an algebraic state, see [Project schema](../projectSchema.md)). A term parameter is either a plain local one (`{ name, symbol, value, unit }`) or `{ name, symbol, shared: <key> }`, linked to one of the template's `sharedParameters`. Those follow the same rules as a bundle's (below): an `"instance"`-scoped one is created fresh for every node placed, so each warehouse gets its own lead time to fork on; a `"project"`-scoped one is reused by symbol, so it is one definition across every node and bundle that declares it. Placing the node, with any shared parameters it created, is one undo step.

## Applying an edge template

Click the template to arm the existing "connect two nodes" interaction (the same flow "Connect to" and manual edge creation already use), pre-loaded with the template's equation/parameters. The only new step is binding the template's declared ports to real states, and that binding is **automatic, not a picker**:

1. Each port declares an expected state **symbol** (e.g. a "Thermal conductor" edge's port expects a state named `temperature`), not an expected node or state ID.
2. On apply, the engine looks for a state with that exact symbol on the relevant endpoint node. State symbols are already required to be unique within a node ([Project schema](../projectSchema.md)), so this lookup can never be ambiguous — it is a lookup, not a heuristic.
3. A match auto-binds with no further user interaction. No match leaves the port unbound.

There is deliberately **no fallback picker** for the no-match case. A picker that offered "close" or ranked candidates would reintroduce the exact failure mode this design exists to avoid: a user picking a plausible-looking but semantically wrong state (e.g. binding a temperature-difference port to a voltage state) through nothing more than an ordinary dropdown click. An unbound port is instead surfaced by the **existing model validator**, the same way it already flags any other incomplete/missing binding today — and fixed through the **existing edge editor's** binding UI. Neither needs to be built; both already handle this exact class of problem for hand-authored edges.

This also means the design does **not** attempt unit/quantity type-checking beyond the exact symbol match. States already carry a `unit` string, so a softer, ranked-suggestion picker could theoretically use it — but that reintroduces the wrong-guess risk above and was explicitly dropped in favor of the binary match-or-unbound approach. A related idea — an edge template optionally suggesting a paired node template it's known to work with, for discoverability — was also considered and dropped as unnecessary given the validator already closes the correctness gap; it could still be a nice-to-have later but isn't required.

## Bundles: several edges among several nodes, in one step

**Status: shipped**, added after the node and edge templates above. A **bundle** (`kind: "bundle"`) stamps out a set of related edges among N named endpoint nodes as one undoable action. It exists for physics and finance that cannot be expressed as a single edge: a bank run needs one edge that drains reserves and a matched edge that drains deposits, and those two must always move by the same amount; a battery-powered motor needs an armature edge, a discharge edge and a heating edge, two of which must agree on one winding resistance.

A bundle declares:

- `endpoints`: two or more `{ id, label }` roles (a bank, the depositor wallets).
- `sharedParameters`: parameters declared once and linked from any edge parameter that names them via `shared` (see [Project schema](../projectSchema.md) for what a shared parameter is). Each has a `scope`: `"instance"` (the default) creates a fresh one for every application of the bundle, right for a per-facility control such as an emergency-lending slider; `"project"` reuses an existing shared parameter with the same symbol and creates one only if none exists, right for model-wide constants such as a reserve target that several bundles (and several applications of one bundle) must agree on.
- `edges`: each with a `from` and `to` endpoint id, the same `ports`, `output`, `latex`, `bidirectional` and `parameters` an edge template has, plus an optional `color`. A parameter is either a plain local one or `{ name, symbol, shared: <key> }`.

**Applying one.** Select the endpoint nodes on the canvas and click the bundle; there is no chained endpoint pick, since a bundle can have more endpoints than a single edge. Which node plays which endpoint is decided by the nodes themselves: a node fits an endpoint when it has every state symbol that endpoint's edge ports name, so the user need not remember an order. Selection order only breaks ties (two banks in an interbank-lending bundle are interchangeable, so the first-selected one lends). If the selection cannot be assigned, nothing is created and the library panel says which endpoint has no match, mirroring the no-fallback-picker stance above. Edges sharing an endpoint pair fan out sideways so each stays individually clickable. The whole application, including any shared parameters it created, is one undo step.

**Not supported.** Bundles create edges only, not nodes, and cannot yet be instantiated from the `Add` menu or dragged. A group of nodes with their edges is an assembly, below.

## Assemblies: a piece of model, placed whole

A template of `kind: "fragment"` (shown as an Assembly in the library) holds a `fragment`: nodes, relationships and shared parameters exactly as the canvas copies and pastes them (the `konjugateGraphFragment` format in `src/graphClipboard.mjs`, with an optional `sharedParameters` array of project-document shared parameters). Because it is the canvas's own representation rather than a second, smaller vocabulary, it can carry everything a user can build there: inline C++ or Python programs on a node, a source term or a relationship, several equations on one relationship, numerics, appearance, descriptions, live parameters with their slider ranges. A new feature in the project schema works in an assembly the day it exists, with nothing in the template format to extend. The `node`, `edge` and `bundle` kinds remain for the small, readable cases that bind to nodes the user already has by matching state symbols.

An assembly stands alone. Every shared parameter its nodes and relationships link to must be carried in `fragment.sharedParameters`, and a program in it must be inline `cpp` or `python` source: a reference to something installed on one machine (an FMU, a plugin) would not travel. A shared parameter may declare `scope: "project"`, in which case placing the assembly links to the model's existing shared parameter with the same symbol if there is one; otherwise (the default, `instance`) each placement makes its own, under a symbol not yet taken. Placing an assembly gives every entity a new id, rewrites every reference to them (any `id`, `...Id` or `...Ids` field, so a binding kind added later is renumbered too), keeps the template's names, cascades it from the left edge of the canvas as a node template is, and is one undoable step. Positions in the fragment are relative to where it lands.

## Writing a template's description

A template's `description` is what a person reads in the library, and it is copied onto the node or relationship placed from it (a bundle's edges carry their own, in each edge's `description`), so it is where a shipped component explains itself. Write plain sentences, no markup, and cover in this order: what it is and the equation it applies; which nodes and states it connects, from which to which; what each parameter or state means, with its unit and default; and anything that surprises (a simplification, a pairing that does not work). Name each state, parameter and edge as it appears in the editor. `tests/componentTemplate.test.mjs` fails when a bundled template's description never mentions one of its states, parameters or edges, so a parameter added without being explained is caught. A description states only what the model does: where the equations leave a behaviour uncertain, check it by running a small model before writing it down.

## Your own library: saving a selection

Select nodes and press Save to my library on the selection toolbar, or right-click the selection and choose Save to my library. A dialog asks for a name, an optional description and an optional section, such as `Pumps / Centrifugal`. The selected nodes and the relationships between them are kept as an assembly (a `fragment` template) with their programs, descriptions and the shared parameters they link to; the layout is kept relative to its own middle, and what the selection was in (a subsystem, an edge group, the route an edge took) is left behind. The new template appears in the library panel under My library, filed in the sections it was given, and is placed exactly like a bundled assembly.

A section is a path of names held on each template (`section: ["Pumps", "Centrifugal"]`, at most four deep), not a folder that exists on its own: a section is there while a template is in it and gone when the last one leaves, so there is no second list to keep in step with the templates. Renaming a section rewrites the path on every template in it or below it, and so does moving it. The pencil beside a template edits its name, description and section; the pencil beside a section renames it; the cross deletes a template after asking. Bundled and plugin templates cannot be changed or deleted from here.

A selection is refused, with a sentence saying what to change, if what it holds could not travel: a program that is a reference to something installed on one machine (an FMU or a plugin) and not inline C++ or Python source, or a node that reads something outside the selection (the state of a node that was not selected). Select that node too, or point the input at something selected. A relationship alone cannot be saved, since it needs the nodes it connects.

Where the templates are kept differs by edition, and what is allowed with them does not. The desktop app keeps each as a JSON file in its user data folder (`componentLibrary`, beside the bundled ones in the same format, so a file can be copied to another machine and dropped in). The web edition keeps them in the browser's IndexedDB. Both go through `src/userLibraryStore.mjs`, which holds every rule (validation, a taken id being given the next free one, editing, moving a section, deleting) and is given only a way to read, write and remove; `src/userLibrary.mjs` builds a template from a selection, and `src/librarySections.mjs` is the section arithmetic. A template made in one edition is not seen in the other until its file is carried across by hand. The web edition cannot run C++, so a template with a C++ program saved there will not run there.

## Why nodes and edges must be one coordinated vocabulary

Auto-binding by symbol only works if node templates and edge templates agree on names — the "Thermal mass" node template and the "Thermal conductor" edge template both have to spell temperature the same way. That is a **naming-convention discipline for whoever curates the built-in library**, not new engine machinery: a small canonical vocabulary per domain (e.g. `temperature`, `voltage`, `pressure`), applied consistently across every bundled template.

It degrades gracefully outside the library: a user's own hand-built node won't necessarily follow the convention, so applying a library edge template against it just falls through to an unbound port plus the validator, exactly as described above — not a hard failure, just no auto-match bonus.

## Sidebar UI

A persistent **left** sidebar, not a modal — the existing shape library dialog is a `<dialog>` users must reopen for each pull, which doesn't suit pulling in many components over a build session. Left is free real estate today (the toolstrip runs full-width along the top; node/edge inspector cards dock `right: 10px`), and it mirrors a clean convention: right side edits the selected entity, left side is where new entities come from.

- **Toggle, not persistent-always-open or hover-based.** A toolstrip button opens it; clicking again closes it. Reuses the existing `.toolButton.active` toggle pattern already used elsewhere in the toolstrip — no new interaction concept.
- **Search plus domain tags**, extending the existing shape library's proven pattern (`shapeLibraryDomains`/`shapeLibrarySearch`/`shapeLibraryResults` in `renderer.mjs`) rather than inventing a new one. A **type** filter (Nodes / Edges / All) is added as a second, independent chip row using the same chip UI, defaulting to "All" so both kinds are visible together, not siloed into separate tabs.
- **Domain tags are multi-select**, since a component can legitimately belong to more than one domain (a heat exchanger is fluid and thermal). Items carry `domains: string[]` rather than a single `domain`. There is no separate "All" chip — zero domains selected already means "show everything," which removes a special case rather than adding one.
- **Sectioned when idle, filtered when active.** With no domain chip or search active, results are grouped under domain headers (supports browsing/discovery — useful since components can be domain-ambiguous and a user may not know the taxonomy in advance). A cross-domain item appears under each of its domains' sections. The moment a chip or search is used, the view collapses to a flat filtered list — the same behavior the shape library already has today, just conditional on a filter actually being active.

## Implementation principle

Template application should call the **same creation and binding functions manual node/edge authoring already calls**, not a parallel code path. If dropping a template node calls the same function the "Create node" dialog calls, and applying a template edge feeds the same binding step manual edge creation uses, then undo/redo, validation, and everything else that already works for hand-authored entities works for templated ones automatically. This is a constraint on *how* to build it, stated up front so it isn't accidentally implemented as a separate insertion path.

## Storage: built-in and user-savable, both

Resolved: both, using the same pattern add-on discovery already uses. Add-on discovery (see [Add-on development](../addonDevelopment.md)) scans two locations — the application's bundled `addons` directory and a userData `addons` directory — merging by ID and skipping duplicates. Templates follow the identical shape: a bundled library directory plus a userData library directory, one loader, same merge-by-ID logic. This resolves "built-in vs. user-savable" as one mechanism, not two features — a user saving their own configured node/edge as a template just writes into the userData root, no separate code path.

## Relationship to plugins, not add-ons

This is **not** an add-on. Add-ons are Electron/presentation-layer extensions — sandboxed in a separate window, permission-controlled, and explicitly forbidden from editing the active model ("no ability to edit the active model through API version 1"). A component library needs to insert nodes and wire edges into the live model while it's being built, which is a different layer entirely. See [Add-on development](../addonDevelopment.md#add-ons-vs-plugins) for the full comparison.

Konjugate's architecture already describes a second, separate concept — **plugins** (native engine, numerical execution, required when a model references one) — that is conceptually much closer to what edge templates are. [Interaction providers](../interactionProviders.md#add-ons-and-plugins) already sketches an "inline relationship → package and publish → reusable plugin contribution" maturity ladder, and describes a prebuilt plugin almost exactly the way this document describes an edge template: "a manifest supplies parameter and binding schemas... a user of a prebuilt plugin chooses it, binds its declared ports and enters parameters without needing to read source." Node and edge templates, as proposed here, are an early rung on that same ladder — project-local or personal-library entries with declared ports, not yet a formally installed, versioned, third-party-distributable package.

The plugin system's actual packaging/registry/trust layer is explicitly out of scope for this proposal. It does not exist yet (`interactionProviders.md`'s own implementation checklist marks "define a separate engine-plugin manifest, registry and trust boundary" and "package an inline provider as a reusable plugin" both **not done**), and building it is a separate, larger undertaking with its own security design — not something to fold into a template-library feature. The practical implication here is narrower: keep the template format (ports, bindings, parameters, implementation) shaped closely enough to a plugin's declared-ports contract that promoting a template into a real plugin later, once that system exists, would be a natural extension rather than a rewrite.

## Existing systems this builds on

- Shape library: `assets/shapes/{electrical,fluid,mechanical,structural}`, `shapeLibraryDialog`, `renderShapeLibraryResults()` in `renderer.mjs` — the search/domain-filter mechanism this extends.
- Manual edge creation's "compose state references" step — the binding mechanism a failed auto-match falls through to.
- Node/edge editor cards (`.contextCard`, docked `right: 10px`) — the spatial convention the left sidebar mirrors.
- Toolstrip toggle buttons (`.toolButton.active`) — the open/close interaction.
- Model validator (`engine/src/modelValidator.cpp`) — already flags missing/incomplete bindings (e.g. `sourceBindingMissing`, `providerOutputMissing`) for hand-authored edges; an unbound template port is the same class of finding, not a new validation rule.
- Add-on discovery's bundled-plus-userData scan (`docs/addonDevelopment.md`) — the storage pattern this proposal's template library follows.
- [Interaction providers](../interactionProviders.md#add-ons-and-plugins) — the add-ons/plugins distinction and the inline-to-reusable-plugin maturity ladder this proposal's templates sit on an early rung of.
