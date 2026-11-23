/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Generated graphs for the scaling benchmark: the same physics at any number of nodes, written as an ordinary Konjugate project, one node
// per thermal mass and one relationship per direction of each conduction path. Nothing here is committed as a .kjt; the benchmark builds
// each model when it runs, and the command line writes one to open in Konjugate:
//
//   node benchmarks/scaling/graphScalability/graphs.mjs <chain | grid | random> <nodes> <output.kjt>
//
// Families (temperatures are measured from a fixed ambient of 0, in kelvin; time in seconds):
//
//   chain   n masses in a row, each joined to its neighbours, the two ends also to the ambient:
//               dT_i/dt = (T_{i-1} - T_i) + (T_{i+1} - T_i),   T_0 = T_{n+1} = 0
//   grid    an m × m sheet (n = m²), each mass joined to its four neighbours, the edge masses to the ambient in place of a missing one:
//               dT_ij/dt = Σ_neighbours (T_neighbour - T_ij),   the ambient 0 beyond the edge
//   random  a random sparse network: a ring through every node (so the network is connected) and n further paths between random pairs
//           (an average of four neighbours), conductance g ∈ [0.5, 1.5] W/K, capacity C ∈ [1, 2] J/K, no ambient:
//               C_i dT_i/dt = Σ_j g_ij (T_j - T_i)
//
// The chain and the grid are solved exactly. Their system matrix is the discrete Laplacian with zero boundary values, whose eigenvectors are
// products of sines: for a side of n masses, mode k is sin(kπ(i+1)/(n+1)) with eigenvalue -2(1 - cos(kπ/(n+1))), and a grid's mode is the
// product of one per side with the sum of their eigenvalues. Each starts as a sum of three modes (the slowest, a middle one and the fastest),
// so its exact motion is three decaying exponentials at every node, and so is every fixed-step method's: explicit Euler multiplies a mode
// by 1 + hλ per step, Runge–Kutta 4 by 1 + z + z²/2 + z³/6 + z⁴/24 with z = hλ. Konjugate's numbers can therefore be checked at any size
// both against the exact solution of the equations (the method's error) and against the exact result of the method itself (that the
// engine computes what the method says, to rounding).
//
// The random network has no closed form. Its total heat Σ C_i T_i is conserved exactly by the equations and, being linear, by both methods,
// so it is checked from Konjugate's own states; its numbers are checked against the same method stepped independently here, and for small
// networks against the matrix exponential.

import { writeFile } from 'node:fs/promises';
import { encodeProjectFile } from '../../../src/projectFile.mjs';
import { createModel, difference, negate, product, state } from '../../lib/project.mjs';
import { integerBelow, mulberry32, uniform } from '../../lib/random.mjs';

export const families = ['chain', 'grid', 'random'];

// The three starting modes of a side of n masses, and their amplitudes.
const modeAmplitudes = [1, 0.5, 0.25];
const sideModes = (n) => [1, Math.ceil(n / 2), n];
const sine = (k, i, n) => Math.sin((k * Math.PI * (i + 1)) / (n + 1));
const eigenvalue = (k, n) => -2 * (1 - Math.cos((k * Math.PI) / (n + 1)));

// The growth of a mode of eigenvalue λ over one step h of each method, exactly.
export const amplification = {
    explicitEuler: (z) => 1 + z,
    rungeKutta4: (z) => 1 + z + (z * z) / 2 + (z * z * z) / 6 + (z * z * z * z) / 24
};

// The side lengths of a family's lattice for a requested number of nodes.
export function latticeSides(family, size) {
    if (family === 'chain') return [size];
    if (family === 'grid') {
        const side = Math.round(Math.sqrt(size));
        return [side, side];
    }
    throw new Error(`${family} is not a lattice.`);
}

// The system in the form the engine evaluates it, node by node: dT_i/dt = Σ_k coefficient_k (T_neighbour_k - T_i) + own_i T_i, the
// neighbours of node i at offsets[i] to offsets[i + 1].
function compressed(nodeCount, neighbourLists, own) {
    const offsets = new Int32Array(nodeCount + 1);
    neighbourLists.forEach((list, index) => { offsets[index + 1] = offsets[index] + list.length; });
    const neighbours = new Int32Array(offsets[nodeCount]);
    const coefficients = new Float64Array(offsets[nodeCount]);
    neighbourLists.forEach((list, index) => list.forEach(([other, coefficient], position) => {
        neighbours[offsets[index] + position] = other;
        coefficients[offsets[index] + position] = coefficient;
    }));
    return { nodeCount, offsets, neighbours, coefficients, own };
}

