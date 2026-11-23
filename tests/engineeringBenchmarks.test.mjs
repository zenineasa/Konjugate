/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The engineering benchmarks' own machinery (benchmarks/README.md, Engineering systems), checked without the engine: the model builder's
// piecewise, min/max and time terms, the exact references against independent arithmetic, the balances their models are built on, and
// the provenance every reference records.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { cases, createModel, parameter, state, time } from '../benchmarks/lib/project.mjs';
import { buckAveragedReference, buckSwitchedReference, constants as circuitConstants } from '../benchmarks/electrical/switchedCircuits/problem.mjs';
import { affineEquilibrium } from '../benchmarks/lib/linearAlgebra.mjs';
import { constants as exchangerConstants, effectivenessNtu, system } from '../benchmarks/thermal/heatExchanger/problem.mjs';
import { build as buildDataCentre, bypassFlow, coldAisleFlow, constants as dataCentreConstants, rackFlow, unitFlow } from '../benchmarks/showcase/dataCentre/problem.mjs';
import { cauerInverseCapacitance, constants as modelicaConstants } from '../benchmarks/modelica/standardLibrary/problem.mjs';

const benchmarks = join(import.meta.dirname, '..', 'benchmarks');

test('the model builder writes cases, min, max and the time binding', () => {
    const model = createModel('Builder test');
    const node = model.node('Node', { states: [['x', 'X', 0, '']] });
    model.sourceTerm(node, 'x', cases(['Less', 't', 'switchAt'], ['Min', ['Max', 'x', 0], 1], 'True', 0), { t: time, switchAt: parameter('Switch time', 2, 's'), x: state(node, 'x') });
    const [term] = model.document({ runConfiguration: { name: 'Test', globalTimeStep: 1, outputInterval: 1 } }).nodes[0].sourceTerms;
    assert.equal(term.expression, '\\begin{cases} \\min\\left(\\max\\left(\\mathrm{x}, 0\\right), 1\\right) & t < \\mathrm{switchAt} \\\\ 0 & \\text{otherwise} \\end{cases}');
    assert.deepEqual(term.expressionModel.bindings.find((binding) => binding.kind === 'time'), { kind: 'time', symbol: 't' });
});

test('the switched buck\'s exact reference matches a fine integration, and settles near the averaged one', () => {
    const p = circuitConstants.buck;
    const r = p.windingResistance + p.switchResistance;
    const period = 1 / p.frequency;
    // Classical Runge–Kutta at 4000 steps a period: every switching edge (at 0 and 0.4 of each period) falls on a step boundary, so each
    // step's switch state is known from its index.
    const stepsPerPeriod = 4000;
    const step = period / stepsPerPeriod;
    let [i, v, energy] = [0, 0, 0];
    const rate = (s, [current, voltage]) => [(s * p.inputVoltage - r * current - voltage) / p.inductance, (current - voltage / p.load) / p.capacitance, s * p.inputVoltage * current];
    const end = 20 * period;
    for (let k = 0; k < 20 * stepsPerPeriod; ++k) {
        const s = k % stepsPerPeriod < p.duty * stepsPerPeriod ? 1 : 0;
        const a = rate(s, [i, v]);
        const b = rate(s, [i + step / 2 * a[0], v + step / 2 * a[1]]);
        const c = rate(s, [i + step / 2 * b[0], v + step / 2 * b[1]]);
        const d = rate(s, [i + step * c[0], v + step * c[1]]);
        i += step / 6 * (a[0] + 2 * b[0] + 2 * c[0] + d[0]);
        v += step / 6 * (a[1] + 2 * b[1] + 2 * c[1] + d[1]);
        energy += step / 6 * (a[2] + 2 * b[2] + 2 * c[2] + d[2]);
    }
    const [exact] = buckSwitchedReference([end]);
    assert.ok(Math.abs(exact[0] - i) < 1e-6 && Math.abs(exact[1] - v) < 1e-6 && Math.abs(exact[2] - energy) / energy < 1e-6, `${exact} against ${[i, v, energy]}`);
    const [late] = buckSwitchedReference([2 ** -7]);
    const [averaged] = buckAveragedReference([2 ** -7]);
    assert.ok(Math.abs(late[1] - averaged[1]) < 0.1, 'after start-up the switched output voltage sits near the averaged one');
});

