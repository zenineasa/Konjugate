---
type: Proposal
title: A guided first-model tour
description: Design for an optional, skippable in-app tour that takes a new user from an empty canvas to a first running model, in the desktop and web editions, and that can be started again from the Welcome window.
tags: [proposals, onboarding, welcome, tour]
status: stable
implementation: complete
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# A guided first-model tour

**Status: built** (stages 1 to 3, the desktop and web editions, with the "Fill this in for me" buttons). Written down before any code, like [The Welcome window](welcomeWindow.md), so the steps and wording could be reviewed first. The decisions at the end were settled as recommended, with the changes noted in place.

## The decision this rests on

A person opening Konjugate for the first time faces an empty canvas and has to work out, unaided, the sequence that matters: a node holds states, a relationship connects two nodes with an equation, a run produces results that can be scrubbed. The On-Ramp videos explain this, but they are not in the app and do not check that the person did it. The tour takes them through that sequence in the real interface, in about three minutes, and leaves them with a model of their own.

Three rules shape everything below. It **starts by itself on the very first launch**, and every step has a way out. It is **always available again** from a "Take the 3-minute tour" card on the Welcome window, so skipping by accident costs nothing. And it **runs in both editions**, so it teaches only what the desktop and web editions share; the desktop-only extras (add-ons, plugins, providers, FMUs) are named once, at the end.

## What the person builds

A heater and a block joined by one relationship, which is the smallest model that shows every part of the workflow: two nodes, one state each, one equation, one run, one results view. Heat flowing from the heater into the block needs no domain knowledge, and the result (the block warming towards the heater) is obvious at a glance. The relationship is directed, so the heater holds its temperature: it is a source, not a second body that cools.

| # | The person… | Highlighted | Done when |
| --- | --- | --- | --- |
| 1 | Opens the Add menu and chooses Node | Add button, then the Node entry | The node builder is open |
| 2 | Names it "Heater" and gives it a state "Temperature" (symbol `temperature`, initial value 350, unit K) | The name field, the state row | The node exists with that state |
| 3 | Adds a second node, "Block", with the same state starting at 300 | As above | Two nodes exist |
| 4 | Opens Add, chooses Edge, picks Heater as source and Block as target | The edge builder's From and To | The edge builder holds those two nodes |
| 5 | Enters the equation that moves heat, `k·(sourceTemperature − targetTemperature)`, with `k` the coefficient the edge builder already adds | The Updates field, the equation field, the reference chips | The relationship exists and its equation is valid |
| 6 | Presses Run, with the suggested 20 s run | Run button | A run has completed |
| 7 | Clicks the Block, which opens its editor on the plot of its temperature over the run | The Block's label, then the plot | The Block's plot has been on screen |
| 8 | Drags the timeline and watches the two temperatures converge | The timeline | The timeline has been moved |
| 9 | Reads the finish: save the model, try an example from the Examples menu, and, on desktop, look at add-ons and plugins in the Extensions dialog | None | They press Finish |

Each step names what to do in one sentence, says why in one more, and advances **when the person has done it**, not when they press Next. Next exists only on steps 1 and 9 (the introduction and the finish), where there is nothing to do.

The equation and values are filled in by the person typing or, for the equation, by choosing the reference chips the builder already offers; a "Fill this in for me" button on steps 2, 3 and 5 types the step's values, for people who would rather watch than type. The step never needs LaTeX knowledge: the visual equation editor is the one it points at.

## The card never covers the work

The card is not fixed in one place: the editors and builders open at the sides, the panels on the left and the timeline at the bottom, and a card sitting on any of them would hide what the step is about. It takes the first of four places (bottom left, bottom right, top left, top right) that covers neither the control the step points at nor anything the person is working in, stays where it is while that is still clear so it does not jump between steps, and can be dragged by its title to anywhere else, where it then stays. While a dialog is open (the run settings) the card and its ring move into it, since a dialog sits above the rest of the page. The interaction test checks that the card overlaps neither builder.

## Starting, skipping and starting again

