/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The Parameter tuning card's setup, kept with the project (`tuningSetup`, docs/projectSchema.md) so a tuning can be opened again and run
// again after the model changes, instead of being set up from nothing each time. Like add-on data it sits beside the model, not in it:
// it is written when the project is saved and read when it is opened, and never reaches the engine, validation or the undo history.
// What a person typed is checked here on the way in, since a project file can be edited by hand; anything unusable is dropped, never thrown.

const directions = ['minimise', 'maximise'];
const goals = ['data', 'objective', 'replay'];

const finitePositive = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);

// The setup a project file carries, made safe to use, or null when it carries none.
export function normalizeTuningSetup(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const goal = goals.includes(raw.goal) ? raw.goal : 'data';
    const setup = { version: 1, goal };
    if (typeof raw.backend === 'string' && raw.backend) setup.backend = raw.backend;
    const maxSimulations = finitePositive(raw.maxSimulations);
    if (maxSimulations) setup.maxSimulations = Math.round(maxSimulations);
    const maxMinutes = finitePositive(raw.maxMinutes);
    if (maxMinutes) setup.maxMinutes = maxMinutes;
    if (typeof raw.csvFileName === 'string' && raw.csvFileName) setup.csvFileName = raw.csvFileName;
    const program = normalizeProgram(raw.objective?.program);
    if (goal === 'objective' && raw.objective && typeof raw.objective === 'object' && (typeof raw.objective.expression === 'string' || program)) {
        setup.objective = { expression: typeof raw.objective.expression === 'string' ? raw.objective.expression : '', ...(typeof raw.objective.latex === 'string' && raw.objective.latex ? { latex: raw.objective.latex } : {}), direction: directions.includes(raw.objective.direction) ? raw.objective.direction : 'minimise' };
        if (program) setup.objective.program = program;
        const targetTime = finitePositive(raw.objective.targetTime);
        const timeStep = finitePositive(raw.objective.timeStep);
        if (targetTime) setup.objective.targetTime = targetTime;
        if (timeStep) setup.objective.timeStep = timeStep;
        // A limit is an expression, or the name of a number the objective program reports.
        const constraints = (Array.isArray(raw.objective.constraints) ? raw.objective.constraints : [])
            .filter((entry) => entry && ((typeof entry.expression === 'string' && entry.expression.trim()) || (typeof entry.report === 'string' && entry.report.trim())) && Number.isFinite(Number(entry.limit)))
            .map((entry) => ({
                ...(typeof entry.report === 'string' && entry.report.trim() ? { report: entry.report.trim() } : { expression: entry.expression, ...(typeof entry.latex === 'string' && entry.latex ? { latex: entry.latex } : {}) }),
                relation: entry.relation === '>=' ? '>=' : '<=', limit: Number(entry.limit)
            }));
        if (constraints.length) setup.objective.constraints = constraints;
    }
    if (goal === 'replay' && raw.replay && typeof raw.replay === 'object') setup.replay = normalizeReplaySetup(raw.replay);
    return setup;
}

// An objective written as a program: its language, source and the keys it reads, each bound to a state, a tuned parameter or a
// measured column.
function normalizeProgram(raw) {
    if (!raw || typeof raw !== 'object' || (raw.language !== 'cpp' && raw.language !== 'python') || typeof raw.source !== 'string') return null;
    const bindings = (Array.isArray(raw.bindings) ? raw.bindings : []).filter((binding) => binding && typeof binding.key === 'string' && ['state', 'parameter', 'measured'].includes(binding.kind))
        .map((binding) => ({ key: binding.key, kind: binding.kind, ...(binding.kind === 'measured' ? { column: String(binding.column ?? '') } : { id: Number.isSafeInteger(binding.id) ? binding.id : null }) }));
    return { language: raw.language, source: raw.source, bindings };
}

