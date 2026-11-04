// Copyright © 2026 Zenin Easa Panthakkalakath

// Opens each screen of the web edition in a touch phone viewport and reports what does not fit: a panel
// wider than the screen, a panel under the tool rail, content cut off by its own panel, a page that
// scrolls sideways. A screenshot of every screen is saved so the report can be checked by eye.
//
// Usage: node scripts/phoneLayoutAudit.mjs [--sizes 360x760,412x800] [--only <screen name substring>] [--out <directory>]
// Serves out/webShellThreads, so run `node scripts/buildWebShell.mjs threads` first after changing the page.

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rootDirectory } from './developmentEnvironment.mjs';

const port = Number(process.env.KONJUGATE_PHONE_AUDIT_PORT) || 4801;

// CSS pixel sizes of phones from 2021 on, with the height left for a page once a browser's own bars are
// counted, then the same phones on their side and a foldable opened out.
const defaultSizes = [
    [344, 700], [360, 700], [375, 640], [390, 700], [412, 760], [430, 760], [440, 780], [674, 760],
    [640, 360], [800, 360], [930, 430]
];

function argumentValue(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
}

const sizes = argumentValue('--sizes')
    ? argumentValue('--sizes').split(',').map((size) => size.split('x').map(Number))
    : defaultSizes;
const only = argumentValue('--only');
const outputDirectory = argumentValue('--out') ?? join(rootDirectory, 'out', 'phoneLayoutAudit');

function startServer() {
    const child = spawn(process.execPath, ['scripts/serveWebShell.mjs', 'threads'], {
        cwd: rootDirectory,
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    return new Promise((resolve, reject) => {
        child.stdout.on('data', (chunk) => { if (chunk.toString().includes('Web shell served at')) resolve(child); });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`serveWebShell.mjs exited early with code ${code}.`)));
        setTimeout(() => reject(new Error('Timed out waiting for the web shell server to start.')), 15000);
    });
}

// Runs in the page. Finds the screens currently shown and reports what overflows them.
function measure() {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const problems = [];
    const rail = document.querySelector('.toolstrip');
    const railRect = rail ? rail.getBoundingClientRect() : null;
    const railOnTheRight = railRect && railRect.width < viewportWidth / 2 && railRect.height > railRect.width && railRect.left > viewportWidth / 2;

    const describe = (element) => {
        const name = element.id ? `#${element.id}` : `.${[...element.classList].join('.')}`;
        const label = (element.getAttribute('aria-label') || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 28);
        return label ? `${name} "${label}"` : name;
    };
    const visible = (element) => {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    };

    if (document.documentElement.scrollWidth > viewportWidth + 1) {
        problems.push(`the page scrolls sideways (${document.documentElement.scrollWidth} wide in ${viewportWidth})`);
    }

    const surfaces = [...document.querySelectorAll('.contextCard:not(.hidden), aside:not([hidden]), .liveParameterPanel:not([hidden]), dialog[open], [role="menu"]:not(.hidden):not([hidden]), .phoneMenu:not(.hidden)')]
        .filter(visible);
    for (const surface of surfaces) {
        const rect = surface.getBoundingClientRect();
        const name = describe(surface);
        if (rect.left < -1 || rect.right > viewportWidth + 1) problems.push(`${name} leaves the screen sideways (${Math.round(rect.left)} to ${Math.round(rect.right)} in ${viewportWidth})`);
        if (rect.top < -1 || rect.bottom > viewportHeight + 1) problems.push(`${name} leaves the screen vertically (${Math.round(rect.top)} to ${Math.round(rect.bottom)} in ${viewportHeight})`);
        // Dialogs, menus and the sheets a long press opens are meant to sit over the rail.
        const meantToCoverRail = surface.closest('.toolstrip, dialog, [role="menu"], .phoneMenu, #addPalette, #nodeContextMenu, #edgeContextMenu, #waypointContextMenu');
        if (railOnTheRight && !meantToCoverRail && rect.right > railRect.left + 1 && rect.left < railRect.left && rect.width > 80) {
            problems.push(`${name} runs under the tool rail by ${Math.round(rect.right - railRect.left)}px`);
        }
        const style = getComputedStyle(surface);
        const clipsSideways = ['hidden', 'clip'].includes(style.overflowX) || ['hidden', 'clip'].includes(style.overflow);
        if (surface.scrollWidth > surface.clientWidth + 1 && (clipsSideways || style.overflowX === 'auto' || style.overflowX === 'scroll')) {
            problems.push(`${name} has content wider than itself (${surface.scrollWidth} in ${surface.clientWidth})`);
        }
        // Content that sticks out of the card it lives in, unless something between them scrolls.
        for (const child of surface.querySelectorAll('input, select, textarea, button, label, .chip, img, canvas, table, p, h1, h2, h3, span')) {
            if (!visible(child)) continue;
            const childRect = child.getBoundingClientRect();
            if (childRect.width < 2) continue;
            let scrolls = false;
            for (let ancestor = child.parentElement; ancestor && ancestor !== surface; ancestor = ancestor.parentElement) {
                const ancestorStyle = getComputedStyle(ancestor);
                if (['auto', 'scroll'].includes(ancestorStyle.overflowX)) { scrolls = true; break; }
            }
            if (scrolls) continue;
            if (childRect.right > rect.right + 1.5 || childRect.left < rect.left - 1.5) {
                problems.push(`${describe(child)} sticks out of ${name} (${Math.round(childRect.left)} to ${Math.round(childRect.right)}, card ${Math.round(rect.left)} to ${Math.round(rect.right)})`);
                break;
            }
        }
    }

    // A control that is shown but too small to hit by thumb.
    const small = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], input[type="checkbox"], select')]
        .filter((element) => visible(element) && !element.closest('[hidden], .hidden'))
        .filter((element) => { const r = element.getBoundingClientRect(); return r.width < 28 || r.height < 28; })
        .filter((element) => { const r = element.getBoundingClientRect(); return r.right > 0 && r.bottom > 0 && r.left < viewportWidth && r.top < viewportHeight; });
    if (small.length) problems.push(`${small.length} controls under 28px: ${small.slice(0, 4).map(describe).join(', ')}`);

    return { problems: [...new Set(problems)], surfaces: surfaces.map(describe) };
}

