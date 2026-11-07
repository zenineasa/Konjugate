/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The unit catalogue (src/units.mjs): units read however people write them, conversions proposed between units of one kind and
// refused between kinds, raw transmitter signals scaled through their ranges, and every unit the example models use understood.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeProjectBundle } from '../src/projectFile.mjs';
import { parseUnit, quantityName, rangeConversion, sameDimension, unitConversion } from '../src/units.mjs';

const close = (actual, expected, what) => assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${what}: ${actual} against ${expected}`);
// A value through a conversion, as a mapping applies it.
const convert = (value, from, to) => {
    const conversion = unitConversion(from, to);
    assert.equal(conversion.error, undefined, `${from} → ${to}: ${conversion.error}`);
    return value * conversion.scale + conversion.offset;
};

test('temperatures: absolute on their own, differences inside a compound unit', () => {
    close(convert(25, '°C', 'K'), 298.15, '25 °C');
    close(convert(212, '°F', '°C'), 100, '212 °F');
    close(convert(-40, 'degF', 'deg C'), -40, '-40 °F');
    close(convert(0, 'K', '°F'), -459.67, 'absolute zero');
    close(convert(491.67, '°R', 'K'), 273.15, 'the ice point in rankine');
    close(convert(20, 'W/°C', 'W/K'), 20, 'a conductance per °C is per K');
    close(convert(1, 'W/°F', 'W/K'), 1.8, 'a conductance per °F');
    assert.equal(parseUnit('C').note, 'C read as degrees Celsius');
    close(convert(30, 'C', 'K'), 303.15, 'a bare C, as an instrument writes it');
});

test('the units of process signals: pressure, flow, power, energy, speed, fractions, electricity', () => {
    close(convert(1, 'bar', 'kPa'), 100, 'a bar');
    close(convert(6894.757293168, 'Pa', 'psi'), 1, 'a psi');
    close(convert(760, 'torr', 'atm'), 1, 'a standard atmosphere is 760 torr');
    close(convert(1, 'mmHg', 'Pa'), 133.322387415, 'a millimetre of mercury, a little more than a torr');
    close(convert(60, 'L/min', 'L/s'), 1, 'litres a minute');
    close(convert(1, 'gpm', 'm3/s'), 3.785411784e-3 / 60, 'a gallon a minute');
    close(convert(3.6, 'm³/h', 'L/s'), 1, 'cubic metres an hour');
    close(convert(1, 'hp', 'W'), 745.69987158227, 'a horsepower');
    close(convert(1, 'kWh', 'MJ'), 3.6, 'a kilowatt-hour');
    close(convert(1, 'BTU', 'kJ'), 1.05505585262, 'a BTU');
    close(convert(100, 'km/h', 'm/s'), 100 / 3.6, 'kilometres an hour');
    close(convert(50, '%', '1'), 0.5, 'a percentage');
    close(convert(250, 'ppm', '%'), 0.025, 'parts per million');
    close(convert(20, 'mA', 'A'), 0.02, 'a loop current');
    close(convert(1, 'kV', 'V'), 1000, 'a kilovolt');
});

test('angles and speeds of rotation: rpm to rad/s, and to Hz with one revolution a cycle', () => {
    close(convert(60, 'rpm', 'rad/s'), 2 * Math.PI, 'a revolution a second');
    close(convert(60, 'rpm', 'Hz'), 1, 'rpm as a frequency');
    assert.equal(unitConversion('rpm', 'Hz').note, 'one revolution taken as one cycle');
    close(convert(180, 'deg', 'rad'), Math.PI, 'half a turn');
    close(convert(90, '°', '-'), Math.PI / 2, 'an angle onto a pure number, in radians');
    assert.equal(unitConversion('°', '-').note, 'a pure number taken as radians');
});

test('compound units, written the ways engineers write them', () => {
    for (const [a, b] of [['W/m2K', 'W/(m^2*K)'], ['W/(m²·K)', 'W/m^2/K'], ['J/kg·K', 'J/(kg K)'], ['J/kgK', 'J kg^-1 K^-1'], ['N·m', 'Nm'], ['m3/s', 'm^3 s^-1'], ['kg·m²', 'kgm2'], ['N·s/m', 'kg/s']]) {
        const conversion = unitConversion(a, b);
        assert.equal(conversion.identity, true, `${a} and ${b} are one unit: ${JSON.stringify(conversion)}`);
    }
    assert.equal(parseUnit('W/(m²·K)').kind, 'heat transfer coefficient');
    assert.equal(parseUnit('J/(kg K)').kind, 'specific heat capacity');
    assert.equal(parseUnit('N/m').kind, 'stiffness');
    assert.equal(parseUnit('[kPa]').kind, 'pressure', 'A unit in brackets, as a column heading writes it.');
});

test('no conversion between two kinds of quantity, or from text that is not a unit', () => {
    assert.match(unitConversion('Pa', 'K').error, /^Pa is a pressure, and K a temperature: one cannot be turned into the other\.$/);
    assert.match(unitConversion('W', 'J').error, /a power, and J an energy or torque/);
    assert.match(unitConversion('furlongs', 'm').error, /"furlongs" is not a unit Konjugate knows/);
    assert.equal(parseUnit('m/s/banana'), null);
    assert.equal(sameDimension(parseUnit('Nm'), parseUnit('J')), true);
    assert.equal(quantityName(parseUnit('m/s²').dimensions), 'acceleration');
});

test('a raw transmitter signal scaled through its range: 4–20 mA onto 0–150 °C', () => {
    const loop = rangeConversion({ low: 4, high: 20 }, { low: 0, high: 150 });
    close(4 * loop.scale + loop.offset, 0, 'the bottom of the loop');
    close(12 * loop.scale + loop.offset, 75, 'the middle');
    close(20 * loop.scale + loop.offset, 150, 'the top');
    assert.match(rangeConversion({ low: 4, high: 4 }, { low: 0, high: 1 }).error, /two different raw ends/);
});

test('every unit the example models are written in is understood', async () => {
    const found = new Set();
    async function walk(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await walk(path);
            else if (entry.name.endsWith('.kjt')) {
                const visit = (value) => {
                    if (Array.isArray(value)) value.forEach(visit);
                    else if (value && typeof value === 'object') {
                        if (typeof value.unit === 'string') found.add(value.unit);
                        Object.values(value).forEach(visit);
                    }
                };
                visit(JSON.parse((await decodeProjectBundle(await readFile(path))).content));
            }
        }
    }
    await walk(join(import.meta.dirname, '..', 'examples'));
    assert.ok(found.size > 20, `The examples use many units: ${found.size}.`);
    assert.deepEqual([...found].filter((unit) => !parseUnit(unit)), [], 'Every one is read.');
});
