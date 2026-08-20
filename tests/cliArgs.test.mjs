/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { matchRunConfiguration, parseCliFlags } from '../src/cliArgs.mjs';

test('parseCliFlags reads --flag value pairs', () => {
    assert.deepEqual(parseCliFlags(['--target-time', '10', '--configuration', 'Default']), {
        'target-time': '10',
        configuration: 'Default'
    });
});

test('parseCliFlags treats a flag with no following value (or another flag next) as boolean true', () => {
    assert.deepEqual(parseCliFlags(['--verbose']), { verbose: true });
    assert.deepEqual(parseCliFlags(['--verbose', '--target-time', '10']), { verbose: true, 'target-time': '10' });
});

test('parseCliFlags ignores non-flag tokens', () => {
    assert.deepEqual(parseCliFlags(['project.kjt', '--target-time', '10']), { 'target-time': '10' });
});

const runConfigurations = [
    { id: 1, name: 'Default', globalTimeStep: 0.01 },
    { id: 2, name: 'Fine', globalTimeStep: 0.001 }
];

test('matchRunConfiguration matches by name', () => {
    assert.equal(matchRunConfiguration(runConfigurations, 1, 'Fine'), runConfigurations[1]);
});

test('matchRunConfiguration falls back to numeric id when no name matches', () => {
    assert.equal(matchRunConfiguration(runConfigurations, 1, '2'), runConfigurations[1]);
});

test('matchRunConfiguration returns null for an unknown name/id', () => {
    assert.equal(matchRunConfiguration(runConfigurations, 1, 'Nonexistent'), null);
});

test('matchRunConfiguration defaults to the active configuration when nothing is requested', () => {
    assert.equal(matchRunConfiguration(runConfigurations, 2, undefined), runConfigurations[1]);
});

test('matchRunConfiguration falls back to the first configuration if the active id is stale', () => {
    assert.equal(matchRunConfiguration(runConfigurations, 999, undefined), runConfigurations[0]);
});

test('matchRunConfiguration returns null for a project with no run configurations', () => {
    assert.equal(matchRunConfiguration([], 1, undefined), null);
});
