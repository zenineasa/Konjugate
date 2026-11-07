/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The Connections panel (docs/proposals/pushService.md, "On the screen"): the push service's one Start / Stop switch and its state,
// the keys with Make and Revoke, and how to send from a script, JSON first (nothing to install), then protobuf and gRPC under their
// own headings. Desktop only: a web page cannot listen on a port.

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// The examples a person copies, for these addresses, key and signal: [{ id, title, code }], JSON first.
export function pushExamples({ host = '127.0.0.1', port = 8737, grpcPort = port + 1, key = 'YOUR_KEY', signal = 'vesselTemperature' } = {}) {
    const url = `http://${host}:${port}/v1/readings`;
    const target = `${host}:${grpcPort}`;
    return [
        {
            id: 'python', title: 'Python, as JSON (nothing to install)',
            code: `import json, time, urllib.request

KEY = "${key}"

def send(readings):
    request = urllib.request.Request(
        "${url}",
        data=json.dumps({"readings": readings}).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY})
    # A refused message raises urllib.error.HTTPError, whose body says why.
    with urllib.request.urlopen(request) as response:
        return json.load(response)

print(send([{"signal": "${signal}", "value": 341.2, "time": time.time()}]))`
        },
        {
            id: 'javascript', title: 'JavaScript, as JSON',
            code: `const key = '${key}';
const response = await fetch('${url}', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: \`Bearer \${key}\` },
    body: JSON.stringify({ readings: [{ signal: '${signal}', value: 341.2, time: Date.now() / 1000 }] })
});
console.log(await response.json());`
        },
        {
            id: 'curl', title: 'curl, to try it',
            code: `curl -X POST ${url} -H "Content-Type: application/json" -H "Authorization: Bearer ${key}" \\
     -d '{"readings": [{"signal": "${signal}", "value": 341.2}]}'`
        },
        {
            id: 'protobuf', title: 'Python, as protobuf',
            code: `# Save pushReadings.proto (below) beside the script, then:
#   pip install protobuf grpcio-tools
#   python -m grpc_tools.protoc -I. --python_out=. pushReadings.proto
import time, urllib.request
import pushReadings_pb2 as push

message = push.PushReadings()
reading = message.readings.add(signal="${signal}", value=341.2)
reading.time.FromNanoseconds(time.time_ns())
request = urllib.request.Request("${url}", data=message.SerializeToString(),
    headers={"Content-Type": "application/x-protobuf", "Authorization": "Bearer ${key}"})
with urllib.request.urlopen(request) as response:
    answer = push.PushAnswer.FromString(response.read())
    print(answer.status, answer.taken, answer.reason)`
        },
        {
            id: 'grpcPython', title: 'Python, streaming over gRPC',
            code: `# Save pushReadings.proto (below) beside the script, then:
#   pip install grpcio grpcio-tools
#   python -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. pushReadings.proto
import time, grpc
import pushReadings_pb2 as push, pushReadings_pb2_grpc as push_grpc

def read_instrument():
    return 341.2  # your instrument here

def readings():
    while True:
        message = push.PushReadings()
        reading = message.readings.add(signal="${signal}", value=read_instrument())
        reading.time.FromNanoseconds(time.time_ns())
        yield message
        time.sleep(1)

with grpc.insecure_channel("${target}") as channel:
    stub = push_grpc.ReadingPushStub(channel)
    # Each message is answered in order; a sender faster than Konjugate takes the readings is held back.
    for answer in stub.Push(readings(), metadata=[("authorization", "Bearer ${key}")]):
        if answer.status != 202:
            print("refused:", answer.reason)`
        },
        {
            id: 'grpcCpp', title: 'C++, streaming over gRPC',
            code: `// protoc -I. --cpp_out=. --grpc_out=. --plugin=protoc-gen-grpc=$(which grpc_cpp_plugin) pushReadings.proto
#include <iostream>
#include <grpcpp/grpcpp.h>
#include <google/protobuf/util/time_util.h>
#include "pushReadings.grpc.pb.h"

using namespace konjugate::push::v1;

int main() {
    auto stub = ReadingPush::NewStub(grpc::CreateChannel("${target}", grpc::InsecureChannelCredentials()));
    grpc::ClientContext context;
    context.AddMetadata("authorization", "Bearer ${key}");
    auto stream = stub->Push(&context);
    PushReadings message;
    auto* reading = message.add_readings();
    reading->set_signal("${signal}");
    reading->set_value(341.2);
    *reading->mutable_time() = google::protobuf::util::TimeUtil::GetCurrentTime();
    stream->Write(message);
    PushAnswer answer;
    if (stream->Read(&answer)) std::cout << answer.status() << ' ' << answer.reason() << '\\n';
    stream->WritesDone();
    return stream->Finish().ok() ? 0 : 1;
}`
        }
    ];
}

