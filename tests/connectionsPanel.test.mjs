/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What the Connections panel shows (src/renderer/connectionsPanel.mjs): the examples a person copies, written for the addresses, key
// and signal in use, JSON first; and the sentence for the service's state.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pushExamples, pushServiceSentence } from '../src/renderer/connectionsPanel.mjs';

test('the examples use the addresses, the key and a signal the key may send, JSON first', () => {
    const examples = pushExamples({ host: '127.0.0.1', port: 9000, grpcPort: 9001, key: 'kjp_abc', signal: 'mass' });
    assert.deepEqual(examples.map((example) => example.id), ['python', 'javascript', 'curl', 'protobuf', 'grpcPython', 'grpcCpp']);
    for (const example of examples) {
        assert.match(example.code, /kjp_abc/, example.id);
        assert.match(example.code, /mass/, example.id);
    }
    for (const id of ['python', 'javascript', 'curl', 'protobuf']) assert.match(examples.find((example) => example.id === id).code, /http:\/\/127\.0\.0\.1:9000\/v1\/readings/, id);
    for (const id of ['grpcPython', 'grpcCpp']) assert.match(examples.find((example) => example.id === id).code, /127\.0\.0\.1:9001/, id);
    assert.doesNotMatch(examples[0].code, /^import (?!json, time, urllib\.request)/m, 'The first example needs nothing installed.');
    assert.match(pushExamples().find((example) => example.id === 'grpcPython').code, /127\.0\.0\.1:8738/, 'gRPC is on the next port by default.');
});

test('the state reads as a sentence', () => {
    assert.match(pushServiceSentence({ listening: false }), /^Not listening/);
    assert.equal(pushServiceSentence({ listening: false, failure: 'The push service ended unexpectedly (code 1).' }), 'Stopped: The push service ended unexpectedly (code 1).');
    assert.equal(pushServiceSentence({ listening: true, host: '127.0.0.1', port: 8737, grpcPort: 8738, clients: 1, readingsPerSecond: 2.5, unclaimed: 3 }),
        'Listening on 127.0.0.1:8737 (HTTP and WebSocket) and 127.0.0.1:8738 (gRPC): 1 client, 2.5 readings a second. 3 readings came for signals no live twin was following.');
});