function latticeGraph(family, size) {
    const sides = latticeSides(family, size);
    const nodeCount = sides.reduce((total, side) => total * side, 1);
    const coordinates = (index) => (sides.length === 1 ? [index] : [index % sides[0], Math.floor(index / sides[0])]);
    const indexOf = (coordinate) => (sides.length === 1 ? coordinate[0] : coordinate[0] + coordinate[1] * sides[0]);
    const neighbourLists = [];
    const own = new Float64Array(nodeCount);
    for (let index = 0; index < nodeCount; ++index) {
        const coordinate = coordinates(index);
        const list = [];
        sides.forEach((side, axis) => {
            for (const delta of [-1, 1]) {
                const moved = coordinate.slice();
                moved[axis] += delta;
                if (moved[axis] < 0 || moved[axis] >= side) own[index] -= 1;
                else list.push([indexOf(moved), 1]);
            }
        });
        neighbourLists.push(list);
    }
    // The starting modes: mode m takes the same index on every side.
    const modes = modeAmplitudes.map((amplitude, position) => {
        const ks = sides.map((side) => sideModes(side)[position]);
        return { amplitude, ks, eigenvalue: ks.reduce((total, k, axis) => total + eigenvalue(k, sides[axis]), 0) };
    });
    const shape = (mode, index) => coordinates(index).reduce((value, coordinate, axis) => value * sine(mode.ks[axis], coordinate, sides[axis]), 1);
    // The temperature of every node when each mode has grown by factor(mode).
    const field = (factor) => {
        const values = new Float64Array(nodeCount);
        for (const mode of modes) {
            const scale = mode.amplitude * factor(mode);
            for (let index = 0; index < nodeCount; ++index) values[index] += scale * shape(mode, index);
        }
        return values;
    };
    return {
        family, nodeCount, sides, system: compressed(nodeCount, neighbourLists, own), initial: field(() => 1), capacities: null,
        positions: (index) => { const [x, y = 0] = coordinates(index); return [x * 1.5, y * 1.5, 0]; },
        // Exact solution of the equations at time t.
        exact: (time) => field((mode) => Math.exp(mode.eigenvalue * time)),
        // Exact result of a fixed-step method after `steps` steps of h.
        discrete: (method, step, steps) => field((mode) => amplification[method](step * mode.eigenvalue) ** steps),
        largestEigenvalueMagnitude: 4 * sides.length
    };
}

function randomGraph(size, seed) {
    const random = mulberry32(seed);
    const nodeCount = size;
    const capacities = Float64Array.from({ length: nodeCount }, () => uniform(random, 1, 2));
    const initial = Float64Array.from({ length: nodeCount }, () => uniform(random, -1, 1));
    const pairs = new Map();
    const key = (a, b) => (a < b ? a * nodeCount + b : b * nodeCount + a);
    const join = (a, b) => { if (a !== b && !pairs.has(key(a, b))) pairs.set(key(a, b), [Math.min(a, b), Math.max(a, b), uniform(random, 0.5, 1.5)]); };
    for (let index = 0; index < nodeCount; ++index) join(index, (index + 1) % nodeCount);
    const wanted = pairs.size + nodeCount;
    while (pairs.size < wanted) join(integerBelow(random, nodeCount), integerBelow(random, nodeCount));
    const neighbourLists = Array.from({ length: nodeCount }, () => []);
    for (const [a, b, conductance] of pairs.values()) {
        neighbourLists[a].push([b, conductance / capacities[a]]);
        neighbourLists[b].push([a, conductance / capacities[b]]);
    }
    const positions = Array.from({ length: nodeCount }, () => [uniform(random, 0, 1.5 * Math.sqrt(nodeCount)), uniform(random, 0, 1.5 * Math.sqrt(nodeCount)), 0]);
    // Gershgorin: every eigenvalue lies within twice the largest row sum of the coefficients.
    let bound = 0;
    neighbourLists.forEach((list) => { bound = Math.max(bound, 2 * list.reduce((total, [, coefficient]) => total + coefficient, 0)); });
    return {
        family: 'random', nodeCount, sides: null, system: compressed(nodeCount, neighbourLists, new Float64Array(nodeCount)), initial, capacities,
        positions: (index) => positions[index], exact: null, discrete: null, largestEigenvalueMagnitude: bound, pathCount: pairs.size
    };
}

export function generateGraph(family, size, { seed = 20261123 } = {}) {
    if (family === 'random') return randomGraph(size, seed);
    if (family === 'chain' || family === 'grid') return latticeGraph(family, size);
    throw new Error(`Unknown graph family ${family}; expected one of ${families.join(', ')}.`);
}

// The number of contributions (relationships and source terms) the engine evaluates per node substep, summed over nodes.
export function contributionCount(graph) {
    let own = 0;
    for (let index = 0; index < graph.nodeCount; ++index) if (graph.system.own[index] !== 0) own += 1;
    return graph.system.offsets[graph.nodeCount] + own;
}

