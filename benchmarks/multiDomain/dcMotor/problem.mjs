/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A multi-domain feedback loop: a DC motor under PID speed control, with its electrical, mechanical and thermal parts as separate nodes.
//
//   Controller  measured speed ω_m (a 1 ms sensor lag on the rotor's speed), the integral x_I of the speed error, and a derivative filter
//               x_d (5 ms) on the measured speed:
//                   dω_m/dt = (ω - ω_m) / T_s     dx_I/dt = ω_ref(t) - ω_m     dx_d/dt = (ω_m - x_d) / T_d
//                   V = clamp(K_p (ω_ref - ω_m) + K_i x_I - K_d (ω_m - x_d) / T_d, ±24 V)
//               The setpoint ω_ref is 200 rad/s, then 400 rad/s from 4 s.
//   Armature    L di/dt = V - R(T_w) i - K ω, its resistance rising with the winding's temperature, R = R_0 (1 + α (T_w - T_0))
//   Rotor       J dω/dt = K i - b ω - τ_load(t), the load 0.1 N m from 8 s
//   Winding     C_w dT_w/dt = R(T_w) i² - (T_w - T_h) / R_wh
//   Housing     C_h dT_h/dt = (T_w - T_h) / R_wh + b ω² - (T_h - T_a) / R_ha
//   Ambient     T_a = 293.15 K
// Energy is booked where it changes domain, each account a state integrated by Konjugate: the supply's work ∫ V i (armature), the copper
// loss ∫ R i² (armature), the friction loss ∫ b ω² and the work done on the load ∫ τ ω (rotor), and the heat to ambient (housing). Two
// balances follow, from Konjugate's own states:
//   electromechanical  ∫ V i = ½ L i² + ½ J ω² + ∫ R i² + ∫ b ω² + ∫ τ ω      (kept by an exact solution; a numerical one shows its error)
//   thermal            ∫ R i² + ∫ b ω² = C_w ΔT_w + C_h ΔT_h + ∫ heat to ambient   (linear in the states: kept to rounding by any method)
//
// The voltage clamp saturates briefly after the setpoint step. The setpoint and load steps fall on step boundaries, but Runge–Kutta 4's last
// stage of the step ending at one is evaluated at that instant and sees the new value: an error of order h, which sets its order here to one.
// Reference: SciPy's solve_ivp DOP853 at rtol = 1e-13, atol = 1e-15 in pieces between the setpoint and load steps, with Radau as a check
// (generateReference.py).

import { join } from 'node:path';
import { errorMetrics, observedOrder } from '../../lib/metrics.mjs';
import { trajectory } from '../../lib/engine.mjs';
import { cases, createModel, difference, negate, parameter, product, quotient, square, state, sum, time } from '../../lib/project.mjs';
import { createChecks, engineRun, linePlot, methodName, referenceAgreement, referenceData, resultRow, series } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
export const modelPath = join(directory, 'dcMotor.kjt');
export const constants = Object.freeze({
    resistance: 1.0, referenceTemperature: 293.15, temperatureCoefficient: 0.00393, inductance: 2e-3, torqueConstant: 0.05, inertia: 1e-4, friction: 1e-5,
    windingCapacity: 5, housingCapacity: 50, windingToHousing: 1, housingToAmbient: 2, ambient: 293.15,
    sensorLag: 1e-3, derivativeFilter: 5e-3, proportional: 0.05, integral: 1.0, derivative: 2e-4, voltageLimit: 24,
    setpoint: { initial: 200, final: 400, at: 4 }, load: { torque: 0.1, at: 8 }
});

