---
type: Proposal
title: Algebraic constraints
description: Implicit constraints on the graph -- Kirchhoff's laws at a junction, a rigid joint, incompressible continuity, a fixed sum of fractions -- written as a third kind of state whose equation is 0 = the sum of its parts, solved at every instant the Rate states are evaluated, so a model's constraints are as accurate as its method; which needs they meet that Updates and settling do not; semi-explicit index 1 first, with structural matching, blocks and the index found along the graph, higher index refused by name and later reduced by differentiation and projection; consistent initialisation; Newton per stage for Euler and Runge-Kutta, a mass matrix for Rodas4; partitions, determinism, programs, FMUs, export and the web; diagnostics in plain words; a file that changes only where a constraint is used; benchmarks; and a staged plan.
tags: [proposals, engine, numerics, solvers, constraints, dae, equations, editors]
status: draft
implementation: none
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Algebraic constraints

**Status: proposed 23 November 2026, design only; nothing here is built. It builds on [Rates and updates](ratesAndUpdates.md) (two kinds of state), [Integrators](integrators.md) (whole-model stages, Rodas4, Jacobian structure from the graph, Konjugate's own LU) and [One editor for nodes and relationships](unifiedEntityEditors.md) (one equation per state), and it takes up two things those proposals left out: "DAE solvers" in Integrators' table of methods left out, and "Solving stiff rings that settling does not converge on (Newton over the ring)" in Rates and updates. The [open questions](#open-questions) each carry a recommendation.**

## The problem

A Konjugate state is a **Rate**, $\frac{dx}{dt} = \sum$, integrated over the step, or an **Update**, $x^{+} = \sum$, replaced at its end ([Rates and updates](ratesAndUpdates.md)). Both are *explicit*: each state's equation says what the state is, or how fast it changes, from things already known. A great deal of engineering is not written that way. It is written as **conditions that must hold at every instant**, with no state on the left:

- the currents into a junction of a circuit sum to zero (Kirchhoff's current law), and the junction's voltage is whatever makes them do so;
- the two ends of a rigid rod stay a fixed distance apart, and the force in the rod is whatever keeps them there;
- the flows into a junction of incompressible pipework sum to zero, and its pressure is whatever makes them do so;
- the fractions of a mixture sum to one.

Each is an equation $0 = g(x, z)$ together with an unknown $z$ -- a voltage, a force, a pressure -- that has no equation of its own and is found from the condition. Together with the Rate states, $\dot x = f(x, z, t)$, that is a **differential-algebraic equation (DAE)**. Modelica tools (Dymola, OpenModelica) are built around them: they analyse the structure of the equations, reduce the ones that cannot be solved directly (index reduction), find consistent starting values, and integrate with a DAE solver.

Konjugate has none of this, and its bundled examples show the cost of doing without:

- **The four-bar linkage** ([example](../../examples/fourBarLinkage.md)) holds its rods by "nothing but stiff spring-dampers approximating rigid rods" because "it has no constraint solver to lean on": the rod lengths stay within 2 to 3 % of their nominal values, a visible error, and the stiffness and damping are tuning knobs with no physical meaning.
- **The pump suction line** ([example](../../examples/pumpSuctionHydraulics.md)) gives every junction an artificial capacitance (Chorin's artificial compressibility) because incompressible continuity cannot be written, and then needs added damping to keep explicit Euler stable; its own investigation found that damping to be about ten times the real pipe friction and the dominant source of head loss. Making the capacitance realistic needed proportionally more substeps, until a 3 s run took over a minute. It also avoids the implicit Colebrook–White friction equation for the same reason.

Updates and settling cannot stand in for constraints, for two reasons set out [below](#what-updates-and-settling-already-serve-and-what-they-cannot): a ring of Updates is settled by sweeping it, which only converges when the ring is a contraction, and an Update is held through a whole-model method's stages, so even an explicit value worked out from the Rate states couples to them at first order.

## Decisions in brief

These are the recommendations; each open choice among them is listed in [Open questions](#open-questions).

1. **A third kind of state, "algebraic"**, whose equation is $0 = \sum$: everything that reaches it (its node's own part, each relationship's part, a program's output) is summed into a **residual** that is kept at zero, and the state is one of the unknowns found so that it is. One equation per state stays true, so the system is square by construction: as many residuals as unknowns. A bidirectional relationship's part, added at one end and subtracted at the other, is Kirchhoff's current law and every other conservation law at a junction, with no new mechanism.
2. **Algebraic states are found wherever Rate states are evaluated**: at every stage of a whole-model method, at every substep for a block inside one node, and again after Updates change at the end of a global step. They read Updates as Rate states do, held from the start of the step.
3. **Semi-explicit index 1 first**: $\dot x = f(x, z, t)$, $0 = g(x, z, t)$ with $\partial g/\partial z$ non-singular. It covers circuits, incompressible networks, quasi-steady thermal nodes, chemical equilibria and fractions, and every method can solve it.
4. **Structure from the graph**: the compiled plan already knows which states every part reads; a maximum matching of residuals to algebraic states decides whether the system can be solved at an instant, and its strongly connected components split it into **blocks** solved in order. A constraint that cannot reach its unknowns at the instant has **index above 1**; how many times it must be differentiated to reach them, through the Rate states' equations, is its index, and it is found along the graph.
5. **Higher index is refused by name first, and reduced later** by Pantelides' algorithm, differentiation of the constraints that need it (symbolic, from MathJSON), and **projection** back onto every original and hidden constraint after each accepted step. Dummy derivatives with dynamic state selection are kept for later, if a benchmark needs them.
6. **Every method can solve index 1**: Euler node by node and Runge–Kutta 4 (and Dormand–Prince) solve the algebraic block by Newton's method at every stage, which is Runge–Kutta applied to the underlying ordinary differential equation, so their order is kept; Rodas4 takes the DAE directly in mass-matrix form. No method is refused; a model whose constraints make it stiff is told so and offered Stiff.
7. **Consistent initialisation** is a solve at the start: algebraic states' start values are guesses; Rate states' are fixed unless a person marks one "starts near"; values that cannot be met are refused by name, never quietly changed.
8. **The file changes only where a constraint is used**: a state says `kind: "algebraic"`, which every engine that reads kinds already refuses by name if it does not know it; no other field is written unless set.

## What needs implicit constraints

### Engineering cases

| Domain | Example | Constraint | Unknown it finds | Index |
| --- | --- | --- | --- | --- |
| Electrical | A resistor network between capacitors and inductors; an RLC filter drawn as its schematic (MSL `Modelica.Electrical.Analog`) | Kirchhoff's current law at each junction | the junction's voltage | 1 |
| Electrical | A diode, transistor or other nonlinear element across a junction | Current balance with $i = I_s(e^{v/V_T} - 1)$ | the junction's voltage, implicitly | 1 |
| Electrical | Two capacitors in parallel, or a capacitor across a voltage source; inductors in series with a current source | Voltages (currents) around a loop (cut set) of storage elements | none at the instant: their states are not independent | 2 |
| Hydraulic | Incompressible pipework with junctions and parallel branches (the pump suction line without artificial capacitance; a water distribution network, the Hardy Cross problem) | Continuity at each junction | the junction's pressure | 1 |
| Hydraulic | Colebrook–White friction factor | $\frac{1}{\sqrt{f}} = -2\log_{10}(\frac{\varepsilon}{3.7D} + \frac{2.51}{Re\sqrt{f}})$ | the friction factor | 1 |
| Thermal | A wall's surface, or a thin plate, with negligible heat capacity | The heat flows into it sum to zero | its temperature | 1 |
| Chemical | Fast equilibria and quasi-steady intermediates; Robertson's kinetics with $y_3 = 1 - y_1 - y_2$ | Equilibrium relations; mass conservation | the fast species' concentrations | 1 |
| Chemical | Electrolyte solutions | Charge neutrality | the hydrogen ion concentration (pH) | 1 |
| Process | A flash drum; a mixture's fractions | Vapour–liquid equilibrium; $\sum_i x_i = 1$ | the temperature or a fraction | 1 |
| Power | Generators on a grid (the classic transient-stability model) | Power flow at each bus | bus voltages and angles | 1 |
| Mechanical | A pendulum in Cartesian coordinates; a rigid rod; a closed linkage (the four-bar, a slider-crank, a parallel robot; MSL `MultiBody.Examples.Loops`) | Fixed distances and coincident points | the constraint forces (Lagrange multipliers) | 3 |
| Mechanical | Two inertias joined rigidly or through an ideal gear (MSL `Mechanics.Rotational`) | Equal (or proportional) angles | the torque between them | 2 (angle-level) |
| Logistics | A cross-dock with no storage | What goes in goes out at each instant | the outflow split | 1 |

Index 2 and 3 cases are listed because they are what people meet next, and because a tool that accepted them without reducing them would give wrong numbers or none.

### What Updates and settling already serve, and what they cannot

**Already served, and staying as they are:**

- **Derived quantities read by no Rate within the step**: a battery's terminal voltage from its charge, a sensor's reading, a port's waiting time. An Update reads the Rate states at $t + h$ and is exact at every sample.
- **Causal chains** settled within a step: the Robotics Toolbox's articulated-body method, which is the explicit solution of an open chain's joint constraints, worked out joint by joint. An open chain has a known order, and settling finds it.
- **Rings that are contractions**: settling sweeps a ring to its fixed point when it converges ([Rates and updates](ratesAndUpdates.md#settling-within-a-step)).
- **Discrete-time logic**: counters, sample-and-hold, a digital controller's output, which mean "once per step" and should stay so.
- **Compliance written on purpose**: a real spring, a real tank. A physically stiff element is a Rate and belongs to Rodas4, not to a constraint.

**Not served:**

- **Rings that do not settle.** Settling is a fixed-point (Jacobi) iteration. A resistor network with a voltage source, or pipework whose junctions have no capacitance, is a linear system that Jacobi sweeps converge on slowly or not at all, and a nonlinear one (a diode, quadratic pipe losses) may diverge; Rates and updates leaves such rings to "Newton over the ring", which is what this proposal is.
- **An unknown that cannot be put on the left.** The diode's junction voltage, Colebrook's friction factor and a flash drum's temperature appear inside nonlinear functions; there is no Update $x = \dots$ to write.
- **No natural direction.** A resistor should be one component whether its current is decided by its left end or its right. Modelica's acausal connectors exist for this, and an Update must pick a direction.
- **Accuracy under a whole-model method.** An Update is held through every stage of Runge–Kutta 4, Dormand–Prince and Rodas4 ([Integrators, Updates and settling](integrators.md#updates-and-settling)). A Rate that reads even an exact derived quantity, $y_3 = 1 - y_1 - y_2$, reads it at its start-of-step value through all four stages: the coupling is first order, whatever the method. An algebraic state is a stage quantity, found from the stage's Rate states, and keeps the method's order. So a quantity defined at the instant and read by a Rate belongs here even when it could be written explicitly.
- **Constraints on positions.** A rigid rod fixes positions that only forces change, and only through speeds. No Update can make it hold, and the penalty spring the four-bar example uses is an approximation with its own stiffness.

## The DAE Konjugate would solve

**Semi-explicit form.** With Rate states $x$ and algebraic states $z$:

$$\dot x = f(x, z, t), \qquad 0 = g(x, z, t)$$

Updates $u$ are constants within a step to both, as they are to Rates today. This is the form Konjugate's graph already has: every Rate state's derivative is the explicit sum of its parts, so $f$ is known, and every algebraic state contributes one residual to $g$.

**Index 1** means $\partial g / \partial z$ is non-singular: at any instant, given $x$, the constraints determine $z$ (the implicit function theorem), so the DAE is an ordinary differential equation $\dot x = f(x, z(x, t), t)$ in disguise. Its index is 1 because one differentiation of $g$ gives $\dot z$.

**Why index 1 first.** It is most of what the table above needs outside mechanics. Every method can solve it with no change to what a step is. Its consistent initialisation is a single solve for $z$ with $x$ given. And it needs no symbolic differentiation, which Konjugate does not have yet ([Integrators, Jacobians](integrators.md#jacobians-for-rodas4) plans it as stage 4). Higher index needs all of that, plus decisions (which states stay states, how drift is removed) that index 1 does not.

**Implicit ODEs are covered too.** A body with a configuration-dependent mass matrix, $M(x)\,\ddot q = F$, is written with an algebraic state $a$ for the acceleration: $\dot v = a$ as a Rate, and $0 = M(x)\,a - F$ on $a$. It is index 1 whenever $M$ is non-singular.

## Writing a constraint on the graph

### The choices, weighed

| | A third kind of state, $0 = \sum$ (recommended) | A constraint relationship | A free-standing equation, $0 = \dots$, as an entity or a node of its own |
| --- | --- | --- | --- |
| Where the unknown lives | it is the state the equation is written on | nowhere: a multiplier must be added somewhere | nowhere: unknowns must be named separately |
| Square system | by construction: one residual per algebraic state | only if unknowns are counted against relationships | only by a global count, so "too many equations" and "too few unknowns" become new errors |
| Conservation at a junction | the bidirectional rule already gives it | needs a new summing rule | needs the sum written out by hand at every junction |
| Constraints among more than two nodes (a fraction sum, a junction of five pipes) | yes | no: a relationship has two ends | yes |
| Fits one equation per state ([One editor](unifiedEntityEditors.md)) | yes: a new left side | no: an equation with no state | no: an equation with no state |
| Engine and file | one new value of `kind` | a new relationship kind with its own rules | a new top-level entity, a new binding scheme |

**Recommendation: a third kind of state.** Everything else in Konjugate is "a state, and the sum of what reaches it"; an algebraic state keeps that shape and changes only what the sum means.

### A third kind of state

A state with `kind: "algebraic"` is an unknown. Its equation is written

$$0 = \sum_j f_{ij} + s_i$$

with every part that reaches it -- its node's own part, each relationship's part (with its sign at either end of one running both ways), a program's output -- summed into its residual. At every instant at which it is needed, every algebraic state in a block is found together, so that every residual in the block is zero.

**The state an equation is written on is bookkeeping, not causality.** The equation on $z_i$ need not contain $z_i$: a capacitor's current $i_C$ carries the equation $0 = v_p - v_n - u_C$, which does not contain $i_C$; the junction balance next to it does. The structural analysis decides which unknown each equation determines (the matching, below); writing each residual on a state only guarantees that the counts agree and gives every residual a home on the canvas, a name in a message and a place in the results.

**The parts' units are the residual's.** A junction's voltage (V) carries a residual in amperes, a rod's force (N) a residual in square metres. The residual's unit is the parts' common unit, shown on the state's line, and the validator says so where parts disagree, as it already checks units elsewhere.

### Kirchhoff on the graph

A source $V(t)$ driving a resistor $R$ and a capacitor $C$ in series, drawn as its schematic:

| Node | State | Kind | Equation | Parts from |
| --- | --- | --- | --- | --- |
| Junction 1 | $v_1$ | algebraic | $0 = i_S - \frac{v_1 - v_2}{R}$ | Source's pin; Resistor |
| Junction 2 | $v_2$ | algebraic | $0 = \frac{v_1 - v_2}{R} - i_C$ | Resistor; Capacitor's pin |
| Ground | $v_0$ | algebraic | $0 = i_C - i_S + i_0$ | Capacitor's and Source's pins; its own $i_0$ |
| Ground | $i_0$ | algebraic | $0 = v_0$ | its own |
| Source | $i_S$ | algebraic | $0 = v_1 - v_0 - V(t)$ | its own; its pins |
| Capacitor | $u_C$ | Rate | $\frac{du_C}{dt} = \frac{i_C}{C}$ | its own |
| Capacitor | $i_C$ | algebraic | $0 = v_2 - v_0 - u_C$ | its own; its pins |

- **The resistor is one relationship running both ways** between Junction 1 and Junction 2. Its part, $\frac{v_1 - v_2}{R}$, is added to Junction 2's balance and subtracted from Junction 1's, which is the current leaving one and entering the other. Nothing new is needed: this is how a bidirectional relationship already works.
- **A pin is a relationship with two parts** ([Rates and updates, Terms](ratesAndUpdates.md#terms): "a relationship may carry several terms, each into a state at either end"): it carries the component's current into the junction's balance and the junction's voltage into the component's equation. It is Modelica's `connect()`, an across variable and a flow variable, drawn as an edge.
- **Six residuals, six unknowns, one Rate state.** The matching pairs $0 = v_0$ with $v_0$, $0 = v_1 - v_0 - V$ with $v_1$, $0 = v_2 - v_0 - u_C$ with $v_2$, and the three balances with $i_S$, $i_C$ and $i_0$; it exists, so the circuit is index 1.
- **The library hides the bookkeeping.** "Ground", "Voltage source", "Resistor", "Capacitor" and "Inductor" are templates ([Component library](componentLibrary.md)); a person places them and draws the wires. The pin relationships are what "connect" makes between a component and a junction.

### A rigid rod

A pendulum in Cartesian coordinates: a bob with Rate states $x, y, v_x, v_y$ and an algebraic state $\lambda$, the rod's tension per unit length.

$$\dot v_x = -\frac{\lambda x}{m}, \quad \dot v_y = -\frac{\lambda y}{m} - g, \qquad 0 = x^2 + y^2 - L^2 \ \text{(on } \lambda\text{)}$$

The residual on $\lambda$ does not contain $\lambda$, nor do its first derivative ($2(x v_x + y v_y)$); the second does. It is index 3. The structural analysis finds this from the bindings alone, and in the first stage the validator refuses it by name ([Diagnostics](#validation-structural-analysis-and-diagnostics-in-plain-words)); in the reduction stage it is differentiated twice and kept on both constraints by projection. A rigid joint between two bodies is a small joint node carrying the multiplier, with relationships to both bodies; the library's "Rigid rod" and "Revolute joint" templates make it.

### A fixed sum of fractions

A mixture node with Rate states $x_1$, $x_2$ (driven by reactions) and an algebraic $x_3$ with the node's own part $1 - x_1 - x_2 - x_3$: index 1, found at every stage, so a reaction rate that reads $x_3$ keeps the method's order. Written as an Update, $x_3 = 1 - x_1 - x_2$, it gives the same samples, but Rates read it held through the step.

### In the editors

[One editor for nodes and relationships](unifiedEntityEditors.md) makes a state's left side its kind, chosen from a control that lists the left sides as math. The list gains one line:

- $x =$ "its value, set each step" (an Update)
- $\frac{dx}{dt} =$ "how fast it changes" (a Rate)
- $0 =$ "found at every instant so that this equation holds" (algebraic)
- $\frac{d^2x}{dt^2} =$, greyed until the engine has it

The equation reads $0 = \frac{v_1 - v_2}{R} \;\boxed{-\,i_C}$ with its own part typed in and every other part a chip, exactly as for the other kinds. The state's line reads "Voltage · v · found at every instant, starts near 0 V", and under the equation one line says which unknowns it is found with: "solved with 5 others ›", opening the block's view (below). A state whose residual must be differentiated says so in the same place once reduction exists ("differentiated twice to find λ ›"). A relationship's card shows its parts in the balances they land on, read-only on the left side as for every kind. Choosing $0 =$ in a file that says no kinds makes it say every state's kind, in one undoable step, as choosing either kind does today.

The node's Numerics tab, under the substeps and the Updates setting, shows nothing new for a node with algebraic states; the run's settings hold the solve's tolerance ([Solving](#which-methods-solve-them)).

### On the canvas

- **A junction is drawn as a junction.** A node whose states are all algebraic and that has no Rate state of its own -- a circuit's junction, a pipe tee -- is drawn by the library's templates as a small dot rather than a box; it is still a node, opened and edited like any other. A hand-made node keeps its shape.
- **Algebraic states are marked** on a node's state list on the canvas with "0 =", as Rates and Updates are by their left sides.
- **Blocks are shown on request.** The block view (from "solved with 5 others ›", and from any finding about a block) highlights the nodes and relationships of the block and dims the rest, as a ring of settling Updates is highlighted today.
- **Findings land on the canvas** like every other: on the node whose residual could not be met, the states it names highlighted.

### Entry points

Following the rule that a feature is plainly named and reachable on a short path to a working result:

- **The left side's control**, above: the one place a constraint is written by hand.
- **The library**: an "Acausal electrical" section (Ground, Junction, Resistor, Capacitor, Inductor, Voltage source, Current source, Diode) and a "Hydraulic network" section (Junction, Pipe with Darcy–Weisbach and Colebrook–White, Tank, Pump curve), and, with reduction, "Rigid rod" and "Revolute joint". Placing a Resistor between two junctions makes it, its pins and their parts in one undo step.
- **A finding's action**: a ring of Updates that did not settle (`ringDidNotSettle`) offers "Solve as constraints", which makes the ring's states algebraic with residuals $0 = \sum - x$, as one undoable step that the finding says changes the numbers (they become the instant's solution, read at every stage, rather than a step-late sweep).
- **A tutorial**, "A circuit as you draw it", built on the acausal RLC benchmark model, once the tutorials list grows.
- **Two examples**: the four-bar linkage with rigid rods beside its penalty version, and the pump suction line with incompressible junctions beside its artificial-compressibility version, each guide saying what changed and by how much.

## Validation, structural analysis and diagnostics in plain words

### Structure from the bindings

The compiled plan knows, for every part, which states it reads ([Integrators](integrators.md#jacobians-for-rodas4)). So, at compile time and with no evaluation:

1. **The incidence of the algebraic system**: a bipartite graph with a row per residual (per algebraic state) and a column per algebraic state, with an entry where a part reaching the row reads the column. A version 2 program's declared dependencies sharpen its rows ([Program SDK version 2, Jacobians](programSdkV2.md#jacobians-for-rodas4)); without them its output is taken to read every input.
2. **A maximum matching** of rows to columns (augmenting paths, Duff's algorithm, in state order so it is the same every time). A **perfect matching** means the system is structurally non-singular: index 1, structurally.
3. **Blocks**: the strongly connected components of the matched graph (Tarjan's algorithm), in dependency order (the block lower triangular form). Each block is solved on its own, the smallest first; a block of one equation linear in its unknown is solved in one Newton step, and most circuits split into small blocks.
4. **If the matching is not perfect**, Pantelides' algorithm, specialised to the semi-explicit form: an unmatched residual is differentiated, which, because every Rate state's derivative is the explicit sum of its parts, means replacing each Rate state it reads by that state's parts. If the derivative reads an algebraic state the residual can be matched to, its index is 2; once more, 3. A residual that never reaches one, however often it is differentiated, is **redundant or inconsistent** (two voltage sources in parallel). Unknowns that no residual can reach are **undetermined** (a part of a circuit with no ground).

Structural non-singularity is necessary, not sufficient: a block can be singular at particular values (a linkage at a dead point). That is found at run time, when Newton's linear system cannot be factorised, and said by name.

### What the validator and a run say

| Code | When | What it says (example) |
| --- | --- | --- |
| `algebraicStateEmpty` | nothing reaches an algebraic state's equation | "Junction 3's voltage is found from its equation, but nothing is in it. Connect something to Junction 3, or give voltage a value or a rate." |
| `constraintUndetermined` | algebraic states no residual can determine | "Nothing decides the voltages of Junction 3 and Junction 4: they are connected to the rest of the circuit only through each other. Is a ground missing?" |
| `constraintRedundant` | residuals no unknown can satisfy, at any index | "Source A and Source B are connected in parallel: both fix the voltage between Junction 1 and Ground, so their equations can only both hold if they agree. Remove one, or put a resistance between them." |
| `constraintIndexTooHigh` | index above 1, while reduction is not built | "Rod length fixes Bob's x and y, but only a force changes a position, and only through a speed: nothing at an instant can make this equation true. Write the pendulum in its angle, or make the rod a stiff spring (as the four-bar linkage example does)." |
| `constraintDifferentiated` (information) | index above 1, reduced | "Rod length is met through its second derivative, which finds λ; Bob's positions and speeds are put back on the rod after every step." |
| `constraintNotDifferentiable` | a residual that must be differentiated has a program's part | "Rod length must be differentiated to find λ, but Rod model's part is a program, which Konjugate cannot differentiate. Write it as an equation." |
| `constraintThroughOlderProgram` | the only route from a residual to its unknown is an older (version 1) program | "Junction 2's balance reaches its voltage only through Pump (an older program), which is evaluated once a step and held: its output cannot follow the voltage within the step. Convert Pump to the current program format." |
| `constraintThroughFmu` (information) | an imported FMU's input reads an algebraic state and its output lands on that state's block | "Valve.fmu reads Junction 2's pressure and adds to its balance; an imported FMU steps on its own, so this loop is closed once a step, not at every instant." |
| `constraintUnitsDiffer` | parts of one residual in different units | "Junction 2's balance adds amperes (Resistor) to volts (Capacitor's pin)." |
| `constraintBlockLarge` (information) | a block of more than a few hundred unknowns | "Junctions 1 to 400 are solved together as one system of 400 equations; this is the run's largest cost." |
| `constraintStartInconsistent` | fixed start values that cannot meet a constraint | "Rod length is 0.3 m² off at the start: x = 1 m and y = 0.5 m are not on a rod of 1 m. Change one of them, or let Konjugate adjust one (starts near)." |
| `constraintStartAdjusted` (information) | starting values marked "starts near" were changed to meet the constraints | "To meet Rod length at the start, Bob's y was moved from −0.9 m to −0.866 m." |
| `constraintDidNotConverge` (run finding) | Newton did not meet a block within its limit | "At t = 2.31 s Junctions 1–4 could not be found: Junction 3's balance was still 0.02 A off after 50 tries. The circuit may have no solution here, or it may need smaller steps." |
| `constraintSingular` (run finding) | a block's linear system could not be factorised | "At t = 0.84 s the linkage's equations stopped determining Joint C's force: the linkage is at a position where it can move without anything moving it (a dead point)." |
| `constraintsMakeStiff` (run finding) | an explicit method's steps are limited by the constraints' fast dynamics | "This model is stiff where its constraints meet its capacitors: Runge–Kutta 4 needs very small steps here. Use Stiff." with "Use Stiff" |

Each finding names states, nodes and relationships by their names and short names, never by ids, highlights them on the canvas, and opens the block's view. The checks are the native validator's (`engine/src/modelValidator.cpp`), on the flat graph, so subsystems and components are checked after expansion as everything else is.

## Higher index: refuse first, then reduce

### Why refuse first

A higher-index model handed to a solver that expects index 1 does not fail cleanly: Newton's matrix is singular, or a method loses its order, or a constraint drifts slowly away. A refusal that says why, and what to write instead, is better than any of those. The refusal also costs nothing that reduction needs, so it can ship with index 1.

### How to reduce

**Pantelides' algorithm** finds which constraints to differentiate and how many times (above). Two ways then exist to integrate what results.

| | Differentiate and project (recommended first) | Dummy derivatives (Mattsson and Söderlind, 1993) |
| --- | --- | --- |
| Idea | integrate the index-1 system formed by the most-differentiated constraints (the pendulum at acceleration level: $\lambda$ found from $\ddot g = 0$); after each accepted step, move the states the least distance, weighted by their tolerances, back onto every original and intermediate constraint ($g = 0$, $\dot g = 0$) | keep every constraint and its derivatives as equations; demote as many differentiated states to algebraic ("dummy") as there are extra equations, so the system is index 1 and square with no drift |
| What must be chosen | nothing | which states to demote; for the pendulum $x$ or $y$, and the right choice changes as the pendulum swings (dynamic state selection) |
| Where it acts | at step boundaries, like an Update; deterministic | inside the step; switching the selection is an event with re-initialisation |
| Drift | removed at every accepted step; within a step $O(h^{p+1})$ | none |
| Order | kept (Hairer, Lubich and Roche; Ascher and Petzold, coordinate projection) | kept |
| Cost | one small Gauss–Newton solve per accepted step per reduced block | a larger algebraic block at every stage, plus the switching |
| What Modelica tools do | used in multibody codes | what Dymola and OpenModelica do, with tool-specific switching rules |

**Recommendation: differentiate and project first.** It needs no state selection and no switching, which is where Modelica tools differ most and fail most visibly; it acts at the step boundary, where Konjugate already changes states (Updates, live control, a twin's replaced states), so determinism, checkpoints and the live session follow; and its order is a known result. Dummy derivatives are kept for later, if the MSL comparisons find a model that projection handles badly (a long run where per-step projection costs too much, or a model whose constraints must hold exactly within steps). **Baumgarte stabilisation** is not proposed: its feedback gains are tuning knobs and make the system stiff, the very things the penalty spring has today.

Reduction needs **symbolic differentiation** of the residuals, which [Integrators](integrators.md#jacobians-for-rodas4) plans as its stage 4 (analytic Jacobians from MathJSON). So reduction comes after that, and a constraint with a program's part that must be differentiated is refused by name (`constraintNotDifferentiable`).

## Consistent initialisation

**Index 1.** Before the first step, with every Rate state at its start value and every Update at its, each block is solved for its algebraic states, using their stored `initialValue` as Newton's first guess. The stored value of an algebraic state is a guess, as a settling Update's stored initial value is a placeholder today. Initialisation uses damped Newton with a larger iteration limit than a step, since the guess may be far off. If it fails, the run does not start, and `constraintDidNotConverge` says which block and how far off it was.

**Fixed and guessed start values.** A Rate state's start value is fixed: it is what the person said. A person may mark it **starts near** (a toggle on the state's opened line, beside ◎), and it becomes a guess the initialisation may move. Needed for index 1 only when a person wants a constraint to choose a Rate state's start; needed often after reduction, where hidden constraints restrict Rate states too ($x v_x + y v_y = 0$ for the pendulum). Fixed values that cannot meet the constraints are refused (`constraintStartInconsistent`), never quietly moved; values marked "starts near" are moved the least distance that meets them, and the run says so (`constraintStartAdjusted`). Over- and under-determined starts (more fixed values than the constraints allow; fewer than they need) are found by the same matching, at the derivative level, and said by naming the states to free or to fix.

**Several solutions.** A quadratic constraint can be met in more than one way (a four-bar assembled in either of its two modes, a circuit with a tunnel diode). Newton finds the solution nearest its guess, and keeps following it from step to step; the help says so, and a person chooses the branch by the start values.

**When values jump.** Algebraic states are found again, from the values just before as guesses:

- **after the Updates are replaced** at the end of every global step (the update phase is a jump in the constants the constraints read);
- **after a live parameter set** or a scheduled parameter lands, before the next step;
- **after a checkpoint is restored**: the stored algebraic values are the guesses, and since they were consistent the solve returns them to the bit (it checks the residual and takes no Newton step when it is already met);
- **after a live twin's rewind with states replaced** ([Live engine session](liveEngineSession.md)): measured states are fixed, and, after reduction, unmeasured Rate states in a reduced block are projected;
- **for every member of the state estimator** ([State estimator](stateEstimator.md)) after its correction: algebraic states are not filter states (they are functions of the Rate states), so they are never corrected directly, only found again.

## Which methods solve them

### The rule

**Algebraic states are found wherever Rate states are evaluated.** Whatever the method, every evaluation of $f$ is preceded by the solve of $g = 0$ for $z$ at the same Rate state values, so every Rate reads algebraic states consistent with what it reads of the Rate states. For a whole-model method this is every stage; for Euler node by node, every substep of a block that lies within one node, and the step's start for one that spans nodes (held through the step, as other nodes' states are).

Within a global step, from $t$ to $t + h$:

1. every state is read at $t$; the algebraic states are consistent there (from the end of the previous step);
2. Rate states are integrated, the algebraic states found at every stage (or substep, above), Updates held at $t$;
3. the algebraic states are found at $t + h$ from the Rate states reached and the Updates at $t$ (for a stiffly accurate method, the last stage gives them);
4. Updates are replaced, reading Rate and algebraic states at $t + h$, as Rates and updates says;
5. the algebraic states are found once more, with the new Updates; these are the values sampled, checkpointed and read by the next step. After reduction, projection runs here too.

An Update that reads an algebraic state whose residual reads that Update is a ring that goes round once per step, as every ring through an Update does; validation names it (`updatesRing` gains algebraic states in what it lists).

### Methods

| Method | How it solves index 1 | Cost | Order |
| --- | --- | --- | --- |
| **Euler, node by node** (default) | Newton at each substep for a block within one node; at the step's start for a block spanning nodes, held through the step | one block solve per substep (local) or per global step (spanning) | first order, as today; coupling through a spanning block first order in $H$ |
| **Semi-implicit node** | as above, solved once at each substep's start; the node's states then updated in order | as above | first order; a constrained mechanism loses the symplectic property (RATTLE is left out) |
| **Runge–Kutta 4** | Newton at every stage (the state-space form: RK4 applied to $\dot x = f(x, z(x), t)$) | four block solves a step, each warm-started from the previous stage | 4, provided Newton's tolerance is below the step's error; the solve's tolerance is set from it |
| **Dormand–Prince 5(4)** | Newton at every stage; error estimated on Rate states only (algebraic states are functions of them); a solve that fails rejects the step | six or seven block solves a step | 5 |
| **Rodas4** | the DAE directly, in mass-matrix form, $M\dot y = F(y)$ with $M = \mathrm{diag}(I, 0)$: algebraic rows enter the factorised matrix $M/(h\gamma) - J$; no Newton iteration within the step | one Jacobian (now including the algebraic rows and columns) and one factorisation a step | 4 for index 1 (RODAS was built to keep it); stiffly accurate, so the step's end meets $g = 0$ to the method's error |
| **BDF** (planned) | the DAE directly, as DASSL does | Newton on the corrector, Jacobian reused | variable; index 1, and index 2 with care |

**So no method is refused for index 1.** What is unsuitable is a mismatch of method and model, not of method and constraint: an index-1 model often comes from removing a fast time constant (a junction's capacitance) and the fast dynamics that remain make it stiff, and an explicit method then takes tiny steps or fails to converge at a stage. That is said with `constraintsMakeStiff` and "Use Stiff", and the Run dialog, when a model has algebraic states, says under Method: "This model has constraints. Every method meets them at each step; Stiff is usually fastest for circuits and networks."

**Higher index, once reduced**, is index 1 plus projection, and every method takes it the same way; projection runs after every accepted step, and for Euler node by node after every global step. No method is ever given an unreduced index 2 or 3 system.

### Newton's method, in detail

- **Per block, in block order**, warm-started from the block's last values (the previous stage, substep or step).
- **The Jacobian** of the block's residuals with respect to its unknowns: coloured finite differences from the graph's structure ([Integrators](integrators.md#jacobians-for-rodas4)), analytic once MathJSON differentiation exists. It is recomputed at the start of every global step and reused within it (simplified Newton) while Newton contracts fast enough, recomputed when it does not; the rule is fixed and depends only on computed numbers, so it is deterministic and leaves no hidden state in a checkpoint.
- **The linear solve** is Konjugate's own dense LU with partial pivoting, and sparse LU with a fill-reducing ordering for large blocks, the same code Rodas4 uses, run on one worker, with the ordering computed once.
- **Converged** when the weighted norm of the Newton correction, scaled by each state's tolerance, is below a fraction of the step's error tolerance (for adaptive methods), or below a fixed tolerance (relative $10^{-10}$, absolute from the state's scale) for fixed-step methods; a run configuration may set `constraints.tolerance`.
- **A limit on iterations** (default 50 a solve, 200 at initialisation; `constraints.iterationLimit`), with damping (a backtracking line search) at initialisation and after a jump.
- **Failure**: under an adaptive method the step is rejected and shortened, as for `OutOfDomain` ([Program SDK version 2](programSdkV2.md#exceptions-and-non-finite-values)); under a fixed-step method the run stops, keeping the samples it has, with `constraintDidNotConverge`. A run never carries on with a constraint it could not meet, because the numbers after it would be wrong with nothing to say so.

## The graph architecture

### Determinism

The rule that makes backends agree -- every evaluation reads an immutable snapshot, every reduction has a stable order, every node writes only its own states -- holds for the solve. The residual parts are evaluated in parallel, each entry written by one evaluation; the residual's norm and the Newton correction's are reduced in node order, as Dormand–Prince's error norm is; the factorisation and solve run on one worker with an ordering fixed at compile time; the Jacobian reuse rule depends only on those numbers. So every backend at every worker count does the same Newton iterations and gives the same bits. Across platforms, numbers differ by rounding, and rarely a rounding difference may change an iteration count; the benchmark compares platforms within tolerance.

### Partitions and parallel execution

**A block is one unit of work.** The communication-aware partitioner keeps each block's nodes in one partition where it can, its weight the block's evaluations times its expected iterations. A block that must span partitions (a large network) is solved by the partition holding its first node in state order: each Newton iteration, the others evaluate their parts of its residuals and send them, and receive the new values; one exchange per iteration, deterministic, and reported in the execution summary so a model where it dominates is visible. Blocks in different partitions with no dependency between them are solved concurrently.

### Multi-rate

Under Euler node by node, a block within one node is solved at the node's substeps; a block spanning nodes with different substeps is solved at the global step and held, and validation says so in a line of information ("Junction 1 to Junction 4 link nodes stepping at different rates; their constraints are met at each global step"). Under a whole-model method there are no per-node substeps, as now.

### Programs

- **A version 2 program** ([Program SDK version 2](programSdkV2.md)) is pure in `evaluate()`, so it may be called at every Newton iteration and differenced for the Jacobian; its memory is constant within the step and changes in `advance()` after the step is accepted (after step 5 above). Its declared dependencies sharpen the matching; an analytic Jacobian, when it provides one, is used.
- **A version 1 program** is evaluated once a step, as now (held under a whole-model method, once per substep node by node), and its output is a constant within every solve: calling it at every Newton iteration would advance whatever memory it keeps. It therefore adds nothing to the incidence, and where it is the only route from a residual to its unknown the model is refused (`constraintThroughOlderProgram`), pointing at the converter.
- **A node program** cannot set an algebraic state ("set by program" belongs to Updates and Rates); its outputs may add parts to a residual, under the rules above.
- **A program's output landing on a residual** is a part of it like an equation's, shown as a chip.

### Imported FMUs

A Co-Simulation FMU is stepped once a global step and held ([Integrators](integrators.md#nodes-that-cannot-take-stages-fmus-and-stateful-node-providers)). Its outputs are constants within every solve, and its inputs read the algebraic states at the step's start. A loop through an FMU with direct feedthrough cannot be solved at the instant (the FMU cannot be asked again for the same instant); it is closed once a step, and validation says so (`constraintThroughFmu`). Importing Model Exchange, which could take part in the solve, stays outside this proposal as it is outside Integrators.

### Live control, the twin and stability analysis

- **Live control and schedules** land at global steps, after which the algebraic states are found again ([Consistent initialisation](#consistent-initialisation)); a parameter change that makes the constraints unmeetable stops the run with a finding naming the parameter.
- **Pacing and the twin's speed budget** measure the solve with everything else.
- **Stability analysis** uses the underlying ODE's Jacobian, $f_x - f_z\, g_z^{-1} g_x$, per block (the Schur complement), so its eigenvalues and step limits are those of the dynamics the constraints leave; it reports the constraints' contribution when they are what makes the model stiff.
- **Parameter tuning** runs the model as it is run; a candidate whose constraints cannot be met at the start fails with its reason and is skipped, as a failed run is today.

### Code export, FMU export and the web

**Code export** reproduces the engine's arithmetic exactly or refuses by name. The solve is written as the engine computes it: the block order, the coloured Jacobian, the reuse rule, the LU and the stopping rule, from the same headers the integrators use (`engine/include/konjugate/integrators/`), pasted in as plain C++ with no dependency; the Python export carries a line-for-line port. Each method's export gains the solve in the stage that builds it, and refuses a model with algebraic states, by name, until then. The OpenMP, `std::thread` and MPI modes solve a block on one thread and synchronise as the engine does.

**FMU export** runs the same solve inside `fmi2DoStep`; algebraic states may be outputs of the FMU (a junction's voltage, a rod's force); `fmi2SetReal` of a parameter makes the next `fmi2DoStep` find them again first; `fmi2GetFMUstate` and serialisation hold them like every state (they are the next solve's guess). Model Exchange export stays not offered.

**The web edition** gains no dependency: matching, blocks, Newton and LU are Konjugate's own code under Emscripten. The threaded web build solves blocks as the native thread pool does.

## File format and backwards compatibility

The hard rule: every file a released version wrote opens and gives the same numbers to the bit; a file this version writes without the new features is byte for byte what the version before wrote; new fields are written only when used. A model with no algebraic state never reaches the new code: the structural analysis finds no algebraic state and the plan compiles as today.

### Project document

| Change | Written when | Older files in this version | This version's files in older versions |
| --- | --- | --- | --- |
| A state's `kind: "algebraic"` | only on an algebraic state | absent: rate or update, as today | refused by name by every engine that reads kinds (`stateKindInvalid`); engines that predate kinds (the released 1.4 series) do not read `kind` and would integrate the residual as a rate, below |
| An algebraic state's `initialValue` | as today | -- | read as a start value |
| A Rate state's `initialValueFixed: false` ("starts near") | only when false | absent: fixed, as today | kept by the codec's pass-through, ignored |
| A run configuration's `constraints: { tolerance, iterationLimit }` | only when set and not default | absent: defaults | ignored |
| `requires` | not written: the unknown `kind` already makes every engine that reads kinds refuse | -- | -- |

**Older engines.** An engine that reads kinds and does not know `algebraic` refuses the file with `stateKindInvalid`, naming the state; that engine's message cannot be improved after the fact, but it is a refusal, not a wrong answer. The 1.4 series predates kinds and would read the state as a Rate and integrate its residual: wrong numbers, silently. Rates and updates already accepted the same exposure for `kind: "update"`, and Integrators for `method` (its decision 2). This proposal accepts it on the same terms, and recommends that the first release with algebraic states be one in which kinds have already shipped (2.0.0 or later), so the gap is only the released 1.4 series. No marker on every node is written to make 1.4 refuse.

**A file that says no kinds** is unchanged: it cannot contain an algebraic state, since saying one makes the file say every kind (above).

**Pasting and components**: content with algebraic states put into a file that says no kinds makes that file say its kinds in the same undoable step, as content saying any kind does today ([Project schema](../projectSchema.md)).

### Results and checkpoints

| Change | Older results in this version | This version's results in older versions |
| --- | --- | --- |
| Algebraic states recorded as states | -- | open and play as states; continuing a checkpoint is refused by the model's `kind` as above |
| Checkpoint | algebraic states are states, so `ResultCheckpoint` holds them already; no new field. The Jacobian is recomputed at every global step, so `solver_state` gains nothing | unchanged |
| The execution summary's blocks, reductions and solve cost | absent | skipped as unknown fields |
| New findings (`constraintDidNotConverge`, `constraintSingular`, `constraintsMakeStiff`) | absent | skipped |

## Verification

The [benchmark suite](../../benchmarks/README.md) is the proof, with its rules unchanged: committed models, exact or independent references, thresholds in each `benchmark.json`.

**The default, to the bit.** Every bundled example's digest unchanged, and the Logistics and Robotics Toolboxes' engine runs replayed before and after each stage; `benchmark:accuracy` unchanged with no threshold moved; a file saved without algebraic states byte-identical to the previous version's.

**Structural analysis**, as unit tests with known answers: a circuit without a ground (undetermined), two sources in parallel (redundant), a capacitor across a voltage source and two capacitors in parallel (index 2), the Cartesian pendulum (index 3), a slider-crank (index 3), a resistor ladder (index 1, blocks of one), a mesh (one block); each message's text checked.

**Index 1.**

- **Robertson as a DAE**, $y_3$ algebraic with $0 = y_1 + y_2 + y_3 - 1$, Hairer and Wanner's standard index-1 form: concentrations against the published reference at the standard checkpoints to $t = 10^{11}$ under Rodas4, the constraint to rounding, and its numbers equal to the ODE form's within tolerance.
- **The acausal RLC circuits**: `benchmarks/electrical/rlcCircuits`' series and coupled circuits drawn as schematics (junctions, resistor relationships, capacitor and inductor nodes, a source and a ground) give the causal models' numbers within tolerance, every balance below tolerance at every sample, and the method's order in the convergence study (Runge–Kutta 4 between 3.9 and 4.1), showing the solve costs no order.
- **A resistor network** with an exact solution (a ladder driven by a step): exact to rounding, every block solved in one Newton step.
- **The pump suction line, incompressible**: the junctions' pressures algebraic, no artificial capacitance or damping, against a reference computed independently (the underlying ODE in SciPy's Radau at tight tolerance, `benchmarks/reference/generateReferences.py`), and beside the example's present numbers, the difference reported.
- **The transistor amplifier and the Akzo Nobel problem** (index 1, from the IVP Test Set, Mazzia and Magherini) against their published references.
- **Updates against algebraic states**: the fraction sum as an Update and as an algebraic state under Runge–Kutta 4; the Update's coupling has order 1 and the algebraic state's order 4, which is the reason this proposal gives for stage quantities.

**Higher index, once reduced.**

- **The pendulum in Cartesian coordinates**, index 3 reduced to 1: its angle $\mathrm{atan2}(x, -y)$ against `benchmarks/mechanical/pendulum`'s reference, $x^2 + y^2 - L^2$ and $x v_x + y v_y$ below tolerance at every sample, energy drift bounded over the benchmark's horizon, the method's order observed; and, before reduction is built, the refusal and its text.
- **The four-bar linkage with rigid rods**: with the crank's angle commanded, the linkage's positions are known in closed form; rod lengths exact to tolerance, against the penalty version's 2–3 %.
- **Two inertias joined by an ideal gear** (index 2) equal to the single equivalent inertia; **a capacitor loop** (index 2) equal to its equivalent capacitor.
- **Andrews' squeezing mechanism** (index 3, IVP Test Set) against its reference, as the stress case for projection.

**Modelica Standard Library comparisons.** The benchmark suite's MSL phase (in progress) first records, for each MSL example compared, whether it can be written in Konjugate without constraints, with constraints of index 1, or only with reduction: that tally decides how soon reduction is needed. The candidates for accuracy comparisons, against OpenModelica at tight tolerance with the same parameters, are `Modelica.Electrical.Analog.Examples.ChuaCircuit` (index 1, nonlinear), `CauerLowPassAnalog` (capacitor loops, index 2), `Modelica.Mechanics.Rotational.Examples.First` (rigidly connected inertias and a gear), `Modelica.Mechanics.MultiBody.Examples.Elementary.Pendulum` and `MultiBody.Examples.Loops.Fourbar1` (closed loop, index 3); examples with ideal switches and diodes (structure that changes at events) are outside this proposal and recorded as such.

**Determinism and restart.** Bits identical across serial, thread pool and partitioned at several worker counts on the acausal RLC, a block deliberately split across partitions, and the reduced pendulum; a run to $T$ equals a run to $T/2$ continued from its checkpoint; a live parameter set re-initialises identically on replay; WebAssembly within rounding of native.

**Export.** C++ and Python export reproduce the engine's samples to the bit on the acausal RLC and, once reduced, the pendulum; `test:fmiExportFidelity` and `test:fmiRoundTrip` run with algebraic states, including `fmi2GetFMUstate` across a step.

**The editors and canvas**: interaction tests for choosing $0 =$, the block view, "Solve as constraints" from a ring that did not settle, and each finding landing on its nodes.

## Order of work

0. **Measure the need.** The MSL comparison's tally, above, and the two examples' present errors, recorded before anything is built.
1. **Index 1 under the methods built so far.** `kind: "algebraic"` in the codec and the engine; the structural analysis (incidence, matching, blocks, Pantelides' index detection) and its messages in the validator; higher index refused by name; consistent initialisation with "starts near"; Newton per block with Konjugate's own dense LU (shared with Rodas4, built here if Rodas4 has not yet); solving under Euler node by node and Runge–Kutta 4; the re-solve after Updates, live control and restore; determinism on every backend; the editors' $0 =$ and state line, the block view, canvas markings; export refused by name. Benchmarks: Robertson as a DAE, the acausal RLC, the resistor network, the transistor amplifier, the Update-against-algebraic comparison. Nothing ships until every digest is unchanged.
2. **With Rodas4 and Dormand–Prince** ([Integrators](integrators.md) stages 2 and 3): Rodas4 in mass-matrix form, Dormand–Prince with Newton per stage and rejection on failure, `constraintsMakeStiff` with "Use Stiff". The incompressible pump suction line and Akzo Nobel in the benchmark.
3. **The library and the way in**: the acausal electrical and hydraulic sections, junctions drawn as dots, "Solve as constraints" on a ring that did not settle, the incompressible pump suction example, and the tutorial.
4. **Export**: C++, Python and FMU export of the solve, per method.
5. **Higher index**, after analytic Jacobians from MathJSON ([Integrators](integrators.md) stage 4): differentiation of residuals, reduction to index 1, projection after each accepted step, initialisation on hidden constraints; "Rigid rod" and "Revolute joint"; the Cartesian pendulum, the rigid four-bar (as a second version of the example), the gear and capacitor-loop cases, Andrews' squeezing, and the MSL mechanics comparisons.
6. **Only if measured**: dummy derivatives with dynamic state selection; sparse LU tuned for very large networks; concurrent block solves across partitions; BDF ([Integrators](integrators.md#left-out-and-why)) if a large stiff DAE shows Rodas4's factorisation a step dominating.

## Not in this proposal

- **Structure that changes at events**: ideal diodes and switches, clutches that lock and slip, contact that opens and closes. They need event location (planned with dense output) and re-initialisation at the event, on top of this.
- **Fully implicit DAEs** $F(\dot y, y, t) = 0$ with no Rate/algebraic split; the semi-explicit form covers them through an algebraic state for each implicit derivative (above).
- **Optimisation constraints** (inequalities, bounds on a design), which belong to [Toolbox mechanisms and design optimisation](toolboxMechanismsAndDesignOptimisation.md), not to simulation.
- **Symplectic constrained integrators** (SHAKE, RATTLE), the natural follow-up to semi-implicit Euler for constrained mechanics.

## Open questions

1. **How a constraint is written.** A third kind of state (an unknown carrying $0 = \sum$), a constraint relationship, or a free-standing equation. *Recommendation: the third kind of state*, for the square system, the bidirectional rule giving conservation at junctions, and one equation per state.
2. **Words.** The left side $0 =$ with "found at every instant so that this equation holds" in the editor; "algebraic" in the file (`kind: "algebraic"`), in the help and in messages only where needed ("constraint" in messages a person reads). *Recommendation: as written*; "constraint" was considered for the file, but the state is the unknown, not the constraint.
3. **Euler node by node with constraints.** Allow it, solving blocks within a node at substeps and spanning blocks at the global step, or require a whole-model method for any model with algebraic states. *Recommendation: allow it*, since it is the default and first order either way, and offer Stiff through the finding when the constraints make the model stiff.
4. **Higher index.** Refuse by name first, then reduce by differentiation and projection; dummy derivatives only if measured. *Recommendation: as written*, with the MSL tally (order of work 0) deciding how soon stage 5 comes.
5. **Where a multiplier lives.** Relationships could own algebraic states (a rigid rod's force on the rod itself) instead of a small joint node. *Recommendation: nodes only for now*: one place for states, one editor, and templates that make the joint node; reconsider with [Subsystem components](subsystemComponents.md) and the relationships-with-states question that proposal raises.
6. **Start values.** Fixed by default with a "starts near" toggle, and inconsistent fixed values refused; or adjusting them silently by least squares. *Recommendation: refuse and say*, with "starts near" one click away from the message, since silently moved start values make a result that does not match what the file says.
7. **Older programs on a residual.** Held and refused only where they are the sole route to an unknown, or refused on residuals outright. *Recommendation: held, refused only where needed*, so a load modelled by an older program still works in a circuit.
8. **A fixed-step solve that fails.** Stop the run, or carry on with the last values and a warning. *Recommendation: stop*, keeping the samples so far, since every number after an unmet constraint is wrong.
9. **The solve's tolerance.** Tied to the adaptive methods' tolerance, and fixed (relative $10^{-10}$) for fixed-step methods, with `constraints.tolerance` to override. *Recommendation: as written.*
10. **Drawing junctions.** Library junctions as dots, hand-made nodes unchanged, or every node with only algebraic states drawn as a dot. *Recommendation: library only*, so a person's own drawing never changes shape under them.
11. **"Solve as constraints" on a ring that did not settle.** Offer it, saying the numbers change, or leave the conversion to the editor. *Recommendation: offer it*: it is the shortest path from the problem a person meets today to the feature that solves it.
12. **The released 1.4 series** reading `kind: "algebraic"` as a Rate. Accept it, as `kind: "update"` and `method` already are, or write a marker that 1.4 refuses. *Recommendation: accept*, and ship algebraic states no earlier than a release in which kinds have already shipped.
