/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A stand-in for src/engineSession.mjs's EngineSession, for unit tests of what drives a long-lived session (src/windowSession.mjs)
// without a built engine. It answers the same commands with replies of the same shape (see the top of engineSession.mjs), running a
// model the test gives as plain functions: each state's derivative, stepped by explicit Euler at the configuration's time step,
// and the states the model computes from others. Inputs hold their last sample, as a hold schedule does; a parameter with no input
// takes its value from the document unless a setParameterValue command changed it. Checkpoints are kept at time 0 and, when an
// advance asks for them, at every multiple of the checkpoint interval it passes.
//
//   const engines = installFakeEngine(t, { derivatives: { 2: ({ input }) => input(20) }, computed: { 3: (state) => 2 * state(2) } });
//   ... new WindowSession(...) ...           every EngineSession.start in the test now starts a FakeEngine, kept in `engines`
//   engines.crash = (engine, commands) => true   the next run fails as a dead process does (EngineSessionError, alive false)
//
// The real EngineSession.start is restored when the test ends (t.mock).

import { EngineSession, EngineSessionError } from '../../src/engineSession.mjs';

const near = (a, b) => Math.abs(a - b) < 1e-9;
const roundTime = (time) => Math.round(time * 1e9) / 1e9;

export class FakeEngine {
    alive = true;
    closed = false;
    batches = []; // every command list given to run/send, in order

    constructor(document, configuration, { derivatives = {}, computed = {} } = {}, controls = {}) {
        this.document = document;
        this.configuration = configuration;
        this.controls = controls;
        this.derivatives = derivatives;
        this.computed = computed;
        const states = document.nodes.flatMap((node) => node.states ?? []);
        this.stateIds = states.map((state) => state.id);
        this.algebraicStateIds = Object.keys(computed).map(Number).filter((stateId) => this.stateIds.includes(stateId));
        // What this engine says it can do beyond the protocol's first version: nothing, unless a test says so (it follows no state).
        this.features = [];
        this.reportedStateIds = configuration.reportedStateIds ?? this.stateIds;
        this.parameters = new Map([
            ...(document.sharedParameters ?? []),
            ...(document.edges ?? []).flatMap((edge) => edge.parameters ?? []),
            ...document.nodes.flatMap((node) => (node.sourceTerms ?? []).flatMap((term) => term.parameters ?? []))
        ].map((parameter) => [parameter.id, Number(parameter.value ?? 0)]));
        this.values = states.map((state) => Number(state.initialValue ?? 0));
        this.time = 0;
        this.inputs = new Map(); // parameterId -> [{ time, value }] in time order
        this.#settle();
        this.checkpoints = new Map([[0, [...this.values]]]);
    }

    #get = (stateId) => this.values[this.stateIds.indexOf(stateId)];

