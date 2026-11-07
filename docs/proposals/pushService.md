---
type: Proposal
title: "The push service"
description: Design for the fallback in digital twin connections, a service in Konjugate that a lab's own script sends readings to when it has no file, broker or OPC UA server to put them in, and how those readings reach a live twin.
tags: [proposals, digital-twin, connections, security, real-time]
status: draft
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# The push service

**Status: built, steps 1 to 5: the service with HTTP, the WebSocket and gRPC, JSON and protobuf, keys, the live twin source, the app's Connections panel and chip, `konjugate --cli serve` (as `--cli serve`, the app's existing command-line mode), and listening on the network, encrypted, with a demonstration (`examples/dataSources/pushTankRig.py`, the simulated rig sending to the service from any computer).** Step 5 was built before a lab asked for it, so that one is ready when it does. Building it showed: the OPC UA library's certificates are marked for OPC UA's uses and refused by TLS clients for a server, so the certificate is made with `@peculiar/x509` (already installed under that library) as a self-signed certificate that may vouch only for itself (a CA with a path length of 0) and for serving, the form curl, Node and Python accept as a trusted certificate once given the file, Python 3.15's strict checking and the old LibreSSL of macOS's own Python 3.9 included; a certificate not yet valid (the clock set back) is made again, as is one about to run out or no longer naming every address of this computer; and a hostname that is itself an address is left out of the names. The service refuses to listen beyond the loopback address without encryption, whoever asks. Code: `src/pushCertificate.mjs`; tests in `tests/pushService.test.mjs` (the certificate's life, HTTPS, a secure WebSocket and gRPC over TLS, a client that does not trust the certificate refused, plain HTTP not answered), `tests/pushServiceHost.test.mjs`, `tests/pushCli.test.mjs`, `tests/connectionsPanel.test.mjs` (no example turns checking off), `tests/engine/liveTwinPushNetwork.mjs` and the interaction suite. Built as designed, with these findings: a key made while the service runs is known at once, because a key the service does not know makes it read the key file again before refusing (a revocation takes up to half a second); a headless `serve` has no twin to hand readings to, so it records them as a data log, which a Konjugate elsewhere follows as it grows; and a twin whose source stops now keeps saying why, with where its readings were recorded, for every source. Code: `src/pushKeyStore.mjs`, `src/pushGate.mjs`, `src/pushCodecs.mjs`, `src/pushService.mjs`, `src/pushSource.mjs`, `src/pushServiceProcess.mjs`, `src/pushServiceHost.mjs`, `src/pushCli.mjs` and `src/renderer/connectionsPanel.mjs`; tests in `tests/pushService.test.mjs` (every refusal sent all five ways), `tests/pushServiceHost.test.mjs`, `tests/pushCli.test.mjs`, `tests/connectionsPanel.test.mjs`, `tests/engine/liveTwinPush.mjs` and the interaction suite. [Digital twin connections](digitalTwinConnections.md#the-push-service-a-fallback) describes the push service in outline and puts it last: a lab whose instrument script has nowhere to put its numbers can send them to Konjugate itself. This document turns that outline into a design to build from. Every other way into a live twin is a connection Konjugate makes outward, to a file, a broker or an OPC UA server; this is the one place Konjugate listens, so most of what follows is about keeping that safe and plain.

## Who it is for

A lab with a Python or JavaScript script that reads an instrument (a serial thermometer, a balance, a DAQ card) and prints or plots the numbers, with no broker, no historian and no logger writing a file. For that lab the advice stays the same: appending to a file or publishing to a broker takes a few lines and keeps a record without Konjugate. The push service is for when neither is wanted, and for a first trial before either is set up.

## What a script sends

One reading, or many at once, in one of three ways that all carry the same message and give the same answers: JSON over HTTP or a WebSocket, protobuf over the same endpoints, or a gRPC stream. JSON is the default, the one the examples lead with, since a script needs nothing installed to write it; protobuf is for a lab that wants the schema as the contract, or sends at a rate where size matters; gRPC is for a client that streams heavily and wants flow control, or is written in a language (C++, Go, Rust, C#) where generated code is easier than calling HTTP by hand.

```json
{ "readings": [
    { "signal": "vesselTemperature", "time": "2026-11-07T10:15:02.250Z", "value": 341.2 },
    { "signal": "heaterPower", "time": 1794046502.25, "value": 1200, "quality": "good" }
] }
```

- **`signal`** is a name the key is allowed to send (below). **`value`** is a finite number. **`time`** is an ISO 8601 string or seconds since 1970; it may be left out, and the reading is then stamped when it arrives, which is said in the panel since it folds network delay into the measurement. **`quality`** is `good`, `uncertain` or `bad`, as for every other source, and `good` when left out.
- **The protobuf message** is `PushReadings` in `protocol/pushReadings.proto`, beside the engine's own: a repeated `Reading` of `signal` (string), `value` (double), `time` (a `google.protobuf.Timestamp`, left unset to be stamped on arrival) and `quality` (an enum, `GOOD` when unset). It is the same message field for field, so a reading means the same whichever way it came, and the checks below are made once, on the decoded readings, not once for each encoding. Its answer, `PushAnswer`, carries the same status, count and reason as the JSON answer. The `.proto` is published with the examples, so a script in any language can generate its code from it.
- **HTTP:** `POST /v1/readings` with `Authorization: Bearer <key>`, and `Content-Type: application/json` or `application/x-protobuf`; the answer comes in the encoding that was sent. Any other content type is refused with `415`, naming the two. The answer is `202` with how many readings were taken, `400` with the first thing wrong in the message (a missing value, a time that is not a time), `401` for a key that is unknown or revoked, and `403` naming a signal the key may not send. A message with one bad reading is refused whole, so a script never half-succeeds without knowing.
- **WebSocket:** `GET /v1/stream` upgraded, with the same header. Each text frame is one JSON message and each binary frame one protobuf message, so one connection may carry either; each is answered with the same status and reason in the encoding it came in, so a script can log what was refused. Stopping the service closes the socket with code 1001 and the reason.
- **gRPC:** the same `.proto` defines `service ReadingPush { rpc Push(stream PushReadings) returns (stream PushAnswer); rpc Check(CheckRequest) returns (CheckAnswer); }`, served on its own port (HTTP/2; by default the HTTP port plus one). The key is sent as `authorization: Bearer <key>` metadata. `Push` takes a stream of messages and answers each one in order, with HTTP/2's flow control slowing a client that sends faster than the readings are taken, instead of letting them pile up in memory; a refused message is answered in the stream with its reason, and only a bad key ends the call (`UNAUTHENTICATED`, or `PERMISSION_DENIED` for a revoked one). `Check` says whether a key is good and which signals it may send, so a client can find out before it starts. Stopping the service ends each call with `UNAVAILABLE` and the reason. The standard gRPC health service is served too, so the usual tools can see whether it is up.
- **What the panel shows,** for a person to copy: the address, a key, and ten lines of Python (`urllib.request`, no package to install) and of JavaScript (`fetch`) that send one reading as JSON; then, each under its own heading, the `.proto` to save with the command that generates code from it, the same reading sent as protobuf, and a short gRPC client in Python and in C++ streaming readings. JSON comes first, so a person who needs nothing more stops reading there.

JSON leads because the service faces other people's scripts ([Live engine session](liveEngineSession.md): what faces other people's tools stays as plain as it can be), and a script needs nothing installed to write it, can be tried with `curl`, and can be read in a log. Protobuf is offered beside it because it costs Konjugate almost nothing (the app already decodes the engine's messages with `protobufjs`) and gives a lab that wants it a typed contract and smaller messages. gRPC is offered from the start, though no lab has asked for it, for what HTTP and a WebSocket lack: flow control for a heavy stream, a defined way to answer and fail each message instead of a small protocol of our own, a service definition from which clients in any language are generated, and the standard health check. What it costs is a second port, a library in the app and a second listener to encrypt on the network; none of it reaches a person who uses JSON.

## Keys

- A key belongs to one rig or script, has a name the person gives it ("vessel rig", "Lisa's balance script") and the list of signals it may send, and is revoked on its own.
- It is 32 random bytes, shown once when it is made, with a copy button. Konjugate keeps only its SHA-256 hash, its name, its signals and when it was last used, in the app's own settings folder. None of it goes in a project file, so sharing a project never shares a key, and a key that was never stored cannot leak from the keychain or the settings.
- A key's signals are names, not a live twin's mapping: one script can feed whichever twin is listening for those names.

## Reaching a live twin

A live twin gains a fifth source, `{ kind: 'push', signals, recordTo }`, beside the file, the recording, MQTT and OPC UA ([liveTwinHost.mjs](../../src/liveTwinHost.mjs)). It follows the same shape as `followMqtt`: a header made at once from the signals the twin maps, then batches of observations in time order, gathered for a few milliseconds so a burst becomes one batch. What arrives is also written to a data log at `recordTo`, like a broker's, since nothing else keeps it. Readings for signals no twin is listening to are taken (the script is not told off for running before the twin) and counted in the panel, not kept.

Choosing the source in the live twin card lists the signals the service's keys may send, so the mapping is chosen from names that can arrive.

## Where it runs

One `PushService` class in a Node module (`src/pushService.mjs`) with `start({ host, port, tls })`, `stop(reason)` and `status()`, reading keys from a `PushKeyStore`. Two front ends use it:

- **The app** starts it in its own process (Electron's `utilityProcess`), not in the main process, so a flood of messages cannot stall the windows, and watches it: if it ends, the chip turns red and says why, and a twin reading from it stops with that reason. Readings reach the main process over the process's message port and go from there to the live twin host.
- **`konjugate --cli serve`**, for a lab computer with no screen, runs the same class in the foreground and prints the address, each client as it connects, and the rate. It manages keys with `konjugate --cli serve keys add <name> --signals a,b`, `list` and `revoke <name>`, using the same store. With no twin in its process, it writes what arrives to a data log.

For the server: Node's own `http` and `https`, the `ws` package already installed through `mqtt` (to be made a direct dependency), `protobufjs`, already used for the engine's messages, and one new dependency, `@grpc/grpc-js` (pure JavaScript, no native build), with the `.proto` loaded by `@grpc/proto-loader`. Inside, three front ends (HTTP, WebSocket, gRPC) and a `PushCodec` for each encoding turn what arrives into readings; all three then call the same `PushGate`, which checks the key, the signals it may send and the readings, and hands them on. So there is one place where access is decided and one set of checks, whichever way a reading came, and a front end only translates.

## On the screen

- **A Connections panel,** opened from the live twin card and from the menu, with one Start / Stop switch, the state (stopped, or listening on an address with the number of clients and readings a second), the keys with Add, Revoke and last used, and the examples. Opening a project never starts it.
- **A toolbar chip** while it is on, like the one for a running tuning: "Listening on 127.0.0.1:8737, 2 clients" (the clients of every front end together; the panel shows both ports and the clients of each). Clicking it opens the panel.

## Local or on the network

- **Loopback by default** (`127.0.0.1`), which is right when the script runs on the same computer, and needs no encryption since nothing leaves it.
- **On the network** is a separate choice with a warning, and offered only encrypted: keys sent over plain HTTP on a lab network can be read by anyone on it. The service then listens with HTTPS, secure WebSockets and gRPC over TLS, all on one certificate Konjugate makes the first time (self-signed, kept in the settings folder with its key readable by this user only, made with `@peculiar/x509`, as the status above explains) or one the person chooses. The panel shows the certificate's fingerprint, and the examples show how a script trusts that certificate rather than turning checking off.
- Every connection is logged with its key's name and address. A key that fails ten times a minute from one address is refused from that address for a minute.

## Stopping

Stop says first if a live twin is reading from the service and asks to confirm. Then it refuses new connections, closes each WebSocket with code 1001 and "Konjugate stopped listening", answers HTTP with `503` and the same reason, flushes the readings already taken to the twin and its recording, and ends the process. Quitting the app stops it the same way.

## Desktop only

A web page cannot listen on a port. The web edition's live twin card does not offer the source, and says so where the other desktop-only sources are listed.

## Order of work

1. **The service and its contract,** with keys: `PushService`, `PushKeyStore`, `PushGate`, the two codecs and `protocol/pushReadings.proto` with its messages and the `ReadingPush` service, and the HTTP, WebSocket and gRPC front ends. Unit tests of every refusal (malformed JSON, a protobuf body that does not decode, an unsupported content type, a bad time, an unknown key, a signal not granted, a revoked key, the rate limit), written once and run against each front end, so the three are held to the same answers; a test that the same readings are taken identically whichever way they came; a test that a gRPC client sending faster than the readings are taken is slowed rather than buffered without limit; and a test that starts the service on free ports, sends from a real HTTP client, a real WebSocket in both encodings and a real gRPC client, and stops it cleanly, each client told why.
2. **The live twin source,** `kind: 'push'`, with its recording, and an engine-backed test like the MQTT one: readings pushed over a minute of model time, the twin's moves the same as replaying the recording it wrote.
3. **The app:** the utility process, the Connections panel, the chip, the source in the live twin card, and interaction tests for starting, adding a key, a twin following pushed readings, and stopping with a twin attached.
4. **`konjugate --cli serve`** and its key commands.
5. **On the network,** with the certificate and its fingerprint. **Built**, with the demonstration: `examples/dataSources/pushTankRig.py` sends the simulated rig's readings to the service over HTTPS, trusting the saved certificate, and [tests/engine/liveTwinPushNetwork.mjs](../../tests/engine/liveTwinPushNetwork.mjs) runs it against this computer's network address and checks the live twin's moves against the rig's own log, to the bit.

## Open decisions

1. **The default ports.** Proposed 8737 for HTTP and the WebSocket and 8738 for gRPC, unassigned and easy to say; any can be chosen.
2. **A reading with no time:** stamped on arrival (proposed, said in the panel) or refused.
3. **Whether step 5 is built** before a lab asks to push from another computer. Decided: built now, so that one is ready when a lab asks, with a demonstration anyone can run.
