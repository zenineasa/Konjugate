/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Every benchmark problem, in the order the results list them. Each is a directory benchmarks/<category>/<problem>/ holding problem.mjs
// (its model, reference and evaluation), benchmark.json (its runs, horizons and thresholds), its .kjt models and, where it has one,
// reference.json (numerical reference data and how it was made).

import * as rcNetwork from './thermal/rcNetwork/problem.mjs';
import * as rlcCircuits from './electrical/rlcCircuits/problem.mjs';
import * as harmonicOscillator from './mechanical/harmonicOscillator/problem.mjs';
import * as pendulum from './mechanical/pendulum/problem.mjs';
import * as lotkaVolterra from './population/lotkaVolterra/problem.mjs';
import * as graphSplit from './coupling/graphSplit/problem.mjs';
import * as convergenceOrder from './verification/convergenceOrder/problem.mjs';

export const problems = [
    { id: 'thermal/rcNetwork', directory: rcNetwork.directory, models: rcNetwork.models, evaluate: rcNetwork.evaluate },
    { id: 'electrical/rlcCircuits', directory: rlcCircuits.directory, models: rlcCircuits.models, evaluate: rlcCircuits.evaluate },
    { id: 'mechanical/harmonicOscillator', directory: harmonicOscillator.directory, models: harmonicOscillator.models, evaluate: harmonicOscillator.evaluate },
    { id: 'mechanical/pendulum', directory: pendulum.directory, models: pendulum.models, evaluate: pendulum.evaluate },
    { id: 'population/lotkaVolterra', directory: lotkaVolterra.directory, models: lotkaVolterra.models, evaluate: lotkaVolterra.evaluate },
    { id: 'verification/convergenceOrder', directory: convergenceOrder.directory, models: {}, evaluate: convergenceOrder.evaluate },
    { id: 'coupling/graphSplit', directory: graphSplit.directory, models: graphSplit.models, evaluate: graphSplit.evaluate }
];
