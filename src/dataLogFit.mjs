/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Calibrating a model against a stretch of a data log (docs/connectingADataSource.md, "Calibrating to a log"): the model's tunable
// parameters are fitted so that, driven by what the log says was done, it reproduces what the log says was measured. The engine's
// fit wants its measured data on a regular grid it can pair with the simulation's samples row by row; a log's readings come when they
// come, with gaps and failed readings. So this puts the stretch on a grid: each grid time gets the mean of the good readings in its
// step (which also smooths the noise a little), a short run of empty steps is filled in a straight line between its neighbours, and
// a longer gap is refused, with the advice to calibrate on another stretch.
//
// The plan's document is the model with its inputs driven by the log (as a replay drives them, held between readings) and its
// measured states starting at their first reading; its CSV has one column per measured signal, named by the state's symbol, which
// is how the engine's fit matches columns to states.

import { interpolate, latestReadings, replayPlan, ReplayError } from './dataLogReplay.mjs';

const longestFill = 3; // grid steps in a row that may be filled in a straight line

export function fitPlanFromLog(document, log, mapping, { from = null, to = null, timeStep }) {
    if (!(timeStep > 0)) throw new ReplayError('The calibration step must be a positive number of seconds.');
    const plan = replayPlan(document, log, mapping, { timeStep, anchor: true, from, to });
    const states = new Map(plan.document.nodes.flatMap((node) => node.states ?? []).map((state) => [state.id, state]));
    const span = plan.configuration.targetTime;
    const steps = Math.floor(span / timeStep + 1e-9);
    if (steps < 2) throw new ReplayError('The stretch is too short to calibrate on: it needs at least two steps.');
    const columns = plan.outputs.map((output) => {
        const symbol = states.get(output.stateId)?.symbol;
        if (!symbol) throw new ReplayError(`The state for ${output.signal} is no longer in the model.`);
        const grid = [];
        let reading = 0;
        for (let index = 0; index <= steps; index += 1) {
            const time = index * timeStep;
            const lower = time - timeStep / 2;
            const upper = time + timeStep / 2;
            while (reading < output.readings.length && output.readings[reading].time < lower) reading += 1;
            let sum = 0;
            let count = 0;
            for (let look = reading; look < output.readings.length && output.readings[look].time < upper; look += 1) {
                sum += output.readings[look].value;
                count += 1;
            }
            grid.push(count ? sum / count : null);
        }
        // Fill short runs of empty steps between known neighbours; refuse a longer gap.
        for (let index = 0; index <= steps; index += 1) {
            if (grid[index] !== null) continue;
            let end = index;
            while (end <= steps && grid[end] === null) end += 1;
            const before = index - 1;
            if (before < 0 || end > steps || end - index > longestFill) {
                throw new ReplayError(`${output.signal} has no readings from ${Math.round(index * timeStep)} s to ${Math.round(end * timeStep)} s into the stretch: calibrate on a stretch without a gap that long.`);
            }
            for (let fill = index; fill < end; fill += 1) {
                grid[fill] = interpolate([{ time: before, value: grid[before] }, { time: end, value: grid[end] }], fill);
            }
            index = end;
        }
        return { symbol, grid };
    });
    const header = ['time', ...columns.map((column) => column.symbol)].join(',');
    const rows = Array.from({ length: steps + 1 }, (_, index) => [String(index * timeStep), ...columns.map((column) => String(column.grid[index]))].join(','));
    return { document: plan.document, csv: `${[header, ...rows].join('\n')}\n`, start: plan.start, steps, outputs: plan.outputs.map((output) => output.signal), latestReadings };
}
