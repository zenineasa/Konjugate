# Copyright © 2026 Zenin Easa Panthakkalakath
#
# SciPy's solve_ivp on the comparison problems (benchmarks/comparisons/problems.mjs), served to compare.mjs one round at a time: for each
# tolerance an untimed warm-up solve, then one timed solve of the solve alone (time.perf_counter around solve_ivp), preceded by the quiet
# gate when one is given; the work SciPy counts (evaluations, Jacobians, LU factorisations) and the error against the reference.
#
#   python -I scipyRunner.py --serve [--quiet-command "node benchmarks/lib/quiet.mjs --wait"]    commands as JSON lines on stdin
#   python -I scipyRunner.py --spec spec.json --reference --output reference.json      (Robertson: Radau and BDF at rtol 1e-12)
#
# The equations are written here again from the problem's kind and parameters, as problems.mjs states them. The implicit methods (Radau,
# BDF, LSODA) are given the exact Jacobian, sparse for the large grids (LSODA takes only a dense one), as Konjugate's Stiff and BDF work
# with exact Jacobians by default. Output is at the problem's samples through t_eval (SciPy's dense output).

import argparse
import json
import math
import os
import platform
import shlex
import subprocess
import sys
import time

import numpy as np
import scipy
from scipy.integrate import solve_ivp
from scipy import sparse


def system(spec, switching=None):
    kind = spec['kind']
    p = spec['parameters']
    if kind == 'robertson':
        k1, k2, k3 = p['k1'], p['k2'], p['k3']

        def f(t, y):
            a, b, c = y
            return np.array([-k1 * a + k3 * b * c, k1 * a - k3 * b * c - k2 * b * b, k2 * b * b])

        def jac(t, y):
            a, b, c = y
            return np.array([[-k1, k3 * c, k3 * b], [k1, -k3 * c - 2 * k2 * b, -k3 * b], [0.0, 2 * k2 * b, 0.0]])
        return f, jac
    if kind == 'vanDerPol':
        mu = p['mu']

        def f(t, y):
            x, v = y
            return np.array([v, mu * (1 - x * x) * v - x])

        def jac(t, y):
            x, v = y
            return np.array([[0.0, 1.0], [-2 * mu * x * v - 1, mu * (1 - x * x)]])
        return f, jac
    if kind == 'lorenz':
        sigma, rho, beta = p['sigma'], p['rho'], p['beta']

        def f(t, y):
            x, v, z = y
            return np.array([sigma * (v - x), x * (rho - z) - v, x * v - beta * z])

        def jac(t, y):
            x, v, z = y
            return np.array([[-sigma, sigma, 0.0], [rho - z, -1.0, -x], [v, x, -beta]])
        return f, jac
    if kind == 'linear':
        n = len(p['rows'])
        rows, cols, vals = [], [], []
        for i, row in enumerate(p['rows']):
            for j, value in row:
                rows.append(i)
                cols.append(j)
                vals.append(value)
        matrix = sparse.csr_matrix((vals, (rows, cols)), shape=(n, n))
        forcing = np.array(p['forcing'], dtype=float)
        if not spec.get('sparse'):
            dense = matrix.toarray()

            def f(t, y):
                return dense @ y + forcing
            return f, (lambda t, y: dense)

        def f(t, y):
            return matrix @ y + forcing
        return f, (lambda t, y: matrix)
    if kind == 'buck':
        vin, L, C, R = p['inputVoltage'], p['inductance'], p['capacitance'], p['load']
        r = p['windingResistance'] + p['switchResistance']
        omega = 2 * math.pi * p['frequency']
        phase = math.pi * p['duty']
        threshold = math.cos(phase)

        def make(s_of_t):
            def f(t, y):
                i, v = y[0], y[1]
                s = s_of_t(t)
                return np.array([(s * vin - r * i - v) / L, (i - v / R) / C, s * vin * i, r * i * i, v * v / R])

            def jac(t, y):
                i, v = y[0], y[1]
                s = s_of_t(t)
                return np.array([[-r / L, -1 / L, 0, 0, 0], [1 / C, -1 / (R * C), 0, 0, 0], [s * vin, 0, 0, 0, 0], [2 * r * i, 0, 0, 0, 0], [0, 2 * v / R, 0, 0, 0]], dtype=float)
            return f, jac
        if switching is None:
            return make(lambda t: 1.0 if math.cos(omega * t - phase) >= threshold else 0.0)
        return make(lambda t: switching[0])
    raise ValueError(f'unknown kind {kind}')


