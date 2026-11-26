/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Compare with original (docs/proposals/fmuImportWorkflow.md, stage 7): an exported FMU's run, as the node it was placed as, against the
// run of the model it was exported from, output by output, by the FMU's output names and the times the two runs share. The comparison
// belongs to that one node (`original.nodeId`): another FMU, or the same FMU placed again, is not compared with a run it did not come
// from, even when its outputs have the same names. Pure, for the project window and a unit test.

// `original` is { modelName, times, outputs: { name: values }, nodeId }; `nodes` the model's nodes; `samples` the run's; `outputName(node,
// output)` an output's FMU name. { title, lines, compared } or null when there is nothing to compare (no comparison, or its node gone).
export function compareWithOriginal({ original, nodes, samples, outputName }) {
    if (!original || !samples?.length) return null;
    const node = (nodes ?? []).find((candidate) => candidate.id === original.nodeId && !candidate.deleted && candidate.implementation?.kind === 'fmi');
    if (!node) return null;
    const byTime = new Map(original.times.map((time, index) => [Number(time).toPrecision(12), index]));
    const lines = [];
    let largest = 0;
    let compared = 0;
    let where = '';
    for (const output of node.implementation.outputs ?? []) {
        const name = outputName(node, output);
        const reference = original.outputs[name];
        if (!reference) continue;
        let difference = 0;
        let count = 0;
        for (const sample of samples) {
            const index = byTime.get(Number(sample.time).toPrecision(12));
            const value = sample.states.find((state) => state.stateId === output.stateId)?.value;
            if (index === undefined || !Number.isFinite(value)) continue;
            const gap = Math.abs(value - reference[index]);
            if (gap > difference) difference = gap;
            if (gap > largest) { largest = gap; where = `${name} at t = ${sample.time} s`; }
            count += 1;
        }
        if (!count) continue;
        compared += count;
        lines.push(`${name}: ${count} samples, largest difference ${difference === 0 ? '0 (identical)' : difference.toPrecision(3)}.`);
    }
    if (!lines.length) {
        lines.push('No output of the FMU matched one of the original run, by name and time: compare the samples the two runs share, or run both to the same times.');
    }
    const title = !compared ? `Not compared with ${original.modelName}'s run.`
        : largest === 0 ? `Identical to ${original.modelName}'s run: largest difference 0 over ${compared} values.`
            : `Largest difference from ${original.modelName}'s run: ${largest.toPrecision(3)} (${where}).`;
    return { title, lines, compared };
}
