/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A first launch, as a person meets it: the app itself, started on a brand-new profile, with and without a project given to open
// (src/firstLaunchTour.mjs's launchGreeting and mayTakeOfferedTour). With nothing to open, the first-model tour starts by itself; with a
// project on the command line (as a double-click on Windows and Linux, or macOS's open-file, gives one), the project stays open, the tour
// does not start over it, the Welcome window opens as on any other launch, and the tour is left to offer on the next launch that opens
// nothing. The interaction suites run with --interaction-test, which leaves out the launch's greeting, so this runs the app without it:
// `npm run test:firstLaunch`, and `npm run test:all`. Each launch has a profile folder of its own (--user-data-dir), so nothing here reads
// or writes the person's own.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import electronPath from 'electron';
import { _electron as electron } from 'playwright';

const root = join(import.meta.dirname, '..');
const example = join(root, 'examples', 'heatedWaterTank.kjt');
let folder;

before(async () => { folder = await mkdtemp(join(tmpdir(), 'konjugate-first-launch-')); });
after(async () => { await rm(folder, { recursive: true, force: true }); });

async function launch(profile, projectPath = null) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // --use-mock-keychain: as the interaction suite, so macOS does not ask for the login Keychain.
    const app = await electron.launch({ executablePath: electronPath, args: [root, '--use-mock-keychain', `--user-data-dir=${profile}`, ...(projectPath ? [projectPath] : [])], env, timeout: 60000 });
    const projectWindow = await app.firstWindow({ timeout: 60000 });
    await projectWindow.waitForFunction(() => Boolean(window.__debugTour), null, { timeout: 60000 });
    return { app, projectWindow };
}

const welcomeState = (profile) => readFile(join(profile, 'welcomeState.json'), 'utf8').then(JSON.parse, () => ({}));
const welcomeWindowOf = async (app) => {
    for (const page of app.windows()) if ((await page.title().catch(() => '')).includes('Welcome')) return page;
    return null;
};
async function eventually(check, message, timeout = 30000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.fail(message);
}

test('a first launch with nothing to open starts the first-model tour', async () => {
    const profile = join(folder, 'fresh');
    const { app, projectWindow } = await launch(profile);
    try {
        await projectWindow.waitForFunction(() => window.__debugTour.tutorial() === 'firstModel', null, { timeout: 30000 });
        await eventually(async () => (await welcomeState(profile)).tourOffered === true, 'The tour taken was not remembered as offered.');
        assert.equal(await welcomeWindowOf(app), null, 'The Welcome window does not open beside the tour on the first launch.');
    } finally {
        await app.close();
    }
});

test('a first launch given a project keeps it open, and the tour waits for a launch that opens nothing', async () => {
    const profile = join(folder, 'withProject');
    const { app, projectWindow } = await launch(profile, example);
    try {
        await projectWindow.waitForFunction(() => document.querySelector('.documentTitle')?.textContent === 'heatedWaterTank'
            && document.querySelectorAll('.node-label-container').length > 0, null, { timeout: 30000 });
        // The Welcome window is the greeting this launch has instead of the tour, and Learn by doing offers the tour in it.
        await eventually(async () => Boolean(await welcomeWindowOf(app)), 'The Welcome window did not open in place of the tour.');
        // Long enough for a tour that was going to start (as it did in 2.0.2, a moment after the project had loaded) to have started.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        assert.equal(await projectWindow.evaluate(() => window.__debugTour.active()), false, 'No tutorial should start over the project given.');
        assert.equal(await projectWindow.evaluate(() => document.querySelector('.documentTitle')?.textContent), 'heatedWaterTank', 'The project given should still be the one open.');
        assert.notEqual((await welcomeState(profile)).tourOffered, true, 'The tour was not offered, so the next launch that opens nothing still offers it.');
    } finally {
        await app.close();
    }

    // The next launch, on the same profile, with nothing to open: the tour, now.
    const again = await launch(profile);
    try {
        await again.projectWindow.waitForFunction(() => window.__debugTour.tutorial() === 'firstModel', null, { timeout: 30000 });
    } finally {
        await again.app.close();
    }
});
