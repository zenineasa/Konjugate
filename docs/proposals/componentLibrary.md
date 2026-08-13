<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Component library: reusable node and edge templates

**Status: proposal, not yet implemented.** This document records a design brainstormed in conversation, for review before implementation begins. Unlike the rest of `docs/`, it does not describe shipped behavior.

## Problem

Building a model from scratch means authoring every node's states and every edge's equation by hand. Edges are the expensive part: a programmable relationship requires writing an equation or inline C++/Python implementation, which is real engineering work even for a component (a resistor, a thermal conductor, a spring) whose behavior is well-known and reusable across many models.

## Proposal

A library of pre-configured node and edge templates a user can pull into their model directly, skipping the authoring step entirely for well-known components.

- **Node templates** carry states (symbols, units, initial values), numerics defaults, and appearance — close to a full node record minus `id`. Appearance can reference the existing shape library (`assets/shapes/`) directly.
- **Edge templates** carry the equation or provider `implementation` (source, parameters with defaults) and a small **ports** declaration instead of concrete node/state IDs — see "Applying an edge template" below. This is the higher-value half: it is what eliminates equation/code authoring for the user.

Both are governed by the same `implementation`/`expressionModel` JSON shape already documented in [Project schema](../projectSchema.md); a template is essentially that shape with concrete node/state IDs replaced by symbolic names.

## Applying a node template

Drag from the library sidebar, drop at a canvas position — the same shape of interaction as today's node placement, just pre-filled instead of starting from the "Add node" dialog's blank defaults.

## Applying an edge template

Click the template to arm the existing "connect two nodes" interaction (the same flow "Connect to" and manual edge creation already use), pre-loaded with the template's equation/parameters. The only new step is binding the template's declared ports to real states, and that binding is **automatic, not a picker**:

1. Each port declares an expected state **symbol** (e.g. a "Thermal conductor" edge's port expects a state named `temperature`), not an expected node or state ID.
2. On apply, the engine looks for a state with that exact symbol on the relevant endpoint node. State symbols are already required to be unique within a node ([Project schema](../projectSchema.md)), so this lookup can never be ambiguous — it is a lookup, not a heuristic.
3. A match auto-binds with no further user interaction. No match leaves the port unbound.

There is deliberately **no fallback picker** for the no-match case. A picker that offered "close" or ranked candidates would reintroduce the exact failure mode this design exists to avoid: a user picking a plausible-looking but semantically wrong state (e.g. binding a temperature-difference port to a voltage state) through nothing more than an ordinary dropdown click. An unbound port is instead surfaced by the **existing model validator**, the same way it already flags any other incomplete/missing binding today — and fixed through the **existing edge editor's** binding UI. Neither needs to be built; both already handle this exact class of problem for hand-authored edges.

This also means the design does **not** attempt unit/quantity type-checking beyond the exact symbol match. States already carry a `unit` string, so a softer, ranked-suggestion picker could theoretically use it — but that reintroduces the wrong-guess risk above and was explicitly dropped in favor of the binary match-or-unbound approach. A related idea — an edge template optionally suggesting a paired node template it's known to work with, for discoverability — was also considered and dropped as unnecessary given the validator already closes the correctness gap; it could still be a nice-to-have later but isn't required.

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