const click = (selector) => async (page) => { await page.evaluate((query) => document.querySelector(query)?.click(), selector); };

async function loadExample(page) {
    await page.evaluate(() => document.querySelector('#exampleButton').click());
    await page.waitForFunction(() => document.querySelector('#examplesExplorerDialog')?.open
        && [...document.querySelectorAll('.examplesExplorerItem')].some((item) => item.querySelector('b').textContent === 'Thermal Management'));
    await page.evaluate(() => [...document.querySelectorAll('.examplesExplorerItem')].find((item) => item.querySelector('b').textContent === 'Thermal Management').click());
    await page.waitForFunction(() => document.querySelector('#examplesExplorerDetailTitle').textContent === 'Thermal Management');
    await page.evaluate(() => document.querySelector('#examplesExplorerLoad').click());
    await page.waitForFunction(() => document.querySelectorAll('.node-label-container').length === 3 && !document.querySelector('#examplesExplorerDialog').open, null, { timeout: 20000 });
    // Phone layout: a guide window may have opened over the model; leave whatever it did but let it settle.
    await page.waitForTimeout(600);
}

async function runModel(page) {
    await page.waitForFunction(() => !document.querySelector('#runButton').disabled, null, { timeout: 30000 });
    await page.evaluate(() => document.querySelector('#runButton').click());
    await page.waitForFunction(() => document.querySelector('#runLaunchDialog')?.open);
}

