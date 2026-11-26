---
type: Guide
title: Driving the App from a Script
description: Exploring or testing the desktop app from a script with scripts/exploreApp.mjs, answering its native dialogs, screenshots, one driven run at a time, and the lock-screen check.
tags: [testing, interaction-tests, automation, dialogs]
status: stable
---

# Driving the app from a script

How to drive the desktop app from a script, for a test or for exploring it as a person would, without leaving anything on the screen for a person to clean up. The interaction suite (`npm run test:interaction`, see [Development Setup](developmentSetup.md)) and `scripts/exploreApp.mjs` both launch the app this way, through the same driver (`tests/drivers/electronWindowDriver.mjs`). Use one of them; never write a wrapper of your own around Electron. A wrapper of one's own launches without the driver, so the first native dialog the app asks (a "Discard unsaved changes?", a save dialog) stays on the screen until a person clicks it, and the script waits for it forever.

## The entry point

```
node scripts/exploreApp.mjs path/to/script.mjs [--out <folder>] [--minutes <n>] [--keep-profile]
```

The script exports one function, `async function explore(driver, context)`, which runs inside the app's main process once the project window has loaded. `tests/explore/openExampleOverChanges.mjs` is a short example: it changes the new project, opens an example over it, answers the "Discard unsaved changes?" Cancel and then Discard changes, and takes a screenshot after each.

The app is launched as the interaction tests launch it: Electron with `--interaction-test` (which also keeps the Welcome window and update checks away), a scratch profile in a temporary folder in which the first-model tour has already been taken (so the tour does not start in place of what the script opens), Chromium's mock keychain (`--use-mock-keychain`, so listing model configurations does not ask for the login Keychain), the engine in `out/engine` (it says so if there is none; it does not build one), the interaction suite's add-ons where they are found, and every native dialog answered by the driver. On macOS the computer is kept awake (`caffeinate`) for as long as the app runs. The run is stopped, saying why, if the app's main process stops answering for 30 seconds or the whole run takes longer than `--minutes` (15 by default). The profile is removed afterwards unless `--keep-profile` is given; the output folder (`--out`, or a temporary folder it names) is kept.

`context` holds `window` (the project window's handle), `screenshot(name, handle?)`, `waitFor(handle, expression, message?, timeoutMs?)`, `sleep(ms)`, `log(...)` and `outputDirectory`. A handle has `evaluate(expression)` (runs in the window's page and returns the value), `click({ x, y })`, `mouseDown`, `mouseUp`, `mouseMove`, `rightClick`, `keyDown(keyCode)`, `keyUp`, `focus()`, `close()` and `title()`; these are real input events sent to the window, not synthetic DOM events. `driver.allHandles()` lists every window, and `driver.waitForNewHandle(before, { titleIncludes })` waits for one the app opens. Give a newly opened window time to finish loading (wait for something in it with `waitFor`) before clicking in it, or the click is lost.

## Native dialogs

A native dialog cannot be clicked by a script, and one left open stays on the screen after the run. While the app is driven, every one is answered by the driver instead, and recorded. The driver covers each way Konjugate brings up something native:

