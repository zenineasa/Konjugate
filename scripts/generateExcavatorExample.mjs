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
//
// The machine is drawn in 3D by the Pose Visualizer add-on (1.0.7 or later): its "Machine pose" node holds four bodies, the cab, the
// boom, the stick and the bucket, each by a prefix to the visualizer's own names (`boomX`, `boomY`, `boomZ`, `boomRoll`, `boomPitch`,
// `boomYaw`), and its appearance a part for each, a box at the part's true size in metres in the part's own frame (x along it, z up).
// Each part's pose is set by a relationship from its joint, in the visualizer's convention (yaw about z, then pitch about y, so raising
// a part by an angle is a pitch of minus that angle): the cab turns by the swing; the boom stands on the cab at the pivot; the stick at
// the boom's far end; the bucket at the stick's.
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
    pose: 50,
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

// The parts the Pose Visualizer draws, each a box in its own frame (x along the part from where it is held, z up), in metres.
export const excavatorParts = Object.freeze([
    { prefix: 'cab', color: '#d9a531', box: [[-2.2, 1.2], [-1.25, 1.25], [0, 1.8]] },
    { prefix: 'boom', color: '#e0b23c', box: [[0, excavator.lengths.boom], [-0.2, 0.2], [-0.25, 0.25]] },
    { prefix: 'stick', color: '#e8bd4c', box: [[0, excavator.lengths.stick], [-0.15, 0.15], [-0.18, 0.18]] },
    { prefix: 'bucket', color: '#f0c85c', box: [[0, excavator.lengths.bucket], [-0.5, 0.5], [-0.3, 0.3]] }
]);

// Where each part is at the start, in the visualizer's convention: { x, y, z, roll, pitch, yaw }.
export function startingPoses({ pivot, lengths, joints } = excavator) {
    const yaw = joints.swing.start;
    const boom = joints.boom.start;
    const stick = boom + joints.stick.start;
    const bucket = stick + joints.bucket.start;
    const along = (from, length, angle) => ({ x: from.x + length * Math.cos(angle) * Math.cos(yaw), y: from.y + length * Math.cos(angle) * Math.sin(yaw), z: from.z + length * Math.sin(angle) });
    const boomBase = { x: pivot.offset * Math.cos(yaw), y: pivot.offset * Math.sin(yaw), z: pivot.height };
    const stickBase = along(boomBase, lengths.boom, boom);
    const bucketBase = along(stickBase, lengths.stick, stick);
    return {
        cab: { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw },
        boom: { ...boomBase, roll: 0, pitch: -boom, yaw },
        stick: { ...stickBase, roll: 0, pitch: -stick, yaw },
        bucket: { ...bucketBase, roll: 0, pitch: -bucket, yaw }
    };
}

