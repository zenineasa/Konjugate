/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Settings › Push service (docs/proposals/pushService.md, "On the screen"; once a panel of its own, now a page of Settings): the push service's one Start / Stop switch and its state,
// on this computer only or on the network, encrypted, with the certificate scripts trust; the keys with Make and Revoke; and how to
// send from a script: the simulated rig to try it, then JSON (nothing to install), protobuf and gRPC under their own headings.
// Desktop only: a web page cannot listen on a port.

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// The examples a person copies, for these addresses, key and signal: [{ id, title, code }]. `encrypted`: the service listens on the
// network, so each example uses https (or TLS for gRPC) and trusts `certificateFile`, the certificate saved from the panel, as a
// script must: it is how the script knows it talks to this Konjugate, and checking is never turned off.
export function pushExamples({ host = '127.0.0.1', port = 8737, grpcPort = port + 1, key = 'YOUR_KEY', signal = 'vesselTemperature', encrypted = false, certificateFile = 'konjugate-push.pem' } = {}) {
    const address = host.includes(':') ? `[${host}]` : host;
    const base = `${encrypted ? 'https' : 'http'}://${address}:${port}`;
    const url = `${base}/v1/readings`;
    const target = `${address}:${grpcPort}`;
    const pythonTrust = encrypted ? `\n# Trust exactly the certificate saved from Konjugate's Settings › Push service.\ncontext = ssl.create_default_context(cafile="${certificateFile}")\n` : '';
    const pythonOpen = encrypted ? 'urllib.request.urlopen(request, context=context)' : 'urllib.request.urlopen(request)';
    return [
        {
            id: 'rig', title: 'The simulated rig, sending a heated tank\'s readings',
            code: `# Save the demo scripts (the button above) to a folder and run this there, or run it from
# examples/dataSources in the Konjugate repository. In Konjugate, open the Live twin on the
# simulated rig's model, choose "A script sending readings", give heaterPower the role Input and
# tankTemperature Measured, "Use these signals", then "Start live twin".
# The key must be allowed to send heaterPower and tankTemperature. --speed 600 runs an hour in six seconds.
python3 pushTankRig.py ${base} \\
    --key ${key} \\${encrypted ? `
    --certificate ${certificateFile} \\` : ''}
    --speed 600`
        },
        {
            id: 'python', title: 'Python, as JSON (nothing to install)',
            code: `import json, ${encrypted ? 'ssl, ' : ''}time, urllib.request

KEY = "${key}"
${pythonTrust}
def send(readings):
    request = urllib.request.Request(
        "${url}",
        data=json.dumps({"readings": readings}).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY})
    # A refused message raises urllib.error.HTTPError, whose body says why.
    with ${pythonOpen} as response:
        return json.load(response)

print(send([{"signal": "${signal}", "value": 341.2, "time": time.time()}]))`
        },
        {
            id: 'javascript', title: 'JavaScript, as JSON',
            code: `${encrypted ? `// Run with NODE_EXTRA_CA_CERTS=${certificateFile} node send.mjs, so Node trusts the service's certificate.\n` : ''}const key = '${key}';
const response = await fetch('${url}', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: \`Bearer \${key}\` },
    body: JSON.stringify({ readings: [{ signal: '${signal}', value: 341.2, time: Date.now() / 1000 }] })
});
console.log(await response.json());`
        },
        {
            id: 'curl', title: 'curl, to try it',
            code: `curl -X POST ${url}${encrypted ? ` --cacert ${certificateFile}` : ''} -H "Content-Type: application/json" -H "Authorization: Bearer ${key}" \\
     -d '{"readings": [{"signal": "${signal}", "value": 341.2}]}'`
        },
        {
            id: 'protobuf', title: 'Python, as protobuf',
            code: `# Save pushReadings.proto (below) beside the script, then:
#   pip install protobuf grpcio-tools
#   python -m grpc_tools.protoc -I. --python_out=. pushReadings.proto
import ${encrypted ? 'ssl, ' : ''}time, urllib.request
import pushReadings_pb2 as push
${pythonTrust}
message = push.PushReadings()
reading = message.readings.add(signal="${signal}", value=341.2)
reading.time.FromNanoseconds(time.time_ns())
request = urllib.request.Request("${url}", data=message.SerializeToString(),
    headers={"Content-Type": "application/x-protobuf", "Authorization": "Bearer ${key}"})
with ${pythonOpen} as response:
    answer = push.PushAnswer.FromString(response.read())
    print(answer.status, answer.taken, answer.reason)`
        },
        {
            id: 'grpcPython', title: `Python, streaming over gRPC${encrypted ? ' with TLS' : ''}`,
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
${encrypted ? `
# Trust exactly the certificate saved from Konjugate's Settings › Push service.
with open("${certificateFile}", "rb") as file:
    credentials = grpc.ssl_channel_credentials(root_certificates=file.read())
` : ''}
with ${encrypted ? `grpc.secure_channel("${target}", credentials)` : `grpc.insecure_channel("${target}")`} as channel:
    stub = push_grpc.ReadingPushStub(channel)
    # Each message is answered in order; a sender faster than Konjugate takes the readings is held back.
    for answer in stub.Push(readings(), metadata=[("authorization", "Bearer ${key}")]):
        if answer.status != 202:
            print("refused:", answer.reason)`
        },
        {
            id: 'grpcCpp', title: `C++, streaming over gRPC${encrypted ? ' with TLS' : ''}`,
            code: `// protoc -I. --cpp_out=. --grpc_out=. --plugin=protoc-gen-grpc=$(which grpc_cpp_plugin) pushReadings.proto
#include <iostream>
${encrypted ? '#include <fstream>\n#include <sstream>\n' : ''}#include <grpcpp/grpcpp.h>
#include <google/protobuf/util/time_util.h>
#include "pushReadings.grpc.pb.h"

using namespace konjugate::push::v1;

int main() {
${encrypted ? `    // Trust exactly the certificate saved from Konjugate's Settings › Push service.
    std::ifstream file("${certificateFile}");
    std::stringstream certificate;
    certificate << file.rdbuf();
    grpc::SslCredentialsOptions options;
    options.pem_root_certs = certificate.str();
    auto stub = ReadingPush::NewStub(grpc::CreateChannel("${target}", grpc::SslCredentials(options)));`
        : `    auto stub = ReadingPush::NewStub(grpc::CreateChannel("${target}", grpc::InsecureChannelCredentials()));`}
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
    if (state.encrypted) {
        const where = (state.addresses ?? []).filter((address) => !address.includes(':'));
        const at = where.length ? ` at ${where.join(', ')}` : '';
        return `Listening on the network, encrypted${at}: port ${state.port} for HTTPS and secure WebSockets, ${state.grpcPort} for gRPC over TLS. ${plural(state.clients ?? 0, 'client')}${rate}.${unclaimed}`;
    }
    return `Listening on ${state.host}:${state.port} (HTTP and WebSocket) and ${state.host}:${state.grpcPort} (gRPC): ${plural(state.clients ?? 0, 'client')}${rate}.${unclaimed}`;
}

export class ConnectionsPanel {
    #api;
    #confirm;
    #copy;
    #state = { listening: false };
    #keys = [];
    #madeKey = null;
    #proto = '';
    #examplesShown = null;
    #certificate = null; // what is said about the certificate the service uses on the network, once asked for

    // page: Settings › Push service, the element holding the panel. api: window.engine.pushService. confirm(message): asks before stopping
    // a service a twin follows. copy(text): puts text on the clipboard.
    constructor({ page, api, confirm = (message) => window.confirm(message), copy = (text) => navigator.clipboard.writeText(text) }) {
        this.#api = api;
        this.#confirm = confirm;
        this.#copy = copy;
        const find = (id) => page.querySelector(`#${id}`);
        this.parts = {
            port: find('pushServicePort'), grpcPort: find('pushServiceGrpcPort'), toggle: find('pushServiceToggle'), state: find('pushServiceState'),
            log: find('pushServiceLog'), keys: find('pushKeys'), keyName: find('pushKeyName'), keySignals: find('pushKeySignals'), keyAdd: find('pushKeyAdd'),
            made: find('pushKeyMade'), madeValue: find('pushKeyMadeValue'), madeCopy: find('pushKeyCopy'), keyStatus: find('pushKeyStatus'),
            examples: find('pushExamples'), saveDemo: find('pushSaveDemoScripts'), saveDemoStatus: find('pushSaveDemoStatus'),
            network: find('pushServiceNetwork'), certificate: find('pushCertificate'), certificateText: find('pushCertificateText'),
            certificateSave: find('pushCertificateSave'), certificateChoose: find('pushCertificateChoose'), certificateKonjugate: find('pushCertificateKonjugate'),
            certificateStatus: find('pushCertificateStatus')
        };
        const { port, toggle, keyAdd, madeCopy, examples, network, certificateSave, certificateChoose, certificateKonjugate } = this.parts;
        network.addEventListener('change', () => this.#showNetwork());
        this.parts.saveDemo.addEventListener('click', async () => {
            try {
                const folder = await this.#api.saveDemoScripts();
                if (folder) this.parts.saveDemoStatus.textContent = `Saved pushTankRig.py and simulatedTankRig.py in ${folder}. Run the command under Try it from there.`;
            } catch (error) {
                this.parts.saveDemoStatus.textContent = String(error.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
            }
        });
        certificateSave.addEventListener('click', () => this.#certificateAction(() => this.#api.saveCertificate(), (path) => (path ? `Saved to ${path}. Give that file to the scripts that will send readings.` : '')));
        certificateChoose.addEventListener('click', () => this.#certificateAction(() => this.#api.chooseCertificate(), (info) => (info ? 'Your own certificate is used from the next start.' : ''), true));
        certificateKonjugate.addEventListener('click', () => this.#certificateAction(() => this.#api.useKonjugateCertificate(), () => 'Konjugate\'s own certificate is used from the next start.', true));
        port.addEventListener('input', () => { this.#renderPorts(); this.#renderExamples(); });
        toggle.addEventListener('click', () => this.#toggle());
        keyAdd.addEventListener('click', () => this.#addKey());
        madeCopy.addEventListener('click', () => this.#copy(this.#madeKey ?? ''));
        examples.addEventListener('click', (event) => {
            const button = event.target.closest('[data-copy]');
            if (!button) return;
            // In the summary, so it must not also open or close the example.
            event.preventDefault();
            this.#copy(button.closest('details').querySelector('code').textContent);
        });
        api.onState((state) => this.render(state));
    }

    // The page is shown: the service's state and keys, as they are now.
    async show() {
        if (!this.#proto) this.#proto = await this.#api.proto().catch(() => '');
        this.render(await this.#api.state());
        await this.#refreshKeys();
    }

    // The page is left, or Settings closed: a key is shown once, so it is put away.
    hidden() {
        this.#madeKey = null;
        this.parts.made.hidden = true;
        this.#renderExamples();
    }

    render(state) {
        this.#state = state;
        const { port, toggle, state: line, log } = this.parts;
        if (!port.value) port.value = String(state.port ?? state.defaultPort ?? 8737);
        port.disabled = state.listening;
        this.parts.network.disabled = state.listening;
        if (state.listening) this.parts.network.checked = Boolean(state.encrypted);
        if (state.certificate) this.#certificate = state.certificate;
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
        this.#renderCertificate();
        this.#renderKeys();
        this.#renderExamples();
    }

    // On the network: the certificate is shown (and made, the first time), so it can be saved for the scripts before starting.
    async #showNetwork() {
        if (this.parts.network.checked && !this.#certificate) {
            try {
                this.#certificate = await this.#api.certificate();
            } catch (error) {
                this.parts.certificateStatus.textContent = String(error.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
            }
        }
        this.#renderPorts();
        this.#renderCertificate();
        this.#renderExamples();
    }

    #renderCertificate() {
        const { certificate, certificateText, certificateKonjugate } = this.parts;
        const shown = this.parts.network.checked && this.#certificate;
        certificate.hidden = !shown;
        if (!shown) return;
        const info = this.#certificate;
        // Each name or address once, without this computer's own loopback ones (in any of the forms they are written in).
        const loopback = (name) => name === 'localhost' || /^127\./.test(name) || /^(0+:){7}0*1$|^::1$/i.test(name);
        const names = [...new Set(info.names.filter((name) => !loopback(name)))].join(', ');
        certificateText.textContent = `${info.own ? 'Your own certificate' : 'Konjugate\'s own certificate'}${names ? `, for ${names}` : ''}, until ${new Date(info.notAfter).toLocaleDateString()}. SHA-256 fingerprint: ${info.fingerprint}`;
        certificateKonjugate.hidden = !info.own;
    }

    async #certificateAction(action, said, replaces = false) {
        const { certificateStatus } = this.parts;
        certificateStatus.textContent = '';
        try {
            const result = await action();
            if (replaces && result) this.#certificate = result;
            certificateStatus.textContent = said(result);
            this.#renderCertificate();
        } catch (error) {
            certificateStatus.textContent = String(error.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
        }
    }

    #chosenPort() {
        const value = Number(this.parts.port.value);
        return Number.isInteger(value) && value > 0 && value < 65535 ? value : null;
    }

    #renderPorts() {
        const port = this.#state.listening ? this.#state.port : this.#chosenPort();
        const encrypted = this.#state.listening ? this.#state.encrypted : this.parts.network.checked;
        this.parts.grpcPort.textContent = port ? `${encrypted ? 'HTTPS here, gRPC over TLS' : 'gRPC'} on ${this.#state.listening ? this.#state.grpcPort : port + 1}` : 'A port is a whole number from 1 to 65534.';
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
                const network = this.parts.network.checked;
                if (network && !this.#confirm('Listen on the network? Any computer that can reach this one can then connect to the push service. Only a script with a key can send readings, only the signals its key allows, and everything is encrypted. Stop it when you are done.')) return;
                this.render(await this.#api.start(port, network));
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
            row.className = `settingsItem connectionsKey${key.revoked ? ' revoked' : ''}`;
            row.dataset.key = key.name;
            const used = lastUsed[key.name] ? `last used ${new Date(lastUsed[key.name]).toLocaleTimeString()}` : 'not used since the service started';
            row.innerHTML = `<span class="settingsItemText"><strong class="settingsItemLabel">${escapeHtml(key.name)}</strong><small class="settingsItemHint">${escapeHtml(key.signals.join(', '))}</small><small class="settingsItemHint">${key.revoked ? 'Revoked' : escapeHtml(used[0].toUpperCase() + used.slice(1))}</small></span>`
                + (key.revoked ? '' : '<span class="settingsItemControl"><button class="settingsButton danger" type="button" data-revoke>Revoke</button></span>');
            row.querySelector('[data-revoke]')?.addEventListener('click', async () => {
                if (!this.#confirm(`Revoke the key "${key.name}"? A script using it is refused from its next message.`)) return;
                await this.#api.keys.revoke(key.name);
                await this.#refreshKeys();
            });
            return row;
        }));
        if (!this.#keys.length) this.parts.keys.innerHTML = '<div class="settingsItem settingsEmpty">No keys yet. Make one below for each rig or script.</div>';
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
        const encrypted = this.#state.listening ? Boolean(this.#state.encrypted) : this.parts.network.checked;
        // On the network, the address a script on another computer uses: this computer's first IPv4 address the certificate is for.
        const host = encrypted ? ((this.#state.addresses ?? []).find((address) => !address.includes(':')) ?? this.#certificate?.names.find((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name) && name !== '127.0.0.1') ?? 'this-computer') : '127.0.0.1';
        const settings = { host, port, grpcPort, encrypted, key: this.#madeKey ?? 'YOUR_KEY', signal: newest?.signals[0] ?? 'vesselTemperature' };
        // Drawn again only when something they show has changed, not at every change of the rate or the clients.
        const shown = JSON.stringify({ ...settings, proto: this.#proto.length });
        if (shown === this.#examplesShown) return;
        this.#examplesShown = shown;
        const examples = pushExamples(settings);
        const open = new Set([...this.parts.examples.querySelectorAll('details[open]')].map((details) => details.dataset.example));
        // In the order of the groups, so each group's heading appears once.
        const groups = ['Try', 'JSON', 'Protobuf', 'gRPC'];
        const sections = [
            ...examples.map((example) => ({ ...example, group: example.id === 'rig' ? 'Try' : ['python', 'javascript', 'curl'].includes(example.id) ? 'JSON' : example.id === 'protobuf' ? 'Protobuf' : 'gRPC' })),
            { id: 'proto', title: 'pushReadings.proto', code: this.#proto || 'The message definition could not be read.', group: 'Protobuf' }
        ].map((section, index) => ({ section, index }))
            .sort((a, b) => groups.indexOf(a.section.group) - groups.indexOf(b.section.group) || a.index - b.index)
            .map(({ section }) => section);
        let lastGroup = null;
        this.parts.examples.replaceChildren(...sections.flatMap((section) => {
            const parts = [];
            if (section.group !== lastGroup) {
                lastGroup = section.group;
                const heading = document.createElement('h4');
                heading.textContent = { Try: 'Try it', JSON: 'As JSON', Protobuf: 'As protobuf (generate the code from the .proto)', gRPC: 'Over gRPC (a stream, for heavy feeds or other languages)' }[section.group];
                parts.push(heading);
            }
            const details = document.createElement('details');
            details.className = 'connectionsExample';
            details.dataset.example = section.id;
            details.open = open.has(section.id) || (open.size === 0 && section.id === 'python');
            details.innerHTML = `<summary>${escapeHtml(section.title)}<button class="settingsButton" type="button" data-copy>Copy</button></summary><pre><code>${escapeHtml(section.code)}</code></pre>`;
            parts.push(details);
            return parts;
        }));
    }
}
