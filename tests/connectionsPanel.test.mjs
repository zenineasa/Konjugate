/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What Settings › Push service shows (src/renderer/connectionsPanel.mjs): the examples a person copies, written for the addresses, key
// and signal in use, JSON first; and the sentence for the service's state.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pushExamples, pushServiceSentence } from '../src/renderer/connectionsPanel.mjs';

test('the examples use the addresses, the key and a signal the key may send, JSON first', () => {
    const examples = pushExamples({ host: '127.0.0.1', port: 9000, grpcPort: 9001, key: 'kjp_abc', signal: 'mass' });
    assert.deepEqual(examples.map((example) => example.id), ['rig', 'python', 'javascript', 'curl', 'protobuf', 'grpcPython', 'grpcCpp']);
    for (const example of examples) {
        assert.match(example.code, /kjp_abc/, example.id);
        // The simulated rig sends its own two signals.
        if (example.id !== 'rig') assert.match(example.code, /mass/, example.id);
    }
    for (const id of ['python', 'javascript', 'curl', 'protobuf']) assert.match(examples.find((example) => example.id === id).code, /http:\/\/127\.0\.0\.1:9000\/v1\/readings/, id);
    for (const id of ['grpcPython', 'grpcCpp']) assert.match(examples.find((example) => example.id === id).code, /127\.0\.0\.1:9001/, id);
    assert.doesNotMatch(examples[1].code, /^import (?!json, time, urllib\.request)/m, 'The first script example needs nothing installed.');
    assert.match(examples[0].code, /pushTankRig\.py http:\/\/127\.0\.0\.1:9000 \\\n    --key kjp_abc \\\n    --speed 600$/, 'The demonstration is one command, filled in.');
    assert.match(pushExamples().find((example) => example.id === 'grpcPython').code, /127\.0\.0\.1:8738/, 'gRPC is on the next port by default.');
});

test('the state reads as a sentence', () => {
    assert.match(pushServiceSentence({ listening: false }), /^Not listening/);
    assert.equal(pushServiceSentence({ listening: false, failure: 'The push service ended unexpectedly (code 1).' }), 'Stopped: The push service ended unexpectedly (code 1).');
    assert.equal(pushServiceSentence({ listening: true, host: '127.0.0.1', port: 8737, grpcPort: 8738, clients: 1, readingsPerSecond: 2.5, unclaimed: 3 }),
        'Listening on 127.0.0.1:8737 (HTTP and WebSocket) and 127.0.0.1:8738 (gRPC): 1 client, 2.5 readings a second. 3 readings came for signals no live twin was following.');
});

test('on the network, every example uses TLS and trusts the saved certificate, and none turns checking off', () => {
    const examples = pushExamples({ host: '192.168.1.8', port: 8737, grpcPort: 8738, key: 'kjp_abc', signal: 'mass', encrypted: true, certificateFile: 'konjugate-push.pem' });
    for (const example of examples) {
        assert.doesNotMatch(example.code, /http:\/\//, `${example.id} uses https`);
        assert.match(example.code, /konjugate-push\.pem/, `${example.id} trusts the saved certificate`);
        assert.doesNotMatch(example.code, /CERT_NONE|verify=False|--insecure|-k |rejectUnauthorized|check_hostname = False|insecure_channel/, `${example.id} keeps checking on`);
    }
    assert.match(examples[0].code, /pushTankRig\.py https:\/\/192\.168\.1\.8:8737 \\\n    --key kjp_abc \\\n    --certificate konjugate-push\.pem \\\n    --speed 600$/);
    assert.match(examples.find((example) => example.id === 'grpcPython').code, /grpc\.secure_channel\("192\.168\.1\.8:8738", credentials\)/);
    assert.match(examples.find((example) => example.id === 'javascript').code, /NODE_EXTRA_CA_CERTS=konjugate-push\.pem/);
    assert.match(pushServiceSentence({ listening: true, encrypted: true, addresses: ['192.168.1.8', 'fd00::5'], port: 8737, grpcPort: 8738, clients: 2 }),
        /^Listening on the network, encrypted at 192\.168\.1\.8: port 8737 for HTTPS and secure WebSockets, 8738 for gRPC over TLS\. 2 clients\.$/);
});