// A box's mesh as a node's appearance part keeps it: four corners and an outward normal for each face, two triangles each.
function boxMesh([[x0, x1], [y0, y1], [z0, z1]]) {
    const faces = [
        [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
        [[-1, 0, 0], [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]]],
        [[0, 1, 0], [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]]],
        [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
        [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
        [[0, 0, -1], [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]]]
    ];
    const round = (value) => Number(value.toFixed(4));
    return {
        position: faces.flatMap(([, corners]) => corners.flat().map(round)),
        normal: faces.flatMap(([normal]) => [normal, normal, normal, normal].flat()),
        index: faces.flatMap((_face, face) => [0, 1, 2, 0, 2, 3].map((corner) => face * 4 + corner))
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

    // The Machine pose node's states: six for each part, under its prefix, in the visualizer's names.
    const roles = ['x', 'y', 'z', 'roll', 'pitch', 'yaw'];
    const poses = startingPoses();
    const poseStateId = (prefix, role) => ids.pose + 1 + excavatorParts.findIndex((part) => part.prefix === prefix) * roles.length + roles.indexOf(role);
    const poseSymbol = (prefix, role) => `${prefix}${role[0].toUpperCase()}${role.slice(1)}`;
    const poseNames = { x: 'x', y: 'y', z: 'z', roll: 'roll', pitch: 'pitch', yaw: 'yaw' };
    const poseStates = excavatorParts.flatMap(({ prefix }) => roles.map((role) => state(poseStateId(prefix, role), `${prefix[0].toUpperCase()}${prefix.slice(1)} ${poseNames[role]}`,
        poseSymbol(prefix, role), poses[prefix][role], ['x', 'y', 'z'].includes(role) ? 'm' : 'rad')));
    const poseOut = (prefix, role, mathJson) => ({ stateId: poseStateId(prefix, role), mathJson });
    const fromPose = (prefix, role, symbol) => fromTarget(ids.pose, poseStateId(prefix, role), symbol);
    // A part held at the far end of `parent` (whose pose is on the Machine pose node), raised by the source's absolute angle.
    const partPose = (name, prefix, parent, sourceId, angleId, lengthParameter) => {
        const t = (role) => `target${prefix[0].toUpperCase()}${prefix.slice(1)}${parent[0].toUpperCase()}${parent.slice(1)}${role[0].toUpperCase()}${role.slice(1)}`;
        const reach = (trig) => ['Multiply', lengthParameter.symbol, ['Multiply', ['Cos', t('pitch')], [trig, t('yaw')]]];
        return setting(name, sourceId, ids.pose, [lengthParameter], [
            fromSource(sourceId, angleId, 'sourceAngle'), uses(lengthParameter),
            ...['x', 'y', 'z', 'pitch', 'yaw'].map((role) => fromPose(parent, role, t(role)))
        ], [
            poseOut(prefix, 'x', ['Add', t('x'), reach('Cos')]),
            poseOut(prefix, 'y', ['Add', t('y'), reach('Sin')]),
            // The parent's pitch is minus its angle, so its far end is up by length·sin(−pitch).
            poseOut(prefix, 'z', ['Add', t('z'), ['Negate', ['Multiply', lengthParameter.symbol, ['Sin', t('pitch')]]]]),
            poseOut(prefix, 'pitch', ['Negate', 'sourceAngle']),
            poseOut(prefix, 'yaw', t('yaw'))
        ]);
    };

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
                // The four parts' poses, for the Pose Visualizer to draw the machine in 3D, each with its box at true size.
                id: ids.pose, name: 'Machine pose', type: 'Pose', position: [-10, -1, 0],
                appearance: { ...box('#5f7480'), parts: excavatorParts.map(({ prefix, color, box: extent }) => ({ prefix, mesh: boxMesh(extent), color })) },
                states: poseStates,
                sourceTerms: []
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
            tipShare('Bucket reach', ids.bucket, ids.bucketAngle, length('Bucket length', 'bucketLength', lengths.bucket)),
            // The parts' poses, in the order each needs the one before it.
            setting('Cab pose', ids.cab, ids.pose, [], [fromSource(ids.cab, ids.swing, 'sourceSwing')], [poseOut('cab', 'yaw', 'sourceSwing')]),
            (() => {
                const offset = length('Pivot offset', 'pivotOffset', pivot.offset);
                const height = length('Pivot height', 'pivotHeight', pivot.height);
                return setting('Boom pose', ids.boom, ids.pose, [offset, height],
                    [fromSource(ids.boom, ids.boomAngle, 'sourceAngle'), fromPose('cab', 'yaw', 'targetCabYaw'), uses(offset), uses(height)], [
                        poseOut('boom', 'x', ['Multiply', 'pivotOffset', ['Cos', 'targetCabYaw']]),
                        poseOut('boom', 'y', ['Multiply', 'pivotOffset', ['Sin', 'targetCabYaw']]),
                        poseOut('boom', 'z', 'pivotHeight'),
                        poseOut('boom', 'pitch', ['Negate', 'sourceAngle']),
                        poseOut('boom', 'yaw', 'targetCabYaw')
                    ]);
            })(),
            partPose('Stick pose', 'stick', 'boom', ids.stick, ids.stickAngle, length('Boom length', 'boomLength', lengths.boom)),
            partPose('Bucket pose', 'bucket', 'stick', ids.bucket, ids.bucketAngle, length('Stick length', 'stickLength', lengths.stick))
        ]
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await writeFile(join(import.meta.dirname, '..', 'examples', 'excavator.kjt'), await encodeProjectFile(JSON.stringify(excavatorProject())));
}
