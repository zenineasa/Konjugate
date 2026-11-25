/* Copyright © 2026 Zenin Easa Panthakkalakath */

// When the first-model tour (docs/proposals/guidedTour.md) starts by itself: on a first launch, and never in place of a project. Plain
// decisions with no Electron or Node in them, so the main process and the project window share them and they can be tested alone.

// What a launch shows beside its first window: the first-model tour, offered only on a launch that has never offered it and was given no
// project to open (a .kjt from a double-click, macOS's open-file, or the command line); the Welcome window otherwise, whose Learn by doing
// offers the tour first until it is done. A project given at launch is what the person asked for, so the tour never takes its place, and
// it is left unoffered, for the next launch that opens nothing.
export function launchGreeting({ tourOffered = false, projectOpened = false } = {}) {
    return tourOffered || projectOpened ? 'welcome' : 'tour';
}

// Whether a project window takes up the tour offered on a first launch: only while it still holds the new, empty project it opened with,
// once the file it may have been opened for has been looked for. A project there by any route (a file from the OS, one an add-on opened or
// is about to open, a recent project, an example, a result) is kept, and so is a tutorial already running or carrying on after a restart.
export function mayTakeOfferedTour({ fileRequested = false, projectPath = null, fileName = 'untitled.kjt', exampleId = null, hasContent = false, dirty = false, hasResult = false, addonProjectExpected = false, tutorialActive = false, tutorialResuming = false } = {}) {
    if (fileRequested || projectPath !== null || exampleId !== null || addonProjectExpected) return false;
    if (fileName !== 'untitled.kjt' || hasContent || dirty || hasResult) return false;
    return !tutorialActive && !tutorialResuming;
}
