/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The Parameter tuning card's setup, kept with the project (`tuningSetup`, docs/projectSchema.md) so a tuning can be opened again and run
// again after the model changes, instead of being set up from nothing each time. Like add-on data it sits beside the model, not in it:
// it is written when the project is saved and read when it is opened, and never reaches the engine, validation or the undo history.
// What a person typed is checked here on the way in, since a project file can be edited by hand; anything unusable is dropped, never thrown.

const directions = ['minimise', 'maximise'];
const goals = ['data', 'objective'];

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
    if (goal === 'objective' && raw.objective && typeof raw.objective === 'object' && typeof raw.objective.expression === 'string') {
        setup.objective = { expression: raw.objective.expression, direction: directions.includes(raw.objective.direction) ? raw.objective.direction : 'minimise' };
        const targetTime = finitePositive(raw.objective.targetTime);
        const timeStep = finitePositive(raw.objective.timeStep);
        if (targetTime) setup.objective.targetTime = targetTime;
        if (timeStep) setup.objective.timeStep = timeStep;
        const constraints = (Array.isArray(raw.objective.constraints) ? raw.objective.constraints : [])
            .filter((entry) => entry && typeof entry.expression === 'string' && entry.expression.trim() && Number.isFinite(Number(entry.limit)))
            .map((entry) => ({ expression: entry.expression, relation: entry.relation === '>=' ? '>=' : '<=', limit: Number(entry.limit) }));
        if (constraints.length) setup.objective.constraints = constraints;
    }
    return setup;
}

// What to keep after a run was started: the card's own settings, in the saved form.
export function tuningSetupFromRun({ goal, backend, maxSimulations, maxMinutes, csvFileName, objective }) {
    return normalizeTuningSetup({
        goal, backend, maxSimulations, maxMinutes, csvFileName,
        objective: goal === 'objective' && objective ? { expression: objective.expression, direction: objective.direction, targetTime: objective.targetTime, timeStep: objective.timeStep, constraints: objective.constraints } : null
    });
}

// The same setup, or null when saving it would change nothing (so running again does not mark the project as having unsaved work).
export function sameTuningSetup(first, second) {
    return JSON.stringify(first ?? null) === JSON.stringify(second ?? null);
}
