/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes examples/excavator.kjt: a small excavator's four functions, made to be driven with two joysticks the way an operator drives one
// (the "Drive with two joysticks" tutorial, src/tutorials/driveWithJoysticks.mjs). Each function is a joint whose speed follows a live
// command from −1 to 1, one stick axis each, through the lag of its hydraulics: the cab's swing, the boom, the stick (the arm's second
// part) and the bucket. Centred, a command holds its joint still.
//
// Where the bucket's tip is, is worked out exactly at every step, not integrated: each part's absolute angle is its joint's angle plus
// the absolute angle of the part it hangs from (a relationship from parent to child sets it), and the tip's height and reach are set by
// three relationships, the boom's, the stick's and the bucket's, each giving its part's length along its absolute angle; a state set by
// several relationships takes the sum of what they give. So the tip's height is pivot height + boom·sin(boom) + stick·sin(stick) +
// bucket·sin(bucket), with the angles absolute, and its reach the same with cosines.
//   node scripts/generateExcavatorExample.mjs

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeProjectFile } from '../src/projectFile.mjs';
import { exampleOwnership } from './exampleOwnership.mjs';

export const excavator = Object.freeze({
    lag: 0.3,                                   // s: how quickly a joint's speed follows its command
    pivot: { height: 1.8, offset: 0.8 },        // m: the boom's pivot, above the ground and in front of the swing axis
    lengths: { boom: 5.7, stick: 2.9, bucket: 1.5 },
    // The functions: the most each turns, in rad/s, with its command full over, and where it starts (a joint's angle relative to its parent).
    joints: {
        swing: { name: 'Swing', maxRate: 0.5, start: 0 },
        boom: { name: 'Boom', maxRate: 0.3, start: 0.6 },
        stick: { name: 'Stick', maxRate: 0.4, start: -1.9 },
        bucket: { name: 'Bucket', maxRate: 0.6, start: -0.8 }
    }
});

const ids = {
    cab: 1, swing: 2, swingRate: 3,
    boom: 10, boomAngle: 11, boomRate: 12,
    stick: 20, stickJoint: 21, stickRate: 22, stickAngle: 23,
    bucket: 30, bucketJoint: 31, bucketRate: 32, bucketAngle: 33,
    tip: 40, height: 41, reach: 42,
    run: 90
};

// Where the tip starts, from the starting angles (the engine sets it at the run's start the same way).
export function startingTip({ pivot, lengths, joints } = excavator) {
    const boom = joints.boom.start;
    const stick = boom + joints.stick.start;
    const bucket = stick + joints.bucket.start;
    return {
        height: pivot.height + lengths.boom * Math.sin(boom) + lengths.stick * Math.sin(stick) + lengths.bucket * Math.sin(bucket),
        reach: pivot.offset + lengths.boom * Math.cos(boom) + lengths.stick * Math.cos(stick) + lengths.bucket * Math.cos(bucket)
    };
}

