/* Copyright © 2026 Zenin Easa Panthakkalakath */

// `konjugate --cli serve`: the push service for a lab computer with no screen (docs/proposals/pushService.md, "Where it runs"). It
// runs the same PushService as the app, in the foreground, printing the addresses, each client as it connects, and the rate. With no
// live twin in this process, what arrives is written to a Konjugate data log as it comes, which a Konjugate elsewhere can follow
// while it grows (a shared folder) or replay later. The keys are the app's own, managed here with `serve keys`.
//
//   konjugate --cli serve [--port 8737] [--grpc-port 8738] [--record <file.csv>] [--inputs a,b]
//                         [--network [--certificate <file.pem> --private-key <file.pem>]]
//
// --network listens on every interface, encrypted, with Konjugate's own certificate (made the first time, kept with the keys) or
// the one given; it prints the certificate's fingerprint and where its file is, to give to the scripts that will trust it.
//   konjugate --cli serve keys list
//   konjugate --cli serve keys add <name> --signals a,b
//   konjugate --cli serve keys revoke <name>

import { join, resolve } from 'node:path';
import { parseCliFlags } from './cliArgs.mjs';
import { DataLogWriter } from './dataLogWriter.mjs';
import { PushKeyStore } from './pushKeyStore.mjs';
import { PushService, defaultPushPort } from './pushService.mjs';
import { ensurePushCertificate, networkAddresses, readOwnCertificate } from './pushCertificate.mjs';

export const pushCliUsage = 'Usage: konjugate --cli serve [--port <port>] [--grpc-port <port>] [--record <file.csv>] [--inputs <signal,...>]\n'
    + '                         [--network [--certificate <file.pem> --private-key <file.pem>]]\n'
    + '       konjugate --cli serve keys list\n'
    + '       konjugate --cli serve keys add <name> --signals <signal,...>\n'
    + '       konjugate --cli serve keys revoke <name>';

const list = (text) => String(text ?? '').split(',').map((item) => item.trim()).filter(Boolean);
const stamp = (milliseconds) => new Date(milliseconds).toISOString().replace(/[:.]/g, '-');

// Until Ctrl+C, or the process is told to stop.
const untilStopped = () => new Promise((done) => {
    const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); done(); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
});

// Runs a `serve` command; answers the exit code. directory: where the app keeps its keys. untilStop: resolves when serving should
// end (Ctrl+C by default). cwd: where a recording goes when no --record is given.
export async function runPushCli(args, { directory, out = console.log, err = console.error, untilStop = untilStopped, now = () => Date.now(), cwd = process.cwd(), statusEveryMilliseconds = 10000 }) {
    const keys = new PushKeyStore(directory);
    const [first, second, ...rest] = args;
    try {
        if (first === 'keys') return await runKeysCommand(keys, second, rest, { out, err });
        if (first && !first.startsWith('--')) {
            err(pushCliUsage);
            return 2;
        }
        return await serve(keys, parseCliFlags(args), { out, err, untilStop, now, cwd, statusEveryMilliseconds });
    } catch (error) {
        err(error.message);
        return 1;
    }
}

async function runKeysCommand(keys, command, rest, { out, err }) {
    if (command === 'list') {
        const all = await keys.list();
        if (!all.length) out('No keys yet. Make one with: konjugate --cli serve keys add <name> --signals <signal,...>');
        for (const key of all) out(`${key.name}${key.revoked ? ' (revoked)' : ''}: may send ${key.signals.join(', ')}; made ${new Date(key.created).toISOString()}`);
        return 0;
    }
    if (command === 'add') {
        const [name, ...flagArgs] = rest;
        const flags = parseCliFlags(flagArgs);
        if (!name || name.startsWith('--')) {
            err(pushCliUsage);
            return 2;
        }
        const { key, record } = await keys.add(name, list(flags.signals));
        out(`Made the key "${record.name}", which may send ${record.signals.join(', ')}:`);
        out('');
        out(`    ${key}`);
        out('');
        out('It is shown this once and kept only as a hash: copy it into the script now.');
        return 0;
    }
    if (command === 'revoke') {
        const [name] = rest;
        if (!name) {
            err(pushCliUsage);
            return 2;
        }
        await keys.revoke(name);
        out(`Revoked the key "${name}": it stops working at once.`);
        return 0;
    }
    err(pushCliUsage);
    return 2;
}

