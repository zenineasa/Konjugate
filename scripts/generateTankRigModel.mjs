/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes examples/dataSources/simulatedTankRig.kjt: the model of the simulated rig (examples/dataSources/simulatedTankRig.py), to replay
// the rig's data logs through. It is the Tank Calibration example's tank with its true values, and one change: the heater's power is a
// shared parameter, "Heater power", instead of a fixed heat flow, because what the operator does to the rig is an input, and a
// recording drives an input through a shared parameter's schedule (docs/connectingADataSource.md).
//
//   node scripts/generateTankRigModel.mjs

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeProjectFile } from '../src/projectFile.mjs';
import { exampleOwnership } from './exampleOwnership.mjs';
import { tankCalibration, tankProject } from './generateTankCalibrationExample.mjs';

const root = join(import.meta.dirname, '..');
export const heaterPowerParameterId = 40;

export function tankRigProject() {
    const project = tankProject({ ...tankCalibration.truth, tuned: false });
    project.ownership = exampleOwnership('Simulated Tank Rig');
    project.sharedParameters.push({
        id: heaterPowerParameterId, name: 'Heater power', symbol: 'heaterPower', value: tankCalibration.heaterPower, unit: 'W', mode: 'constant'
    });
    // A day, at the rig's one-minute thermometer interval; a replay sets its own length from the log.
    project.runConfigurations = [{ id: 30, name: 'One day', globalTimeStep: 60, outputInterval: 60 }];
    // The heater input now reads the shared heater power, not the heater node's fixed heat flow.
    const heater = project.edges.find((edge) => edge.name === 'Heater input');
    const latex = '\\frac{\\mathrm{heaterPower}}{\\mathrm{waterThermalCapacitance}}';
    heater.equation = latex;
    heater.equationModel = {
        latex, output: { role: 'target', stateId: 2 },
        bindings: [
            { kind: 'parameter', parameterId: 12, symbol: 'heaterPower' },
            { kind: 'parameter', parameterId: 8, symbol: 'waterThermalCapacitance' }
        ],
        mathJson: ['Divide', 'heaterPower', 'waterThermalCapacitance']
    };
    heater.parameters.push({ id: 12, name: 'Heater power', symbol: 'heaterPower', value: tankCalibration.heaterPower, unit: 'W', mode: 'constant', sharedParameterId: heaterPowerParameterId });
    return project;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await writeFile(join(root, 'examples', 'dataSources', 'simulatedTankRig.kjt'), await encodeProjectFile(`${JSON.stringify(tankRigProject(), null, 4)}\n`));
    console.log('Wrote examples/dataSources/simulatedTankRig.kjt.');
}
