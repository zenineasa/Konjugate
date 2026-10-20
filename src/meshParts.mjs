/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A node's body parts (`appearance.parts`, see docs/projectSchema.md) as the canvas edits them: each the shape of one
// body whose pose the node reports among its states (`<prefix>X`, `<prefix>Y`, `<prefix>Z` and a turn), as a mesh
// `{ position, normal, index }` in metres in the body's own frame. Pure functions of their arguments.

export const partPrefixPattern = /^([a-z][A-Za-z0-9]*)?$/;

// A mesh from a geometry's flat arrays, scaled to metres (`scale` is metres per file unit: 0.001 for millimetres).
// Without an index, every three positions are a triangle; without normals, each triangle's own is used.
export function meshFromArrays(position, normal, index, scale = 1) {
    if (!position?.length || position.length % 3) throw new Error('The file contains no usable geometry.');
    const vertexCount = position.length / 3;
    const triangles = index?.length ? Array.from(index) : Array.from({ length: vertexCount }, (_, vertex) => vertex);
    if (triangles.length % 3 || triangles.some((vertex) => vertex >= vertexCount)) throw new Error('The file\'s triangles are malformed.');
    const round = (value) => Math.round(value * 1e9) / 1e9;
    let normals = normal?.length === position.length ? Array.from(normal, round) : null;
    if (!normals) {
        normals = new Array(position.length).fill(0);
        for (let triangle = 0; triangle < triangles.length; triangle += 3) {
            const [a, b, c] = triangles.slice(triangle, triangle + 3).map((vertex) => [0, 1, 2].map((axis) => position[3 * vertex + axis]));
            const u = [0, 1, 2].map((axis) => b[axis] - a[axis]);
            const v = [0, 1, 2].map((axis) => c[axis] - a[axis]);
            const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            const length = Math.hypot(...n) || 1;
            for (const vertex of triangles.slice(triangle, triangle + 3)) for (let axis = 0; axis < 3; axis += 1) normals[3 * vertex + axis] = round(n[axis] / length);
        }
    }
    return { position: Array.from(position, (value) => round(value * scale)), normal: normals, index: triangles };
}

// Why the parts cannot be shown as written, per part, and what a visualizer will do with them.
export function partProblems(parts, stateSymbols) {
    const seen = new Set();
    const symbols = new Set(stateSymbols);
    return parts.map((part) => {
        const errors = [];
        const notes = [];
        const prefix = part.prefix ?? '';
        if (!partPrefixPattern.test(prefix)) errors.push(`"${prefix}" is not a valid prefix: start with a lowercase letter and use only letters and digits, or leave it empty.`);
        else if (seen.has(prefix)) errors.push(`Two parts have the prefix "${prefix}".`);
        seen.add(prefix);
        if (!part.mesh?.position?.length) errors.push('Choose a mesh file for this part.');
        const name = (axis) => (prefix ? `${prefix}${axis}` : axis.toLowerCase());
        const missing = ['X', 'Y', 'Z'].map(name).filter((symbol) => !symbols.has(symbol));
        if (!errors.length && missing.length) notes.push(`This node has no state ${missing.join(', ')}: a visualizer places the part at the origin along ${missing.length === 1 ? 'that axis' : 'those axes'}.`);
        return { errors, notes };
    });
}

export function triangleCount(mesh) {
    return Math.floor((mesh?.index?.length ?? 0) / 3);
}
