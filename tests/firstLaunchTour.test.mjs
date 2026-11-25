/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { launchGreeting, mayTakeOfferedTour } from '../src/firstLaunchTour.mjs';

test('a launch offers the first-model tour only when it never has and was given no project to open', () => {
    assert.equal(launchGreeting({ tourOffered: false, projectOpened: false }), 'tour');
    assert.equal(launchGreeting(), 'tour', 'A brand-new profile with nothing to open is the tour\'s first launch.');
    // A .kjt from a double-click, macOS's open-file or the command line keeps the screen: the Welcome window, never the tour over it.
    assert.equal(launchGreeting({ tourOffered: false, projectOpened: true }), 'welcome');
    assert.equal(launchGreeting({ tourOffered: true, projectOpened: false }), 'welcome');
    assert.equal(launchGreeting({ tourOffered: true, projectOpened: true }), 'welcome');
});

test('a window takes the offered tour only while it holds its new, empty project', () => {
    const fresh = { fileRequested: false, projectPath: null, fileName: 'untitled.kjt', exampleId: null, hasContent: false, dirty: false, hasResult: false, addonProjectExpected: false, tutorialActive: false, tutorialResuming: false };
    assert.equal(mayTakeOfferedTour(fresh), true);
    assert.equal(mayTakeOfferedTour(), true);
    const kept = {
        'a file the OS asked this window to open, even one that failed or was not unlocked': { fileRequested: true },
        'a project opened from a file (Open, a recent project)': { projectPath: '/projects/network.kjt', fileName: 'network.kjt' },
        'a project an add-on opened as an unsaved copy': { fileName: 'network.kjt', hasContent: true, dirty: true },
        'an add-on project on its way': { addonProjectExpected: true },
        'an example': { exampleId: 'heatedWaterTank', fileName: 'heatedWaterTank.kjt', hasContent: true },
        'work started on the new project': { hasContent: true },
        'an unsaved change': { dirty: true },
        'a result on screen': { hasResult: true },
        'a tutorial already running': { tutorialActive: true },
        'a tutorial carrying on after a restart': { tutorialResuming: true }
    };
    for (const [what, change] of Object.entries(kept)) assert.equal(mayTakeOfferedTour({ ...fresh, ...change }), false, `The tour should not replace ${what}.`);
});
