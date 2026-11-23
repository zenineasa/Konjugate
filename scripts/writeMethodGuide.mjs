/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes docs/choosingAMethod.md from the method guide in src/integrationMethods.mjs, its one source (tests/integrationMethods.test.mjs
// checks the page is current).
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { methodGuideMarkdown } from '../src/integrationMethods.mjs';

await writeFile(join(import.meta.dirname, '..', 'docs', 'choosingAMethod.md'), methodGuideMarkdown());
