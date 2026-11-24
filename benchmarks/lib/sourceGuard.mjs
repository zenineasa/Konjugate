/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The sources a timing session's numbers depend on, and the refusal to time them with uncommitted changes (benchmarks/README.md, Reproduce
// these results). A session records the commit it timed; with uncommitted changes to what the engine or the harness is built from, that
// commit is not what was timed, and the published numbers could not be traced to the repository. So npm run benchmark:performance, and
// setup.mjs before it builds the engine, refuse to go on, naming the files, until they are committed; --allow-uncommitted goes on regardless,
// and the session is marked as timed with uncommitted changes in its results and at the top of its report.
//
// The timed sources: everything that builds the engine (engine/, protocol/, vcpkg.json, vcpkgOverlays/, scripts/buildEngine.mjs and
// scripts/generateReportProtocol.mjs, which setup.mjs runs), the benchmark harness (benchmarks/, but not benchmarks/results/, where a
// session writes its own results), package.json (the version recorded) and every module outside benchmarks/ the harness imports, followed
// from import to import (src/engineProtocol.mjs, src/projectFile.mjs and theirs). Untracked files there count too: a new source file is a
// change. No dependencies, so setup.mjs can use it before npm run setup's packages and src/generated/ exist.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { repositoryRoot } from './shippedEngine.mjs';

export const timedSourcePaths = ['engine', 'protocol', 'vcpkg.json', 'vcpkgOverlays', 'scripts/buildEngine.mjs', 'scripts/generateReportProtocol.mjs', 'benchmarks', 'package.json'];
export const excludedPaths = ['benchmarks/results'];

const toPosix = (path) => path.split(sep).join('/');
const relativeImport = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;

function modulesUnder(directory, skip) {
    const found = [];
    for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (skip(path)) continue;
        if (statSync(path).isDirectory()) found.push(...modulesUnder(path, skip));
        else if (/\.(mjs|js|cjs)$/.test(name)) found.push(path);
    }
    return found;
}

// The modules outside benchmarks/ that the harness imports, directly or through each other, repository-relative and sorted.
export function harnessImports(root = repositoryRoot) {
    const benchmarks = join(root, 'benchmarks');
    const skip = (path) => excludedPaths.some((excluded) => path === join(root, excluded)) || path.endsWith(`${sep}node_modules`);
    const pending = modulesUnder(benchmarks, skip);
    const seen = new Set(pending);
    const outside = new Set();
    while (pending.length) {
        const module = pending.pop();
        for (const [, specifier] of readFileSync(module, 'utf8').matchAll(relativeImport)) {
            const target = resolve(dirname(module), specifier);
            const fromRoot = relative(root, target);
            if (seen.has(target) || fromRoot.startsWith('..') || !existsSync(target) || statSync(target).isDirectory()) continue;
            seen.add(target);
            pending.push(target);
            if (!target.startsWith(benchmarks + sep)) outside.add(toPosix(fromRoot));
        }
    }
    return [...outside].sort();
}

// The paths in git status --porcelain=v1 -z output; a rename or copy is followed by its original path, which is skipped.
export function parsePorcelain(output) {
    const fields = output.split('\0');
    const paths = [];
    for (let index = 0; index < fields.length; ++index) {
        const field = fields[index];
        if (field.length < 4) continue;
        paths.push(field.slice(3));
        if (/[RC]/.test(field.slice(0, 2))) ++index;
    }
    return paths;
}

// The timed sources with uncommitted changes, repository-relative and sorted; null when this is not a git checkout, so cannot be told.
export function uncommittedTimedSources(root = repositoryRoot) {
    // Every path, present or not: a deleted source is a change too, and git status takes a path that matches nothing.
    const pathspecs = [...timedSourcePaths, ...harnessImports(root)];
    try {
        const output = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...pathspecs, ...excludedPaths.map((path) => `:(exclude)${path}`)],
            { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return [...new Set(parsePorcelain(output))].sort();
    } catch {
        return null;
    }
}

// Whether a session may time this checkout: { ok, files, message }. files is null when it is not a git checkout. With allowUncommitted it
// is always ok, and message, when there are changes, says what the session will be marked with.
export function checkTimedSources({ allowUncommitted = false, root = repositoryRoot, action = 'time the benchmarks' } = {}) {
    const files = uncommittedTimedSources(root);
    if (files && !files.length) return { ok: true, files, message: null };
    const what = files
        ? `${files.length} file${files.length === 1 ? '' : 's'} that the timed engine or the benchmark harness ${files.length === 1 ? 'is' : 'are'} built from ${files.length === 1 ? 'has' : 'have'} uncommitted changes:\n${files.map((file) => `  ${file}`).join('\n')}`
        : 'this is not a git checkout, so it cannot be told whether the timed engine and the benchmark harness are a commit.';
    if (allowUncommitted) return { ok: true, files, message: `Going on with uncommitted changes (--allow-uncommitted): ${what}\nThe session is marked as timed with uncommitted changes, in its results and at the top of its report.` };
    return {
        ok: false, files,
        message: `Not going to ${action}: ${what}\nCommit them first, so the results record the commit that was timed, then run this again. To go on regardless, add --allow-uncommitted; the session is then marked as timed with uncommitted changes, in its results and at the top of its report.`
    };
}