- **First launch.** The tour starts in the project window with a card that says what it is and has two buttons, "Start" and "Skip tour", so a person who wants to be left alone is one click from the empty canvas. The Welcome window is not opened on that first launch, since two surfaces would compete for attention; it is one click away from the Konjugate button, and its first card is the tour.
- **Skipping.** "Skip tour" on the first card, and a "Skip tour" link on every step. A skip says, once, where the tour can be found again ("You can take the tour any time from the Welcome window"). Closing the window or quitting mid-tour counts as a skip.
- **Starting again.** The Welcome window carries a "Take the 3-minute tour" card at the top, always, however many times the tour has been taken. It starts the tour on a new, empty project; if the open project has unsaved changes the usual save prompt appears first, and the tour never touches a person's model without it. A tour started from the card never auto-starts again, and it can be left at any step.
- **Not offered again.** The tour auto-starts only while `tourOffered` is absent from the welcome state; both the first start and a skip set it. An update never brings it back.

## When the person goes off the script

A tour that dead-ends is worse than none. Each step states what must be true to be done, so the tour can **check the state instead of trusting the path**: if a person deletes the node they just made, the tour notices that step 2's condition no longer holds and offers "Go back to step 2" instead of waiting for something that cannot happen. A step is never blocked by something the tour did not ask for: the person can pan, rotate, open other panels or rename things, and the highlight simply follows its target if that is still on screen. If the target is not on screen (a panel the person closed), the step's card says where to find it.

## How it is built, so it cannot rot

- **Steps are data.** One module, `src/tour/tourSteps.mjs`, lists each step's id, text, the selector it highlights, the `done` check (a pure function of the document and a few facts about the UI) and an optional `fill` action. The renderer's tour controller only reads that list; the desktop and web editions both import it, so there is one set of steps and nothing to drift.
- **Done checks use the document, not the DOM, wherever they can:** "two nodes exist, each with a state called Temperature" is a question about the project model, which is the same in both editions and does not break when a button moves. Only steps about the interface itself (a builder is open, the timeline moved) look at the DOM.
- **One interaction test plays the whole tour** by performing each step's action in the real UI and asserting that the step advances, then does it again by pressing "Fill this in for me", then skips at each step in turn and checks the state. It runs in both editions' interaction suites; a UI change that breaks a step fails the test, not a user.
- **The wording lives in one file** with the steps, so changing it never touches the controller.
- **Nothing about the tour is sent anywhere.** The only record is two booleans in `welcomeState.json` (`tourOffered`, `tourCompleted`), beside what is already kept there. The web edition has no Welcome window, so it offers the tour itself, once on a first visit (kept in the browser's local storage) and again whenever the Konjugate button is pressed, which is what opens the Welcome window on the desktop.

## Desktop and web

The tour uses only what both editions have: the canvas, the node and edge builders, the equation editor, the run, the timeline, saving and the Examples menu. Steps that mention a button the web edition lacks do not exist. The finish step adds one sentence on desktop only, pointing to the Extensions dialog ("Add-ons chart results and drive runs; plugins add providers"), and a sentence in the web edition pointing at the desktop app for them.

## Decisions (settled)

1. **The model:** a heater and a block with a heat equation (above).
2. **No Welcome window on the first launch,** so the tour has the screen to itself.
3. **"Fill this in for me"** on the typing steps, which fills the fields and leaves the person to press the builder's own Create button.
4. **Length:** nine steps; a shorter tour that stops after the first run is the fallback if it feels long in practice.

## Order of work

1. **The step list and the controller,** with steps 1 to 3 only (two nodes), and the interaction test for them.
2. **Steps 4 to 8,** the equation and the run, and the test extended to the whole tour.
3. **Starting and skipping:** the first-launch card, the welcome-state flags, the Welcome window's "Take the 3-minute tour" card.
4. **The web edition's interaction test,** and the "Fill this in for me" buttons.

All four stages are built. Symbols in Konjugate must start with a lowercase letter, which is why the state's symbol is `temperature` and not `T`.
