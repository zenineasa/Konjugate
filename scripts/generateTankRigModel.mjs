/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes examples/dataSources/simulatedTankRig.kjt: the model of the simulated rig (examples/dataSources/simulatedTankRig.py), to replay
// the rig's data logs through. It is the Tank Calibration example's tank with its true values, and one change: the heater's heat flow
// is set from a shared parameter, "Heater power", instead of being fixed, because what the operator does to the rig is an input, and
// a recording drives an input through a shared parameter's schedule (docs/connectingADataSource.md).
//
//   node scripts/generateTankRigModel.mjs

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeProjectFile } from '../src/projectFile.mjs';
import { exampleOwnership } from './exampleOwnership.mjs';
import { tankCalibration, tankProject } from './generateTankCalibrationExample.mjs';

const root = join(import.meta.dirname, '..');
export const heaterPowerParameterId = 40;
export const heatLossParameterId = 10;

export function tankRigProject() {
    const project = tankProject({ ...tankCalibration.truth, tuned: false });
    project.ownership = exampleOwnership('Simulated Tank Rig');
    project.sharedParameters.push({
        id: heaterPowerParameterId, name: 'Heater power', symbol: 'heaterPower', value: tankCalibration.heaterPower, unit: 'W', mode: 'constant'
    });
    // A day, at the rig's one-minute thermometer interval; a replay sets its own length from the log.
    project.runConfigurations = [{ id: 30, name: 'One day', globalTimeStep: 60, outputInterval: 60 }];
    // The heater's heat flow follows the shared heater power: a state the heater node sets from it at every instant, which the
    // heater input to the tank reads as in the Tank Calibration example. A live twin's model then heats the tank as the heater is
    // switched, rather than at the fixed value the state would otherwise carry (and shows it with the inputs, as the heater's power).
    const heater = project.nodes.find((node) => node.name === 'Electric heater');
    heater.sourceTerms = [{
        id: 13, state: 'qDot', expression: 'heaterPower', setsValue: true,
        expressionModel: { latex: '\\mathrm{heaterPower}', output: { stateId: 4 }, mathJson: 'heaterPower', bindings: [{ kind: 'parameter', parameterId: 14, symbol: 'heaterPower' }] },
        parameters: [{ id: 14, name: 'Heater power', symbol: 'heaterPower', value: tankCalibration.heaterPower, unit: 'W', mode: 'constant', sharedParameterId: heaterPowerParameterId }]
    }];
    // The heat loss is what changes on a real rig (insulation getting wet, a lid left open), so it is marked tunable: a live twin's
    // refit finds it, and its estimator can track it as it goes (the drifting recording's heat loss grows 10% an hour).
    const loss = project.edges.find((edge) => edge.name === 'Ambient heat loss').parameters.find((parameter) => parameter.id === heatLossParameterId);
    loss.tuning = { ...tankCalibration.heatLossBounds };
    return project;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await writeFile(join(root, 'examples', 'dataSources', 'simulatedTankRig.kjt'), await encodeProjectFile(`${JSON.stringify(tankRigProject(), null, 4)}\n`));
    console.log('Wrote examples/dataSources/simulatedTankRig.kjt.');
}