test('the heat exchanger\'s discretised equilibrium balances the two streams, and ε-NTU is the textbook value', () => {
    const { specificHeat, hot, cold } = exchangerConstants;
    for (const arrangement of ['counterflow', 'parallel']) {
        for (const segments of exchangerConstants.segmentCounts) {
            const { matrix, forcing } = system(arrangement, segments);
            const equilibrium = affineEquilibrium(matrix, forcing);
            const hotOut = equilibrium[segments - 1];
            const coldOut = equilibrium[arrangement === 'counterflow' ? segments : 2 * segments - 1];
            const released = hot.massFlow * specificHeat * (hot.inlet - hotOut);
            const taken = cold.massFlow * specificHeat * (coldOut - cold.inlet);
            assert.ok(Math.abs(released - taken) / released < 1e-12, `${arrangement} ${segments}: ${released} W released, ${taken} W taken`);
        }
    }
    // NTU = 4000 / 2090, C_r = 0.5: counterflow 0.7623, parallel flow 0.6289 (Incropera's relations).
    assert.ok(Math.abs(effectivenessNtu('counterflow') - 0.762325) < 1e-6);
    assert.ok(Math.abs(effectivenessNtu('parallel') - 0.628898) < 1e-6);
});

test('every air volume in the data centre takes in what it gives out', () => {
    const c = dataCentreConstants;
    for (const row of c.rows) {
        const draws = row.loads.reduce((total, load, j) => total + (1 - c.recirculation[j]) * rackFlow(load), 0);
        const exhaust = row.loads.reduce((total, load) => total + rackFlow(load), 0);
        const recirculated = row.loads.reduce((total, load, j) => total + c.recirculation[j] * rackFlow(load), 0);
        assert.ok(Math.abs(coldAisleFlow(row) - (draws + bypassFlow(row))) < 1e-9, 'cold aisle: plenum in, racks and bypass out');
        assert.ok(Math.abs(exhaust + bypassFlow(row) - (recirculated + coldAisleFlow(row))) < 1e-9, 'hot aisle: exhaust and bypass in, recirculation and return out');
    }
    const returned = c.rows.reduce((total, row) => total + coldAisleFlow(row), 0);
    assert.ok(Math.abs(c.coolingUnits * unitFlow() - returned) < 1e-9, 'room and plenum: the cooling units move what the aisles return');
    const { document } = buildDataCentre();
    assert.equal(document.nodes.length, 26);
});

test('the Cauer filter\'s inverse capacitance matrix inverts it', () => {
    const { c1, c2, c3, c4, c5 } = modelicaConstants.cauerLowPass;
    const matrix = [[c1 + c2, -c2, 0], [-c2, c2 + c3 + c4, -c4], [0, -c4, c4 + c5]];
    const inverse = cauerInverseCapacitance();
    for (let row = 0; row < 3; ++row) {
        for (let column = 0; column < 3; ++column) {
            const product = matrix[row].reduce((total, value, k) => total + value * inverse[k][column], 0);
            assert.ok(Math.abs(product - (row === column ? 1 : 0)) < 1e-12);
        }
    }
});

test('every engineering reference records how it was made', () => {
    for (const problem of ['electrical/switchedCircuits', 'thermal/heatExchanger', 'fluid/pipeNetwork', 'multiDomain/dcMotor', 'showcase/dataCentre', 'modelica/standardLibrary', 'fmi/referenceFmus']) {
        const { provenance } = JSON.parse(readFileSync(join(benchmarks, problem, 'reference.json'), 'utf8'));
        assert.equal(provenance.generator, `benchmarks/${problem}/generateReference.py`, problem);
        assert.ok(provenance.method && provenance.python && provenance.numpy, `${problem} records its method and versions`);
    }
});