// A sentence for the service's state, as the panel and the card show it.
export function pushServiceSentence(state) {
    if (!state?.listening) return state?.failure ? `Stopped: ${state.failure}` : 'Not listening. Nothing can send readings until it is started.';
    const rate = state.readingsPerSecond ? `, ${state.readingsPerSecond.toFixed(1)} readings a second` : '';
    const unclaimed = state.unclaimed ? ` ${plural(state.unclaimed, 'reading')} came for signals no live twin was following.` : '';
    return `Listening on ${state.host}:${state.port} (HTTP and WebSocket) and ${state.host}:${state.grpcPort} (gRPC): ${plural(state.clients ?? 0, 'client')}${rate}.${unclaimed}`;
}

export class ConnectionsPanel {
    #dialog;
    #api;
    #confirm;
    #copy;
    #state = { listening: false };
    #keys = [];
    #madeKey = null;
    #proto = '';
    #examplesShown = null;

    // dialog: the panel's <dialog>. api: window.engine.pushService. confirm(message): asks before stopping a service a twin follows.
    // copy(text): puts text on the clipboard.
    constructor({ dialog, api, confirm = (message) => window.confirm(message), copy = (text) => navigator.clipboard.writeText(text) }) {
        this.#dialog = dialog;
        this.#api = api;
        this.#confirm = confirm;
        this.#copy = copy;
        const find = (id) => dialog.querySelector(`#${id}`);
        this.parts = {
            port: find('pushServicePort'), grpcPort: find('pushServiceGrpcPort'), toggle: find('pushServiceToggle'), state: find('pushServiceState'),
            log: find('pushServiceLog'), keys: find('pushKeys'), keyName: find('pushKeyName'), keySignals: find('pushKeySignals'), keyAdd: find('pushKeyAdd'),
            made: find('pushKeyMade'), madeValue: find('pushKeyMadeValue'), madeCopy: find('pushKeyCopy'), keyStatus: find('pushKeyStatus'),
            examples: find('pushExamples'), close: find('connectionsClose')
        };
        const { port, toggle, keyAdd, madeCopy, close, examples } = this.parts;
        port.addEventListener('input', () => { this.#renderPorts(); this.#renderExamples(); });
        toggle.addEventListener('click', () => this.#toggle());
        keyAdd.addEventListener('click', () => this.#addKey());
        madeCopy.addEventListener('click', () => this.#copy(this.#madeKey ?? ''));
        close.addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => {
            // A key is shown once: closing the panel puts it away.
            this.#madeKey = null;
            this.parts.made.hidden = true;
            this.#renderExamples();
        });
        examples.addEventListener('click', (event) => {
            const button = event.target.closest('[data-copy]');
            if (!button) return;
            // In the summary, so it must not also open or close the example.
            event.preventDefault();
            this.#copy(button.closest('details').querySelector('code').textContent);
        });
        api.onState((state) => this.render(state));
    }

    async open() {
        if (!this.#proto) this.#proto = await this.#api.proto().catch(() => '');
        this.render(await this.#api.state());
        await this.#refreshKeys();
        if (!this.#dialog.open) this.#dialog.showModal();
    }

    render(state) {
        this.#state = state;
        const { port, toggle, state: line, log } = this.parts;
        if (!port.value) port.value = String(state.port ?? state.defaultPort ?? 8737);
        port.disabled = state.listening;
        toggle.textContent = state.listening ? 'Stop' : 'Start';
        toggle.classList.toggle('doneButton', !state.listening);
        line.textContent = pushServiceSentence(state);
        line.classList.toggle('warning', !state.listening && Boolean(state.failure));
        log.replaceChildren(...(state.log ?? []).slice(-5).reverse().map((entry) => {
            const item = document.createElement('li');
            item.textContent = `${new Date(entry.time).toLocaleTimeString()} ${entry.line}`;
            return item;
        }));
        this.#renderPorts();
        this.#renderKeys();
        this.#renderExamples();
    }

    #chosenPort() {
        const value = Number(this.parts.port.value);
        return Number.isInteger(value) && value > 0 && value < 65535 ? value : null;
    }

    #renderPorts() {
        const port = this.#state.listening ? this.#state.port : this.#chosenPort();
        this.parts.grpcPort.textContent = port ? `gRPC on ${this.#state.listening ? this.#state.grpcPort : port + 1}` : 'A port is a whole number from 1 to 65534.';
    }

    async #toggle() {
        const { toggle, state: line } = this.parts;
        toggle.disabled = true;
        try {
            if (this.#state.listening) {
                if (this.#state.followers && !this.#confirm(`${plural(this.#state.followers, 'live twin')} ${this.#state.followers === 1 ? 'is' : 'are'} following the readings scripts send. Stopping the push service stops ${this.#state.followers === 1 ? 'it' : 'them'} too. Stop listening?`)) return;
                this.render(await this.#api.stop());
            } else {
                const port = this.#chosenPort();
                if (!port) {
                    line.textContent = 'A port is a whole number from 1 to 65534.';
                    return;
                }
                this.render(await this.#api.start(port));
            }
        } catch (error) {
            line.textContent = `Could not ${this.#state.listening ? 'stop' : 'start'}: ${String(error.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')}`;
            line.classList.add('warning');
        } finally {
            toggle.disabled = false;
        }
    }

    async #refreshKeys() {
        this.#keys = await this.#api.keys.list();
        this.#renderKeys();
        this.#renderExamples();
    }

    #renderKeys() {
        const lastUsed = this.#state.lastUsed ?? {};
        this.parts.keys.replaceChildren(...this.#keys.map((key) => {
            const row = document.createElement('div');
            row.className = `connectionsKey${key.revoked ? ' revoked' : ''}`;
            row.dataset.key = key.name;
            const used = lastUsed[key.name] ? `last used ${new Date(lastUsed[key.name]).toLocaleTimeString()}` : 'not used since the service started';
            row.innerHTML = `<span><strong>${escapeHtml(key.name)}</strong><small>${escapeHtml(key.signals.join(', '))}</small></span>`
                + `<small>${key.revoked ? 'revoked' : escapeHtml(used)}</small>`
                + (key.revoked ? '' : '<button type="button" data-revoke>Revoke</button>');
            row.querySelector('[data-revoke]')?.addEventListener('click', async () => {
                if (!this.#confirm(`Revoke the key "${key.name}"? A script using it is refused from its next message.`)) return;
                await this.#api.keys.revoke(key.name);
                await this.#refreshKeys();
            });
            return row;
        }));
        if (!this.#keys.length) this.parts.keys.innerHTML = '<small>No keys yet: make one for each rig or script.</small>';
    }

    async #addKey() {
        const { keyName, keySignals, keyStatus, made, madeValue } = this.parts;
        keyStatus.textContent = '';
        try {
            const signals = keySignals.value.split(',').map((signal) => signal.trim()).filter(Boolean);
            const { key, record } = await this.#api.keys.add(keyName.value, signals);
            this.#madeKey = key;
            madeValue.textContent = key;
            made.hidden = false;
            keyName.value = '';
            keySignals.value = '';
            keyStatus.textContent = `Made "${record.name}", which may send ${record.signals.join(', ')}. The examples below use it.`;
            await this.#refreshKeys();
        } catch (error) {
            keyStatus.textContent = String(error.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
        }
    }

    #renderExamples() {
        const port = this.#state.listening ? this.#state.port : (this.#chosenPort() ?? 8737);
        const grpcPort = this.#state.listening ? this.#state.grpcPort : port + 1;
        const newest = this.#keys.find((key) => !key.revoked);
        const settings = { host: '127.0.0.1', port, grpcPort, key: this.#madeKey ?? 'YOUR_KEY', signal: newest?.signals[0] ?? 'vesselTemperature' };
        // Drawn again only when something they show has changed, not at every change of the rate or the clients.
        const shown = JSON.stringify({ ...settings, proto: this.#proto.length });
        if (shown === this.#examplesShown) return;
        this.#examplesShown = shown;
        const examples = pushExamples(settings);
        const open = new Set([...this.parts.examples.querySelectorAll('details[open]')].map((details) => details.dataset.example));
        const sections = [
            ...examples.map((example) => ({ ...example, group: ['python', 'javascript', 'curl'].includes(example.id) ? 'JSON' : example.id === 'protobuf' ? 'Protobuf' : 'gRPC' })),
            { id: 'proto', title: 'pushReadings.proto', code: this.#proto || 'The message definition could not be read.', group: 'Protobuf' }
        ];
        let lastGroup = null;
        this.parts.examples.replaceChildren(...sections.flatMap((section) => {
            const parts = [];
            if (section.group !== lastGroup) {
                lastGroup = section.group;
                const heading = document.createElement('h4');
                heading.textContent = { JSON: 'As JSON', Protobuf: 'As protobuf (generate the code from the .proto)', gRPC: 'Over gRPC (a stream, for heavy feeds or other languages)' }[section.group];
                parts.push(heading);
            }
            const details = document.createElement('details');
            details.className = 'connectionsExample';
            details.dataset.example = section.id;
            details.open = open.has(section.id) || (open.size === 0 && section.id === 'python');
            details.innerHTML = `<summary>${escapeHtml(section.title)}<button type="button" data-copy>Copy</button></summary><pre><code>${escapeHtml(section.code)}</code></pre>`;
            parts.push(details);
            return parts;
        }));
    }
}
