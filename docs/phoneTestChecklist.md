---
type: Guide
title: Phone test checklist
description: What only a real phone can confirm about the web edition's phone layout, offline copy and install.
tags: [web-edition, phone, testing, pwa]
status: draft
implementation: none
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Phone test checklist

What only a real phone can confirm. The layout is checked in Chrome at 360 by 760 (upright) and 800 by 360 (on its side) with touch, but a real device differs in its browser, its keyboard, its gestures and its storage.

- Upright and on its side: the tools (a rail down the right edge upright, a row along the top on its side) are all within reach of the thumb, and turning the phone midway through a session keeps the model, the selection and any open panel.
- The menu button, the tool picker (tap the tool in use) and the actions on a selection open and close without a second tap.
- Edges: connecting two nodes by touch, with the first node picked from the node's own "Connect to…" button.
- Dragging a node, then a second finger landing mid-drag (the case behind the DragControls crash), and a long press for the context menu.
- The on-screen keyboard: a field in the node editor, the parameters sheet and the run dialog stays in view when the keyboard opens, and the math keyboard does not cover its own field.
- Run a model, scrub, play, open a node's Results tab: the plot's chips toggle curves, and a drag pans the plot without moving the page.
- Files: Open project and Save project on Android (the file picker, where the file lands) and on iOS (the share sheet).
- Add to Home Screen on each: the name and icon, opening with no browser bar, and the status bar's colour.
- Offline: with "Use offline" tapped, lock the screen for a minute during the download, then unlock: the copy carries on from where it stopped. Then switch to flight mode, close the app, reopen it, and run a model.
- A phone with a notch or rounded corners on its side: nothing the person needs is under the cut-out.
- A model of about a hundred nodes: panning and the labels stay responsive.
- Extensions: install a `.kjp` plugin from a file (the phone's own file picker), see the review, install, and find its components in the component library and its example in Examples; reload, and confirm it is still installed.
- A project that pins a plugin provider: open it with the plugin missing (the dialog names it), install the plugin from the dialog, run the model, and confirm it completes.
- A result visualizer: install a `.kja` from the phone's file picker, run a model, open the add-on from the end of the menu: it comes up as a sheet above the results bar, ends at the right-hand rail, and scrubbing the timeline updates it; in landscape it is a side sheet and the menu scrolls to reach it.
- Extensions, Discover: the list loads with its images, an entry's detail and its install button are reachable, the review shows who signed the package, and Updates appears after the registry has a newer version of something installed.
- A launcher add-on that imports a model: from its window, "Choose file" opens the phone's file picker (the click in the window must reach the page's picker), the import runs, and "Open in canvas" opens the model.
- A launcher add-on that runs scenarios: after an import, a baseline and a scenario run from its window and the scenario's result differs from the baseline's from the fork on (the run happens off the page, so the phone should stay responsive while it works).
- A launcher add-on that fetches from a declared host: a fetch from a server that allows web pages (for example a place search) returns its answer and the file imports; a fetch from one that does not shows the message saying so, and nothing else on the page breaks
- A launcher add-on that keeps a session: open its model in the canvas with a session, save the project, open it again in a fresh page and restore the session; the window's state and its input files come back
- Exporting a launcher's results downloads a zip the phone can save and open.
