---
type: Proposal
title: "Subsystem components: reusable subsystems with ports, parameters and linked files"
description: "Re-thinking subsystems as reusable components: one definition with named ports and exposed parameters, placed as instances, saved to and linked from their own .kjt file, and expanded into the flat graph the engine already runs."
tags: [proposals, subsystems, components, hierarchy, reuse, kjt]
status: draft
implementation: none
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Subsystem components: reusable subsystems with ports, parameters and linked files

**Status: proposal.** Nothing here is built yet except stage 1, which is being built separately (see [Staged delivery](#staged-delivery)). The decisions the user has already made are stated as decisions; the rest are recommendations, and the choices that are genuinely the user's are collected in [Open questions](#open-questions).

## Problem

A subsystem today is a folder over the graph and a filter on the view. `src/subsystems.mjs` is about sixty lines: a subsystem record holds an id, a name, a parent, a position and a list of ports, each node names the subsystem it sits in, and `executionProjectDocument()` strips both before validation and runs. `src/renderer/renderer.mjs` holds the rest (the box on the canvas, entering and leaving, the breadcrumb, `createSubsystemFromSelection`), and [Subsystems](../subsystems.md) describes it. It was added in `fe3b3d1` and does what it set out to do, which is to let a large model be looked at a part at a time. It cannot yet do what people reach for subsystems to do, which is to build a part once and use it many times:

1. **Create only.** A subsystem can be made from a selection and undone, and that is all: it cannot be renamed, dissolved back into its nodes or deleted, and a node cannot be moved into or out of it.
2. **Ports go stale.** `deriveSubsystemPorts` runs once, in `createSubsystemFromSelection` (around line 16149), and the result is saved. A relationship drawn across the boundary later has no port; a port whose relationship is deleted stays, and stays counted on the box's label.
3. **Ports are not an interface.** A port is a record of one crossing relationship (`edgeId`, `internalNodeId`, `externalNodeId`, `role`). It has no name, no unit and no state; it says what happened to cross the boundary, not what the subsystem offers.
4. **No reuse.** A subsystem exists once. Two nearby features already reuse things in their own ways: [edge groups](../edgeGroups.md) keep one relationship definition and expand it into many edges, and "Save to my library" ([Component library](componentLibrary.md#your-own-library-saving-a-selection), `src/userLibrary.mjs`) keeps a selection as a `fragment` template to place again as loose nodes. Neither gives a reusable part with a boundary.
5. **No exposed parameters.** Two instances of one pump cannot differ in size without editing their insides separately.
6. **Inside, the outside is invisible.** `refreshSubsystemView` hides any relationship whose other end has no object in the current view, so inside a subsystem the relationships that feed it are simply gone.

## Decisions already made

- **Subsystems become reusable components**: a definition with named boundary ports and exposed parameters, placed as instances.
- **A subsystem can be saved to and loaded from its own `.kjt` file.** A loaded subsystem is **linked** to its file by default, so editing the file updates every model that uses it, and any instance can be **detached** into a local copy. A subsystem `.kjt` should open and run on its own.
- **The engine keeps receiving the flat node-and-edge graph.** Subsystems are expanded and stripped before validation and runs, as they are now; the C++ validator and the numerics are not touched.
- **Delivery is staged**: (1) boundary terminals and live-derived ports, (2) the lifecycle: rename, dissolve, delete, move in and out, (3) save a subsystem as a `.kjt` and import it as a copy, (4) linked instances, with refresh and conflict handling.

## The idea in one paragraph

A **component** is a project document with a small `component` block that names its ports and marks which of its shared parameters are exposed. That one shape is used everywhere: a component saved to a file is that document in an ordinary `.kjt` container, so it opens and runs on its own; a component in a project is that document held in the project's `subsystemDefinitions`, either written there (local) or cached there from a file (linked); and a component in My library is that document in the library store. An **instance** is a subsystem record naming its definition, where it sits, and the values of its exposed parameters. When a project is opened, and whenever a definition changes, every instance is **expanded** into ordinary nodes and edges in the project's flat graph, with ids that are the same every time. The canvas draws and edits that flat graph as it does today, the engine runs it as it does today, and each expanded entity knows which definition entity it came from, so an edit made inside an instance can be written back to the definition and every other instance follows.

## Data model

### The component block

A project document may carry a top-level `component` object. Its presence is what makes a document a component; a project without it is an ordinary project and is unaffected.

- `name`: the component's name, which a new instance takes unless renamed.
- `description`: optional, plain sentences, written as a [template description](componentLibrary.md#writing-a-templates-description) is.
- `ports`: an array of `{ key, stateId, name?, direction? }`. `key` is a positive integer unique among the component's ports and never reused, so a port keeps its identity when it is renamed or bound to a different state. `stateId` is the state inside the document that the port exposes. `name` is stored only when the person gives one; otherwise it is derived as the state's node and state names. `direction` is optional (see [Ports](#ports-names-types-and-binding-to-states)).

An exposed parameter is not listed in the block. It is a shared parameter of the document with `exposed: true`; its name, symbol, unit, default value, live mode and tuning bounds are the shared parameter's own, written once.

### Definitions

A project document may carry a top-level `subsystemDefinitions` array. Each entry is `{ id, document, link? }`:

- `id` is in the project's id space, like every other top-level entity.
- `document` is a complete component document (it has `format`, `version`, `nodes`, `edges`, `sharedParameters`, `edgeGroups`, its own `subsystems` and `subsystemDefinitions`, and its `component` block). **Ids inside `document` are in the document's own id space**, not the project's: it is sealed, so a definition can be copied between projects, saved to a file and read back without renumbering anything inside it.
- `link`, present only for a linked definition, says where the document came from: `{ kind: "file", fileName, relativePath, path, sha256, savedAt }` or `{ kind: "library", templateId, sha256, savedAt }`. For a linked definition, `document` is the cached copy, which is what lets a project open and run when the file cannot be found and in the web edition.

A local definition exists only while an instance uses it, as a [library section](componentLibrary.md#your-own-library-saving-a-selection) exists only while a template is in it; the save writes the definitions the instances name and no others, so there is no second list to keep in step.

### Instances

The existing `subsystems` array keeps its place and its meaning (a box on the canvas, with a parent), and each record gains a definition. An instance is `{ id, definitionId, parentSubsystemId, position, name?, parameterValues? }`:

- `name` is stored only when it differs from the component's name.
- `parameterValues` is an array, one entry for each exposed parameter whose value differs from the component's default: `{ parameterKey, value }`, or `{ parameterKey, sharedParameterId }` to bind the exposed parameter to a shared parameter of the parent (every pump reads one ambient temperature). `parameterKey` is the exposed shared parameter's id inside the definition's document; it is named `Key`, not `Id`, because it is in the definition's id space and must not be renumbered with the project's (see [Copy and paste](#copy-and-paste)).
- The stored `ports` list goes. Ports are the component's, and which of them are connected is derived from the flat graph.

### Expanded entities

Every node, edge, state, source term, parameter, shared parameter, edge group and nested instance produced by expanding an instance is an ordinary entity of the flat graph, with a project id, plus `definitionKey`: the id of the entity in the definition's document it was made from. Expanded nodes keep `subsystemId` (the instance they sit in, the innermost one when instances are nested), and expanded edges gain `subsystemId` too, since an edge now belongs to the level that defines it. A relationship drawn outside an instance is an ordinary parent-level edge with no `definitionKey`; it refers to the instance's expanded states by their project ids, as any edge refers to any state.

### Why the flat graph stays in the file

The file keeps the expanded flat graph in `nodes` and `edges`, beside the definitions. This is a copy, and [Design principles](../designPrinciples.md) asks why a copy is needed before one is made. It is needed for three readers that cannot expand: the engine's own command line (`konjugate run model.kjt`, [Engine CLI](../engineCli.md)), which reads a `.kjt` directly and ignores `subsystems` today; an older Konjugate, which would otherwise open a model with the insides of its subsystems missing and run it without them; and anything reading the JSON by hand. Edge groups already make the same choice for the same reason: member edges are written out in full and the group definition overwrites them.

What keeps it from being a second source of truth is that it is never read as one. Opening a project expands every instance from its definition and replaces the expanded content, keeping only each entity's id (by `definitionKey`, below). If what was in the file differs from what the definition produces (the file was edited by hand, or saved by an older Konjugate after someone edited inside an instance), the project says so when it opens and offers to keep those changes by detaching the instance, or to restore the instance from its component. `.kjt` payloads are gzip-compressed, which makes repeated structure cheap. The alternative, writing only the definitions and expanding on the way to the engine, is listed in [Open questions](#open-questions).

### How instances map to flat ids

The flat graph needs project ids for expanded entities that do not change between sessions, because results, run configurations, `tuningSetup`, `twin` mappings, live-control commands and interventions all address states and shared parameters by id. Two rules make expansion deterministic:

1. **An expanded entity keeps its id.** When an instance is expanded, the entity for definition entity `k` in instance `I` keeps the id of the entity already in the flat graph with `definitionKey` `k` inside `I`. Lookup is by the entity's own fields (`subsystemId` and `definitionKey` for nodes, edges and nested instances; `definitionKey` within its node or edge for states, source terms and parameters), which is the "find ids by what they are" rule applied to identity.
2. **A new entity takes the next free id, in document order.** Definition entities with no expanded counterpart yet (a new instance, or a node added to the definition) are given ids from the project's allocator in the order they appear in the definition's document, depth first, nested instances included. The same document therefore expands to the same ids on every machine. A definition entity that no longer exists has its expanded entity removed, and its id is not reused.

A hash of instance and key was considered and rejected: ids must be positive safe integers unique across the project, and a hash into that range can collide. Nested instances need no special case: a nested instance is an expanded entity with its own project id and `definitionKey`, and rule 1 applied inside it finds its contents.

### What changes in the schema documents and the codec

- [Project schema](../projectSchema.md): the `component` block; `subsystemDefinitions`; the instance shape of `subsystems` and the removal of its `ports`; `definitionKey` and edges' `subsystemId`; `sharedParameters[].exposed`; and the id rule, amended to say that ids inside a definition's `document` are in that document's own space. The validation rules below are the codec's and the canvas's, not the native validator's, since the validator only ever sees the flat graph.
- [KJT container format](../kjtFormat.md): no change to the container. One sentence saying that a component file is an ordinary version 1 project whose payload carries a `component` block, so every reader of `.kjt` reads it.
- [Subsystems](../subsystems.md): rewritten at each stage to describe what is built, as it is now.
- `src/modelCodec.mjs`: the node and edge key lists gain `definitionKey` (nodes already list `subsystemId`; edges gain it). Each definition's `document` is read and written by the same functions as a project, with its own id registry, so a component is checked by exactly the code that checks a project. Following the [steps for a new field](../designPrinciples.md#when-you-add-a-field-to-the-schema), the kitchen-sink document in `tests/modelCodec.test.mjs` gains a local and a linked definition, nested instances and exposed parameters.
- `src/subsystems.mjs` grows into the one module that knows the hierarchy: `hydrateSubsystems` (now including legacy migration), `expandInstances(document)`, `writeBackInstance(document, instanceId)` (the inverse, below), `componentInterface(document)` (ports and exposed parameters, derived), and `executionProjectDocument`, which also strips `subsystemDefinitions`, `component` and `definitionKey`.

## Ports: names, types and binding to states

A port is one state of the component, offered to the outside. Binding a port to a state, rather than to a relationship as now, is what turns the list of crossings into an interface: a port exists whether or not anything is connected to it, and a relationship drawn to it refers to the state the port names, so the engine sees an ordinary edge.

- **Typing comes from the state.** A port's symbol and unit are its state's, derived and never copied onto the port. Connecting a relationship or an edge template to an instance auto-binds by symbol exactly as it binds to a node (an instance offers its ports as a node offers its states), so the library's naming vocabulary (`temperature`, `voltage`, `pressure`) carries over unchanged. A unit mismatch when connecting is a warning, not a refusal, as it is between nodes.
- **Names.** A port is shown by its own name if it has one, otherwise as "node · state". The person renames a port in the subsystem's card; the key stays, so nothing connected to it notices.
- **Direction.** Relationships in Konjugate read both endpoints and add to one, so any port can in principle be read or written. `direction` (`in`, `out`, or the default `both`) is a statement by the component's author that the canvas enforces when a relationship is connected (an `out` port can be read from outside but not added to), and it is the place a signal-flow block such as a controller says which way it faces. The engine never sees it.
- **One state per port.** A physical connector that is really two quantities (temperature and heat flow, voltage and current) is two ports in this proposal. Grouping ports into connectors is left for later; see [Open questions](#open-questions).

**Declared and derived ports.** A local subsystem made from a selection should not ask for an interface before it is useful. So the ports of a component are its declared ports, the ones in its `component` block, plus, for a local definition only, a derived port for every inside state that something outside refers to: a relationship's endpoint or binding, a node program's input, an edge group's member edge. Derived ports are computed from the flat graph every time they are needed (this is stage 1's live derivation) and are never stored. Naming a derived port, or pressing "Keep as a port", declares it. Saving a component to a file or to the library declares every derived port, because a file has no outside to derive from. A linked component offers only its declared ports: from outside a linked instance, only those states can be connected, and the canvas says so when a person tries another.

**Inside, the outside is shown** (stage 1). Inside an instance, each port is drawn as a boundary terminal at the edge of the view, named, and every relationship from outside that reaches an inside state is drawn to that state from its terminal, so the outside edges that today vanish are visible and can be clicked. Outside, the instance's box shows its ports as named terminals around it and draws each connected relationship to its terminal.

## Exposed parameters

Exposing a parameter reuses shared parameters, which already are "one value reaching many places", with names, symbols, units, live mode and tuning bounds. In the subsystem's card, Parameters lists the component's exposed parameters with this instance's values; "Expose a parameter…" lists the parameters inside (relationship, source-term and shared ones) and exposing one that is not yet shared makes it a shared parameter inside the component and links the original to it, the same step that sharing a parameter already is.

When an instance is expanded, each exposed parameter becomes an expanded shared parameter of its own, with this instance's value or the component's default. Live control, tuning and the twin's mapping therefore address each instance's value separately with no new mechanism. To give several instances one value (one ambient temperature, one tuned coefficient for identical pumps), the person binds each instance's exposed parameter to a shared parameter of the parent; the expanded parameters then link to it, and tuning it is one variable. A parameter inside a component that is not exposed has the same value in every instance; a tuning flag on it tunes each instance's copy separately, and the tuning card says so.

Initial values of states are not exposed in this proposal. A person who needs every instance to start differently exposes a parameter and uses it, or detaches; whether a state's initial value should be exposable directly is in [Open questions](#open-questions).

## Editing an instance, and the instances beside it

The canvas keeps editing the flat graph, so the node and relationship editors, undo and validation are unchanged. What is new is what happens after an edit inside an instance of a **local** definition: `writeBackInstance` turns that instance's expanded entities back into the definition's document (project ids to `definitionKey`s, this instance's parameter values back to the defaults), and every other instance of the definition is expanded again from it. This is the edge-group rule (no member may diverge from the definition) applied to a whole part, and it reads the instance's entities generically through the codec, so a field added to nodes tomorrow is written back without anyone listing it. When a definition has more than one instance, the subsystem card and the breadcrumb say "Bodies · used 3 times", so it is never a surprise that an edit reaches the others; "Make this one separate" detaches the instance into its own local definition.

Inside a **linked** instance the canvas is read-only, apart from the instance's own exposed parameter values, which are the instance's and not the file's. A bar across the top of the view says "Pump.kjt · linked · used 2 times here" with **Edit Pump.kjt** and **Detach**. Editing the file in place, with a save back to it, was considered and is listed in [Open questions](#open-questions); the recommendation is the separate window described under [Linked files](#linked-files).

## Lifecycle (stage 2)

Every operation is one undo step, works on the instance under the pointer or the selected instance, and is reachable from the subsystem's right-click menu and its card. A single click on a subsystem box selects it and opens its card (name, source, ports, parameters, used how many times, and the actions); the **Open** button on its label, or a double click, steps inside. Today a click on the box steps inside, which leaves no way to select one.

- **Rename.** In the card, or by clicking the name in the breadcrumb while inside. Renaming an instance sets its own `name`; "Rename component" in the card renames the definition.
- **Dissolve.** "Dissolve subsystem" puts the instance's contents into the parent as ordinary nodes and edges, keeping their ids (so plots, results and run configurations still find them) and dropping `definitionKey`. Other instances of the definition are unaffected.
- **Delete.** Deletes the instance and its contents, and the relationships outside that were connected to it, after a confirmation that counts them.
- **Move in and out.** A selection of nodes at the parent can be moved into an instance ("Move into ▸ Bodies", or dragged onto its box), and a selection inside can be moved out ("Move to parent"). Relationships between moved and unmoved nodes stay where they were and become port connections. For a definition used more than once, the confirmation says what happens to the others: moving a node in adds a copy of it to every instance; moving one out takes it out of every instance, deleting the others' copies and any relationships outside connected to them, which the confirmation lists.
- **Place another instance.** Places a second instance of the same local definition beside the first, for a part that should stay identical (see [Open questions](#open-questions) for how this relates to paste).
- In a linked instance, Move in, Move out and the editing actions are disabled, each with a tooltip saying why and pointing at Edit and Detach.

## Saving and placing components (stage 3)

- **Save as component file…** in the subsystem's right-click menu and card. It writes the definition's document in a `.kjt` container: an ordinary project with a `component` block, every derived port declared, laid out around its own middle, with its ownership details taken from the project (the save dialog's ownership override applies, as for any save). The status line says where it went, and the instance stays local in stage 3 (in stage 4 it becomes linked to the file just written, which is the default the user chose).
- **Place component from file…** in the Add menu and in the component library panel. A file picker, then a short review card showing the component's name, description, ports with their units, exposed parameters with defaults, and where it came from (file name and saved date), which is what [Product strategy](../productStrategy.md#reusable-subsystems-from-other-models) asks to be shown before import. Place puts an instance in the view being looked at. In stage 3 the instance is local (a copy); from stage 4 it is linked, with a "Place as a copy" checkbox under the button.
- **Choosing a subsystem from any project.** If the chosen `.kjt` has no `component` block but has subsystems, the review card lists them and the chosen one is imported as a copy, with derived ports declared. Linking to one subsystem inside another project is not offered: a linked file is one component, so it has one owner and one meaning.
- **A component file opened as a project** opens like any project and runs with nothing connected to its ports: their states start at their initial values and nothing adds to them from outside. A bar says "This is a component, used by other models when placed from a file" and the subsystem card's interface editor is available at the top level, so ports and exposed parameters can be edited there. A test bench for a component is a separate project that places it.

## Linked files (stage 4)

### Resolving a link

A file link records `relativePath` (from the project file's folder, written at every save), `path` (absolute, as last resolved), `fileName`, and the `sha256` and `savedAt` of the document it cached. On opening a project, each link is resolved by trying the relative path first, so a project and its components moved or cloned together (a shared drive, a git repository) keep working on any machine, then the absolute path. An unsaved project has no folder, so its links resolve by absolute path until it is saved.

- **Found and unchanged** (same `sha256`): nothing to do.
- **Found and changed, interface compatible**: the cached document is replaced and every instance re-expanded, as one undo step, and the status line says "Pump updated from Pump.kjt (saved 14 Nov)". This is the user's chosen default, that editing the file updates every model using it. Each result records the `sha256` of every component it ran with, so a run can always be told apart from one made before an update.
- **Found and changed, interface changed**: see [Conflicts](#when-the-interface-changes).
- **Not found**: the project opens and runs on the cached copy, and a bar names each missing file with **Locate…** (choose the file; if it is a different version, it is treated as changed), **Detach** and **Keep using the saved copy** (hides the bar until the next open). Nothing is lost, because the cache is a complete document.
- **Moved**: Locate updates the paths; the relative path is rewritten at the next save.

Links are also checked when a project window regains focus, so a file changed by another window, another program or a `git pull` is picked up without reopening.

### When the interface changes

The interface of a component is its declared ports (key, bound state's symbol and unit, direction) and its exposed parameters (key, symbol, unit). On refresh it is compared by key with the cached one:

- A port or parameter renamed, re-described, or bound to a different state with the same symbol and unit is compatible: outside references are rewritten from the old expanded state's id to the new one, and nothing is asked.
- A port or exposed parameter removed, or one whose unit, symbol or direction changed in a way that breaks what is connected, is a conflict. The project opens on the cached copy and a card lists, per instance, what is connected to what is no longer offered, with three answers: **Update and remove** (the listed relationships and parameter bindings are deleted, one undo step), **Keep the old version** (the instance stays on its cached copy and is shown as "behind Pump.kjt", with an Update button), and **Detach**.
- Ports and parameters added are compatible: they appear unconnected, at their defaults.

### Cycles

Local definitions cannot form a cycle, since a definition's document is sealed and can only contain definitions inside itself, strictly nested. Links can: `A.kjt` may place `B.kjt`, which places `A.kjt`. Resolution keeps the chain of files being resolved, by canonical path (the real path after symbolic links) and by `sha256` for library links, and a link that would close a loop is refused with the chain spelled out: "Pump.kjt cannot be placed here: it already contains Plant.kjt, which is this model." The same check runs when placing a component, when saving a component that contains links over a file in its own chain, and when refreshing, since a file can gain a loop after it was linked. Nesting is also limited in depth (16), to stop a chain of files that is not a loop but is unreasonably deep.

### Editing a linked component

**Edit Pump.kjt** opens the file in its own project window, which [Product strategy](../productStrategy.md#reusable-subsystems-from-other-models) already proposed, with the breadcrumb of where it was opened from shown as a reminder. That window owns the file, with its own undo history and its own unsaved-changes prompt, exactly as for any project, so no undo history ever spans two files. When it saves, every open window that links the file is told and refreshes as above, and a project opened later picks the change up when its link resolves. The web edition has one window, so there Edit opens the component in place of the project after offering to save it, and returns to the project afterwards.

### Undo

- A refresh, a detach, Locate, and every lifecycle operation is one undo step in the project. Undoing a refresh puts back the previous cached copy and marks the instance "behind Pump.kjt", with an Update button; it does not change the file.
- Edits inside a local instance are one step each, covering the definition and every instance expanded from it, so undo restores all of them together.
- Changes to the file itself are undone in the window that edits the file.

### Encrypted component files

A component may be saved encrypted like any project. Placing or refreshing one asks for its password; the cached copy in the project is stored in the project's own encryption, if any, so a project that uses an encrypted component opens without that component's password and asks for it only when the file has changed. Whether a project should be allowed to cache an encrypted component in an unencrypted project is in [Open questions](#open-questions); the recommendation is to warn.

## The web edition

The web edition has no file system paths ([Web edition](webEdition.md)): a file is chosen from a picker or dropped, Chromium can keep a `FileSystemFileHandle` (`src/renderer/webShims/projectFiles.mjs` keeps them only for the page's lifetime), and Firefox and Safari can only upload and download. So:

- **Saving and placing work everywhere.** Save as component file downloads, or writes through the File System Access API where there is one; Place component from file uploads. Both are the same code as on the desktop beyond the picker.
- **Links to files are followed by hand.** A file link in a project opened in the browser cannot be resolved by path, so the project runs on its cached copies (which is why the cache is complete) and the bar reads "Pump.kjt is linked to a file; the browser cannot check it for changes" with **Update from file…** (choose the file; it is compared and refreshed as on the desktop) and **Detach**. Keeping handles in IndexedDB so that Chromium could re-check a file after a permission prompt is possible, and left as an open question.
- **Links to My library are followed automatically, in both editions.** The library store already exists in both (a folder on the desktop, IndexedDB in the browser, `src/userLibraryStore.mjs`), so a library link is the one kind of link that works the same everywhere, and it is the recommended way to reuse a component across a person's own models in the browser.
- Project files move between editions unchanged: a desktop project opened in the browser keeps its file links as records and runs on its caches, and saving it in the browser writes them back untouched.

## Relationship to edge groups and My library

**Edge groups** are the same pattern at a smaller scale: one definition, expanded into ordinary entities that carry a reference to it, members never allowed to diverge, detach to diverge, and the reference stripped before the engine. Components should be built to read the same way and share vocabulary in the docs (definition, expand, detach). An edge group inside a component's document works unchanged, since the document is a project. An edge group at a parent level whose members include nodes inside an instance generates relationships that reach into the instance, which is allowed for a local instance (each becomes a derived port connection) and refused for a linked one unless the states are declared ports.

**My library** should hold components, and "Save to my library" should save one, rather than a second "Save component" feature being added beside it. Recommendation:

- A library entry gains a kind, `component`, whose content is a component document, validated by the same code as a component file. A component in the library and the same component in a file are the same document in two containers.
- **Save to my library** on a selection that is exactly one subsystem saves it as a component (the dialog says "Saved as a component with 3 ports and 1 parameter"). On any other selection it saves a `fragment` assembly as today, since a set of loose nodes that bind into the model around them by symbol is a different and still useful thing.
- Placing a component from the library places an instance linked to the library entry, with the same "Place as a copy" checkbox as for files. The library's pencil gains **Edit**, which opens the component as Edit Pump.kjt does, and editing it updates every model linked to it.
- Bundled and plugin templates may also be components, under the same rule as now that they cannot be edited from the library; a model linked to a bundled component follows it when Konjugate is updated, and the update is reported as any refresh is.

## Copy and paste

`src/graphClipboard.mjs` copies by walking the structure and renumbering every `id`, `...Id` and `...Ids` field that names a copied entity. Components fit that rule with one addition: a definition's `document` is copied whole and never walked, since its ids are in its own space. This is also why references from the project into a definition (`definitionKey`, `parameterKey`) are named `Key` and not `Id`: they must not be renumbered with the project.

- **Copying an instance** copies the instance record, its expanded entities and its definition. Pasted into the same project, a **linked** instance becomes another instance linked to the same file. A pasted **local** instance becomes an independent copy, with a new local definition, matching what pasting a node does today; a second instance that stays identical is "Place another instance". This is a recommendation, and it is in [Open questions](#open-questions).
- **Pasting into another project** carries the definition. A local definition arrives as a local definition. A linked one arrives linked, with its cache, and its relative path is recomputed from the absolute one when the target project is saved, since the old relative path was from another folder; if the file cannot be found from the target, it is listed as missing in the usual way.
- **Pasting inside a linked instance** is refused with a sentence saying why, as any edit is.
- A selection is always at one level, so a copy never takes part of an instance.

## Results, exports and names

Two instances of one component have nodes with the same names. Names are labels, never references, so nothing breaks, but anywhere a state is listed out of context it needs its instance path: the results bar, plot legends, the run dialog's state pickers and CSV export show "Pump 2 / Impeller · speed". To keep existing exports unchanged, CSV export adds the path only where two exported columns would otherwise have the same name. Code and FMU export read the flat graph through `executionProjectDocument()` as now and need no change.

## Tutorials

"Organise a larger model" (`src/tutorials/organiseModel.mjs`) folds three bodies into a subsystem and steps into it by clicking the box. Stage 2 changes that click to select, so its `enter` step's text and target change to the box's **Open** button, and its `tutorialEnteredSubsystem` check stays. Its final card should mention renaming and dissolving.

A new tutorial, **Reuse a part of a model**, should come with stage 3, starting from the end of "Organise a larger model" (the shipped example it saves, or a new example of it): name the Bodies subsystem's port, expose the coupling coefficient, place another instance, give it a different coefficient, connect the two instances, run, and save the component to My library. It uses My library and not a file because the library works in both editions and an interaction test can play it without a file picker, which is what every tutorial needs ([Tutorials](tutorials.md)). Stage 4 adds one step: place the component from the library into a new model, edit it, and watch the first model update. File links are covered in the docs and by interaction tests rather than by a tutorial step.

## Migration

Every project saved today has subsystems with no `definitionId`, a stored `ports` snapshot, and nodes naming their subsystem. On opening one:

- Each legacy subsystem becomes a local definition with one instance, innermost first. Its document is built from its member nodes, the edges and edge groups whose endpoints are all inside it, and its nested subsystems, and **its keys are the entities' existing ids**, so expanding it reproduces the flat graph with every id unchanged, and results, run configurations, tuning setups and twin mappings keep working.
- A shared parameter used only inside moves into the definition. One used inside and outside stays at the parent, and the inside parameters are linked to it through an exposed parameter bound with `sharedParameterId`, which leaves the numbers unchanged.
- Edges that cross the boundary stay at the lowest level containing both ends and become derived port connections. The stored `ports` snapshot is discarded, since ports are derived from now on.
- Nothing is asked and the model runs identically; the first save writes the new shape. A test opens every shipped example and a set of legacy fixtures, migrates, and checks that `executionProjectDocument()` produces exactly the same flat graph as before migration.

**Opening a new file in an older Konjugate.** The flat graph is complete, so it opens and runs correctly, and its subsystems appear as plain subsystems (an instance record without `ports` is read as one with none). The older codec keeps unknown fields on nodes and edges but rebuilds the top-level document from a fixed list, so saving it there drops `subsystemDefinitions` and the instances' `definitionId`. The newer version then reads those as legacy subsystems and migrates them, which keeps the model and loses only reuse: instances that shared a definition become independent copies and links become local copies. The project's `savedWith` shows when this has happened.

## Staged delivery

Each stage ships on its own, updates [Subsystems](../subsystems.md) and the schema document as it lands, and is covered by unit tests of the pure functions and interaction tests of the entry points.

1. **Boundary terminals and live-derived ports** (being built separately now). Ports derived from the flat graph whenever needed instead of stored at creation; inside a subsystem, terminals at the boundary with the outside relationships drawn to them. This stage needs none of the data model above and is compatible with it: derived ports here are the derived ports of a local definition later.
2. **Lifecycle.** Select versus open, the subsystem card, rename, dissolve, delete, move in and out; the tutorial's `enter` step updated. Still one subsystem, one place: the data model change can wait.
3. **Components as documents; save and import as a copy.** The `component` block, `subsystemDefinitions`, instances, `definitionKey` and deterministic expansion, legacy migration, declared ports and exposed parameters, Place another instance, Save as component file, Place component from file (as a copy), Save to my library for a subsystem, copy and paste, instance paths in results, and the Reuse tutorial. Everything is local, so no link, refresh or conflict code yet.
4. **Linked instances.** File and library links, resolution, refresh on open and on focus, conflicts, cycles, Edit in its own window, Detach, the web edition's manual update, encrypted components, and the Reuse tutorial's linking step.

## Product strategy

[Reusable subsystems from other models](../productStrategy.md#reusable-subsystems-from-other-models) asks for import as explicit model composition, provenance shown before import, explicit id remapping, atomic reference rewriting, only declared ports at the parent level, one undoable transaction, a recorded source, and detach; and it warns against implying a live external reference without refresh, conflict and offline behaviour. This proposal keeps every one of those and goes further on the last point, because the user chose links as the default: refresh, conflicts and the offline (missing file) case are defined above, and the cached copy is what makes a link safe to follow. It also adopts the strategy's "open in its own window" for editing a linked component. Once stage 4 is built, that section should be shortened to a pointer to this proposal.

## Open questions

1. **Pasting a local subsystem: a copy or another instance?** Recommended: an independent copy, as pasting a node is, with "Place another instance" as the way to get a shared one. The other reading, that a reusable component pasted is another instance, is equally defensible.
2. **Is the flat graph kept in the file?** Recommended: yes, as above, so the engine's command line, older versions and hand readers see the whole model. The alternative is smaller files and no copy at all, at the price of the engine CLI, an older Konjugate and anyone reading the JSON seeing a model without its subsystems' contents.
3. **Refresh a linked component automatically on open when its interface is unchanged?** Recommended: yes, reported in the status line and recorded with each result, which is what "editing the file updates every model" means. The alternative is to ask every time.
4. **Edit a linked component in its own window, or in place?** Recommended: its own window, so one window owns each file and undo never spans two files. Editing in place, with "Save changes to Pump.kjt (used by 3 models)?", is quicker for small changes and harder to make safe.
5. **Should components in My library replace user `fragment` assemblies, or sit beside them?** Recommended: beside them, with Save to my library choosing by what is selected (one subsystem saves a component).
6. **Should a library component be linked by default when placed,** as a file component is? Recommended: yes, for one rule everywhere.
7. **Connectors.** Should a port be able to group several states (temperature and heat flow) so one connection makes both, as the component library's standard physical ports suggest? Recommended: later, once single-state ports are in use.
8. **Can a state's initial value be exposed per instance,** beside parameters? Recommended: not at first; expose a parameter and use it.
9. **Web edition: keep file handles across sessions** in Chromium, so a linked file can be re-checked after a permission prompt, or keep links in the browser manual? Recommended: manual first.
10. **Encrypted components cached in an unencrypted project:** warn, refuse, or allow silently? Recommended: warn when placing and when saving.