export function excavatorProject() {
    let next = 200;
    const id = () => next++;
    const box = (color) => ({ type: 'primitive', shape: 'box', color });
    const state = (stateId, name, symbol, initialValue, unit) => ({ id: stateId, name, symbol, initialValue: Number(initialValue.toFixed(6)), unit });
    const own = (nodeId, stateId, symbol) => ({ kind: 'state', nodeId, stateId, symbol });
    const uses = (parameter) => ({ kind: 'parameter', parameterId: parameter.id, symbol: parameter.symbol });

    // A joint: its angle moved by its speed, and its speed following its live command through the lag. `angleId`/`rateId` are the
    // joint's own states, on `nodeId`.
    function jointTerms(nodeId, key, angleId, angleSymbol, rateId, rateSymbol) {
        const joint = excavator.joints[key];
        const command = { id: id(), name: `${joint.name} command`, symbol: `${key}Command`, value: 0, unit: '', mode: 'live', control: { minimum: -1, maximum: 1, step: 0.01 } };
        const maxRate = { id: id(), name: `${joint.name} top speed`, symbol: `${key}TopSpeed`, value: joint.maxRate, unit: 'rad/s', mode: 'constant' };
        const lag = { id: id(), name: 'Hydraulic lag', symbol: 'hydraulicLag', value: excavator.lag, unit: 's', mode: 'constant' };
        return [
            {
                id: id(), state: rateSymbol,
                expression: `(${maxRate.symbol} * ${command.symbol} - ${rateSymbol}) / hydraulicLag`,
                expressionModel: {
                    latex: String.raw`\frac{\mathrm{${maxRate.symbol}}\cdot\mathrm{${command.symbol}}-\mathrm{${rateSymbol}}}{\mathrm{hydraulicLag}}`,
                    output: { stateId: rateId },
                    mathJson: ['Divide', ['Add', ['Multiply', maxRate.symbol, command.symbol], ['Negate', rateSymbol]], 'hydraulicLag'],
                    bindings: [uses(maxRate), uses(command), uses(lag), own(nodeId, rateId, rateSymbol)]
                },
                parameters: [command, maxRate, lag]
            },
            {
                id: id(), state: angleSymbol, expression: rateSymbol,
                expressionModel: { latex: String.raw`\mathrm{${rateSymbol}}`, output: { stateId: angleId }, mathJson: rateSymbol, bindings: [own(nodeId, rateId, rateSymbol)] },
                parameters: []
            }
        ];
    }

    // A relationship from a parent to a child that sets states of the child (or of the tip), from bindings of either end.
    const setting = (name, sourceId, targetId, parameters, bindings, outputs) => ({
        id: id(), name, source: { nodeId: sourceId }, target: { nodeId: targetId }, directionality: 'directed', color: 0x9aa7b1,
        parameters, equationModel: { bindings, definitions: [], outputs: outputs.map((output) => ({ ...output, role: 'target', setsValue: true })) }
    });
    const length = (name, symbol, value) => ({ id: id(), name, symbol, value, unit: 'm', mode: 'constant' });
    const fromSource = (nodeId, stateId, symbol) => ({ kind: 'state', role: 'source', nodeId, stateId, symbol });
    const fromTarget = (nodeId, stateId, symbol) => ({ kind: 'state', role: 'target', nodeId, stateId, symbol });
    const { joints, lengths, pivot } = excavator;
    const tip = startingTip();

    // A part's share of the tip: its length along its absolute angle, up and out.
    const tipShare = (name, sourceId, angleId, lengthParameter, extras = []) => {
        const angle = fromSource(sourceId, angleId, 'sourceAngle');
        const up = ['Multiply', lengthParameter.symbol, ['Sin', 'sourceAngle']];
        const out = ['Multiply', lengthParameter.symbol, ['Cos', 'sourceAngle']];
        const height = extras.length ? ['Add', extras[0].symbol, up] : up;
        const reach = extras.length ? ['Add', extras[1].symbol, out] : out;
        return setting(name, sourceId, ids.tip, [lengthParameter, ...extras], [angle, ...[lengthParameter, ...extras].map(uses)], [
            { stateId: ids.height, mathJson: height },
            { stateId: ids.reach, mathJson: reach }
        ]);
    };

    return {
        format: 'konjugate', version: 1, ownership: exampleOwnership('Excavator'), metadata: { units: 'SI' },
        sharedParameters: [],
        runConfigurations: [{ id: ids.run, name: 'A minute at the controls', globalTimeStep: 0.01, outputInterval: 0.05 }],
        activeRunConfigurationId: ids.run,
        nodes: [
            {
                id: ids.cab, name: 'Cab', type: 'Swing', position: [0, 0, 0], appearance: box('#d9a531'),
                states: [state(ids.swing, 'Swing angle', 'swing', joints.swing.start, 'rad'), state(ids.swingRate, 'Swing speed', 'swingRate', 0, 'rad/s')],
                sourceTerms: jointTerms(ids.cab, 'swing', ids.swing, 'swing', ids.swingRate, 'swingRate')
            },
            {
                id: ids.boom, name: 'Boom', type: 'Joint', position: [4.5, 3, 0], appearance: box('#e0b23c'),
                states: [state(ids.boomAngle, 'Boom angle', 'boomAngle', joints.boom.start, 'rad'), state(ids.boomRate, 'Boom speed', 'boomRate', 0, 'rad/s')],
                sourceTerms: jointTerms(ids.boom, 'boom', ids.boomAngle, 'boomAngle', ids.boomRate, 'boomRate')
            },
            {
                id: ids.stick, name: 'Stick', type: 'Joint', position: [9, 3, 0], appearance: box('#e8bd4c'),
                states: [
                    state(ids.stickJoint, 'Stick joint', 'stickJoint', joints.stick.start, 'rad'), state(ids.stickRate, 'Stick speed', 'stickRate', 0, 'rad/s'),
                    state(ids.stickAngle, 'Stick angle', 'stickAngle', joints.boom.start + joints.stick.start, 'rad')
                ],
                sourceTerms: jointTerms(ids.stick, 'stick', ids.stickJoint, 'stickJoint', ids.stickRate, 'stickRate')
            },
            {
                id: ids.bucket, name: 'Bucket', type: 'Joint', position: [13.5, 1, 0], appearance: box('#f0c85c'),
                states: [
                    state(ids.bucketJoint, 'Bucket joint', 'bucketJoint', joints.bucket.start, 'rad'), state(ids.bucketRate, 'Bucket speed', 'bucketRate', 0, 'rad/s'),
                    state(ids.bucketAngle, 'Bucket angle', 'bucketAngle', joints.boom.start + joints.stick.start + joints.bucket.start, 'rad')
                ],
                sourceTerms: jointTerms(ids.bucket, 'bucket', ids.bucketJoint, 'bucketJoint', ids.bucketRate, 'bucketRate')
            },
            {
                id: ids.tip, name: 'Bucket tip', type: 'Position', position: [13.5, -3, 0], appearance: box('#8a9aa6'),
                states: [state(ids.height, 'Height', 'height', tip.height, 'm'), state(ids.reach, 'Reach', 'reach', tip.reach, 'm')],
                sourceTerms: []
            }
        ],
        edges: [
            setting('Stick on boom', ids.boom, ids.stick, [],
                [fromSource(ids.boom, ids.boomAngle, 'sourceBoomAngle'), fromTarget(ids.stick, ids.stickJoint, 'targetStickJoint')],
                [{ stateId: ids.stickAngle, mathJson: ['Add', 'sourceBoomAngle', 'targetStickJoint'] }]),
            setting('Bucket on stick', ids.stick, ids.bucket, [],
                [fromSource(ids.stick, ids.stickAngle, 'sourceStickAngle'), fromTarget(ids.bucket, ids.bucketJoint, 'targetBucketJoint')],
                [{ stateId: ids.bucketAngle, mathJson: ['Add', 'sourceStickAngle', 'targetBucketJoint'] }]),
            tipShare('Boom reach', ids.boom, ids.boomAngle, length('Boom length', 'boomLength', lengths.boom),
                [length('Pivot height', 'pivotHeight', pivot.height), length('Pivot offset', 'pivotOffset', pivot.offset)]),
            tipShare('Stick reach', ids.stick, ids.stickAngle, length('Stick length', 'stickLength', lengths.stick)),
            tipShare('Bucket reach', ids.bucket, ids.bucketAngle, length('Bucket length', 'bucketLength', lengths.bucket))
        ]
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await writeFile(join(import.meta.dirname, '..', 'examples', 'excavator.kjt'), await encodeProjectFile(JSON.stringify(excavatorProject())));
}
