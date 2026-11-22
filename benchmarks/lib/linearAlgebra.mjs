/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Dense linear algebra for the benchmarks' analytic references: small matrices only (a dozen states at most), written out plainly so a
// reader can check them. The matrix exponential is Higham's scaling and squaring with a degree 13 Padé approximant ("The scaling and
// squaring method for the matrix exponential revisited", SIAM J. Matrix Anal. Appl. 26(4), 2005), the method behind MATLAB's expm and
// SciPy's scipy.linalg.expm, which the reference generator uses to check these numbers independently.

export function identity(size) {
    return Array.from({ length: size }, (_unused, row) => Array.from({ length: size }, (_unusedColumn, column) => (row === column ? 1 : 0)));
}

export function add(left, right, scale = 1) {
    return left.map((row, i) => row.map((value, j) => value + scale * right[i][j]));
}

export function scaled(matrix, factor) {
    return matrix.map((row) => row.map((value) => value * factor));
}

export function multiply(left, right) {
    const rows = left.length;
    const inner = right.length;
    const columns = right[0].length;
    const product = Array.from({ length: rows }, () => new Array(columns).fill(0));
    for (let i = 0; i < rows; ++i) {
        for (let k = 0; k < inner; ++k) {
            const factor = left[i][k];
            if (factor === 0) continue;
            for (let j = 0; j < columns; ++j) product[i][j] += factor * right[k][j];
        }
    }
    return product;
}

export function multiplyVector(matrix, vector) {
    return matrix.map((row) => row.reduce((sum, value, j) => sum + value * vector[j], 0));
}

function oneNorm(matrix) {
    let largest = 0;
    for (let j = 0; j < matrix[0].length; ++j) {
        let column = 0;
        for (let i = 0; i < matrix.length; ++i) column += Math.abs(matrix[i][j]);
        largest = Math.max(largest, column);
    }
    return largest;
}

// Solves left · X = right for X (right may have several columns), by Gaussian elimination with partial pivoting.
export function solve(left, right) {
    const size = left.length;
    const a = left.map((row) => row.slice());
    const b = right.map((row) => row.slice());
    for (let column = 0; column < size; ++column) {
        let pivot = column;
        for (let row = column + 1; row < size; ++row) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
        if (a[pivot][column] === 0) throw new Error('The matrix is singular.');
        [a[column], a[pivot]] = [a[pivot], a[column]];
        [b[column], b[pivot]] = [b[pivot], b[column]];
        for (let row = column + 1; row < size; ++row) {
            const factor = a[row][column] / a[column][column];
            if (factor === 0) continue;
            for (let j = column; j < size; ++j) a[row][j] -= factor * a[column][j];
            for (let j = 0; j < b[0].length; ++j) b[row][j] -= factor * b[column][j];
        }
    }
    for (let row = size - 1; row >= 0; --row) {
        for (let j = 0; j < b[0].length; ++j) {
            let sum = b[row][j];
            for (let k = row + 1; k < size; ++k) sum -= a[row][k] * b[k][j];
            b[row][j] = sum / a[row][row];
        }
    }
    return b;
}

const padeCoefficients = [
    64764752532480000, 32382376266240000, 7771770303897600, 1187353796428800, 129060195264000, 10559470521600,
    670442572800, 33522128640, 1323241920, 40840800, 960960, 16380, 182, 1
];
const theta13 = 5.371920351148152;

export function expm(matrix) {
    const size = matrix.length;
    const norm = oneNorm(matrix);
    const squarings = norm > theta13 ? Math.max(0, Math.ceil(Math.log2(norm / theta13))) : 0;
    const a = scaled(matrix, 2 ** -squarings);
    const b = padeCoefficients;
    const unit = identity(size);
    const a2 = multiply(a, a);
    const a4 = multiply(a2, a2);
    const a6 = multiply(a4, a2);
    const combine = (terms) => terms.reduce((sum, [factor, term]) => add(sum, term, factor), Array.from({ length: size }, () => new Array(size).fill(0)));
    const uInner = multiply(a6, combine([[b[13], a6], [b[11], a4], [b[9], a2]]));
    const u = multiply(a, add(uInner, combine([[b[7], a6], [b[5], a4], [b[3], a2], [b[1], unit]])));
    const vInner = multiply(a6, combine([[b[12], a6], [b[10], a4], [b[8], a2]]));
    const v = add(vInner, combine([[b[6], a6], [b[4], a4], [b[2], a2], [b[0], unit]]));
    let result = solve(add(v, u, -1), add(v, u));
    for (let index = 0; index < squarings; ++index) result = multiply(result, result);
    return result;
}

// The exact solution of the affine system x' = A x + b from x(0) = x0, at each of `times`: the exponential of the augmented matrix
// [[A, b], [0, 0]] carries the constant forcing exactly, with no inverse of A needed. The system is solved for z = x - offset, whose
// forcing is b + A · offset: an offset near the solution (a temperature network's ambient, say) keeps the augmented matrix's norm, and
// with it the rounding error of the exponential, small.
export function affineSolution(systemMatrix, forcing, initial, times, offset = new Array(systemMatrix.length).fill(0)) {
    const size = systemMatrix.length;
    const shifted = multiplyVector(systemMatrix, offset).map((value, i) => value + forcing[i]);
    const augmented = systemMatrix.map((row, i) => [...row, shifted[i]]);
    augmented.push(new Array(size + 1).fill(0));
    const start = [...initial.map((value, i) => value - offset[i]), 1];
    return times.map((time) => multiplyVector(expm(scaled(augmented, time)), start).slice(0, size).map((value, i) => value + offset[i]));
}

// The equilibrium of x' = A x + b: A x* = -b.
export function affineEquilibrium(systemMatrix, forcing) {
    return solve(systemMatrix, forcing.map((value) => [-value])).map((row) => row[0]);
}