def relative_error(computed, reference, compared):
    worst = 0.0
    for column, state in enumerate(compared):
        ref = reference[:, column]
        span = ref.max() - ref.min()
        err = np.abs(computed[:, state] - ref).max()
        if not np.isfinite(err):
            return math.inf
        worst = max(worst, err / span if span > 0 else (0.0 if err == 0 else math.inf))
    return worst


def switching_intervals(spec):
    p = spec['parameters']
    period = 1 / p['frequency']
    end = spec['run']['targetTime']
    edges = []
    k = 0
    while k * period < end:
        edges.append((k * period, 1.0))
        if k * period + p['duty'] * period < end:
            edges.append((k * period + p['duty'] * period, 0.0))
        k += 1
    return [(start, edges[index + 1][0] if index + 1 < len(edges) else end, s) for index, (start, s) in enumerate(edges)]


def solve(spec, method, rtol, switching_mode):
    times = np.array(spec['times'])
    atol = np.array(spec['absoluteScale']) * rtol
    y0 = np.array(spec['initial'], dtype=float)
    implicit = method in ('Radau', 'BDF', 'LSODA')
    work = {'nfev': 0, 'njev': 0, 'nlu': 0}

    def one(f, jac, span, y, t_eval):
        options = {'method': method, 'rtol': rtol, 'atol': atol, 't_eval': t_eval}
        if implicit:
            if method == 'LSODA' and sparse.issparse(jac(span[0], y)):
                options['jac'] = lambda t, z: jac(t, z).toarray()
            else:
                options['jac'] = jac
        result = solve_ivp(f, span, y, **options)
        for key in work:
            work[key] += int(getattr(result, key, 0) or 0)
        if not result.success:
            raise RuntimeError(result.message)
        return result

    if spec['kind'] == 'buck' and switching_mode == 'given':
        # Integrated interval by interval between the known switching instants, the switch constant in each.
        samples = np.empty((len(times), len(y0)))
        samples[0] = y0
        y = y0
        state = [1.0]
        for start, end, s in switching_intervals(spec):
            state[0] = s
            f, jac = system(spec, switching=state)
            inside = times[(times > start) & (times <= end)]
            result = one(f, jac, (start, end), y, np.concatenate([inside, [end]]) if len(inside) == 0 or inside[-1] != end else inside)
            for t_value, column in zip(result.t, result.y.T):
                index = np.searchsorted(times, t_value)
                if index < len(times) and times[index] == t_value and t_value > start:
                    samples[index] = column
            y = result.y[:, -1]
        return samples, work
    f, jac = system(spec)
    result = one(f, jac, (times[0], times[-1]), y0, times)
    return result.y.T, work


class QuietCheckFailed(Exception):
    pass


def quiet(command):
    # The quiet check before a timed run. Its exit is 0 once the computer is quiet, after waiting or not; anything else is a refusal or
    # an error. Its output goes to our stderr and it reads nothing: our stdout and stdin are the JSON-lines protocol with compare.mjs.
    if not command:
        return
    sys.stdout.flush()
    result = subprocess.run(shlex.split(command), stdin=subprocess.DEVNULL, stdout=sys.stderr.fileno(), stderr=sys.stderr.fileno())
    if result.returncode != 0:
        raise QuietCheckFailed(f'the quiet check before the timed run failed (exit {result.returncode}): {command}')


