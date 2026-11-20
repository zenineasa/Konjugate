---
type: Proposal
title: Neural Toolbox
description: A toolbox for neural networks as parts of a physical model - imported from ONNX or PyTorch, run as a block or opened up as neurons and weights on the canvas, inspected, steered and edited against the system they act on, and exported back - led by one complete workflow for a robot arm's learned policy.
tags: [proposals, neural-networks, machine-learning, onnx, robotics, providers, toolboxes]
status: draft
implementation: none
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Neural Toolbox

**Status: proposed. A throwaway prototype (November 2026, not kept in the repository) proved the mapping onto the engine and measured the canvas at scale. Core change 2 is built; core change 1 is superseded by [Rates and values](ratesAndValues.md); nothing of the toolbox itself is built.**

## The problem

More and more engineering systems have a neural network inside them: a robot's learned policy, a neural surrogate standing in for an expensive part of a plant, a grey-box model in which physics gives the structure and a small network learns what the physics leaves out. The people who build these train the network in PyTorch, then test it in a loop they put together themselves: a Python script stepping an ODE, a co-simulation, or a block in another tool that treats the network as a sealed box.

That loop answers *whether* the system misbehaves, but not *why*. When a learned arm controller overshoots, the questions an engineer actually has are about the network and the physics together: which part of the network drives the overshoot, what happens to the joint torques if that part is turned down, whether a smaller network would do, whether the policy can be adjusted for a heavier payload without retraining from scratch. Answering them today means switching between a notebook (good at the network, blind to the physics) and a simulator (good at the physics, blind to the network).

Konjugate already has most of what this needs: a graph in which every quantity is a node's state, relationships that settle a chain of algebraic values within an instant, live parameters, forks, recorded interventions, fitting and design optimisation, digital twins, and C++ and FMU export. The Neural Toolbox adds neural networks to that graph, both as a block and opened up as neurons and weights, with a way in (import) and a way back out (export).

## What this is, and what it is not

It is **neural networks inside physical models**: inspecting, steering, editing and fine-tuning a network *against the system it acts on*, and handing the edited network back.

It is not a general tool for analysing neural networks. Interpretability work on large models already has good tools (TransformerLens, nnsight, Captum) and happens in notebooks; a feedforward network on its own has no dynamics for Konjugate's time, forks and steering to act on; and the canvas cannot show millions of weights (see [Scale](#scale)). Training also stays in PyTorch: Konjugate's fitting is derivative-free, which suits tens to hundreds of weights, not a network's worth.

## The flagship workflow: a robot arm's learned policy

