/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A launcher's fork in the web edition, as launcherHost.mjs's runScenarioBranches makes it on the desktop: the model run on from the
// baseline's checkpoint nearest the fork, to the scenario's end, with the scenario's parameter changes in place before its first step.
// `host.runModel({ content, config, commands })` answers the decoded result; `host.canSendCommands` says whether the page can send the
// engine commands (a cross-origin isolated page can, webLauncherEngine.mjs). Where it can, the changes go as the same commands the
// desktop sends. Where it cannot, they go into the model as stored schedules (interventionSchedules.mjs). No DOM.

import { nearestCheckpoint } from './launcherRuns.mjs';
import { applyInterventionSchedules } from './interventionSchedules.mjs';

const scheduleCommand = (change, checkpoint) => {
    const base = { type: 'scheduleParameterValue', parameterId: change.sharedParameterId };
    // A path of values is followed as a piecewise schedule, its times counted from the fork; a change with a duration is a pulse that
    // returns to the parameter's base value when it ends.
    if (change.samples) return { ...base, mode: 'piecewise', samples: change.samples.map((sample) => ({ time: checkpoint.time + sample.time, value: sample.value })), baseValue: change.baseValue ?? 0 };
    if (change.duration > 0) return { ...base, mode: 'pulse', startTime: checkpoint.time + change.at, duration: change.duration, targetValue: change.value, baseValue: change.baseValue ?? 0 };
    return { ...base, mode: 'step', startTime: checkpoint.time + change.at, targetValue: change.value };
};

// { forkTime, child } where child is the forked run's decoded result.
export async function runScenarioFork({ host, document, contentText, config, scenario, interventions, baseline }) {
    const checkpoint = nearestCheckpoint(baseline.result.checkpoints, scenario.forkAt);
    if (!checkpoint) throw new Error('The baseline kept no checkpoint to fork from.');
    const forkConfig = { ...config, targetTime: scenario.runTime, startCheckpoint: structuredClone(checkpoint) };
    if (host.canSendCommands) {
        // Held before its first step, so every change is in place when the first step is taken.
        const commands = [{ type: 'setRunState', state: 'paused' }, ...interventions.map((change) => scheduleCommand(change, checkpoint)), { type: 'setRunState', state: 'running' }];
        return { forkTime: checkpoint.time, child: { result: await host.runModel({ content: contentText, config: { ...forkConfig, startPaused: true }, commands }) } };
    }
    const content = interventions.length ? JSON.stringify(applyInterventionSchedules(document, interventions, checkpoint.time)) : contentText;
    return { forkTime: checkpoint.time, child: { result: await host.runModel({ content, config: forkConfig, commands: [] }) } };
}