// What each screen needs done to it before it is on show. `needsExample` screens are opened on a loaded model.
const screens = [
    { name: 'start', open: async () => {} },
    { name: 'menu', open: click('#phoneMenuButton') },
    { name: 'welcome', open: click('#welcomeButton') },
    { name: 'examples', open: click('#exampleButton') },
    { name: 'add palette', open: click('#addButton') },
    { name: 'node builder', open: async (page) => { await page.evaluate(() => document.querySelector('#addButton').click()); await page.evaluate(() => document.querySelector('#addPalette button')?.click()); } },
    { name: 'component library', open: click('#componentLibraryButton') },
    { name: 'assistant', open: click('#assistantButton') },
    { name: 'parameters table', open: click('#parametersButton') },
    { name: 'diagnostics', open: click('#diagnosticsButton') },
    { name: 'toolchains', open: click('#providerToolchainsButton') },
    { name: 'extensions', open: click('#extensionsButton') },
    { name: 'help and feedback', open: click('#helpFeedbackButton') },
    { name: 'causal inference', needsExample: true, open: click('#causalInferenceButton') },
    { name: 'parameter tuning', needsExample: true, open: click('#parameterTuningButton') },
    { name: 'model loaded', needsExample: true, open: async () => {} },
    { name: 'node editor', needsExample: true, open: click('.objectLabel') },
    { name: 'edge editor', needsExample: true, open: click('.bundleLabel') },
    { name: 'node context menu', needsExample: true, open: async (page) => {
        const box = await page.evaluate(() => { const r = document.querySelector('.node-label-container').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
        await page.mouse.click(box.x, box.y, { button: 'right' });
    } },
    { name: 'label detail', needsExample: true, open: click('#nodeLabelsButton') },
    { name: 'run dialog', needsExample: true, open: runModel },
    { name: 'results', needsExample: true, open: async (page) => {
        await runModel(page);
        await page.evaluate(() => document.querySelector('#runLaunchForm, #runLaunchDialog form')?.requestSubmit?.());
        await page.waitForFunction(() => document.querySelector('.resultTransport') && getComputedStyle(document.querySelector('.resultTransport')).display !== 'none', null, { timeout: 60000 });
        await page.waitForTimeout(800);
    } },
    { name: 'results: live controls', needsExample: true, open: async (page) => {
        await runModel(page);
        await page.evaluate(() => document.querySelector('#runLaunchForm, #runLaunchDialog form')?.requestSubmit?.());
        await page.waitForFunction(() => document.querySelector('.resultTransport') && getComputedStyle(document.querySelector('.resultTransport')).display !== 'none', null, { timeout: 60000 });
        await page.evaluate(() => document.querySelector('#liveParameterButton')?.click());
        await page.waitForTimeout(500);
    } },
    { name: 'results: execution summary', needsExample: true, open: async (page) => {
        await runModel(page);
        await page.evaluate(() => document.querySelector('#runLaunchForm, #runLaunchDialog form')?.requestSubmit?.());
        await page.waitForFunction(() => document.querySelector('.resultTransport') && getComputedStyle(document.querySelector('.resultTransport')).display !== 'none', null, { timeout: 60000 });
        await page.evaluate(() => document.querySelector('#executionSummaryButton')?.click());
        await page.waitForTimeout(500);
    } },
    { name: 'results: branches', needsExample: true, open: async (page) => {
        await runModel(page);
        await page.evaluate(() => document.querySelector('#runLaunchForm, #runLaunchDialog form')?.requestSubmit?.());
        await page.waitForFunction(() => document.querySelector('.resultTransport') && getComputedStyle(document.querySelector('.resultTransport')).display !== 'none', null, { timeout: 60000 });
        await page.evaluate(() => document.querySelector('#branchesButton')?.click());
        await page.waitForTimeout(500);
    } }
];

const { chromium } = await import('playwright');
await mkdir(outputDirectory, { recursive: true });
const server = await startServer();
const report = [];
let exitCode = 0;
try {
    const browser = await chromium.launch({ args: ['--disable-popup-blocking', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    for (const [width, height] of sizes) {
        const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, acceptDownloads: true });
        for (const screen of screens) {
            if (only && !screen.name.includes(only)) continue;
            const page = await context.newPage();
            const entry = { size: `${width}x${height}`, screen: screen.name, problems: [] };
            page.on('pageerror', (error) => entry.problems.push(`page error: ${error.message.slice(0, 120)}`));
            try {
                await page.goto(`http://localhost:${port}/`, { waitUntil: 'load', timeout: 30000 });
                await page.waitForSelector('.documentTitle', { state: 'attached', timeout: 30000 });
                await page.waitForTimeout(400);
                if (screen.needsExample) await loadExample(page);
                await screen.open(page);
                await page.waitForTimeout(500);
                const result = await page.evaluate(measure);
                entry.problems.push(...result.problems);
                entry.surfaces = result.surfaces;
            } catch (error) {
                entry.problems.push(`could not open this screen: ${error.message.split('\n')[0].slice(0, 140)}`);
            }
            const fileName = `${width}x${height}-${screen.name.replace(/[^a-z0-9]+/gi, '-')}.png`;
            await page.screenshot({ path: join(outputDirectory, fileName) }).catch(() => {});
            entry.screenshot = fileName;
            report.push(entry);
            console.log(`${entry.problems.length ? 'x' : 'ok'}  ${entry.size}  ${screen.name}${entry.problems.length ? `\n      - ${entry.problems.join('\n      - ')}` : ''}`);
            await page.close();
        }
        await context.close();
    }
    await browser.close();
    await writeFile(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
    const failing = report.filter((entry) => entry.problems.length);
    console.log(`\n${report.length - failing.length} of ${report.length} screens are clean. Screenshots and report.json are in ${outputDirectory}`);
} catch (error) {
    console.error(error);
    exitCode = 1;
} finally {
    server.kill();
    process.exitCode = exitCode;
}
