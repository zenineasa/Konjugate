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
import * as protheroRobinson from './verification/protheroRobinson/problem.mjs';
import * as graphScalability from './scaling/graphScalability/problem.mjs';
import * as causalReconstruction from './causal/reconstruction/problem.mjs';
import * as vanDerPol from './oscillators/vanDerPol/problem.mjs';
import * as robertson from './chemistry/robertson/problem.mjs';
import * as lorenz from './chaos/lorenz/problem.mjs';
import * as doublePendulum from './mechanical/doublePendulum/problem.mjs';
import * as bouncingBall from './mechanical/bouncingBall/problem.mjs';
import * as switchedCircuits from './electrical/switchedCircuits/problem.mjs';
import * as heatExchanger from './thermal/heatExchanger/problem.mjs';
import * as pipeNetwork from './fluid/pipeNetwork/problem.mjs';
import * as dcMotor from './multiDomain/dcMotor/problem.mjs';
import * as dataCentre from './showcase/dataCentre/problem.mjs';
import * as standardLibrary from './modelica/standardLibrary/problem.mjs';
import * as referenceFmus from './fmi/referenceFmus/problem.mjs';

export const problems = [
    { id: 'thermal/rcNetwork', directory: rcNetwork.directory, models: rcNetwork.models, evaluate: rcNetwork.evaluate },
    { id: 'electrical/rlcCircuits', directory: rlcCircuits.directory, models: rlcCircuits.models, evaluate: rlcCircuits.evaluate },
    { id: 'mechanical/harmonicOscillator', directory: harmonicOscillator.directory, models: harmonicOscillator.models, evaluate: harmonicOscillator.evaluate },
    { id: 'mechanical/pendulum', directory: pendulum.directory, models: pendulum.models, evaluate: pendulum.evaluate },
    { id: 'population/lotkaVolterra', directory: lotkaVolterra.directory, models: lotkaVolterra.models, evaluate: lotkaVolterra.evaluate },
    { id: 'verification/convergenceOrder', directory: convergenceOrder.directory, models: {}, evaluate: convergenceOrder.evaluate },
    { id: 'verification/protheroRobinson', directory: protheroRobinson.directory, models: protheroRobinson.models, evaluate: protheroRobinson.evaluate },
    { id: 'coupling/graphSplit', directory: graphSplit.directory, models: graphSplit.models, evaluate: graphSplit.evaluate },
    { id: 'scaling/graphScalability', directory: graphScalability.directory, models: graphScalability.models, evaluate: graphScalability.evaluate, measure: graphScalability.measure },
    { id: 'causal/reconstruction', directory: causalReconstruction.directory, models: causalReconstruction.models, evaluate: causalReconstruction.evaluate },
    { id: 'oscillators/vanDerPol', directory: vanDerPol.directory, models: vanDerPol.models, evaluate: vanDerPol.evaluate },
    { id: 'chemistry/robertson', directory: robertson.directory, models: robertson.models, evaluate: robertson.evaluate },
    { id: 'chaos/lorenz', directory: lorenz.directory, models: lorenz.models, evaluate: lorenz.evaluate },
    { id: 'mechanical/doublePendulum', directory: doublePendulum.directory, models: doublePendulum.models, evaluate: doublePendulum.evaluate },
    { id: 'mechanical/bouncingBall', directory: bouncingBall.directory, models: bouncingBall.models, evaluate: bouncingBall.evaluate },
    { id: 'electrical/switchedCircuits', directory: switchedCircuits.directory, models: switchedCircuits.models, evaluate: switchedCircuits.evaluate },
    { id: 'thermal/heatExchanger', directory: heatExchanger.directory, models: heatExchanger.models, evaluate: heatExchanger.evaluate },
    { id: 'fluid/pipeNetwork', directory: pipeNetwork.directory, models: pipeNetwork.models, evaluate: pipeNetwork.evaluate },
    { id: 'multiDomain/dcMotor', directory: dcMotor.directory, models: dcMotor.models, evaluate: dcMotor.evaluate },
    { id: 'showcase/dataCentre', directory: dataCentre.directory, models: dataCentre.models, evaluate: dataCentre.evaluate },
    { id: 'modelica/standardLibrary', directory: standardLibrary.directory, models: standardLibrary.models, evaluate: standardLibrary.evaluate },
    { id: 'fmi/referenceFmus', directory: referenceFmus.directory, models: referenceFmus.models, evaluate: referenceFmus.evaluate }
];