// The graph as a Konjugate project document, and its states' IDs in node order.
export function graphDocument(graph, { globalTimeStep, outputInterval }) {
    const titles = { chain: 'a thermal chain', grid: 'a thermal grid', random: 'a random thermal network' };
    const model = createModel(`Benchmark: ${titles[graph.family]} of ${graph.nodeCount} nodes`);
    const { offsets, neighbours, coefficients, own } = graph.system;
    const nodes = [];
    for (let index = 0; index < graph.nodeCount; ++index) {
        const node = model.node(`Mass ${index + 1}`, { type: 'Thermal mass', position: graph.positions(index), color: '#c0704d', states: [['temperature', 'Temperature', graph.initial[index], 'K']] });
        if (own[index] !== 0) {
            const loss = own[index] === -1 ? negate('temperature') : negate(product(-own[index], 'temperature'));
            model.sourceTerm(node, 'temperature', loss, { temperature: state(node, 'temperature') });
        }
        nodes.push(node);
    }
    for (let index = 0; index < graph.nodeCount; ++index) {
        for (let position = offsets[index]; position < offsets[index + 1]; ++position) {
            const other = neighbours[position];
            const flow = difference('otherTemperature', 'ownTemperature');
            model.edge(`Conduction from mass ${other + 1} to mass ${index + 1}`, nodes[other], nodes[index], 'temperature', coefficients[position] === 1 ? flow : product(coefficients[position], flow), {
                otherTemperature: state(nodes[other], 'temperature'), ownTemperature: state(nodes[index], 'temperature')
            });
        }
    }
    return { document: model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep, outputInterval } }), stateIds: nodes.map((node) => node.stateIds.temperature) };
}

export async function writeGraphModel(graph, path, run) {
    const { document, stateIds } = graphDocument(graph, run);
    await writeFile(path, await encodeProjectFile(JSON.stringify(document)));
    return stateIds;
}

// The method stepped here, independently of the engine, over the whole vector of temperatures: the reference for a graph with no closed
// form. Sums each node's flows in the order the model lists its relationships, as the engine does, so the two differ by rounding only.
export function stepIndependently(graph, method, step, steps) {
    const { nodeCount, offsets, neighbours, coefficients, own } = graph.system;
    const rate = (values, out) => {
        for (let index = 0; index < nodeCount; ++index) {
            let total = 0;
            for (let position = offsets[index]; position < offsets[index + 1]; ++position) total += coefficients[position] * (values[neighbours[position]] - values[index]);
            out[index] = total + own[index] * values[index];
        }
        return out;
    };
    let values = Float64Array.from(graph.initial);
    const k1 = new Float64Array(nodeCount), k2 = new Float64Array(nodeCount), k3 = new Float64Array(nodeCount), k4 = new Float64Array(nodeCount), stage = new Float64Array(nodeCount);
    for (let count = 0; count < steps; ++count) {
        rate(values, k1);
        if (method === 'explicitEuler') {
            for (let index = 0; index < nodeCount; ++index) values[index] += step * k1[index];
            continue;
        }
        for (let index = 0; index < nodeCount; ++index) stage[index] = values[index] + (step / 2) * k1[index];
        rate(stage, k2);
        for (let index = 0; index < nodeCount; ++index) stage[index] = values[index] + (step / 2) * k2[index];
        rate(stage, k3);
        for (let index = 0; index < nodeCount; ++index) stage[index] = values[index] + step * k3[index];
        rate(stage, k4);
        const next = new Float64Array(nodeCount);
        for (let index = 0; index < nodeCount; ++index) next[index] = values[index] + (step / 6) * (k1[index] + 2 * k2[index] + 2 * k3[index] + k4[index]);
        values = next;
    }
    return values;
}

// The system as a dense matrix, for the matrix exponential of a small graph.
export function denseMatrix(graph) {
    const { nodeCount, offsets, neighbours, coefficients, own } = graph.system;
    const matrix = Array.from({ length: nodeCount }, () => new Array(nodeCount).fill(0));
    for (let index = 0; index < nodeCount; ++index) {
        matrix[index][index] += own[index];
        for (let position = offsets[index]; position < offsets[index + 1]; ++position) {
            matrix[index][neighbours[position]] += coefficients[position];
            matrix[index][index] -= coefficients[position];
        }
    }
    return matrix;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const [family, size, path] = process.argv.slice(2);
    if (!family || !size || !path) {
        console.error('Usage: node benchmarks/scaling/graphScalability/graphs.mjs <chain | grid | random> <nodes> <output.kjt>');
        process.exit(64);
    }
    const graph = generateGraph(family, Number(size));
    await writeGraphModel(graph, path, { globalTimeStep: 0.02, outputInterval: 0.5 });
    console.log(`Wrote ${path}: ${graph.nodeCount} nodes, ${graph.system.offsets[graph.nodeCount]} relationships.`);
}