async function serve(keys, flags, { out, err, untilStop, now, cwd, statusEveryMilliseconds }) {
    const port = flags.port === undefined ? defaultPushPort : Number(flags.port);
    const grpcPort = flags['grpc-port'] === undefined ? (port === 0 ? 0 : port + 1) : Number(flags['grpc-port']);
    if (![port, grpcPort].every((value) => Number.isInteger(value) && value >= 0 && value < 65536)) {
        err('--port and --grpc-port are port numbers.');
        return 2;
    }
    const live = (await keys.list()).filter((key) => !key.revoked);
    if (!live.length) {
        err('There are no keys, so no script could send anything. Make one first: konjugate --cli serve keys add <name> --signals <signal,...>');
        return 1;
    }
    // What the keys may send now; a signal given to a key made while serving is taken but not recorded (said at the end).
    const names = [...new Set(live.flatMap((key) => key.signals))];
    const inputs = new Set(list(flags.inputs));
    const unknownInput = [...inputs].find((name) => !names.includes(name));
    if (unknownInput) {
        err(`No key may send "${unknownInput}", so it cannot be an input. The keys may send ${names.join(', ')}.`);
        return 2;
    }
    if ((flags.certificate || flags['private-key']) && !flags.network) {
        err('A certificate is for listening on the network: add --network.');
        return 2;
    }
    if (Boolean(flags.certificate) !== Boolean(flags['private-key'])) {
        err('Give both the certificate and its private key: --certificate <file.pem> --private-key <file.pem>.');
        return 2;
    }
    const tls = !flags.network ? null : flags.certificate
        ? await readOwnCertificate(resolve(cwd, String(flags.certificate)), resolve(cwd, String(flags['private-key'])))
        : await ensurePushCertificate(keys.directory);
    const epoch = Math.floor(now() / 1000) * 1000;
    const recordTo = resolve(cwd, typeof flags.record === 'string' ? flags.record : join(cwd, `pushed ${stamp(epoch)}.csv`));
    const signals = names.map((name) => ({ name, unit: '', role: inputs.has(name) ? 'input' : 'output' }));
    const writer = await DataLogWriter.create(recordTo, { source: 'Konjugate push service', epoch, signals });
    let unrecorded = 0;
    const recorded = new Set(names);
    const service = new PushService({
        keyStore: keys,
        deliver: (readings) => {
            const observations = readings.filter((reading) => recorded.has(reading.signal))
                .map((reading) => ({ time: reading.time - epoch / 1000, signal: reading.signal, value: reading.value, quality: reading.quality }));
            unrecorded += readings.length - observations.length;
            return writer.append(observations);
        },
        log: out,
        now
    });
    let status;
    try {
        status = await service.start({ port, grpcPort, ...(tls ? { host: '0.0.0.0', tls } : {}) });
    } catch (error) {
        await writer.close();
        throw new Error(`Could not listen: ${error.message}`);
    }
    if (tls) {
        const at = networkAddresses().ips.filter((ip) => !ip.includes(':'));
        out(`Listening on the network, encrypted, at ${at.length ? at.join(', ') : 'this computer\'s addresses'}: port ${status.port} for HTTPS and secure WebSockets, ${status.grpcPort} for gRPC over TLS, for ${names.join(', ')}.`);
        out(`Certificate ${tls.path}${tls.made ? ' (made just now)' : ''}, SHA-256 fingerprint ${tls.fingerprint}. Give scripts that file to trust.`);
        out(`To try it from another computer: python3 examples/dataSources/pushTankRig.py https://${at[0] ?? '<this computer>'}:${status.port} --key <key> --certificate <that file> --speed 600`);
    } else {
        out(`Listening on ${status.host}:${status.port} (HTTP and WebSocket) and ${status.host}:${status.grpcPort} (gRPC), for ${names.join(', ')}.`);
    }
    out(`Recording to ${recordTo}. Press Ctrl+C to stop.`);
    let lastTaken = 0;
    const timer = setInterval(() => {
        const current = service.status();
        if (current.taken === lastTaken) return;
        lastTaken = current.taken;
        out(`${current.taken} readings so far, ${current.readingsPerSecond.toFixed(1)} a second, ${current.clients} client${current.clients === 1 ? '' : 's'}.`);
    }, statusEveryMilliseconds);
    timer.unref?.();
    await untilStop();
    clearInterval(timer);
    const final = service.status();
    await service.stop();
    await writer.close();
    out(`Stopped. ${final.taken} readings taken${unrecorded ? `, ${unrecorded} of them for signals not recorded (given to a key made while serving)` : ''}${writer.late ? `, ${writer.late} too late to write in order` : ''}; recorded in ${recordTo}.`);
    return 0;
}