    // As the engine's held piecewise schedule (engine/src/executionPlan.cpp): the reading in force, and before the first, the first.
    #input(parameterId, time) {
        const samples = this.inputs.get(parameterId) ?? [];
        if (!samples.length) return this.parameters.get(parameterId) ?? 0;
        return (samples.filter((sample) => sample.time <= time + 1e-9).at(-1) ?? samples[0]).value;
    }

    // The computed states, from the others.
    #settle() {
        for (const stateId of this.algebraicStateIds) this.values[this.stateIds.indexOf(stateId)] = this.computed[stateId](this.#get);
    }

    #step(timeStep) {
        const at = this.time;
        const context = { state: this.#get, input: (parameterId) => this.#input(parameterId, at), parameter: (parameterId) => this.parameters.get(parameterId), time: at };
        const rates = this.stateIds.map((stateId) => (this.algebraicStateIds.includes(stateId) ? 0 : (this.derivatives[stateId]?.(context) ?? 0)));
        this.values = this.values.map((value, index) => value + timeStep * rates[index]);
        this.#settle();
        this.time = roundTime(this.time + timeStep);
    }

    #reply(command, extra = {}) {
        return { ok: true, type: command.type, time: this.time, values: [], samples: [], checkpointsTaken: 0, computeNanoseconds: 1000, providerStates: [], ...extra };
    }

    #carryOut(command) {
        switch (command.type) {
            case 'advanceTo': {
                const timeStep = this.configuration.globalTimeStep;
                const interval = this.configuration.checkpointInterval;
                const samples = [];
                let checkpointsTaken = 0;
                while (this.time < command.time - 1e-9) {
                    this.#step(timeStep);
                    samples.push({ time: this.time, values: this.reportedStateIds.map(this.#get) });
                    if (command.takeCheckpoints && interval > 0 && near(this.time / interval, Math.round(this.time / interval))) {
                        this.checkpoints.set(this.time, [...this.values]);
                        checkpointsTaken += 1;
                    }
                }
                if (command.discardSamples) return this.#reply(command, { checkpointsTaken });
                // As EngineSession keeps them: every n-th as they arrive, and always the last.
                const every = Number.isInteger(command.keepEvery) && command.keepEvery > 1 ? command.keepEvery : 1;
                const kept = samples.filter((_, index) => index % every === 0);
                if (samples.length && kept.at(-1) !== samples.at(-1)) kept.push(samples.at(-1));
                return this.#reply(command, { samples: kept, checkpointsTaken });
            }
            case 'restoreCheckpoint': {
                const found = [...this.checkpoints.keys()].find((time) => near(time, command.time));
                if (found === undefined) return { ok: false, type: command.type, message: `No checkpoint at ${command.time} s.`, time: this.time, values: [], samples: [], checkpointsTaken: 0, computeNanoseconds: 0 };
                this.values = [...this.checkpoints.get(found)];
                this.time = found;
                for (const { stateId, value } of command.overrides ?? []) this.values[this.stateIds.indexOf(stateId)] = value;
                this.#settle();
                return this.#reply(command, { values: [...this.values] });
            }
            case 'restoreState':
                this.values = [...command.values];
                this.time = command.time;
                this.#settle();
                return this.#reply(command, { values: [...this.values], providerStates: command.providerStates ?? [] });
            // As Simulation::appendInputSamples (engine/src/simulationRunner.cpp): with replaceFrom, the readings kept at or after it go
            // first; what is left must come before what arrives.
            case 'appendInputSamples': {
                let kept = this.inputs.get(command.parameterId) ?? [];
                if (command.replaceFrom !== undefined) kept = kept.filter((sample) => sample.time < command.replaceFrom);
                if (kept.length && command.samples.length && !(command.samples[0].time > kept.at(-1).time)) {
                    return { ok: false, type: command.type, message: 'Input readings must come in time order; a corrected reading is sent with replace.', time: this.time, values: [], samples: [], checkpointsTaken: 0, computeNanoseconds: 0 };
                }
                this.inputs.set(command.parameterId, [...kept, ...command.samples]);
                return this.#reply(command);
            }
            case 'setParameterValue':
                this.parameters.set(command.parameterId, command.value);
                return this.#reply(command);
            // As Simulation::retainFrom: the checkpoints before the time go, and every input reading before it but the last.
            case 'retainCheckpointsFrom':
                for (const time of [...this.checkpoints.keys()]) if (time < command.time - 1e-9) this.checkpoints.delete(time);
                for (const [parameterId, samples] of this.inputs) {
                    const firstKept = samples.findIndex((sample) => sample.time > command.time);
                    const from = (firstKept < 0 ? samples.length : firstKept) - 1;
                    if (from > 0) this.inputs.set(parameterId, samples.slice(from));
                }
                return this.#reply(command);
            default:
                return { ok: false, type: command.type, message: `Unknown command ${command.type}.`, time: this.time, values: [], samples: [], checkpointsTaken: 0, computeNanoseconds: 0 };
        }
    }

    async send(commands) {
        if (!this.alive) throw new EngineSessionError('The engine session has stopped.');
        this.batches.push(commands);
        if (this.controls.crash?.(this, commands)) {
            this.controls.crash = null;
            this.alive = false;
            throw new EngineSessionError('The engine session stopped (SIGKILL).');
        }
        const replies = [];
        for (const command of commands) {
            const reply = this.#carryOut(command);
            replies.push(reply);
            if (!reply.ok) break; // the rest of a batch is not carried out once one fails
        }
        return replies;
    }

    async run(commands) {
        const replies = await this.send(commands);
        const failed = replies.find((reply) => !reply.ok);
        if (failed) throw new EngineSessionError(failed.message, failed);
        return replies;
    }

    advanceTo(time, { takeCheckpoints = false, keepEvery = 1 } = {}) { return this.run([{ type: 'advanceTo', time, takeCheckpoints, keepEvery }]).then(([reply]) => reply); }
    appendInputs(parameterId, samples, replaceFrom) { return this.run([{ type: 'appendInputSamples', parameterId, samples, replaceFrom }]).then(([reply]) => reply); }

    async close() {
        this.alive = false;
        this.closed = true;
    }
}

// Makes EngineSession.start start a FakeEngine for the rest of the test. Returns the list of engines started, which also holds
// `crash`, a function of (engine, commands) consulted before each run: returning true kills that engine there.
export function installFakeEngine(t, model = {}) {
    const engines = [];
    t.mock.method(EngineSession, 'start', async (content, configuration) => {
        const engine = new FakeEngine(JSON.parse(content), configuration, model, engines);
        engines.push(engine);
        return engine;
    });
    return engines;
}