The first release is judged by one workflow done completely, with the [Robotics Toolbox](https://github.com/zenineasa/konjugate-robotics):

1. **Import.** An engineer has an arm policy trained in PyTorch (by reinforcement or imitation learning): typically an MLP of two or three hidden layers of 64 to 256 units, reading joint angles, speeds and a target, and producing joint torques or setpoints. They export it to ONNX (or point Konjugate at a TorchScript file through the helper script) and import it with **Add › Neural network from file…**. A review card shows its inputs and outputs and how they will be wired; on accepting, it appears on the canvas as one *policy* node, wired by name to the arm's joint nodes and to a target node.
2. **Run in closed loop.** The arm's dynamics come from the Robotics Toolbox's algebraic relationships (articulated-body method, [Toolbox mechanisms](toolboxMechanismsAndDesignOptimisation.md), Part 2); the policy runs at its own rate (say 50 Hz, holding its output between updates) while the arm steps at a millisecond. Runs, forks, live parameters and the Pose Visualizer work as for any model.
3. **Find what drives a failure.** The arm overshoots when carrying a heavier payload. The engineer right-clicks the policy, chooses **Open up…** and picks its last hidden layer (the layers before it and the output layer stay blocks), runs again, and reads each neuron's activation as an ordinary result signal. Switching neurons off one at a time, or forking at the moment of overshoot with one neuron's gain changed, shows which few neurons push the elbow past its target.
4. **Edit.** They turn those neurons down, prune two that do nothing, and let a design optimisation retune the output layer's weights for the heavier payload: minimise settling time with every joint torque within its motor's limit ([Toolbox mechanisms](toolboxMechanismsAndDesignOptimisation.md), Part 3; [Parameter tuning objectives](parameterTuningObjectives.md)).
5. **Export.** They export the edited policy to ONNX. Konjugate checks the exported file with ONNX Runtime against its own run on the same inputs before saying it is written, and records what was changed from the imported network.

Every step except the last already has an analogue in Konjugate today; what is new is that the network is a first-class part of the model instead of a sealed box. All of it happens in the project window, with no window of the toolbox's own (see [In Konjugate's own window](#in-konjugates-own-window)).

## How a network maps onto Konjugate

An imported network has two forms, and the person moves between them.

### As a block

The whole network, or any contiguous part of it, is one computational-node provider ([Interaction providers](../interactionProviders.md)) running the network through ONNX Runtime. Its inputs are bindings to other nodes' states; its outputs are `setsValue` outputs on the block node's own states. A block costs one call per update, whatever the network's size, so this is the default form, and the only form for layers that are not supported as neurons (convolution, attention).

### Opened up as neurons and weights

Any part of the network can be opened up: one layer or several, at the start, in the middle or at the end, in one place or in several, or only some of a layer's neurons (see [Choosing what to open up](#choosing-what-to-open-up)). The prototype established the mapping:

| Part of the network | In Konjugate |
| --- | --- |
| A neuron | A node with one state, its pre-activation `z` |
| A weight | An algebraic relationship (`equationModel.outputs`, `setsValue: true`) setting the target neuron's `z` to `w · act(x)`, with `w` an editable relationship parameter. Relationships setting the same state are summed, which gives the layer's `Σ w·x` |
| The activation | Applied on the edges that *read* a neuron (`w · tanh(x)`), not stored as a second state on it (see [What the prototype showed](#what-the-prototype-showed)) |
| A bias | A relationship from one constant `Bias` node per component, setting `b · 1` |
| The rest of the network | One block for each connected part left closed, cut from the original at the tensors where it meets an opened part |

Because algebraic relationships settle in dependency order across the whole model at each instant ([Project schema](../projectSchema.md)), an opened-up network computes exactly what the block computes, at the same instant, with no step of delay. Every weight is then a parameter like any other: it can be made live, scheduled, intervened on, forked, tuned or optimised, and every neuron's activation is recorded with the results.

Opening up and closing are reversible: opening replaces the chosen layers or neurons with nodes and relationships and cuts what is left into blocks; closing writes the current weights back and joins neighbouring blocks again. Weights edited while open survive closing.

### Choosing what to open up

The person selects any set of layers, or of neurons within a layer, in the **Open up…** card, which shows the network's graph with the supported operations marked. Then:

- every connected run of selected layers becomes one opened-up part;
- every connected run of unselected layers becomes one block;
- every tensor that crosses between an opened-up part and a block becomes bindings: each element of it is a state of a neuron or an output of a block, read by the other side.

This one rule covers every case:

| What is opened up | What runs as blocks |
| --- | --- |
| The first layers | One block after them. The opened-up part reads the model's states directly (joint angles, a setpoint), through the input scaling the network was trained with |
| The last layers | One block before them. The opened-up part drives the model's states directly (torques, a heater command) |
| Layers in the middle | One block before and one after |
| Two or more separate parts (say layers 2 and 5) | A block between each pair, and before and after them as needed: block, opened, block, opened, block |
| Some neurons of a layer (say the six suspected of driving an overshoot) | The rest of that layer as a block reading the same inputs. Opened and closed neurons are added back together where the next layer reads them |
| The whole network | None |

**Networks that are not a simple chain.** A skip connection that jumps past an opened-up part, or a branch (an encoder feeding two heads), means one block can feed both an opened-up part and a later block, and a later block can read from several. Because the cut is made at tensors rather than at layer boundaries, these need no special case: the tensor a skip connection carries simply becomes bindings to both readers. They are part of the fidelity tests nonetheless.

**Every block between opened-up parts must add no delay.** A chain such as block, opened, block is only correct if each block computes at the same instant as the relationships around it. Today a node provider advances like a co-simulation step and adds one step of delay ([What the prototype showed](#what-the-prototype-showed)), so with blocks between opened-up parts the delays would add up. Feedthrough node providers ([Core changes](#core-changes), 1) are therefore required for this, not an improvement.

**Cutting the ONNX file.** ONNX Runtime runs a whole model, not part of one, so each block is written as its own ONNX sub-model, cut from the original at its boundary tensors and kept with the project. Each is checked when it is made: the blocks and the opened-up parts together, run on a sample of inputs, must give the original model's outputs.

**Replaying recorded activations instead of a block.** When the network's inputs do not depend on the simulation (a recorded data set fed through the network, open loop), the layers before an opened-up part can be replaced by their recorded activations, replayed through shared-parameter schedules as a data log is replayed; this needs no ONNX Runtime at all. In a closed loop, such as the robot arm, the inputs depend on the simulation, and the layers before must be a block.

### Grouping with subsystems

An opened-up layer can be hundreds of nodes and tens of thousands of relationships, which a flat canvas cannot show usefully (see [Scale](#scale)). Opened-up structure is therefore placed in [subsystems](../subsystems.md), and the person chooses how:

- **At import**, a grouping is proposed and can be changed before anything is added: one subsystem per layer (the default for dense networks), per named module of the source model (the default when the model has named submodules, such as an encoder and a head), or per group of neurons the person selects.
- **Afterwards**, regrouping is an ordinary edit: a subsystem can be split, merged or dissolved, and a selection of neurons can be made into a subsystem, as with any nodes today.
- The choice is remembered per component, so reopening a layer later uses the same grouping.

From outside, a collapsed subsystem draws as one box with its boundary relationships, so the relationships inside it cost nothing to draw.

### Rate

A controller in a real system runs at its own rate and holds its output in between. An imported network carries an optional update interval: it is evaluated at multiples of that interval and holds its outputs between them, whichever form it is in. For the opened-up form this needs a small core addition (see [Core changes](#core-changes)). It is also what keeps an opened-up policy affordable: at the measured cost of about 240 ns per relationship per evaluation, a 256-by-256 layer evaluated every millisecond costs about 16 ms per millisecond of simulated time, but evaluated at 50 Hz it costs about 0.8 ms (and a policy is rarely opened up whole).

## In Konjugate's own window

The toolbox opens no window of its own. Everything it does happens in the project window, through surfaces that already exist or that are general enough to belong to Konjugate itself:

| Step | In the project window | What exists today |
| --- | --- | --- |
| Import | **Add › Neural network from file…**, then a review card: inputs and outputs, which operations can be opened up, the suggested wiring to the model's states, and the subsystem grouping, all changeable before anything is added | **Component from file…** works the same way, with a review card. Importers are already deterministic functions run in a worker ([Launcher add-ons](launcherAddons.md), Part 4) |
| Run as a block | The node editor's **Program**: "Installed plugin provider", with a bindings editor for its inputs and outputs | Relationships can already choose an installed plugin provider; nodes cannot, and no node provider has a bindings editor (FMU import notes the same gap) |
| Open up, close, regroup, prune | Right-click a network node or one of its subsystems: **Open up…**, **Close**, **Group by…**, **Prune neuron** | New: model actions (below) |
| Steer, inspect | Neuron gains are live parameters; activations are result signals | Exists: live controls, forks, the node's Results tab, plots |
| Fine-tune | Mark weights as tunable; the Tuning panel and design optimisation | Exists |
| Export | Right-click: **Export as ONNX…**, through the host's own save dialog | New: a model action that returns a file |

Rich views that are not part of the workflow, such as a heat map of a layer's weights or a matrix of activations across a run, are visualisation, and suit the existing result-visualizer add-on window ([Add-on development](../addonDevelopment.md)).

### Model actions

The one new extension point is a **model action**: a contribution that adds an item to the canvas's context menu and, when chosen, proposes a change to the model. It is built from pieces Konjugate already has, and it keeps every boundary the project has drawn:

1. **It only ever proposes.** An action returns operations in the assistant's schema ([`schemas/assistantOperations.schema.json`](../../schemas/assistantOperations.schema.json)). The host validates them, shows them on the same review card as an assistant proposal, and applies them only when the person accepts, as one undoable transaction ([Model Assistant](../aiAssistantGuide.md)). Nothing is applied unattended, and an action cannot start a run.
2. **It sees as little as it needs.** An action receives the entities the person selected and the entities its own package created (the ownership keys of [Toolbox mechanisms](toolboxMechanismsAndDesignOptimisation.md), Part 1), never the whole model, files or the network. It runs in the importer's worker, with its time and memory limits, and must be deterministic.
3. **It belongs to the presentation side.** Actions are an add-on contribution, shipped with the engine plugin as one suite; the plugin stays purely numerical, and trusting one still grants nothing to the other ([Interaction providers](../interactionProviders.md#add-ons-and-plugins)).
4. **The model never depends on it.** An opened-up network is ordinary nodes and relationships, and a block needs only the engine plugin. Uninstalling the add-on loses menu items, never the ability to validate or run the model, in the app or from the command line.
5. **There is one way to change owned structure.** An action's proposal equals what a merge rebuild ([Toolbox mechanisms](toolboxMechanismsAndDesignOptimisation.md), Part 1) would give for the same owned entities, so the in-canvas route and a launcher window cannot disagree.
6. **It starts experimental**, like the launcher kind, with this toolbox as its only user until a second needs it.
7. **Export** is the same idea with a different result: the action returns bytes and a suggested file name, and the host shows the save dialog and writes the file.

This changes a decision. [Launcher add-ons](launcherAddons.md) lists "a general add-on API for editing models, adding nodes or edges from add-on code" as a non-goal, because such an API "would need a versioned schema for edits, undo integration, conflict handling with the user's own edits, and a trust story for arbitrary packaged code changing a user's model". The assistant has since built the first three (a versioned operation schema, one undoable transaction, and validation against the current model before review). The trust story is the constraints above: packaged code reads only what the person selected or what it made, and changes nothing the person has not reviewed.

## Import

- **ONNX is the format Konjugate reads.** Every major framework writes it, it describes the graph and the weights in one file, and ONNX Runtime runs it without a Python installation.
- **PyTorch** models are brought in through a helper script, shipped with the toolbox, that calls `torch.onnx.export` (or `torch.export` and then ONNX) with the person's example input, and names the inputs and outputs from the module's own names where it can.
- **Supported for opening up**, in the first version: dense (`Gemm`, `MatMul` plus `Add`) layers, the activations `Tanh`, `Relu`, `Sigmoid`, `LeakyRelu` and identity, and per-input scaling and offset (`Mul`, `Add`, `Sub`, `Div` by constants). Later: `GRU` and `LSTM` cells, whose hidden states are a natural fit for Konjugate's own states. Anything else is imported and run as a block but cannot be opened up, and the import says which nodes of the graph those are.
- **Binding.** Inputs and outputs are matched to the model's states by name where the names agree, and otherwise mapped by the person on the import review card, as a twin's signals are mapped to states.
- **Re-importing** a retrained network updates the component in place, keeping the person's wiring, grouping and edits where they still apply: the importer marks what it creates as its own and merges on rebuild ([Toolbox mechanisms](toolboxMechanismsAndDesignOptimisation.md), Part 1). Edits to weights that no longer exist are listed, not silently dropped.

## Editing

What a person can do to an imported network, in order of how much it changes:

- **Inspect.** Every opened-up neuron's activation is a recorded state; the result tools, plots and add-ons work on it unchanged.
- **Steer.** Each neuron's outgoing relationships share a *gain* parameter, live by default when opened up. Turning it to 0 switches the neuron off for the rest of the run; above 1 strengthens it. Changes are recorded like any live change, so a steered run replays exactly ([Steering a model by hand](humanInputBinding.md)).
- **Prune and rescale.** Remove a neuron, or fold its gain into its weights.
- **Fine-tune.** Mark weights or biases as tunable and fit them against measured data or optimise them against an objective with constraints. This is derivative-free and practical for tens to a few hundred weights: the output layer, one neuron's connections, a bias per neuron.
- **Change structure.** Add a neuron, or change an activation. Allowed, but the review card says plainly that the network will then usually need fine-tuning or retraining.

Every edit is recorded against the imported original (which weights changed, from what, which neurons were removed), shown in the component's editor, and written into the exported file's metadata.

## Export

- **The component alone, to ONNX.** Konjugate writes the current network, with every edit applied, whichever form each part is in. Before saying it is written, it runs the exported file with ONNX Runtime on a sample of the inputs the component saw in the last run and compares the outputs with Konjugate's own; a difference beyond floating-point rounding is an error, not a warning.
- **The whole hybrid model, as C++ or an FMU.** The existing [code and FMU export](../codeExport.md) carries the model; a block is exported as a call into ONNX Runtime or as generated code for supported layers. Code export does not yet write models that use algebraic relationships, which an opened-up network relies on (see [Core changes](#core-changes)).

## Fidelity

An imported network is only useful if Konjugate computes exactly what the network computes. Each of these is a test that runs with the suite:

- for every supported operation, a network imported, run in block form and opened up gives the outputs of ONNX Runtime on the same inputs to within floating-point rounding (about 1e-12 relative);
- for every way of choosing what to open up (the first layers, the last, the middle, two separate parts, some neurons of a layer, the whole network), and for networks with a skip connection and with a branch, the opened-up parts and the cut blocks together give the original model's outputs at the same instant, with no step of delay;
- import followed by export, with no edits, gives a file whose outputs equal the original's;
- import, edit and export gives a file whose outputs equal Konjugate's run of the edited component;
- a closed loop with an opened-up controller equals an independent simulation of the same loop (the prototype's tank test, to 6e-14 K over 7200 steps).

## What the prototype showed

The prototype built networks directly as Konjugate documents and ran them with the engine and the app as they were in November 2026. Its results are recorded here; its scripts were not kept.

**The mapping is exact.** A 4-8-6-3-2 MLP with its middle two layers opened up, the first layer replayed from recorded activations and the last run by a Python node provider, matches a numpy forward pass to 4e-16 inside the opened-up layers.

**Two ways of placing the activation behave differently.** Stored as a second state set by a `setsValue` source term, the activation is one step late per layer, because a `setsValue` source term is recomputed per node and is not part of the cross-model algebraic pass. Applied on the reading edges, there is no lag at all. Nothing warns about the first today.

| | Activation stored on the neuron | Activation applied on the edge |
| --- | --- | --- |
| First opened layer | exact | exact |
| Second opened layer | 1 step late | exact |
| Output of the node provider after them | 3 steps late | 1 step late |

**A node provider always adds one step.** By design it advances like a co-simulation step (inputs read at `t`, outputs reported at `t + h`), which is right for an FMU with dynamics of its own and an artefact for a stateless network.

**The engine scales linearly; the canvas does not.** The engine ran a 256-by-256 opened-up layer (65,792 relationships) for 201 steps in 3.2 s, exactly. In the app:

| Relationships | Load | Validation settled | Frame rate (idle / orbiting) |
| ---: | ---: | ---: | ---: |
| 1,056 | 0.17 s | 0.2 s | 22 / 22 fps |
| 4,160 | 0.5 s | 0.4 s | 22 / 19 fps |
| 16,512 | 3.1 s | 11 s | 3.7 / 3.7 fps |

(22 fps is the ceiling: the render loop is capped at 30 fps.) Measuring this found a quadratic cost in painting validation results, since fixed (166 s to 11 s at 16,512 relationships). What remains is drawing: every relationship is its own object with its own draw calls, and the canvas redraws even when nothing moves.

**The workflow is worth having.** A 2-6-1 controller trained to drive the heated water tank, opened up on the canvas, matches an independent closed-loop simulation to 6e-14 K. Switching its neurons off one at a time at 40 minutes shows they have distinct jobs: one holds back heating near the setpoint (switched off, the tank runs 2.3 K hot), one is nearly redundant, and one trades settling time against steady offset. That reading of a network, in terms of what the water does, is what this proposal is for.

## Scale

What fits where, from the measurements above:

- **Opened up and visible:** up to a few thousand relationships, comfortably. With collapsed subsystems, much more can be opened up than is visible at once.
- **Opened up and computed:** tens of thousands of relationships, within run-time limits set by the update interval.
- **Block form:** any size ONNX Runtime can run.

So a typical robot policy is imported as a block and opened up one or two layers at a time; a small control or surrogate network can be opened up whole.

## Core changes

Each of these is needed by the flagship workflow, and each is useful without it.

1. **Feedthrough node providers.** *Superseded by [Rates and values](ratesAndValues.md): a program with no state of its own, declared so by its author, is a term like any other and lands on a worked-out state at the instant, with no flag for the modeller.* A node provider marked as having no state of its own is evaluated in the cross-model algebraic pass, in dependency order with algebraic relationships, instead of as a co-simulation step, so a block adds no step of delay. Required, not only better, once blocks sit between opened-up parts. Any stateless external block benefits: a lookup service, a solver, a surrogate.
2. **`setsValue` source terms in the algebraic pass.** *Built (November 2026): a `setsValue` source term that reads a state the pass sets joins it, so the step of delay is gone rather than warned about; a loop through one is refused as `algebraicLoop`.* Either evaluate them in the same cross-model pass as algebraic relationships, or at least warn when an algebraic relationship reads a state one sets.
3. **Plugin-packaged node providers.** Computational-node providers can only be inline today; a toolbox needs to ship one (the ONNX Runtime block) in its `.kjp`, as relationship providers already are ([Plugin development](../pluginDevelopment.md)).
4. **Rendering at scale.** Draw relationships as one batched line geometry (or instanced mesh) rather than one object each, and render only when something has changed. Large logistics networks and interbank meshes benefit as much as networks do.
5. **An update interval for a group of algebraic relationships and providers.** Evaluated at multiples of the interval and held between, for discrete-time controllers of any kind.
6. **Code and FMU export of algebraic relationships.** The existing exports refuse models that use them; the robotics toolbox needs this as well.
7. **Plugin providers for nodes in the node editor, with a bindings editor.** A node's Program can choose an installed plugin provider, as a relationship's can, and any node provider (Python, C++, FMU or plugin) gets one editor for what its inputs read and which states its outputs set. FMU import gains the editor it lacks today.
8. **Model actions**, as described in [Model actions](#model-actions): add-on contributions that propose reviewed, undoable changes from the canvas's context menu, or return a file to save.

## A second workflow: process control and twins

After the flagship, the same pieces serve process control: a learned controller or a neural surrogate in a thermal, hydraulic or chemical plant, run as a [live twin](digitalTwinConnections.md). The new part is refitting: as the plant drifts, the twin's refit adjusts a few of the network's weights alongside the physical parameters, and the result can be exported back to the controller. The tank demo is the seed of this workflow's example.

## Out of scope

- Training, beyond fine-tuning a limited number of weights.
- Opening up convolution, attention or normalisation layers. They run as blocks.
- Networks too large for ONNX Runtime on the person's computer.
- The web edition, until C++ node providers run there.

## Open questions

- **ONNX Runtime or libtorch.** ONNX Runtime is much smaller (tens of megabytes against about a gigabyte) and reads the format we export; libtorch would run TorchScript without conversion. The proposal assumes ONNX Runtime; the helper script covers PyTorch.
- **How much a model action may see.** The proposal gives it the selection and what its package made. Opening up only some neurons of a layer may also need the layer's surroundings (the blocks on either side), which the package made, so this should suffice; it should be checked against the first real actions before the API is published.
- **Opening up very wide layers.** Some neurons of a layer is cheap; a whole 256-unit layer at a millisecond step is not (see [Rate](#rate)). Whether the Open up card should warn about cost before accepting, from the relationship count and the update interval, is worth deciding with the first users.
- **Which neurons' activations are recorded.** Recording every opened-up neuron's activation is simple, but a large layer records a lot; recording only what is visible, or what is marked, may be needed.
- **Who the first real user is.** The workflow should be checked with one engineer who has a learned policy and a problem with it, before the toolbox is built past the core changes.

## Order of work

1. **Core changes 1 and 2** (feedthrough providers, `setsValue` source terms in the algebraic pass), with tests. Small, and they remove both kinds of delay the prototype found.
2. **The ONNX Runtime block** as an inline C++ node provider, then **core changes 3 and 7** to package it and choose and wire it in the node editor. **Add › Neural network from file…** with its review card, importing a dense network as a block, with the fidelity tests.
3. **Core change 8** (model actions), then **opening up and closing** as actions, with the general rule for choosing what to open up, cutting ONNX sub-models, grouping into subsystems at import and afterwards, and **core change 4**, measured as the prototype measured the canvas: the real app driven through Playwright with a throwaway profile, models loaded with `window.__debugProject.load` and frames timed with `window.__debugSettle.frame`, at 1k, 4k, 16k and 65k relationships.
4. **Editing** (gains, pruning, tunable weights, the record of edits) and **export to ONNX** as an action, with its round-trip check.
5. **Core change 5** (update interval), then the **flagship example** with the Robotics Toolbox, and **core change 6** for exporting the whole loop.
6. The process-control workflow and recurrent cells.
