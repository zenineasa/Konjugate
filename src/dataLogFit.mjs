/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Calibrating a model against a stretch of a data log (docs/connectingADataSource.md, "Calibrating to a log"): the model's tunable
// parameters are fitted so that, driven by what the log says was done, it reproduces what the log says was measured. The engine's
// fit wants its measured data on a regular grid it can pair with the simulation's samples row by row; a log's readings come when they
// come, with gaps and failed readings. So this puts the stretch on a grid: each grid time gets the mean of the good readings in its
// step (which also smooths the noise a little), a short run of empty steps is filled in a straight line between its neighbours, and
// a longer gap is refused, with the advice to calibrate on another stretch. The grid is the model's step, which can be much finer than
// the readings (a motor's millisecond step, read every 50 ms): a gap is then judged against the readings' own spacing, so only a
// stretch with several readings missing in a row is one.
//
// The plan's document is the model with its inputs driven by the log (as a replay drives them, held between readings) and its
// measured states starting at their first reading; its CSV has one column per measured signal, named by the state's symbol, which
// is how the engine's fit matches columns to states.

import { interpolate, latestReadings, replayPlan, ReplayError } from './dataLogReplay.mjs';

const longestFill = 3; // grid steps, or readings' spacings, in a row that may be filled in a straight line

// The usual time between readings (the median gap), 0 with fewer than two.
function readingSpacing(readings) {
    const gaps = readings.slice(1).map((reading, index) => reading.time - readings[index].time).filter((gap) => gap > 0).sort((a, b) => a - b);
    return gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
}

// Seconds as the message gives them: to the millisecond under a minute, whole seconds above.
const seconds = (value) => (value < 60 ? `${Number(value.toFixed(3))} s` : `${Math.round(value)} s`);

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
        // Empty grid steps in a row that may be filled: three steps, or three of the readings' spacings when those are longer.
        const fillable = Math.max(longestFill, Math.floor(longestFill * readingSpacing(output.readings) / timeStep + 1e-9));
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
        // Fill short runs of empty steps between known neighbours, and hold the nearest reading over a short run at either end (a
        // reading flagged bad at the very end of a live twin's window, at its now, once made a refit on that move impossible); refuse
        // a longer gap, or a stretch with no reading at all.
        for (let index = 0; index <= steps; index += 1) {
            if (grid[index] !== null) continue;
            let end = index;
            while (end <= steps && grid[end] === null) end += 1;
            const before = index - 1;
            if ((before < 0 && end > steps) || end - index > fillable) {
                throw new ReplayError(`${output.signal} has no readings from ${seconds(Math.max(0, before) * timeStep)} to ${seconds(end * timeStep)} into the stretch: calibrate on a stretch without a gap that long.`);
            }
            for (let fill = index; fill < end; fill += 1) {
                grid[fill] = before < 0 ? grid[end] : end > steps ? grid[before]
                    : interpolate([{ time: before, value: grid[before] }, { time: end, value: grid[end] }], fill);
            }
            index = end;
        }
        return { symbol, grid };
    });
    const header = ['time', ...columns.map((column) => column.symbol)].join(',');
    const rows = Array.from({ length: steps + 1 }, (_, index) => [String(index * timeStep), ...columns.map((column) => String(column.grid[index]))].join(','));
    return { document: plan.document, csv: `${[header, ...rows].join('\n')}\n`, start: plan.start, steps, outputs: plan.outputs.map((output) => output.signal), latestReadings };
}
