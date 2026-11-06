---
type: Proposal
title: The tuning objective in the equation editor, and objectives written as programs
description: Design for writing a tuning objective and its limits in the same visual equation editor edges use, for objectives written as C++ or Python programs, and for the shared classes that make both of these, the existing equation editors and the engine's scoring one family of code instead of four copies.
tags: [proposals, tuning, optimisation, ux, providers, refactoring]
status: draft
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# The tuning objective in the equation editor, and objectives written as programs

**Status: steps 1 to 5 built, with the gaps listed under them.** Follows [Parameter tuning with a custom objective](parameterTuningObjectives.md), whose four stages are built with a plain text box for the objective. Written down first, like that one, so the shape of the code can be reviewed before it is written. The rule that shapes everything below: **nothing is built a second time.** Where the tuning card needs something an edge, a source term or the engine already has, it uses that, and where there are already several copies of it, they become one.

## What is wrong today

The objective is typed as text into a box, with buttons that insert names such as `waterTank_tankTemperature`. It works, but it is a different thing from every other place in Konjugate where a person writes a formula: edges and source terms use a visual maths editor with Visual and LaTeX modes, reference chips that read "Water tank · temperature", and a line under it that says as you type whether the expression is valid. A person who has learned one has to learn another, and a mistake (a state outside a summary, an unknown name) is only reported after Run is pressed.

An objective also cannot express what some goals need. Settling time, overshoot, a cost computed from a frequency spectrum, a figure read from another tool: none of them is a short formula. Edges solve the same problem by letting an Implementation be a C++ or Python program instead of an equation, and tuning should offer the same choice.

## What already exists, and what is copied

Looking before designing, this is what the code has.

| Need | Where it already is | State of it |
| --- | --- | --- |
| A maths field with a LaTeX mode, kept in step with each other, inserting a reference at the cursor, with a diagnostics line | Four places in `renderer.mjs`: the edge builder (`#edgeMathField`), the edge editor (`#editEdgeMathField`), the source-term editor (`#termMathField`) and the edge-group editor (`#groupMathField`) | **Copied four times.** Each has its own input handler, mode buttons, insert function and diagnostics function. |
| Reference chips for states and parameters | `reconcileEquationBindings`, `latexForBinding` in `equationModel.mjs`, drawn by a different function in each of the four places | Logic shared, drawing copied. |
| Checking a formula | `validateEquationLatex` in `equationModel.mjs` | Shared. |
| An Implementation choice (Equation, C++ program, Python program), a code editor window, bindings from keys to states and parameters, a starter template | `edgeImplementationKind`, `window.providerEditor.openWindow`, `defaultProviderSource`, the bindings rows in `renderer.mjs`, again four times (builder, edge editor, source term, group) | Copied, though the editor window and templates are shared. |
| Compiling C++ | `cppToolchain::buildNativeArtifact`, and the toolchain choices in Provider Toolchains | Shared, one function. |
| Running a user's program from the engine | `providerRuntime.cpp`, built around evaluating a provider every substep | Shaped for per-step work; a whole-run objective needs a simpler path. |
| Scoring a trial | `evaluateFittingTrial`, which branches on "is there an objective expression or a CSV mapping" | Two code paths in one function. |
| An optimiser the search can swap | `OptimizerBackend` (abstract) with the NLopt backends | The pattern to copy for scoring. |

So the work is as much consolidation as new features, and the order below does the consolidation first, in the place where it is needed anyway.

## In the interface

### One equation editor class

A class `EquationEditor` in `src/renderer/equationEditor.mjs` owns what the four copies each do: the maths field, the LaTeX textarea, the Visual / LaTeX buttons, keeping the two in step, inserting a piece of LaTeX at the cursor in whichever is showing, and the diagnostics line. It is given what it needs (the elements, a function that validates a formula, and a function that supplies the reference chips) and tells its owner when the formula changes. It knows nothing about edges.

```
EquationEditor                      the maths field, the LaTeX mode, insert, diagnostics
├── RelationshipEquationEditor      references are the two nodes' states and the parameters; validation is validateEquationLatex
├── SourceTermEquationEditor        references are the node's own states and the parameters
└── ObjectiveEditor                 references are states, parameters and measured columns; summaries; validation is the objective check
        └── LimitEditor             the same, one per limit row, for a number the run must stay within
```

The first step is to make `EquationEditor` and move the **edge builder** onto it, which proves it against the existing, well-tested behaviour; the other three existing editors move over afterwards, one at a time, each with its interaction tests passing before the next. None of that changes what a person sees. The new `ObjectiveEditor` and `LimitEditor` are then small, because the maths field is already built.