| What | Where Konjugate asks for it | Answered |
| --- | --- | --- |
| Save dialogs | `dialog.showSaveDialog` in `src/main.mjs` (Save As, exports, FMU and code export, merged FMUs, recordings, certificates) | `{ filePath }`, else cancelled |
| Open dialogs | `dialog.showOpenDialog` in `src/main.mjs` and `src/launcherHost.mjs` (projects, components, plugins, data logs, certificates, add-on files and folders) | `{ filePaths }`, else cancelled |
| Message boxes | `dialog.showMessageBox` in `src/main.mjs`: "Discard unsaved changes?", installing a plugin, removing an AI configuration, and the others | `{ button }` or `{ response }`, else its cancel button |
| A window's `confirm`, `alert`, `prompt` | `src/renderer/renderer.mjs` (deleting a template, a subsystem or a configuration, a large relationship group, a new assistant conversation, and others) and `src/renderer/connectionsPanel.mjs` | `{ button: 'OK' }` or `{ button: 'Cancel' }` (`{ text }` for a prompt), else cancelled |
| A window's file chooser | `<input type="file">` in `src/renderer/index.html` and `renderer.mjs` (geometry files, CSV data for causal inference and parameter tuning) | `{ filePaths }` (set on the input), else nothing chosen |
| Error boxes | `dialog.showErrorBox`, and Electron's own "A JavaScript error occurred in the main process" | dismissed, and printed |
| Certificate trust | `dialog.showCertificateTrustDialog` (not used by Konjugate today) | dismissed |
| Outside apps | `shell.openExternal` (links, bug reports, Bluetooth settings, model download pages), `shell.showItemInFolder` (a live twin's recording), `openPath`, `trashItem` | recorded as kind `external`, not opened |

The main process's dialogs are answered beneath Electron's `dialog` module, at its native binding, so the Sync forms and a reference to a function taken before the driver was installed are answered too. A window's `confirm`, `alert` and `prompt` are answered through a preload the driver registers on every session (`tests/drivers/nativeDialogPreload.cjs`), and its file chooser through the window's DevTools protocol, which takes it before it is shown. All of it is installed before the app opens its first window.

What the driver cannot answer: the operating system's own prompts, which are not the app's. On macOS these are the Keychain (kept away by the mock keychain), and permission prompts for Bluetooth, MIDI, the microphone or the local network, which a feature that asks for them may bring up the first time on a computer. Do not drive those features on a computer where nobody can answer them.

### Answering a dialog

With no answer queued, each dialog is answered as a person backing out would: a save or an open cancelled, a message box with its cancel button, a `confirm` with Cancel. To answer otherwise, queue the answer before the action that asks:

```js
const asked = await driver.answerDialog({ button: 'Discard changes' }, () => window.evaluate(`document.querySelector('#examplesExplorerLoad').click()`));
// asked: { kind: 'message', title: 'Unsaved changes', message: 'Discard unsaved changes?', detail: '…', buttons: ['Cancel', 'Discard changes'], answer: 'pressed "Discard changes"', … }
```

`driver.answerDialog(answer, trigger)` queues the answer, runs `trigger`, waits (10 seconds by default) for the dialog it was for and returns what that dialog asked and the answer given. It throws if no such dialog came, or if the answer did not fit: a button label the dialog does not have is an error naming the buttons it offers (`The message dialog "Discard unsaved changes?" has no "Discard" button; it offers "Cancel", "Discard changes".`), and the dialog is cancelled rather than guessed at. Buttons are matched by their label, exactly as shown.

`driver.answerNextDialog(answer)` only queues it, for a dialog that comes later. Answers are queued per kind and used in order, so a save answer waits for a save dialog however many message boxes come first. The shapes:

- `{ button: 'Discard changes' }` or `{ response: 1 }`: a message box, or a window's `confirm` or `alert` (their buttons are OK and Cancel), with `checkboxChecked: true` to tick its checkbox.
- `{ filePaths: ['/path/a.csv'] }`: an open dialog or a window's file chooser.
- `{ filePath: '/path/model.kjt' }`: a save dialog.
- `{ text: 'Plant' }`: a window's `prompt`.
- `{ kind: 'message', cancel: true }`: cancel the next one of that kind (`save`, `open`, `message`, `prompt`).
- Any of them with `expect: 'some text'` (or a RegExp): the dialog must say it, in its title, message or detail; one that does not is cancelled and is an error.

`driver.setDialogPolicy(policy)` says what a dialog with no answer queued gets: `'cancel'` (the default), `'fail'` (still cancelled, so the app never waits, but an error), or a function given the dialog that returns an answer, or nothing to cancel it. `driver.nativeDialogs()` lists every dialog so far, oldest first, each with its `kind`, `source` (`main` or `renderer`), `title`, `message`, `detail`, `buttons`, the `answer` given and an `error` where one went wrong; `driver.onNativeDialog(listener)` is told of each as it comes; `driver.waitForDialog({ kind, includes })` waits for the next; `driver.checkDialogs()` throws if any since the last check went wrong. `scripts/exploreApp.mjs` prints each dialog as it comes, calls `checkDialogs()` when the script ends, and says which queued answers were never used. The interaction suite prints, after each scenario, the dialogs it asked and how each was answered: a dialog there that the scenario did not expect is a scenario missing an answer.

### The watchdog

Nothing may reach the real screen as a native dialog during a driven run. Should one get past the interception (a window that loaded before the driver was installed, a page that kept the browser's own `confirm`), the window's DevTools protocol sees it open: it is printed loudly with its text (`A native confirm dialog reached the screen past the interception: "…"`), dismissed, and recorded as an error, so `checkDialogs()` fails. If it cannot be dismissed, the app is ended at once rather than left waiting for a click nobody will make. A main process that stops answering (a synchronous wait) is stopped by `scripts/exploreApp.mjs` after 30 seconds, saying so.

## Screenshots

`context.screenshot('after-discard')` (or `driver.screenshot(path, handle)`) saves a window as a PNG through the window itself (`webContents.capturePage()`), so it needs no screen-recording permission, and a window behind another is captured as it is drawn. The capture lags the drawing, so the window is asked to draw again and given a moment first. The operating system's own `screencapture` and clicks through System Events do not work from an agent's shell here (it has neither Screen Recording nor Accessibility permission); use the driver's screenshots and input.

## One driven run at a time

Only one driven run (the desktop interaction suite, the web suite, or an exploration) may use a computer at a time. Each drives real windows that take focus, and two at once steal it from each other and double the load, which fails scenarios in ways that look like bugs. `scripts/exploreApp.mjs` refuses to start while another Electron with `--interaction-test` is running and names it. Before starting a run on a shared computer, make sure nobody else, person or agent, is using its desktop, and do not touch the trackpad while it runs: the windows are real, and a moved pointer moves their camera.

## The lock screen

A run on a locked computer reaches no screen: windows do not draw, and scenarios fail or time out in ways that look like bugs. On macOS, `lsappinfo info -only name "$(lsappinfo front)"` names the app in front; while the screen is locked it is `loginwindow`. `scripts/exploreApp.mjs` checks this and refuses to start; check it yourself before `npm run test:interaction`, and if it is `loginwindow`, wait for someone to unlock the computer rather than running anyway.
