---
type: Proposal
title: "The push service"
description: Design for the fallback in digital twin connections, a service in Konjugate that a lab's own script sends readings to when it has no file, broker or OPC UA server to put them in, and how those readings reach a live twin.
tags: [proposals, digital-twin, connections, security, real-time]
status: draft
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# The push service

**Status: proposed, not built.** [Digital twin connections](digitalTwinConnections.md#the-push-service-a-fallback) describes the push service in outline and puts it last: a lab whose instrument script has nowhere to put its numbers can send them to Konjugate itself. This document turns that outline into a design to build from. Every other way into a live twin is a connection Konjugate makes outward, to a file, a broker or an OPC UA server; this is the one place Konjugate listens, so most of what follows is about keeping that safe and plain.

## Who it is for

A lab with a Python or JavaScript script that reads an instrument (a serial thermometer, a balance, a DAQ card) and prints or plots the numbers, with no broker, no historian and no logger writing a file. For that lab the advice stays the same: appending to a file or publishing to a broker takes a few lines and keeps a record without Konjugate. The push service is for when neither is wanted, and for a first trial before either is set up.

## What a script sends

One reading, or many at once, as JSON. The same message works over HTTP and over a WebSocket.

```json
{ "readings": [
    { "signal": "vesselTemperature", "time": "2026-11-07T10:15:02.250Z", "value": 341.2 },
    { "signal": "heaterPower", "time": 1794046502.25, "value": 1200, "quality": "good" }
] }
```

- **`signal`** is a name the key is allowed to send (below). **`value`** is a finite number. **`time`** is an ISO 8601 string or seconds since 1970; it may be left out, and the reading is then stamped when it arrives, which is said in the panel since it folds network delay into the measurement. **`quality`** is `good`, `uncertain` or `bad`, as for every other source, and `good` when left out.
- **HTTP:** `POST /v1/readings` with `Authorization: Bearer <key>`. The answer is `202` with how many readings were taken, `400` with the first thing wrong in the message (a missing value, a time that is not a time), `401` for a key that is unknown or revoked, and `403` naming a signal the key may not send. A message with one bad reading is refused whole, so a script never half-succeeds without knowing.
- **WebSocket:** `GET /v1/stream` upgraded, with the same header. Each text message is one JSON message as above; each is answered with the same status and reason as a JSON message, so a script can log what was refused. Stopping the service closes the socket with code 1001 and the reason.
- **What the panel shows,** for a person to copy: the address, a key, and ten lines of Python (`urllib.request`, no package to install) and of JavaScript (`fetch`) that send one reading.

The contract is JSON, not protobuf, because it faces other people's scripts ([Live engine session](liveEngineSession.md): what faces other people's tools stays as plain as it can be).

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
- **`konjugate serve`**, for a lab computer with no screen, runs the same class in the foreground and prints the address, each client as it connects, and the rate. It manages keys with `konjugate serve keys add <name> --signals a,b`, `list` and `revoke <name>`, using the same store.

No new dependency for the server itself: Node's own `http` and `https`, and the `ws` package already installed through `mqtt` (to be made a direct dependency).

## On the screen

- **A Connections panel,** opened from the live twin card and from the menu, with one Start / Stop switch, the state (stopped, or listening on an address with the number of clients and readings a second), the keys with Add, Revoke and last used, and the examples. Opening a project never starts it.
- **A toolbar chip** while it is on, like the one for a running tuning: "Listening on 127.0.0.1:8737, 2 clients". Clicking it opens the panel.

## Local or on the network

- **Loopback by default** (`127.0.0.1`), which is right when the script runs on the same computer, and needs no encryption since nothing leaves it.
- **On the network** is a separate choice with a warning, and offered only encrypted: keys sent over plain HTTP on a lab network can be read by anyone on it. The service then listens with HTTPS and secure WebSockets, on a certificate Konjugate makes the first time (self-signed, kept in the settings folder, made with the OPC UA certificate manager already installed) or one the person chooses. The panel shows the certificate's fingerprint, and the examples show how a script trusts that certificate rather than turning checking off.
- Every connection is logged with its key's name and address. A key that fails ten times a minute from one address is refused from that address for a minute.

## Stopping

Stop says first if a live twin is reading from the service and asks to confirm. Then it refuses new connections, closes each WebSocket with code 1001 and "Konjugate stopped listening", answers HTTP with `503` and the same reason, flushes the readings already taken to the twin and its recording, and ends the process. Quitting the app stops it the same way.

## Desktop only

A web page cannot listen on a port. The web edition's live twin card does not offer the source, and says so where the other desktop-only sources are listed.

## Order of work

1. **The service and its contract,** with keys: `PushService`, `PushKeyStore`, the message checks, HTTP and WebSocket, and unit tests of every refusal (malformed JSON, a bad time, an unknown key, a signal not granted, a revoked key, the rate limit), plus a test that starts it on a free port, sends from a real HTTP client and a real WebSocket, and stops it cleanly.
2. **The live twin source,** `kind: 'push'`, with its recording, and an engine-backed test like the MQTT one: readings pushed over a minute of model time, the twin's moves the same as replaying the recording it wrote.
3. **The app:** the utility process, the Connections panel, the chip, the source in the live twin card, and interaction tests for starting, adding a key, a twin following pushed readings, and stopping with a twin attached.
4. **`konjugate serve`** and its key commands.
5. **On the network,** with the certificate and its fingerprint.

## Open decisions

1. **The default port.** Proposed 8737, unassigned and easy to say; any port can be chosen.
2. **A reading with no time:** stamped on arrival (proposed, said in the panel) or refused.
3. **Whether step 5 is built** before a lab asks to push from another computer. Proposed: not until then, since loopback covers a script on the same computer and a broker covers the rest.
