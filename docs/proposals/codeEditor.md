---
type: Proposal
title: The code editor, rebuilt around program SDK version 2
description: Proposed, design only. One code editor for programs on desktop and web, opened from one place, that knows the model the program sits in. A Ports panel shows every input, output and memory value with what it is bound to, its unit, its value now and the conversion at the port, and binds from there. A Test panel runs the program once or for N steps at the model's values, shows a table and a small plot, and marks problems on their lines. The card keeps a read-only summary and preview with an Edit program button in place of its textarea. Adds checks that know the SDK, a compiler lint that is cancelled, timed out and cached, completion and hover for SDK names and the program's own ports, a template picker with worked examples, the word "Program", Cancel with an unsaved-changes guard, and a Test for tuning objectives. The web edition gets the same editor in stage 1. Delivered in ten small stages; four questions decided, one open.
tags: [proposals, editors, programs, providers, sdk, ux, web]
status: draft
implementation: none
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# The code editor, rebuilt around program SDK version 2

**Status: proposed, design only.** Follows [Program SDK version 2](programSdkV2.md), which gave programs declared ports with units, declared memory and a standard check, and fits [One editor for nodes and relationships](unifiedEntityEditors.md), where a program is one line ("set by program ›", or a chip) that opens this editor. Nothing here changes a project file, and nothing changes the numbers a program gives. Four of the five design questions were decided on 2026-11-25 ([Decisions](#decisions)); whether version 1 programs get the new aids stays open ([Open question](#open-question)).

## In short

- **One editor, opened from one place.** A program is edited in its own code editor window only. The card's textarea goes: the card shows a read-only summary and preview of the program, and an **Edit program** button that opens the window.
- **The editor knows the model.** A **Ports** panel lists the program's inputs, outputs and memory, each with what it is bound to, its unit, its value now and the conversion at the port. You can bind ports from the panel.
- **Test where you write.** **Check program** becomes **Test**. It runs once or for N steps at the model's values (which you can edit), shows outputs and memory as a table and a small plot, and marks problems on their lines.
- **Checks that know the SDK**, and a compiler lint that never piles up processes.
- **The same editor on the web, from stage 1**, with Check and Convert, and every later feature on both.
- **Smaller things:** a template picker with examples, "Program" in place of "Provider source", Cancel with an unsaved-changes guard, and Test for tuning objectives.

## What is wrong today

Each row was checked in the code on 2026-11-25.

| Area | Today | Where |
| --- | --- | --- |
| Two places to edit | The card has a plain textarea with the same source, Open code editor, Reset template, a Convert link and the bindings rows. The window has the same source in CodeMirror. Both can be edited, and the window's Apply overwrites the card. | `src/renderer/programSourceSection.mjs`, `src/providerEditor/` |
| Words | The window title, the card heading and the web dialog all say "Provider source". The rest of the app and the docs say "program". | `index.html`, `programSourceSection.mjs:35`, `webShims/providerEditor.mjs:65` |
| Leaving | The window has no Cancel. Closing it with unapplied edits loses them without asking. Apply doubles as a "Saved" indicator. | `src/providerEditor/renderer.mjs` (`setApplyState`) |
| Starting | Reset template inserts one blank template. There is no picker and no example (PID, lookup table). The bundled examples sit in `examples/providers/`, and the app never offers them. | `providerTemplate.mjs`, `examples/providers/` |
| Writing aids | Highlighting only. Python gets CodeMirror's generic keyword and local-name completion. C++ gets none. Neither knows SDK names or the program's ports, and there is no hover documentation and no snippets. | `renderer.mjs` (`basicSetup`, `cpp()`, `python()`) |
| Lint | Runs 500 ms after typing stops. C++ starts the compiler with `-fsyntax-only` each time. There is no timeout and no cache, and a superseded run is ignored but not killed, so fast typing on a slow machine stacks up compiler processes. Python uses `ast.parse`, which reports only the first syntax error. | `main.mjs:2734–2790`, `runProcess` (`main.mjs:2555`) |
| The model | The editor is told nothing about the model except the values to check at. It does not show which states or parameters the ports are bound to, their units, current values or conversions. A program that reads `x.measurment` is only found when it runs. | `programEditorContext` (`renderer.mjs:14309`) |
| Testing | **Check program** is the only test. It runs at the model's values (which you cannot edit), runs three steps, and prints outputs and memory as one sentence. Its problems are a list of strings that are not linked to lines. It runs for version 2 model programs only, and tuning objectives get nothing (`openWindow` there passes no `program`). | `checkProgram` (`providerRuntime.cpp:3053`), `renderer.mjs:12253` |
| Diagnostics | [Program SDK version 2](programSdkV2.md#diagnostics-in-the-app) promises that a program's error "opens the code editor at the line". The window cannot be opened at a line. | `onContent` in `renderer.mjs` |
| Web | The web edition has a different editor: a `<dialog>` with a plain textarea and Validate, Cancel and Save buttons. It has no highlighting, no Check and no Convert, and C++ can be validated only in the pthread build. The WASM engine has no `checkProgram`. | `src/renderer/webShims/providerEditor.mjs` |
| The SDK harness | `konjugate.v2.testing`, `testing.hpp` and `python -m konjugate.v2.check` are good tools, but they work only from a terminal, outside the app. | [Writing a program](../programs.md#testing-a-program) |

## Rules this design keeps

1. **User first.** Every feature has a visible, plainly named entry point and a short path to a working result. Test is a button in the editor, and a new program can start from a working example in two clicks.
2. **Few words.** The editor uses Program, Ports, Test, Apply and Cancel, and nothing else as headings.
3. **Backwards compatibility, always.** Version 1 programs keep working with identical numbers. No stage adds a key to the project file, and editor-only preferences stay in the app's settings. A file saved by the new version opens in older versions.
4. **Fits the node and relationship editor.** "set by program ›" and a program chip open this window. A chip for one output of several opens it with that output's port selected.

## The design

### The window

```
┌ Konjugate · Heater · Program ─────────────────────────────────── − □ × ┐
│ C++ · version 2   Template ▾   ● 1 problem       Test   Cancel  Apply │
├──────────────────────────────────────────┬──────────────────────────────┤
│ 12  k::Input setpoint{this, "setpoint",  │ Ports                   Test │
│ 13      "K"};                            │ ──────────────────────────── │
│ 14  k::Input measurement{this, ...       │ IN  setpoint      K          │
│ 15                                       │     Room · Setpoint   293.15 │
│ 16  double evaluate(...) const {         │ IN  measurement   K          │
│ 17    auto e = x[setpoint] - x[measurm…  │     Room · Temperature  20 °C│
│      ~~~~~~~ 'measurm' is not a port:    │     °C → K at the port       │
│      setpoint, measurement, kp, ki, kd   │ PAR kp            1          │
│ 18    ...                                │     Heater · Kp          50  │
│                                          │ OUT power         W          │
│                                          │     → Heater · Power         │
│                                          │ MEM integral      K·s    0   │
│                                          │ MEM previousError K      0   │
│                                          │ CLOCK every 0.01 s           │
└──────────────────────────────────────────┴──────────────────────────────┘
```

- **The title** names what the program belongs to: "Heater · Program" or "Wall → Room · Program".
- **The toolbar**, from left to right:
  - the language and format ("C++ · version 2", or "Python · older format" followed by Convert to version 2 ›)
  - Template ▾
  - one problem count, which moves the cursor to the first problem when clicked
  - Test, Cancel and Apply
- **The theme menu** moves into the ⋯ menu. It is used once, not every time the editor opens.
- **Apply** saves into the model and keeps the window open. **Cancel** closes without saving. Cmd/Ctrl‑S still applies. Closing the window, or the project window, with unapplied changes asks: "Apply your changes to Heater's program?" with **Apply**, **Don't apply** and **Keep editing**.
- **The side panel** has two tabs, Ports and Test. It folds away to give the code the full width.
- **Opening at a line:** `openWindow` takes an optional `line` (and `port`), so a finding on the canvas or a failed run opens the editor at the program's line.

### Ports: the program in its model

The Ports tab lists what the program declares, in declaration order:

- **Inputs, parameters and constants.** Each one shows its unit, what it is bound to (in the model's names, as chips are written), the value now, and, when units differ, the conversion v2 applies at the port ("°C → K at the port").
- **Outputs.** Each one shows the state it reaches and the kind of part it is (a rate or a value), using the same words as the Equations tab.
- **Memory.** Each value shows its start value. A clock shows its period.

**Binding happens here.** Clicking a port's "bound to" opens a picker of states and parameters. Those whose unit converts to the port's unit come first, and an incompatible unit is shown but not offered, with the reason. The card's bindings rows go in stage 5, replaced by its read-only reads / sets lines (decision **d**). A port with nothing bound and no default shows "not bound" in the problem colour, using the run's own sentence ("Input ‘measurement’ … is not bound to anything and has no default"). A binding to a key the program no longer declares stays visible, marked "not a port of this program", so nothing disappears without being noticed.

**Where the list comes from.** The engine already loads the program to check it, and `checkProgram` already reports its inputs with kind, unit and default. It is extended to describe outputs, memory, clock and the source line of each declaration. The result is cached by a hash of the source, so it is worked out once per edit pause. Unit compatibility and conversions use the unit catalogue the app already uses for equations and the twin's mappings, so the panel and the run cannot disagree.

### Writing aids

- **Completion:**
  - the program's own ports after `x[` or `x.` (C++ or Python), each with its unit and binding
  - memory names after `m.` and `self.` in `advance()`
  - SDK version 2 names (`k::Input`, `k::optional`, `k::dependsOn`, `OutOfDomain`, `fail`, `Random`, `events.accepted()` …)

  The SDK list is generated at build time from `program.hpp` and the `konjugate.v2` docstrings, so it cannot drift from the SDK. A unit test fails if a public name is missing.
- **Hover** on an SDK name shows its one-line documentation and a link to the matching section of [Writing a program](../programs.md). Hover on a port shows its binding, unit and value now, the same as the Ports row.
- **Snippets**, offered by completion only and never inserted on their own: a memory value with `advance()`, a clock, `OutOfDomain` for a lookup, and `jacobian()`.

### Test: run it where you write it

```
│ Ports                         Test │
│ ────────────────────────────────── │
│ Inputs (from the model now)  Reset │
│  setpoint      [ 293.15 ] K        │
│  measurement   [ 290.00 ] K        │
│  t             [ 0      ] s        │
│ [Run once] [Step 10 ▾] Δt 0.01 s   │
│ ✓ ports  ✓ purity  ✓ memory round trip
│ ✗ output ‘power’ is NaN at step 4  line 22 ›
│ ────────────────────────────────── │
│ step  t     power   integral       │
│  0    0.00  157.5   0              │
│  1    0.01  157.6   0.0315         │
│  …                                 │
│ ▁▂▃▅▆▇█  power ▾                   │
```

- **Inputs** are filled in from the model's current values (which `programCheckInputs` already works out) and can be edited. **Reset** brings back the model's values. The values are not saved in the project.
- **Run once** calls `initialize()` and then `evaluate()` once, and runs the standard checks. **Step N** repeats evaluate and then advance N times. The step is the clock's period if the program has a clock, and otherwise the model's step. Inputs are held where you typed them.
- **The results** are a table of time, outputs and memory per step, and a small plot of one column you choose. Numbers are shown to six significant figures, and copying the table copies full precision.
- **Problems** each carry a line link when the engine knows the line (a Python traceback, a C++ `fail()`, a port's declaration). The same problems are underlined in the code.
- **Engine side:** `checkProgram` gets `steps`, `stepSize` and a per-step trace, through the same backend and transport a run uses, so Test gives the run's numbers to the bit. One engine test proves that against the SDK harness for the PID example.

**Future, not planned yet:** replaying a stretch of a real run's inputs ("Use inputs from the last run ›"), once [One editor for nodes and relationships](unifiedEntityEditors.md) stage G records what each part saw at each step; results do not record a program's inputs today (decision **c**).

### Checks that know the SDK

| Check | When | How | Today |
| --- | --- | --- | --- |
| Reads a port it does not declare (`x.measurment`) | As you type | Python: an `ast` walk of `x.` and `x[...]` reads against the declared ports. C++: the compiler already reports it. | Python: only when run |
| A declared input is never read | As you type (Python), on Test (both) | Python: the `ast` walk. Both: on Test, an input whose change moves no output over the steps is flagged as a hint, never an error. | none |
| An output is not set on some path | On Test | The engine already refuses it. Test points at the line of `evaluate()`. | at run time, no line |
| `evaluate()` changes memory or members | On Test | Already enforced (C++ `const`, Python's frozen object, the purity and memory round-trip checks). Test shows each as a named, passed or failed line. | in Check's sentence |
| Unit mismatch between a port and its binding | As you type | Ports panel, from the unit catalogue, with no need to run | when the run starts |
| Python errors beyond the first | As you type | `ast.parse` still stops at the first syntax error (Python's parser cannot recover). Once the source parses, every SDK check above is reported together, and so is `compile()`'s own warning list. | first syntax error only |
| Jacobian against differences | On Test | Already in `checkProgram`. It gets its own line. | in Check's sentence |

**Compiler lint without a pile-up.** There is one compiler process per editor window. A new keystroke kills the one that is running, it is killed after 10 s with "Check took too long; it will run again when you pause", and the answers are cached by a hash of the source, compiler and flags (the last 32 are kept). The C++ delay rises to 800 ms, and Python keeps 500 ms.

### One editor on the web

Decided: the web edition reaches parity in stage 1, and every later stage ships on both. The editor's code is split into a core module (CodeMirror setup, Ports, Test, Template and Convert), which neither host owns, and two small hosts: the desktop window, and, in the web edition, where a page cannot open a second window of the app, an in-page panel that floats over the project at the size the window would be, can be moved and resized, and leaves the canvas usable beside it. The web `<dialog>` with its textarea goes.

- **Python:** lint and Test through Pyodide, which the web edition already loads for runs. [Program SDK version 2](programSdkV2.md) already gives the native numbers to the bit through it.
- **C++:** lint and Test through the in-browser clang the pthread build already uses (`webCppProviderBridge.mjs`). In the build without threads, C++ shows: "C++ programs are checked and run in the desktop app, or in a browser that allows the faster web build." The editor, Ports and completion still work.
- **Test on the web** needs `checkProgram` exported from the WASM engine. It is the same C++ code, so the numbers match the desktop's.

### Starting a program: templates and examples

**Template ▾** replaces Reset template. It lists:

- **Blank:** a relationship, a node, or a node with memory and a clock. These are today's generated templates, filled in with the card's bindings.
- **Examples:** PID controller (`pidController.cpp/.py`), Conduction, Lookup table (interpolated, raising `OutOfDomain` outside its range, a new example), and CSV replay (a version 2 rewrite of `replayProviderSource`, reading the file in `initialize()`).

Choosing one when there is source shows the same before-and-after view Convert uses, and undo takes it back. An empty program opens with the picker already showing, so the first click gives a working program. Every template and example is run through `checkProgram` in the engine tests.

### Tuning objectives

An objective program uses its own SDK (`konjugate/objectiveProgram.hpp`, `konjugate.objective`), not the model program SDK. The editor gets a `purpose` (model program, or objective) and changes what it shows. For an objective, Ports lists its keys bound to states, tuned parameters or measured columns. Test runs the objective once on the last run's result, or on one quick trial if there is none, and shows its value, its reported numbers and any error with its line. Convert is not shown, because objectives have no older format.

### Version 1 programs

A version 1 program opens with the banner it has today ("Older program format …  Convert to version 2 ›"). It gets highlighting, the compiler or Python lint, and the Ports panel for its bindings (keys and what they are bound to, without units, which version 1 does not declare). Test is offered only after conversion, because `checkProgram` loads version 2 programs only. This is the recommendation of the [open question](#open-question). Nothing about a version 1 program changes unless the person converts it.

### The card: a summary, a preview and one button

Decided: the card's textarea is dropped, and the window is the one place a program is edited. The card's program section shows what a person needs to recognise the program and see whether it is healthy, and one plainly named button that opens the editor:

```
Program                                             ✓ passed Test
PidController · C++
reads   Room · Setpoint, Room · Temperature, Kp, Ki, Kd
sets    Heater · Power
┌───────────────────────────────────────────────────────────┐
│ class PidController : public k::Node {                    │
│     k::Input setpoint{this, "setpoint", "K"};             │
│     k::Input measurement{this, "measurement", "K"};       │
│     …                                                     │
└───────────────────────────────────────────────────────────┘
[ Edit program ]
```

- **The heading line** names the program (its declared name) and its language. On the right, one status at most: "✓ passed Test" when Test passed on this exact source in this session, "1 problem · line 17 ›" when the last lint or Test found one (it opens the editor at the line), or "older format · Convert to version 2 ›" for a version 1 program. Nothing is shown when nothing is known; the status is not saved in the file.
- **reads / sets** list the bindings in the model's names, as the Equations tab writes them, read-only. A port with nothing bound reads "measurement · not bound" in the problem colour. These two lines replace the bindings rows once binding moves to Ports (stage 5); until then the rows stay under the preview.
- **The preview** is the first lines of the source, read-only, highlighted, greyed, at most six lines. Clicking it opens the editor at the clicked line, so it never looks editable and then refuses a click.
- **Edit program** opens the window. It is the section's only button. Template ▾, Convert and Test live in the window.
- **No program yet** (a part just switched to C++ or Python): "No program yet." and **Write program**, which opens the window with the template picker showing, so two clicks give a working example.
- **A plugin provider** keeps its select on the card, because it has no source to edit.

**"set by program ›"** on a node's Equations tab, and a program chip on a relationship's, open the same window, with the port of that output selected in Ports. From any entry point there is one editor per program; opening it a second time brings the open window forward.

## Backwards compatibility

- **Project file:** unchanged. Bindings set in Ports are written to the same `implementation.bindings` the card writes today. Templates leave no trace beyond the source. Test inputs are not saved.
- **Numbers:** Test and the run share one engine path. Version 1 programs and their run-time behaviour are not touched.
- **Settings:** theme, panel width and the folded side panel stay in the app's settings, under the existing `konjugate.providerEditor.*` keys.
- **Tests:** about ten interaction tests type into the card's source textarea (`#editEdgeProviderSource` six times). They move to the editor's test hook (`window.__providerEditorView`, already used) in stage 2, which removes the textarea.

## Stages

Each stage is small enough to deliver and review on its own, and each one leaves the app working. Every stage includes its unit tests (`npm test`), desktop interaction tests, and web interaction tests in real Chrome.

| # | Stage | Main tests |
| --- | --- | --- |
| 1 | **One editor everywhere.** The core/host split; the web panel replaces the dialog with highlighting, lint (Python through Pyodide, C++ through in-browser clang in the threads build), Convert and Check, which needs `checkProgram` exported from the WASM engine; "Program" in place of "Provider source"; Cancel and the unsaved-changes guard (window, panel and project-window close); opening at a line and port. The largest stage, because parity comes first. | Unit: the core module runs without Electron globals; the apply/dirty/guard state machine as a pure module. Engine: WASM `checkProgram` gives the desktop's answer for the PID and Conduction examples. Desktop: edit, Cancel asks, Don't apply leaves the model unchanged. Web (Chrome): a Python program highlighted, its error marked on its line, Convert of a version 1 program, Check passes on PID, Apply reaches the card, the guard asks. |
| 2 | **The card.** Textarea, Open code editor and Reset template replaced by the summary, the preview and Edit program; "No program yet" with Write program; the status line. Bindings rows stay for now. | Unit: the summary from a program's implementation (name, reads, sets, preview lines, status). Desktop and web: Edit program opens the window, a click on preview line 3 opens it at line 3; "set by program ›" opens the same window. The ten interaction tests that typed into the textarea move to the editor's hook. |
| 3 | **Lint hygiene.** Kill on supersede, 10 s timeout, cache, C++ delay. | Unit: a `LintScheduler` with a fake process (supersede kills, timeout reports, cache hit spawns nothing), used by both hosts. Desktop: rapid typing never has more than one compiler process. Web: the same for the in-browser clang. |
| 4 | **Ports panel**, read-only. Engine description with outputs, memory, clock and lines, cached by hash, and the unit catalogue for conversions. | Engine: the description JSON for the PID and Conduction examples, native and WASM. Unit: the ports-to-bindings table, including °C→K, an incompatible unit, an unbound port and a stale binding. Desktop and web: the panel shows the PID controller's ports and values. |
| 5 | **Bind from Ports.** The card's bindings rows go, replaced by its read-only reads / sets lines. | Unit: binding writes the same `implementation.bindings` the rows wrote. Desktop and web: bind a port, run, and the run reads it; the card's reads line follows. |
| 6 | **Test panel.** Editable inputs, Run once, Step N, table, small plot, problems with lines; Check program becomes Test. | Engine: the Test trace equals the SDK harness to the bit (PID, 10 steps), native and WASM. Desktop and web: Test on PID shows 10 rows and a plot, and a NaN program shows its line link; the card says "✓ passed Test". |
| 7 | **SDK-aware checks**, as in the table above. | Unit: one fixture per check, the Python `ast` walk and the hint rule. Desktop and web: a misspelt port is underlined as you type. |
| 8 | **Completion, hover and snippets**, with the generated SDK name list. | Unit: the name list matches `program.hpp` and `konjugate.v2`, and port completion offers the declared ports. Desktop and web: `x[` offers the ports. |
| 9 | **Template picker and examples**, including the version 2 Lookup table and CSV replay. | Engine: every template and example passes `checkProgram`. Desktop and web: No program yet, Write program, PID controller, Test passes. |
| 10 | **Tuning objectives** in the same editor, with their own Ports and Test. | Unit: an objective's ports from its keys. Desktop and web: an objective's Test shows its value and a broken one its line. |

Each stage after the first adds to one editor, so it is built once and tested on both. Stage 2 follows stage 1 at once because, from then on, the card no longer holds a second copy of the source. The stages line up with stages C and D of [One editor for nodes and relationships](unifiedEntityEditors.md): whichever lands first draws the card's program section, and the other reuses it.

## Risks and costs

| Risk or cost | Size | Answer |
| --- | --- | --- |
| Web parity in stage 1 | Stage 1 is the largest: a core/host split, a web panel and a WASM `checkProgram` before any new feature | Accepted, because every later stage is then built once; stage 1 adds no new feature, so it can be checked against today's desktop behaviour |
| Compiler processes while typing | Today unbounded on a slow machine | Stage 3: one process, killed on supersede, 10 s cap, cache |
| Describing ports needs the program loaded (compiled for C++) | About as costly as one lint pass | Cached by source hash. Ports keep the last good description, greyed, while the source does not compile. |
| Pyodide size on the web | About 13 MB in `node_modules/pyodide`, already fetched for Python runs | Loaded only when a Python program's editor opens, and kept in the browser's cache |
| C++ on the web | Needs the threads build and Wasmer's in-browser clang (a large first download, and an outside registry) | Plainly said in the build without threads. The first check says it is fetching the compiler. Desktop stays the reference. |
| `checkProgram` in the WASM engine | New export, small code, but the web build must be rebuilt and checked | One engine path and a bit-identity test against desktop |
| Moving the textarea's tests | About ten interaction tests | Done in stage 2, together with the card change |
| A program edited only in a window | A person on a small screen loses sight of the card | The window and the web panel can be moved and resized; the card's summary keeps what the program reads and sets visible |
| Step N hides a wrong step size | A program with no clock is stepped at the model's step, which may differ from a run under Adaptive | The step size is shown and editable, and the table says it holds inputs fixed |
| "Unread input" hint is a guess | A false hint can annoy | Shown as a hint under Test only, never as an error, never on the canvas |
| Interaction suite load | Each stage adds desktop and web tests | Tests are kept narrow: one per behaviour, reusing the PID example project |

## Decisions

Decided by the user on 2026-11-25.

1. **(a) Where the editor lives: its own window.** Not inside the node or relationship card, and not both. Code needs width and height a card cannot give, and the Ports and Test panels need room beside the code. In the web edition the window is an in-page panel, as described above.
2. **(b) Web parity: in stage 1.** The web edition gets the same editor, with Check and Convert, in the first stage, and every later stage ships on both.
3. **(c) Test scope: editable inputs, a table and a small plot, for now.** Replaying a stretch of a real run's inputs is a possible later extension, not planned here.
4. **(d) The card's textarea is dropped.** The card shows a read-only summary and preview and a plainly named **Edit program** button that opens the window; "set by program ›" opens the same window ([The card](#the-card-a-summary-a-preview-and-one-button)).

## Open question

1. **(e) Version 1 programs: the new aids, or only a Convert prompt.** Options: every aid, Test included (which needs a version 1 path in `checkProgram`); highlighting, lint and a bindings-only Ports panel plus Convert, with no Test; or only Convert. **Recommendation: the middle option.** Version 1 has no declared ports or units, so Test would be a weaker, different check that has to be kept forever. A Convert prompt that is plainly there, with Test waiting on the other side, is the better reason to move, and nothing about a version 1 program changes until the person converts it.

Smaller choices made in this design, which the user can overturn: Test inputs are never saved in the project; completion's SDK list is generated at build time from `program.hpp` and the `konjugate.v2` docstrings and checked by a unit test; the theme menu moves into the editor's ⋯ menu.

## Not in this proposal

A debugger with breakpoints; editing several programs in tabs; formatting code; an AI assistant in the editor; programs shared between projects.