export function build() {
    const c = constants;
    const model = createModel('Benchmark: DC motor under PID speed control');
    const controller = model.node('Speed controller', { type: 'PID controller', position: [-4, 2, 0], color: '#8a6fb0', states: [
        ['measuredSpeed', 'Measured speed', 0, 'rad/s'], ['errorIntegral', 'Integral of the speed error', 0, 'rad'], ['derivativeFilter', 'Derivative filter', 0, 'rad/s']
    ] });
    const armature = model.node('Armature', { type: 'Electrical: armature circuit', position: [-2, 0, 0], color: '#3f6fb0', states: [
        ['current', 'Armature current', 0, 'A'], ['supplyEnergy', 'Energy from the supply', 0, 'J'], ['copperLoss', 'Copper loss', 0, 'J']
    ] });
    const rotor = model.node('Rotor', { type: 'Mechanical: rotor and shaft', position: [2, 0, 0], color: '#5d7885', shape: 'cylinder', states: [
        ['speed', 'Angular speed', 0, 'rad/s'], ['frictionLoss', 'Friction loss', 0, 'J'], ['loadWork', 'Work done on the load', 0, 'J']
    ] });
    const winding = model.node('Winding', { type: 'Thermal: winding', position: [-2, -3, 0], color: '#c8553d', states: [['temperature', 'Winding temperature', c.ambient, 'K']] });
    const housing = model.node('Housing', { type: 'Thermal: housing', position: [2, -3, 0], color: '#c8553d', states: [
        ['temperature', 'Housing temperature', c.ambient, 'K'], ['heatToAmbient', 'Heat to ambient', 0, 'J']
    ] });
    const ambient = model.node('Ambient', { type: 'Thermal: ambient', position: [0, -6, 0], color: '#8a8a8a', shape: 'sphere', states: [['temperature', 'Ambient temperature', c.ambient, 'K']] });

    // Controller.
    const setpoint = cases(['Less', 't', 'stepTime'], 'initialSetpoint', 'True', 'finalSetpoint');
    const setpointUses = { t: time, stepTime: parameter('Setpoint step time', c.setpoint.at, 's'), initialSetpoint: parameter('Initial speed setpoint', c.setpoint.initial, 'rad/s'), finalSetpoint: parameter('Final speed setpoint', c.setpoint.final, 'rad/s') };
    model.edge('Speed sensor', rotor, controller, 'measuredSpeed', quotient('speed', 'sensorLag'), { speed: state(rotor, 'speed'), sensorLag: parameter('Sensor time constant', c.sensorLag, 's') }, { color: '#8a6fb0' });
    model.sourceTerm(controller, 'measuredSpeed', quotient(negate('measuredSpeed'), 'sensorLag'), { measuredSpeed: state(controller, 'measuredSpeed'), sensorLag: parameter('Sensor time constant', c.sensorLag, 's') });
    model.sourceTerm(controller, 'errorIntegral', difference(setpoint, 'measuredSpeed'), { ...setpointUses, measuredSpeed: state(controller, 'measuredSpeed') });
    model.sourceTerm(controller, 'derivativeFilter', quotient(difference('measuredSpeed', 'derivativeFilter'), 'filterTime'), {
        measuredSpeed: state(controller, 'measuredSpeed'), derivativeFilter: state(controller, 'derivativeFilter'), filterTime: parameter('Derivative filter time constant', c.derivativeFilter, 's')
    });
    const command = sum(product('proportionalGain', difference(setpoint, 'measuredSpeed')), product('integralGain', 'errorIntegral'),
        negate(quotient(product('derivativeGain', difference('measuredSpeed', 'derivativeFilter')), 'filterTime')));
    const voltage = ['Min', ['Max', command, negate('voltageLimit')], 'voltageLimit'];
    const controllerUses = () => ({
        ...setpointUses, proportionalGain: parameter('Proportional gain', c.proportional, 'V s/rad'), measuredSpeed: state(controller, 'measuredSpeed'),
        integralGain: parameter('Integral gain', c.integral, 'V/rad'), errorIntegral: state(controller, 'errorIntegral'), derivativeGain: parameter('Derivative gain', c.derivative, 'V s²/rad'),
        derivativeFilter: state(controller, 'derivativeFilter'), filterTime: parameter('Derivative filter time constant', c.derivativeFilter, 's'), voltageLimit: parameter('Supply voltage limit', c.voltageLimit, 'V')
    });
    model.edge('Drive voltage', controller, armature, 'current', quotient(voltage, 'inductance'), { ...controllerUses(), inductance: parameter('Armature inductance', c.inductance, 'H') }, { color: '#8a6fb0' });
    model.edge('Supply power', controller, armature, 'supplyEnergy', product(voltage, 'current'), { ...controllerUses(), current: state(armature, 'current') }, { color: '#8a6fb0' });

    // Electrical and mechanical, coupled through the motor constant.
    const resistanceOf = product('coldResistance', sum(1, product('temperatureCoefficient', difference('windingTemperature', 'referenceTemperature'))));
    const resistanceUses = () => ({
        coldResistance: parameter('Armature resistance at 20 °C', c.resistance, 'Ω'), temperatureCoefficient: parameter('Temperature coefficient of resistance', c.temperatureCoefficient, '1/K'),
        windingTemperature: state(winding, 'temperature'), referenceTemperature: parameter('Reference temperature', c.referenceTemperature, 'K')
    });
    model.edge('Armature resistance (hot)', winding, armature, 'current', quotient(negate(product(resistanceOf, 'current')), 'inductance'), {
        ...resistanceUses(), current: state(armature, 'current'), inductance: parameter('Armature inductance', c.inductance, 'H')
    }, { color: '#c8553d' });
    model.edge('Copper loss', winding, armature, 'copperLoss', product(resistanceOf, square('current')), { ...resistanceUses(), current: state(armature, 'current') }, { color: '#c8553d' });
    model.edge('Back EMF', rotor, armature, 'current', quotient(negate(product('torqueConstant', 'speed')), 'inductance'), {
        torqueConstant: parameter('Motor constant', c.torqueConstant, 'V s/rad'), speed: state(rotor, 'speed'), inductance: parameter('Armature inductance', c.inductance, 'H')
    }, { color: '#5d7885' });
    model.edge('Motor torque', armature, rotor, 'speed', quotient(product('torqueConstant', 'current'), 'inertia'), {
        torqueConstant: parameter('Motor constant', c.torqueConstant, 'N m/A'), current: state(armature, 'current'), inertia: parameter('Rotor inertia', c.inertia, 'kg m²')
    }, { color: '#3f6fb0' });
    const loadTorque = cases(['Less', 't', 'loadTime'], 0, 'True', 'loadTorque');
    const loadUses = { t: time, loadTime: parameter('Load step time', c.load.at, 's'), loadTorque: parameter('Load torque', c.load.torque, 'N m') };
    model.sourceTerm(rotor, 'speed', quotient(negate(sum(product('friction', 'speed'), loadTorque)), 'inertia'), {
        friction: parameter('Viscous friction', c.friction, 'N m s/rad'), speed: state(rotor, 'speed'), ...loadUses, inertia: parameter('Rotor inertia', c.inertia, 'kg m²')
    });
    model.sourceTerm(rotor, 'frictionLoss', product('friction', square('speed')), { friction: parameter('Viscous friction', c.friction, 'N m s/rad'), speed: state(rotor, 'speed') });
    model.sourceTerm(rotor, 'loadWork', product(loadTorque, 'speed'), { ...loadUses, speed: state(rotor, 'speed') });

    // Thermal.
    model.edge('Copper loss heating the winding', armature, winding, 'temperature', quotient(product(resistanceOf, square('current')), 'windingCapacity'), {
        ...resistanceUses(), current: state(armature, 'current'), windingCapacity: parameter('Winding heat capacity', c.windingCapacity, 'J/K')
    }, { color: '#c8553d' });
    model.edge('Friction heating the housing', rotor, housing, 'temperature', quotient(product('friction', square('speed')), 'housingCapacity'), {
        friction: parameter('Viscous friction', c.friction, 'N m s/rad'), speed: state(rotor, 'speed'), housingCapacity: parameter('Housing heat capacity', c.housingCapacity, 'J/K')
    }, { color: '#c8553d' });
    for (const [from, to, capacity, label] of [[housing, winding, ['Winding heat capacity', c.windingCapacity], 'winding'], [winding, housing, ['Housing heat capacity', c.housingCapacity], 'housing']]) {
        model.edge(`Conduction into the ${label}`, from, to, 'temperature', quotient(difference('otherTemperature', 'temperature'), product('thermalResistance', 'capacity')), {
            otherTemperature: state(from, 'temperature'), temperature: state(to, 'temperature'), thermalResistance: parameter('Winding-to-housing thermal resistance', c.windingToHousing, 'K/W'), capacity: parameter(capacity[0], capacity[1], 'J/K')
        }, { color: '#c8553d' });
    }
    model.edge('Convection to ambient', ambient, housing, 'temperature', quotient(difference('ambientTemperature', 'temperature'), product('thermalResistance', 'housingCapacity')), {
        ambientTemperature: state(ambient, 'temperature'), temperature: state(housing, 'temperature'), thermalResistance: parameter('Housing-to-ambient thermal resistance', c.housingToAmbient, 'K/W'),
        housingCapacity: parameter('Housing heat capacity', c.housingCapacity, 'J/K')
    }, { color: '#8a8a8a' });
    model.edge('Heat to ambient', ambient, housing, 'heatToAmbient', quotient(difference('temperature', 'ambientTemperature'), 'thermalResistance'), {
        temperature: state(housing, 'temperature'), ambientTemperature: state(ambient, 'temperature'), thermalResistance: parameter('Housing-to-ambient thermal resistance', c.housingToAmbient, 'K/W')
    }, { color: '#8a8a8a' });

    const document = model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 2 ** -12, outputInterval: 2 ** -6 } });
    // Compared states, in the reference's order: i, ω, ω_m, x_I, x_d, T_w, T_h.
    const ids = {
        compared: [armature.stateIds.current, rotor.stateIds.speed, controller.stateIds.measuredSpeed, controller.stateIds.errorIntegral, controller.stateIds.derivativeFilter, winding.stateIds.temperature, housing.stateIds.temperature],
        supplyEnergy: armature.stateIds.supplyEnergy, copperLoss: armature.stateIds.copperLoss, frictionLoss: rotor.stateIds.frictionLoss, loadWork: rotor.stateIds.loadWork, heatToAmbient: housing.stateIds.heatToAmbient
    };
    return { document, ids };
}

