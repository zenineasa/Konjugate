// Copyright © 2026 Zenin Easa Panthakkalakath

// Shrinks the copy of the app Electron Packager is about to archive (run from its afterPrune hook,
// see scripts/packageElectron.mjs). The source tree is never touched.
//
// 1. The main process and the modules it starts on their own (the importer worker and the push
//    service process) are each bundled and minified with esbuild, into src/ where they were, so every
//    `new URL('../protocol/…', import.meta.url)` and `join(currentDir, …)` still points at the
//    same place.
// 2. The renderer pages keep loading files by path (their import maps and <script src> point
//    into node_modules), so the modules they reach are only minified in place.
// 3. Whatever nothing reaches any more is removed: the dependencies only the main process used
//    (now inside its bundle), the web edition's modules and dependencies (src/web*.mjs,
//    renderer/webShims, pyodide, @wasmer/sdk …), and the unused files of three and the compute
//    engine.
//
// `includeTests` also bundles the --interaction-test runner (tests/interactionRunner.mjs and the
// fixtures and dev dependencies it imports), so `make verifyPackagedInteraction` can drive the
// packaged app; a package for users leaves it out.

import { build, transform } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// fileURLToPath, not URL.pathname: on Windows the pathname is /D:/..., which is no path there.
const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Modules Node or Electron start by file name: each becomes a bundle at its own path.
const mainEntries = ['src/main.mjs', 'src/importerWorker.mjs', 'src/pushServiceProcess.mjs'];
// Loaded by Electron, never bundled: preloads only import 'electron', and are just minified.
const preloadPattern = /(?:^|\/)(?:preload|\w+Preload)\.(?:mjs|cjs)$/;
// Native modules (and optional ones that may be missing) are left for Node to load at run time.
const externalPackages = ['electron', 'bufferutil', 'utf-8-validate', 'proper-lockfile'];
// Dependencies the renderer pages load anyway and whose Node entry is that same file, so the main
// process shares the one copy rather than carrying another inside its bundle (5 MB for the compute engine).
const sharedPackages = ['@cortex-js/compute-engine'];
const testModules = ['../tests/interactionRunner.mjs', '../tests/drivers/electronWindowDriver.mjs', '../tests/exploreRunner.mjs'];
const devToolModules = ['../tests/generateExampleThumbnails.mjs'];
// Dependencies loaded as ES modules from a renderer whose unreached script files are removed. The
// rest (classic scripts like plotly, or packages that fetch their own files) are kept whole.
const trimmedPackages = ['three', '@cortex-js/compute-engine'];

const scriptPattern = /\.(?:mjs|cjs|js)$/;
const copyrightHeader = /^\s*(\/\*[^]*?Copyright[^]*?\*\/|\/\/[^\n]*Copyright[^\n]*)/;

async function listFiles(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await listFiles(path));
        else files.push(path);
    }
    return files;
}

const toPosix = (path) => path.split(sep).join('/');

// Leaves the given specifiers as they are, unbundled (a plain `external` cannot match a relative path).
function leaveAlone(specifiers) {
    return {
        name: 'leave-alone',
        setup(builder) {
            builder.onResolve({ filter: /^\.\.\/tests\// }, (args) => (specifiers.includes(args.path) ? { path: args.path, external: true } : undefined));
        }
    };
}

// The test runner's fixtures (an OPC UA server, an MQTT broker …) use dev dependencies the package does not carry,
// and some find their own data files next to them. A test build therefore loads every package a tests/ file imports
// from this checkout's node_modules, where they all are, as one consistent set.
function testDependenciesFromCheckout() {
    const testsDirectory = join(rootDirectory, 'tests') + sep;
    return {
        name: 'test-dependencies-from-checkout',
        setup(builder) {
            builder.onResolve({ filter: /^[^./]/ }, async (args) => {
                if (args.pluginData?.fromCheckout || !args.importer.startsWith(testsDirectory) || args.path.startsWith('node:') || externalPackages.includes(args.path)) return undefined;
                const resolved = await builder.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: { fromCheckout: true } });
                if (resolved.errors.length || resolved.external || !resolved.path.includes(`${sep}node_modules${sep}`)) return undefined;
                return { path: pathToFileURL(resolved.path).href, external: true };
            });
        }
    };
}