// How a data log was replayed: which signal went where, how close counts as agreeing, the step, and the live twin's window,
// stride, horizon and speed. Signals are matched again by name when a log is chosen, so a mapping kept here only fills in what
// the person changed from the first guess.
function normalizeReplaySetup(raw) {
    const replay = {};
    if (typeof raw.logFileName === 'string' && raw.logFileName) replay.logFileName = raw.logFileName;
    const timeStep = finitePositive(raw.timeStep);
    if (timeStep) replay.timeStep = timeStep;
    replay.anchor = raw.anchor !== false;
    replay.mapping = (Array.isArray(raw.mapping) ? raw.mapping : []).filter((entry) => entry && typeof entry.signal === 'string' && (entry.role === 'input' || entry.role === 'output'))
        .map((entry) => ({ signal: entry.signal, role: entry.role, target: Number.isSafeInteger(entry.target) && entry.target > 0 ? entry.target : null }));
    replay.tolerances = Object.fromEntries(Object.entries(raw.tolerances && typeof raw.tolerances === 'object' ? raw.tolerances : {})
        .filter(([, value]) => finitePositive(value)).map(([signal, value]) => [signal, Number(value)]));
    // How the live twin brings each measured state back in step: a gain from 0 (watch only) to 1 (reset to the reading), or an
    // estimate ({ estimate: true, noise }: the readings, with that noise, weighed against the model by the estimator).
    const corrections = Object.entries(raw.corrections && typeof raw.corrections === 'object' ? raw.corrections : {})
        .flatMap(([signal, value]) => {
            if (typeof value === 'number' && value >= 0 && value <= 1) return [[signal, value]];
            if (value && typeof value === 'object' && value.estimate === true) return [[signal, { estimate: true, ...(finitePositive(value.noise) ? { noise: Number(value.noise) } : {}) }]];
            return [];
        });
    if (corrections.length) replay.corrections = Object.fromEntries(corrections);
    // How another logger's file was read (src/loggerCsv.mjs): kept as it was given, and checked when it is used.
    if (raw.logger && typeof raw.logger === 'object' && raw.logger.time && Array.isArray(raw.logger.signals)) replay.logger = structuredClone(raw.logger);
    if (raw.live && typeof raw.live === 'object') {
        const live = {};
        for (const key of ['window', 'stride', 'horizon']) {
            const value = finitePositive(raw.live[key]);
            if (value) live[key] = value;
        }
        if (raw.live.speed === 'follow' || finitePositive(raw.live.speed) || raw.live.speed === 'Infinity') live.speed = String(raw.live.speed);
        // The estimator's ensemble size, and how far each state may drift in an hour beyond what the model says.
        if (Number.isInteger(raw.live.members) && raw.live.members >= 4 && raw.live.members <= 1000) live.members = raw.live.members;
        // The drift warning, in the first measured signal's unit a move; 0 for none.
        if (typeof raw.live.alert === 'number' && Number.isFinite(raw.live.alert) && raw.live.alert >= 0) live.alert = raw.live.alert;
        const drift = Object.entries(raw.live.drift && typeof raw.live.drift === 'object' ? raw.live.drift : {})
            .filter(([stateId, value]) => /^\d+$/.test(stateId) && finitePositive(value)).map(([stateId, value]) => [stateId, Number(value)]);
        if (drift.length) live.drift = Object.fromEntries(drift);
        replay.live = live;
    }
    return replay;
}

// What to keep after a run was started: the card's own settings, in the saved form.
export function tuningSetupFromRun({ goal, backend, maxSimulations, maxMinutes, csvFileName, objective, replay }) {
    return normalizeTuningSetup({
        goal, backend, maxSimulations, maxMinutes, csvFileName, replay,
        objective: goal === 'objective' && objective ? { expression: objective.expression ?? '', latex: objective.latex, direction: objective.direction, targetTime: objective.targetTime, timeStep: objective.timeStep, constraints: objective.constraints, program: objective.program } : null
    });
}

// The same setup, or null when saving it would change nothing (so running again does not mark the project as having unsaved work).
export function sameTuningSetup(first, second) {
    return JSON.stringify(first ?? null) === JSON.stringify(second ?? null);
}