export const models = { dcMotor: () => build().document };

const variantOf = (method) => (method === 'rungeKutta4' ? { method: 'rungeKutta4' } : { integration: 'explicit' });
const methodKey = (method) => (method === 'explicit' ? 'Explicit' : 'RungeKutta4');

// The 10 %–90 % rise time of the speed after the setpoint step, and the speed's dip after the load step.
export function stepResponse(times, speeds) {
    const { setpoint, load } = constants;
    const crossing = (level) => {
        for (let k = 1; k < times.length; ++k) {
            if (times[k] > setpoint.at && speeds[k - 1] < level && speeds[k] >= level) return times[k - 1] + (level - speeds[k - 1]) / (speeds[k] - speeds[k - 1]) * (times[k] - times[k - 1]);
        }
        return NaN;
    };
    const span = setpoint.final - setpoint.initial;
    const riseTime = crossing(setpoint.initial + 0.9 * span) - crossing(setpoint.initial + 0.1 * span);
    const dip = setpoint.final - Math.min(...speeds.filter((_speed, k) => times[k] >= load.at));
    return { riseTime, dip };
}

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    const data = referenceData(directory);
    if (!data) throw new Error('multiDomain/dcMotor needs its reference.json (generateReference.py).');
    const c = constants;
    const { ids } = build();
    const reference = data.states;
    const referenceTimes = reference.map((_sample, k) => k * config.run.outputInterval);
    const referenceResponse = stepResponse(referenceTimes, reference.map((sample) => sample[1]));
    const traces = {};
    for (const method of ['explicit', 'rungeKutta4']) {
        const steps = config.globalTimeSteps[method];
        const errors = [];
        for (const step of steps) {
            const run = engineRun(config.run, { globalTimeStep: step });
            const result = await engine.run(modelPath, variantOf(method), run);
            if (result.times.length !== reference.length) throw new Error('The motor\'s samples do not match its reference.json.');
            const numeric = trajectory(result, ids.compared);
            const metrics = errorMetrics(numeric, reference.map((sample) => sample.slice(0, 7)));
            const value = (id, k) => result.values.get(id)[k];
            const electromechanical = result.times.map((_t, k) => value(ids.supplyEnergy, k) - 0.5 * c.inductance * numeric[k][0] ** 2 - 0.5 * c.inertia * numeric[k][1] ** 2
                - value(ids.copperLoss, k) - value(ids.frictionLoss, k) - value(ids.loadWork, k));
            const thermal = result.times.map((_t, k) => value(ids.copperLoss, k) + value(ids.frictionLoss, k) - c.windingCapacity * (numeric[k][5] - c.ambient)
                - c.housingCapacity * (numeric[k][6] - c.ambient) - value(ids.heatToAmbient, k));
            const supplied = value(ids.supplyEnergy, result.times.length - 1);
            const electromechanicalDefect = Math.max(...electromechanical.map(Math.abs)) / supplied;
            const thermalDefect = Math.max(...thermal.map(Math.abs)) / supplied;
            const supplyEnergyError = Math.max(...result.times.map((_t, k) => Math.abs(value(ids.supplyEnergy, k) - reference[k][7]))) / reference.at(-1)[7];
            const response = stepResponse(result.times, numeric.map((sample) => sample[1]));
            errors.push(metrics.relativeError);
            rows.push(resultRow({
                caseName: 'Currents, speeds, controller and temperatures', model: 'dcMotor', variant: variantOf(method), run, errors: metrics, conservationError: electromechanicalDefect, work: result.work, unit: 'A, rad/s, rad, K',
                note: `thermal balance ${thermalDefect.toExponential(2)}, supply-energy error ${supplyEnergyError.toExponential(2)}; rise time ${(response.riseTime * 1000).toFixed(3)} ms (reference ${(referenceResponse.riseTime * 1000).toFixed(3)}), load dip ${response.dip.toFixed(4)} rad/s (reference ${referenceResponse.dip.toFixed(4)}); conservation = electromechanical balance / supply energy`
            }));
            if (step === config.run.globalTimeStep) {
                traces[method] = { result, numeric };
                const name = methodKey(method);
                add(`relativeError${name}`, metrics.relativeError, `Every state (current, speeds, controller, temperatures): largest error relative to range, ${methodName(variantOf(method))}, h = 2^${Math.log2(step)} s`);
                add(`electromechanicalBalance${name}`, electromechanicalDefect, `Supply energy against stored + copper + friction + load, from Konjugate's own states, relative to the supply energy, ${methodName(variantOf(method))}`);
                add(`thermalBalance${name}`, thermalDefect, `Copper + friction loss against heat stored in winding and housing + heat to ambient, from Konjugate's own states, relative to the supply energy, ${methodName(variantOf(method))}`);
                add(`supplyEnergyError${name}`, supplyEnergyError, `Energy drawn from the supply against the reference, relative to its total, ${methodName(variantOf(method))}`);
                add(`riseTimeError${name}`, Math.abs(response.riseTime - referenceResponse.riseTime) / referenceResponse.riseTime, `10–90 % rise time after the setpoint step against the reference's, relative, ${methodName(variantOf(method))}`);
                add(`loadDipError${name}`, Math.abs(response.dip - referenceResponse.dip) / referenceResponse.dip, `Speed dip after the load step against the reference's, relative, ${methodName(variantOf(method))}`);
            }
        }
        const order = observedOrder(steps, errors);
        rows.push(resultRow({ caseName: 'Error order in h', model: 'dcMotor', variant: variantOf(method), observedOrder: order.fitted, note: `pairwise ${order.pairwise.map((value) => value.toFixed(3)).join(', ')}` }));
        add(`order${methodKey(method)}`, order.fitted, `Observed order of the error in h, ${methodName(variantOf(method))} (fitted over every h)`);
    }
    add('referenceSelfAgreement', referenceAgreement(data.radau, reference), 'The reference (DOP853, rtol 1e-13) against Radau at rtol 1e-10, largest difference relative to each column\'s magnitude');

    const times = traces.explicit.result.times;
    const window = (from, to) => times.map((t, k) => [t, k]).filter(([t]) => t >= from && t <= to).map(([, k]) => k);
    const stepWindow = window(3.9, 4.6);
    const pick = (values) => stepWindow.map((k) => values[k]);
    plots.push(linePlot({
        id: 'dcMotorStepResponse', title: 'DC motor: speed after the setpoint step', subtitle: `200 → 400 rad/s at 4 s; SciPy DOP853 against Konjugate, h = 2^${Math.log2(config.run.globalTimeStep)} s`, xLabel: 'Time (s)', yLabel: 'Speed (rad/s)',
        series: [
            series('Reference', 'reference', pick(times), pick(reference.map((sample) => sample[1]))),
            series('Konjugate, explicit Euler', 'explicit', pick(times), pick(traces.explicit.numeric.map((sample) => sample[1]))),
            series('Konjugate, Runge–Kutta 4', 'rungeKutta4', pick(times), pick(traces.rungeKutta4.numeric.map((sample) => sample[1])))
        ]
    }));
    plots.push(linePlot({
        id: 'dcMotorTemperatures', title: 'DC motor: winding and housing temperatures', subtitle: 'The load from 8 s heats the winding; its resistance rises with it', xLabel: 'Time (s)', yLabel: 'Temperature (K)',
        series: [
            series('Reference, winding', 'reference', times, reference.map((sample) => sample[5])),
            series('Reference, housing', 'reference', times, reference.map((sample) => sample[6])),
            series('Konjugate, winding, explicit Euler', 'explicit', times, traces.explicit.numeric.map((sample) => sample[5])),
            series('Konjugate, housing, explicit Euler', 'semiImplicit', times, traces.explicit.numeric.map((sample) => sample[6]))
        ]
    }));
    const value = (id) => traces.explicit.result.values.get(id);
    plots.push(linePlot({
        id: 'dcMotorEnergy', title: 'DC motor: where the supply\'s energy goes', subtitle: 'Konjugate\'s own energy accounts, explicit Euler', xLabel: 'Time (s)', yLabel: 'Energy (J)',
        series: [
            series('Supply', 'reference', times, value(ids.supplyEnergy)),
            series('Copper loss', 'explicit', times, value(ids.copperLoss)),
            series('Work on the load', 'semiImplicit', times, value(ids.loadWork)),
            series('Friction loss', 'extra', times, value(ids.frictionLoss)),
            series('Heat to ambient', 'guide', times, value(ids.heatToAmbient))
        ]
    }));
    return {
        rows, checks, plots, notes: [
            'The thermal balance is linear in the states and is kept to rounding by either method; the electromechanical one holds only as well as the integration, since ½ L i² and ½ J ω² are quadratic.',
            'The setpoint and load steps are conditions on time in the equations, so Runge–Kutta 4 locates each and steps to it (docs/proposals/integrators.md, Event location): the step that ends at a step input is taken entirely before it, and Runge–Kutta 4 keeps its fourth order through the steps, with its largest error, in the armature current at 4 s, far below explicit Euler\'s, which does not locate them.'
        ]
    };
}