async function bundleMainProcess(buildPath, includeTests) {
    const result = await build({
        absWorkingDir: rootDirectory,
        entryPoints: mainEntries.map((entry) => join(rootDirectory, entry)),
        outdir: join(buildPath, 'src'),
        outbase: 'src',
        outExtension: { '.js': '.mjs' },
        bundle: true,
        // No code splitting: with it, esbuild loses the named exports of a CommonJS package loaded with import()
        // (@peculiar/x509 in src/pushCertificate.mjs), which plain Node keeps. Costs about 0.6 MB of shared code.
        format: 'esm',
        platform: 'node',
        target: 'node24',
        minify: true,
        keepNames: true,
        legalComments: 'none',
        external: [...externalPackages, ...sharedPackages],
        plugins: includeTests ? [leaveAlone(devToolModules), testDependenciesFromCheckout()] : [leaveAlone([...testModules, ...devToolModules])],
        // CommonJS dependencies call require() for Node's built-in modules.
        banner: { js: "/* Copyright © 2026 Zenin Easa Panthakkalakath */\nimport{createRequire as __konjugateCreateRequire}from'node:module';const require=__konjugateCreateRequire(import.meta.url);" },
        metafile: true,
        logLevel: 'error',
        allowOverwrite: true
    });
    return new Set(Object.keys(result.metafile.outputs).map((output) => resolve(rootDirectory, output)));
}

// Every import map in the app's pages, merged: bare specifier -> path relative to the page.
async function readImportMaps(htmlFiles) {
    const maps = [];
    for (const htmlFile of htmlFiles) {
        const html = await readFile(htmlFile, 'utf8');
        for (const match of html.matchAll(/<script type="importmap">([^]*?)<\/script>/g)) {
            for (const [specifier, target] of Object.entries(JSON.parse(match[1]).imports ?? {})) maps.push({ specifier, target: resolve(dirname(htmlFile), target) });
        }
    }
    return maps;
}