def measure(spec, method, switching_mode, quiet_command, skip=(), first_seen=None):
    # One round: for each tolerance not skipped, an untimed warm-up solve, then one timed solve preceded by the quiet gate. The first
    # solve this process makes of a configuration is reported as firstSolveSeconds.
    reference = np.array(spec['reference']['samples'])
    records = []
    over_budget = False
    for rtol in spec['tolerances']:
        record = {'tool': 'SciPy', 'method': method, 'tolerance': rtol, 'switching': switching_mode}
        if rtol in skip or over_budget:
            continue
        try:
            started = time.perf_counter()
            samples, work = solve(spec, method, rtol, switching_mode)
            warm = time.perf_counter() - started
            key = (spec['id'], method, switching_mode, rtol)
            if first_seen is not None and key not in first_seen:
                first_seen[key] = warm
                record['firstSolveSeconds'] = warm
            quiet(quiet_command)
            started = time.perf_counter()
            samples, work = solve(spec, method, rtol, switching_mode)
            record.update({'ok': True, 'solveSeconds': [time.perf_counter() - started], 'work': work,
                           'relativeError': relative_error(samples, reference, spec['compared'])})
            over_budget = record['solveSeconds'][0] > 120
        except Exception as error:  # a solver failure is a result: recorded with its message
            record.update({'ok': False, 'error': str(error)[:300]})
        records.append(record)
        print(f"  SciPy {method} {spec['id']} rtol {rtol:g}: " + (f"{record['solveSeconds'][0] * 1e3:.2f} ms, error {record['relativeError']:.2e}" if record['ok'] else record['error']), file=sys.stderr, flush=True)
    return records


def reference_mode(spec):
    # Robertson's reference at the samples: Radau with the exact Jacobian at rtol 1e-12 and the committed reference's absolute
    # tolerances, restarted at every sample so no sample is interpolated; BDF the same as a check.
    times = spec['times']
    f, jac = system(spec)
    atol = [1e-20, 1e-26, 1e-20]
    out = {}
    for method in ('Radau', 'BDF'):
        y = np.array(spec['initial'], dtype=float)
        samples = [y.tolist()]
        for start, end in zip(times[:-1], times[1:]):
            result = solve_ivp(f, (start, end), y, method=method, jac=jac, rtol=1e-12, atol=atol)
            if not result.success:
                raise RuntimeError(result.message)
            y = result.y[:, -1]
            samples.append(y.tolist())
        out[method] = samples
    radau = np.array(out['Radau'])
    agreement = relative_error(np.array(out['BDF']), radau, [0, 1, 2])
    checkpoints = spec['reference']['checkpoints']
    against = []
    for t_value, state in zip(checkpoints['times'], checkpoints['states']):
        if t_value in times:
            row = radau[times.index(t_value)]
            against.append(max(abs(row[k] - state[k]) / max(abs(state[k]), 1e-300) for k in range(3)))
    return {'samples': out['Radau'], 'source': 'SciPy solve_ivp Radau with the exact Jacobian, rtol 1e-12, atol 1e-20/1e-26/1e-20, restarted at every sample',
            'radauBdfAgreement': agreement, 'largestRelativeDifferenceFromCommittedCheckpoints': max(against) if against else None,
            'checkpointsCompared': len(against), 'versions': versions()}


def versions():
    return {'python': platform.python_version(), 'numpy': np.__version__, 'scipy': scipy.__version__}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--spec')
    parser.add_argument('--output')
    parser.add_argument('--reference', action='store_true')
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--quiet-command', default='')
    args = parser.parse_args()
    if args.reference:
        with open(args.spec) as handle:
            spec = json.load(handle)
        with open(args.output, 'w') as handle:
            json.dump(reference_mode(spec), handle)
        return 0
    # --serve: one command per line on stdin, {"spec": path, "method", "switching", "skip": [tolerances]}; one line of JSON back per command.
    specs = {}
    first_seen = {}
    print(json.dumps({'ready': True, 'versions': versions()}), flush=True)
    for line in sys.stdin:
        command = json.loads(line)
        if command['spec'] not in specs:
            with open(command['spec']) as handle:
                specs[command['spec']] = json.load(handle)
        records = measure(specs[command['spec']], command['method'], command.get('switching', 'written'), args.quiet_command, set(command.get('skip', [])), first_seen)
        print(json.dumps({'records': records}), flush=True)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except BrokenPipeError:
        # compare.mjs has stopped reading: nothing more can be reported, and it says why itself.
        sys.stderr.write('scipyRunner.py: compare.mjs closed the protocol pipe; stopping.\n')
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        sys.exit(1)