A second class, `ReferenceChips`, draws the groups of buttons (states, parameters, measured data, summaries) from a list of `{ label, insertion, title }`, and replaces the five hand-written chip loops.

### What the objective looks like in it

- States, parameters and measured columns appear as chips labelled the way people name them ("Water tank · Water temperature"); what is inserted is a symbol, as for an edge.
- The summaries insert as maths: `final`, `max`, `min` and `mean` as functions, and **integral over the run** as a ∫ with its limits fixed to the run's start and end, so there is nothing to misread about what it adds up.
- The diagnostics line says, as you type, what is wrong: a state used outside a summary ("Water temperature changes over the run: use final, max, min, mean or the integral"), an unknown name, an unclosed bracket. It also says what the expression will compute, in a sentence ("the total over the run of the squared difference between Water temperature and 320 K, plus 0.1 × k²").
- Each limit is a row of the same editor, with **at most / at least** and a number.
- **Match measured data** writes its squared-error objective into this editor, and **Edit as expression** is simply leaving it there to change, which is what the earlier proposal intended.

### An objective that is a program

The goal choice becomes **what scores a run**: an expression, or a program, picked from the same Equation / C++ program / Python program list an edge has. Choosing a program shows the controls an edge shows for one, built from the same parts: a **Bindings** table, an **Open code editor** button that opens the same editor window with a starter template, and **Reset template**. A shared `ProgramSourceSection` class draws them, and the edge builder and edge editor use it too, in place of the markup they each carry.

The bindings are the keys the program reads. A key is bound to a state (its series over the run), a parameter (its value in the trial) or a measured column. The program is given the run as a whole and returns a number:

```cpp
#include <konjugate/objectiveProvider.hpp>

double objective(const konjugate::Run& run) {
    const auto& temperature = run.series("block");        // the state's value at every output time
    const auto& times = run.times();
    // ... settling time, overshoot, anything computed from the whole run ...
    return settlingTime;
}
```

```python
def objective(run):
    temperature = run.series("block")
    return settling_time(run.times, temperature)
```

A program can also return named extra numbers (`run.report("peak", peak)`), and a limit row can then be set to one of those names in place of an expression, so a program can supply both its objective and the quantities to be kept within bounds. The direction (**Minimise / Maximise**), the limits, the run settings and everything after them (progress, stop, review, plot) are the same for both kinds, because they come from the objective, not from how it is written.

## In the engine

### One family of scoring classes

`FittingProblem` stops carrying `objective`, `objectiveVariables`, a CSV mapping and a branch on which is set. It carries one abstract `RunMeasure`, the way it already carries an `OptimizerBackend`:

```
RunMeasure                          evaluate(run) -> a number, and describe() -> what it needs from the run
├── SquaredErrorMeasure             today's CSV fit: the weighted squared difference of mapped columns and states
├── ExpressionMeasure               today's FittingObjective, over text or MathJSON
└── ProgramMeasure                  a user's program; owns starting it, giving it the run and reading its answer
        ├── CppProgramMeasure       compiles with cppToolchain::buildNativeArtifact, once per fit
        └── PythonProgramMeasure    uses the configured interpreter
```

`ProgramMeasure` holds everything the two languages share (the process, the framing of the run it is sent, the timeout, turning a crash into a failed trial) and each subclass only says how to launch. The objective and every limit are `RunMeasure`s, so a limit can be an expression while the objective is a program, or the reverse, with no special case, and `evaluateFittingTrial` becomes "ask the objective, ask each limit, combine", with the penalty rule it already has.

This also removes the second code path the fit has today: the squared error against a CSV is one `RunMeasure` among the others, not a separate branch, and the earlier proposal's "the fitting loss is the preset objective evaluated the same way" is true in the code.

### How a program is run

The program is its own process, started once per fit, not per trial: the engine compiles a C++ objective once (a few seconds, shown as "Preparing the objective…" before the first trial), starts the program, and for each trial sends it the run and reads back the number. A crash, a hang past a time limit, or an exception becomes a failed trial, scored as the worst value like any other failed simulation, with the program's own message shown in the progress warnings, so a bug in a person's objective cannot take down the tuning or the engine. This is the same isolation `pipeWorker` gives edge providers, on the same framed protobuf messages, with one new message pair for "here is a run" and "here is its measures".

It is deliberately **not** run in the engine's own process. In-process is faster and is offered for edge providers that a person trusts, but a tuning runs hundreds of trials of user code, and a single stray pointer ending the whole run is a worse failure there than a few milliseconds per trial.