function resolveSpecifier(specifier, fromFile, importMaps) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) return resolve(dirname(fromFile), specifier.split(/[?#]/)[0]);
    for (const { specifier: key, target } of importMaps) {
        if (key === specifier) return target;
        if (key.endsWith('/') && specifier.startsWith(key)) return join(target, specifier.slice(key.length));
    }
    return null;
}

// The files the renderer pages reach: their scripts, stylesheets and everything those import.
async function walkRendererFiles(buildPath) {
    const sourceDirectory = join(buildPath, 'src');
    const htmlFiles = (await listFiles(sourceDirectory)).filter((file) => file.endsWith('.html'));
    const importMaps = await readImportMaps(htmlFiles);
    const reached = new Set();
    const pending = [];
    const reach = (file) => {
        if (file && !reached.has(file) && existsSync(file)) {
            reached.add(file);
            pending.push(file);
        }
    };
    for (const htmlFile of htmlFiles) {
        reach(htmlFile);
        const html = await readFile(htmlFile, 'utf8');
        for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
            if (!/^[a-z]+:/i.test(match[1])) reach(resolve(dirname(htmlFile), match[1].split(/[?#]/)[0]));
        }
    }
    for (const { target } of importMaps) if (!target.endsWith(sep) && !target.endsWith('/')) reach(target);
    const importPattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']|new\s+(?:Worker|URL)\(\s*(?:new URL\(\s*)?["']([^"']+)["']/g;
    while (pending.length) {
        const file = pending.pop();
        if (!scriptPattern.test(file)) continue;
        const content = await readFile(file, 'utf8');
        for (const match of content.matchAll(importPattern)) reach(resolveSpecifier(match[1] ?? match[2], file, importMaps));
        // A literal path into node_modules (e.g. exampleGuide/renderer.mjs's mathlive import).
        for (const match of content.matchAll(/["'`]((?:\.\.\/)+node_modules\/[^"'`]+)["'`]/g)) reach(resolve(dirname(file), match[1]));
    }
    return reached;
}

function packageNameOf(path, nodeModules) {
    const parts = toPosix(relative(nodeModules, path)).split('/');
    return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

async function packageDependencies(nodeModules, name) {
    try {
        const manifest = JSON.parse(await readFile(join(nodeModules, name, 'package.json'), 'utf8'));
        return Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies });
    } catch {
        return [];
    }
}

async function minifyInPlace(file) {
    const source = await readFile(file, 'utf8');
    const header = copyrightHeader.exec(source)?.[1];
    const { code } = await transform(source, { loader: 'js', minify: true, keepNames: true, legalComments: 'none', target: 'esnext' });
    await writeFile(file, header ? `${header}\n${code}` : code);
}

export async function bundlePackagedApp(buildPath, { includeTests = false } = {}) {
    const sourceDirectory = join(buildPath, 'src');
    const nodeModules = join(buildPath, 'node_modules');

    const bundleOutputs = await bundleMainProcess(buildPath, includeTests);
    const rendererFiles = await walkRendererFiles(buildPath);

    // Our own modules: bundled, reached by a page, a preload, or removed.
    for (const file of await listFiles(sourceDirectory)) {
        if (!scriptPattern.test(file) || bundleOutputs.has(file)) continue;
        if (rendererFiles.has(file) || preloadPattern.test(toPosix(relative(buildPath, file)))) await minifyInPlace(file);
        else await rm(file);
    }
    // The runner is inside the bundle when it is included at all; the preload its driver registers to answer a window's dialogs is
    // loaded by path, so it stays.
    const dialogPreload = join(buildPath, 'tests', 'drivers', 'nativeDialogPreload.cjs');
    const keptPreload = includeTests && existsSync(dialogPreload) ? await readFile(dialogPreload, 'utf8') : null;
    await rm(join(buildPath, 'tests'), { recursive: true, force: true });
    if (keptPreload !== null) {
        await mkdir(dirname(dialogPreload), { recursive: true });
        await writeFile(dialogPreload, keptPreload);
    }

    // Dependencies: the ones the pages load, the external ones the bundle loads, and theirs.
    const kept = new Set();
    const keep = async (name) => {
        if (kept.has(name) || !existsSync(join(nodeModules, name))) return;
        kept.add(name);
        for (const dependency of await packageDependencies(nodeModules, name)) await keep(dependency);
    };
    for (const file of rendererFiles) if (file.startsWith(nodeModules + sep)) await keep(packageNameOf(file, nodeModules));
    for (const name of [...externalPackages, ...sharedPackages]) await keep(name);
    for (const entry of await readdir(nodeModules)) {
        const names = entry.startsWith('@') ? (await readdir(join(nodeModules, entry))).map((name) => `${entry}/${name}`) : [entry];
        for (const name of names) if (!kept.has(name)) await rm(join(nodeModules, name), { recursive: true, force: true });
        if (entry.startsWith('@') && (await readdir(join(nodeModules, entry))).length === 0) await rm(join(nodeModules, entry), { recursive: true });
    }
    if (existsSync(join(nodeModules, '.bin'))) await rm(join(nodeModules, '.bin'), { recursive: true, force: true });

    for (const name of trimmedPackages) {
        const packageDirectory = join(nodeModules, name);
        if (!existsSync(packageDirectory)) continue;
        for (const file of await listFiles(packageDirectory)) {
            if (scriptPattern.test(file) && !rendererFiles.has(file)) await rm(file);
        }
    }

    return { keptPackages: [...kept].sort(), bundleOutputs: [...bundleOutputs].map((file) => toPosix(relative(buildPath, file))) };
}

// Run by hand against a copied app directory: node scripts/bundlePackagedApp.mjs <dir> [--tests]
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const directory = process.argv[2];
    if (!directory || !(await stat(directory)).isDirectory()) {
        console.error('Usage: node scripts/bundlePackagedApp.mjs <copied app directory> [--tests]');
        process.exit(2);
    }
    console.log(await bundlePackagedApp(resolve(directory), { includeTests: process.argv.includes('--tests') }));
}
