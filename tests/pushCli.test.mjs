/* Copyright © 2026 Zenin Easa Panthakkalakath */

// `konjugate --cli serve` (src/pushCli.mjs): keys made, listed and revoked from the command line, and the service run in the
// foreground with what arrives recorded as a data log that reads back.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readDataLog } from '../src/dataLog.mjs';
import { runPushCli } from '../src/pushCli.mjs';

test('keys from the command line, and serving records what arrives', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'konjugatePushCli-'));
    try {
        const lines = [];
        const errors = [];
        const io = { directory, out: (line) => lines.push(line), err: (line) => errors.push(line) };
        assert.equal(await runPushCli(['--port', '0'], io), 1);
        assert.match(errors.at(-1), /no keys/);

        assert.equal(await runPushCli(['keys', 'add', 'vessel rig', '--signals', 'heaterPower,vesselTemperature'], io), 0);
        const key = lines.find((line) => /^\s+kjp_/.test(line)).trim();
        assert.match(lines.join('\n'), /shown this once/);
        assert.equal(await runPushCli(['keys', 'add', 'balance', '--signals', 'mass'], io), 0);
        assert.equal(await runPushCli(['keys', 'revoke', 'balance'], io), 0);
        lines.length = 0;
        assert.equal(await runPushCli(['keys', 'list'], io), 0);
        assert.deepEqual(lines.map((line) => line.split(':')[0]), ['balance (revoked)', 'vessel rig']);
        assert.equal(await runPushCli(['keys', 'rename'], io), 2);
        assert.equal(await runPushCli(['--port', '0', '--inputs', 'stirrer'], io), 2);
        assert.match(errors.at(-1), /No key may send "stirrer"/);

        lines.length = 0;
        let stop;
        const stopped = new Promise((resolve) => { stop = resolve; });
        const serving = runPushCli(['--port', '0', '--record', 'trial.csv', '--inputs', 'heaterPower'], { ...io, cwd: directory, untilStop: () => stopped });
        for (let waited = 0; waited < 5000 && !lines.some((line) => line.startsWith('Recording')); waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
        const port = Number(/127\.0\.0\.1:(\d+) \(HTTP/.exec(lines[0])[1]);
        const epochSeconds = Math.floor(Date.now() / 1000);
        const response = await fetch(`http://127.0.0.1:${port}/v1/readings`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify({ readings: [
                { signal: 'heaterPower', value: 1200, time: epochSeconds + 10 },
                { signal: 'vesselTemperature', value: 341.25, time: epochSeconds + 10, quality: 'uncertain' }
            ] })
        });
        assert.equal((await response.json()).status, 202);
        stop();
        assert.equal(await serving, 0);
        assert.match(lines.at(-1), /^Stopped\. 2 readings taken; recorded in .*trial\.csv\.$/);

        const log = readDataLog(await readFile(join(directory, 'trial.csv'), 'utf8'));
        assert.equal(log.header.source, 'Konjugate push service');
        assert.deepEqual(log.header.signals.map(({ name, role }) => [name, role]), [['heaterPower', 'input'], ['vesselTemperature', 'output']]);
        assert.deepEqual(log.observations.map(({ signal, value, quality }) => [signal, value, quality]), [['heaterPower', 1200, 'good'], ['vesselTemperature', 341.25, 'uncertain']]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
