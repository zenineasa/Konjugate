/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pythonCandidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
const script = `
from examples.providers.accumulatorNode import AccumulatorNode
from konjugate import EvaluationContext, InputView, NodeOutputCollector

provider = AccumulatorNode()
outputs = NodeOutputCollector()
provider.evaluate(EvaluationContext(0.0, 0.5), InputView({'input': 4.0}), outputs)
assert outputs.gradients['output'] == 2.0
checkpoint = provider.checkpoint()
provider.total = 99.0
provider.restore(checkpoint)
assert provider.total == 2.0
print('Accumulator node provider contract passed')
`;

let lastFailure = null;
for (const executable of pythonCandidates) {
    try {
        await access(join(root, 'engine', 'sdk', 'python', 'konjugate'));
    } catch (error) {
        console.error(`Python SDK is missing: ${error.message}`);
        process.exitCode = 1;
        process.exit();
    }
    const result = spawnSync(executable, ['-c', script], {
        cwd: root,
        env: { ...process.env, PYTHONPATH: join(root, 'engine', 'sdk', 'python') },
        encoding: 'utf8'
    });
    if (!result.error) {
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        process.exitCode = result.status ?? 1;
        process.exit();
    }
    lastFailure = result.error;
}

console.error(`Could not start Python: ${lastFailure?.message ?? 'no interpreter found'}`);
process.exitCode = 1;