The C++ header and Python module that give the program its `Run` live beside the edge provider SDK in `engine/include/konjugate` and `engine/sdk/python`, and share the framing code with it.

## What this does not change

The project file gains nothing but the setup it already keeps (`tuningSetup`), which records the objective's kind and, for a program, its source and bindings, so a tuning can be run again. Parameters, bounds, the optimisers, progress, stop-and-keep-best, the toolbar chip and the review are as they are. The web edition has no tuning progress today and no process to run a program in; objectives written as programs are a desktop feature, and the card says so in the web edition.

## Decisions

1. **One `EquationEditor` class**, with the existing four editors moved onto it, one at a time, behind their existing interaction tests. This is done first, because the objective editor is built on it and the consolidation is what makes the rest small.
2. **The objective is stored as the editor's LaTeX plus the engine's own text form,** so that a project can be reopened and the engine does not depend on a maths library: the editor converts to text on Run, and the engine's parser remains the one place that decides what an objective means. The editor's live diagnostics ask the same check the engine uses, through one small `objective-check` command, instead of re-implementing the rules in JavaScript, so the two cannot drift apart.
3. **A program is given the whole run and returns numbers,** not called every step. It runs as a separate process for the whole fit, not in the engine's process.
4. **`RunMeasure` is the engine's one abstraction** for scoring: the CSV fit, an expression and a program are three implementations of it, and limits use the same classes as the objective.
5. **Programs are desktop only** until the web edition can run user code at all.

## Order of work

1. **Extract `EquationEditor` and `ReferenceChips`; move the edge builder onto them,** then the edge editor, the source-term editor and the group editor, each with its tests passing. No visible change.
2. **`ObjectiveEditor` and `LimitEditor`,** the `objective-check` command, the live diagnostics and sentence, the integral and summary buttons, and the restyle of the card into the same steps and spacing as the edge builder. The text box goes. **Built.** The sentence is written from the same MathJSON the engine's text is written from, once that has succeeded, so it says exactly what will run, with each name called as its chip is (`src/objectiveText.mjs`): "Valid objective: 0.1 × k², plus the total over the run of the squared difference between Water tank · Temperature and 320". A sum reads from a term that is added, and a sum inside a summary is put in brackets, so "the total over the run of (a plus b)" and "a, plus the total over the run of b" cannot be confused. Units are not given, as the objective does not carry them. In the card, the goal and how the objective is written sit side by side above the formula, as an edge's choices sit above its equation; the line under an empty formula says what is wanted, as an edge builder's does; and the limits, the length of each trial, and the search's own limits are sections of their own, with the pairs of numbers side by side.
3. **`RunMeasure` in the engine:** the three classes above for the CSV fit and expressions, with today's tests as the proof that nothing changed, and "Match measured data" written as an editable objective. **Built** (`engine/include/runMeasure.hpp`): `SquaredErrorMeasure`, `ExpressionMeasure` and `ProgramMeasure`, made once per fit (an expression is no longer read again for every trial); the fit tests give the same numbers to the last digit. `FittingProblem` keeps its fields and the measures are made from them, so no caller changed. "Match measured data" as an editable objective is not built.
4. **`ProgramMeasure`, `CppProgramMeasure`, `PythonProgramMeasure`,** the SDK header and module, the framed messages, and `ProgramSourceSection`, which the edge builder and editor move onto at the same time. **Built**, simpler: one `ProgramMeasure` whose language only decides how it is started, the C++ header `konjugate/objectiveProgram.hpp` with its glue main, the Python module `konjugate.objective`, the `ObjectiveRunRequest` and `ObjectiveRunResult` messages, and a small `ChildProcess` class that starts the program and reads its answers with a time limit. In the card, an objective is written as an expression, a C++ program or a Python program, with its keys bound to states, tuned parameters or measured columns, and the shared code editor window. Not built: limits set to a number the program reports (they are still expressions); the edge editors moved onto a shared program section; and the provider runtime moved onto `ChildProcess`, which would leave one way of starting a program.
5. **Starter templates and an example:** objectives that compute settling time and overshoot, and an addition to Tank Calibration that tunes to a settling-time goal. **Built:** squared error, settling time and overshoot, each in both languages (`src/objectiveTemplates.mjs`), each built and run through the engine by `tests/engine/objectiveProgram.mjs`, and "Write the objective as a program" in the Tank Calibration guide.

Each step leaves the app working and fully tested, and step 1 can ship alone.
