/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Where timing results are kept, and what they were measured from (benchmarks/README.md, Sessions).
//
// Results are kept per computer, benchmarks/results/<machine>/, not per version: the version in package.json changes only at a release, so
// it cannot tell two engines apart. Each part of a session records instead the source it timed (sourceIdentity): the version, the commit,
// and whether the checkout had uncommitted changes; combine.mjs combines only the sessions timed from the newest source.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repositoryRoot } from './engine.mjs';
import { machineDetails, machineSlug } from './machine.mjs';
import { uncommittedTimedSources } from './sourceGuard.mjs';

export function resultsDirectory(machine = machineDetails()) {
    return join(repositoryRoot, 'benchmarks', 'results', machineSlug(machine));
}

function git(args) {
    try {
        return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return '';
    }
}

// The checkout the engine was built from. Uncommitted changes under benchmarks/results/ are not counted: a session writes its own results
// there, so every part after the first would otherwise be marked as changed. uncommittedSources lists those of them the timed engine or the
// harness is built from (lib/sourceGuard.mjs), which npm run benchmark:performance refuses to time without --allow-uncommitted.
export function sourceIdentity() {
    return {
        konjugateVersion: JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')).version,
        gitCommit: git(['rev-parse', '--short', 'HEAD']) || 'unknown',
        workingTreeChanges: Boolean(git(['status', '--porcelain', '--', '.', ':(exclude)benchmarks/results'])),
        uncommittedSources: uncommittedTimedSources()
    };
}
