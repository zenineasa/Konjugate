/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A catalogue of the units engineering signals and models are written in (docs/proposals/controlRoom.md, "Units, converted and
// proposed"): it reads what people write (`degC`, `°C`, `deg C`, `W/(m·K)`, `m3/h`, `kPa`, `L/min`) into a dimension and a scale onto
// SI, so that two units can be said to measure the same kind of thing, and the conversion between them proposed as the scale and
// offset a mapping already carries (value in the second unit = value in the first × scale + offset).
//
//   parseUnit(text)                 { text, dimensions, scale, offset, kind, note } or null for a unit not in the catalogue
//   unitConversion(from, to)        { scale, offset } between two units of one dimension, or { error } saying why there is none
//   sameDimension(a, b)             whether two parsed units measure the same kind of quantity
//   quantityName(dimensions)        what a dimension is called ('temperature', 'pressure', 'power', ...), or null
//   rangeConversion(raw, scaled)    { scale, offset } taking a raw signal's range onto the quantity's (a 4–20 mA loop onto 0–150 °C)
//
// Dimensions are exponents of the SI base quantities: m (length), kg (mass), s (time), A (current), K (temperature), mol (amount),
// cd (luminous intensity), and an angle (rad) kept apart, so that rad/s and Hz are not taken for one another: between an angular
// speed (rpm, rad/s) and a frequency (Hz) one revolution is taken as one cycle, and the conversion says so. Fractions (%, ppm) are
// dimensionless. An absolute temperature (°C, °F on its own) has an offset; inside a compound unit (W/°C, J/(kg·°F)) it is a temperature
// difference, a scale alone. A bare "C" on its own is read as degrees Celsius, as instrument tags write it, and says so in `note`.

const base = ['m', 'kg', 's', 'A', 'K', 'mol', 'cd', 'rad'];
const dims = (spec = {}) => base.map((name) => spec[name] ?? 0);
const none = dims();

// The units themselves: a symbol (and the other ways it is written) with its scale onto SI and its dimensions; an absolute
// temperature's offset is kept apart, as it only applies to a unit standing alone.
const definitions = [
    // Dimensionless
    [['1', '-', ''], 1, {}], [['%', 'percent', 'pct'], 0.01, {}], [['ppm'], 1e-6, {}], [['ppb'], 1e-9, {}],
    [['rad', 'radian', 'radians'], 1, { rad: 1 }], [['°', 'deg', 'degree', 'degrees'], Math.PI / 180, { rad: 1 }], [['rev', 'revolution', 'revolutions', 'turn'], 2 * Math.PI, { rad: 1 }],
    // Length
    [['m', 'metre', 'meter', 'metres', 'meters'], 1, { m: 1 }], [['in', 'inch', 'inches', '"'], 0.0254, { m: 1 }], [['ft', 'foot', 'feet', "'"], 0.3048, { m: 1 }],
    [['yd', 'yard', 'yards'], 0.9144, { m: 1 }], [['mi', 'mile', 'miles'], 1609.344, { m: 1 }], [['nmi'], 1852, { m: 1 }],
    // Mass
    [['g', 'gram', 'grams'], 1e-3, { kg: 1 }], [['t', 'tonne', 'tonnes'], 1000, { kg: 1 }], [['lb', 'lbs', 'lbm', 'pound', 'pounds'], 0.45359237, { kg: 1 }],
    [['oz', 'ounce', 'ounces'], 0.028349523125, { kg: 1 }],
    // Time
    [['s', 'sec', 'second', 'seconds'], 1, { s: 1 }], [['min', 'minute', 'minutes'], 60, { s: 1 }], [['h', 'hr', 'hour', 'hours'], 3600, { s: 1 }],
    [['d', 'day', 'days'], 86400, { s: 1 }],
    // Temperature (as a difference here; the absolute offset is below)
    [['K', 'kelvin'], 1, { K: 1 }], [['°C', 'degC', 'deg C', 'celsius', '℃'], 1, { K: 1 }, 273.15], [['°F', 'degF', 'deg F', 'fahrenheit', '℉'], 5 / 9, { K: 1 }, 459.67 * 5 / 9],
    [['°R', 'degR', 'rankine'], 5 / 9, { K: 1 }],
    // Electricity
    [['A', 'amp', 'amps', 'ampere'], 1, { A: 1 }], [['V', 'volt', 'volts'], 1, { m: 2, kg: 1, s: -3, A: -1 }], [['Ω', 'ohm', 'ohms'], 1, { m: 2, kg: 1, s: -3, A: -2 }],
    [['S', 'siemens'], 1, { m: -2, kg: -1, s: 3, A: 2 }], [['F', 'farad'], 1, { m: -2, kg: -1, s: 4, A: 2 }], [['Ah'], 3600, { s: 1, A: 1 }],
    [['H', 'henry'], 1, { m: 2, kg: 1, s: -2, A: -2 }], [['Wb', 'weber'], 1, { m: 2, kg: 1, s: -2, A: -1 }], [['T', 'tesla'], 1, { kg: 1, s: -2, A: -1 }],
    // Amount, light, frequency
    [['mol', 'mole', 'moles'], 1, { mol: 1 }], [['cd', 'candela'], 1, { cd: 1 }], [['Hz', 'hertz'], 1, { s: -1 }],
    [['rpm', 'RPM'], 2 * Math.PI / 60, { rad: 1, s: -1 }], [['rps'], 2 * Math.PI, { rad: 1, s: -1 }], [['cps'], 1, { s: -1 }],
    // Force, pressure, energy, power
    [['N', 'newton', 'newtons'], 1, { m: 1, kg: 1, s: -2 }], [['lbf'], 4.4482216152605, { m: 1, kg: 1, s: -2 }], [['kgf'], 9.80665, { m: 1, kg: 1, s: -2 }],
    [['Pa', 'pascal'], 1, { m: -1, kg: 1, s: -2 }], [['bar'], 1e5, { m: -1, kg: 1, s: -2 }], [['atm'], 101325, { m: -1, kg: 1, s: -2 }],
    [['psi', 'psia', 'psig'], 6894.757293168, { m: -1, kg: 1, s: -2 }], [['mmHg'], 133.322387415, { m: -1, kg: 1, s: -2 }], [['torr', 'Torr'], 101325 / 760, { m: -1, kg: 1, s: -2 }],
    [['inHg'], 3386.389, { m: -1, kg: 1, s: -2 }], [['mmH2O', 'mmWC'], 9.80665, { m: -1, kg: 1, s: -2 }], [['inH2O', 'inWC'], 249.08891, { m: -1, kg: 1, s: -2 }],
    [['J', 'joule', 'joules'], 1, { m: 2, kg: 1, s: -2 }], [['Wh'], 3600, { m: 2, kg: 1, s: -2 }], [['cal', 'calorie'], 4.184, { m: 2, kg: 1, s: -2 }],
    [['BTU', 'Btu', 'btu'], 1055.05585262, { m: 2, kg: 1, s: -2 }], [['eV'], 1.602176634e-19, { m: 2, kg: 1, s: -2 }],
    [['W', 'watt', 'watts'], 1, { m: 2, kg: 1, s: -3 }], [['hp', 'HP'], 745.69987158227, { m: 2, kg: 1, s: -3 }], [['VA'], 1, { m: 2, kg: 1, s: -3 }],
    // Volume and flow
    [['L', 'l', 'litre', 'liter', 'litres', 'liters'], 1e-3, { m: 3 }], [['gal', 'gallon', 'gallons'], 3.785411784e-3, { m: 3 }],
    [['impgal'], 4.54609e-3, { m: 3 }], [['bbl'], 0.158987294928, { m: 3 }],
    [['gpm', 'GPM'], 3.785411784e-3 / 60, { m: 3, s: -1 }], [['cfm', 'CFM'], 0.3048 ** 3 / 60, { m: 3, s: -1 }], [['lpm', 'LPM'], 1e-3 / 60, { m: 3, s: -1 }],
    // Speed
    [['mph'], 0.44704, { m: 1, s: -1 }], [['kn', 'knot', 'knots'], 1852 / 3600, { m: 1, s: -1 }]
];

const units = new Map();
for (const [symbols, scale, spec, absoluteOffset] of definitions) {
    for (const symbol of symbols) units.set(symbol, { scale, dimensions: dims(spec), absoluteOffset: absoluteOffset ?? 0 });
}

// SI prefixes, for units that take them (not the dimensionless ones, nor the imperial units, nor min, h and d).
const prefixes = { Y: 1e24, Z: 1e21, E: 1e18, P: 1e15, T: 1e12, G: 1e9, M: 1e6, k: 1e3, h: 1e2, da: 1e1, d: 1e-1, c: 1e-2, m: 1e-3, µ: 1e-6, μ: 1e-6, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
const prefixable = new Set(['m', 'g', 's', 'A', 'K', 'V', 'Ω', 'S', 'F', 'H', 'Wb', 'T', 'mol', 'cd', 'Hz', 'N', 'Pa', 'bar', 'J', 'Wh', 'W', 'L', 'l', 'eV', 'VA', 'Ah', 'cal', 't']);

const superscripts = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-' };

// One unit symbol, with an SI prefix if it takes one: the whole symbol first (so "min" is minutes, "mm" a millimetre, "Pa" a pascal).
function symbolUnit(symbol) {
    if (units.has(symbol)) return units.get(symbol);
    for (const prefix of Object.keys(prefixes).sort((a, b) => b.length - a.length)) {
        if (!symbol.startsWith(prefix)) continue;
        const rest = symbol.slice(prefix.length);
        if (prefixable.has(rest) && units.has(rest)) {
            const unit = units.get(rest);
            return { scale: unit.scale * prefixes[prefix], dimensions: unit.dimensions, absoluteOffset: 0 };
        }
    }
    return null;
}

// A run of letters that is not one symbol, read as several written together ("kgK" as kg·K, "Nm" as N·m): the longest known symbol
// first, then the rest the same way. Null when no split reads it all.
function splitSymbols(name) {
    if (!name) return [];
    for (let length = name.length; length > 0; length -= 1) {
        const unit = symbolUnit(name.slice(0, length));
        if (!unit) continue;
        const rest = splitSymbols(name.slice(length));
        if (rest) return [unit, ...rest];
    }
    return null;
}

// Splits a compound unit into tokens: names (with an exponent written as ^2, 2, ², or -1 after a letter), "*", "/", "(" and ")".
function tokenize(text) {
    const tokens = [];
    let index = 0;
    const source = text.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]/g, (character) => superscripts[character]);
    while (index < source.length) {
        const character = source[index];
        if (/\s/.test(character)) {
            // A space between two names multiplies them ("N m"); around an operator it means nothing.
            index += 1;
            continue;
        }
        if ('*·×.⋅'.includes(character)) {
            tokens.push({ type: '*' });
            index += 1;
            continue;
        }
        if (character === '/') {
            tokens.push({ type: '/' });
            index += 1;
            continue;
        }
        if (character === '(' || character === ')') {
            tokens.push({ type: character });
            index += 1;
            continue;
        }
        const match = /^(°[CFR]|[A-Za-zµμΩ℃℉%°"'_]+)(\^?-?\d+(?:\.\d+)?)?/.exec(source.slice(index));
        if (!match) return null;
        tokens.push({ type: 'name', name: match[1], power: match[2] ? Number(match[2].replace('^', '')) : 1 });
        index += match[0].length;
    }
    return tokens;
}

// The product of the tokens, with "/" dividing by the next factor and brackets grouping: { scale, dimensions } or null.
function evaluate(tokens) {
    let position = 0;
    const factor = () => {
        const token = tokens[position];
        if (!token) return null;
        if (token.type === '(') {
            position += 1;
            const inner = product();
            if (!inner || tokens[position]?.type !== ')') return null;
            position += 1;
            const power = tokens[position]?.type === 'power' ? tokens[position++].power : 1;
            return { scale: inner.scale ** power, dimensions: inner.dimensions.map((value) => value * power) };
        }
        if (token.type !== 'name') return null;
        position += 1;
        const single = symbolUnit(token.name);
        const parts = single ? [single] : splitSymbols(token.name);
        if (!parts) return null;
        // An exponent belongs to the last symbol of a run ("kgm2" is kg·m²).
        return parts.reduce((result, unit, index) => {
            const power = index === parts.length - 1 ? token.power : 1;
            return { scale: result.scale * unit.scale ** power, dimensions: result.dimensions.map((value, at) => value + unit.dimensions[at] * power) };
        }, { scale: 1, dimensions: none });
    };
    // As engineers write them, everything after a slash is below it until the next slash or bracket: W/m2K and J/kg·K are W/(m²·K)
    // and J/(kg·K).
    const product = () => {
        let result = factor();
        if (!result) return null;
        let below = false;
        while (position < tokens.length && tokens[position].type !== ')') {
            const token = tokens[position];
            if (token.type === '/') below = true;
            if (token.type === '*' || token.type === '/') position += 1;
            const dividing = below;
            const next = factor();
            if (!next) return null;
            result = dividing
                ? { scale: result.scale / next.scale, dimensions: result.dimensions.map((value, index) => value - next.dimensions[index]) }
                : { scale: result.scale * next.scale, dimensions: result.dimensions.map((value, index) => value + next.dimensions[index]) };
        }
        return result;
    };
    const result = product();
    return result && position === tokens.length ? result : null;
}

// The names quantities are known by, by their dimensions.
const quantities = [
    ['dimensionless', {}], ['length', { m: 1 }], ['area', { m: 2 }], ['volume', { m: 3 }], ['mass', { kg: 1 }], ['time', { s: 1 }], ['temperature', { K: 1 }],
    ['current', { A: 1 }], ['amount of substance', { mol: 1 }], ['frequency', { s: -1 }], ['speed', { m: 1, s: -1 }], ['acceleration', { m: 1, s: -2 }],
    ['force', { m: 1, kg: 1, s: -2 }], ['pressure', { m: -1, kg: 1, s: -2 }], ['energy or torque', { m: 2, kg: 1, s: -2 }], ['power', { m: 2, kg: 1, s: -3 }],
    ['voltage', { m: 2, kg: 1, s: -3, A: -1 }], ['resistance', { m: 2, kg: 1, s: -3, A: -2 }], ['charge', { s: 1, A: 1 }],
    ['inductance', { m: 2, kg: 1, s: -2, A: -2 }], ['capacitance', { m: -2, kg: -1, s: 4, A: 2 }], ['magnetic flux', { m: 2, kg: 1, s: -2, A: -1 }], ['magnetic field', { kg: 1, s: -2, A: -1 }],
    ['volume flow', { m: 3, s: -1 }], ['mass flow or damping', { kg: 1, s: -1 }], ['density', { m: -3, kg: 1 }], ['stiffness', { kg: 1, s: -2 }],
    ['moment of inertia', { m: 2, kg: 1 }], ['rotational damping', { m: 2, kg: 1, s: -1, rad: -1 }],
    ['heat capacity', { m: 2, kg: 1, s: -2, K: -1 }], ['specific heat capacity', { m: 2, s: -2, K: -1 }], ['thermal conductance', { m: 2, kg: 1, s: -3, K: -1 }],
    ['thermal conductivity', { m: 1, kg: 1, s: -3, K: -1 }], ['heat transfer coefficient', { kg: 1, s: -3, K: -1 }], ['concentration', { m: -3, mol: 1 }],
    ['dynamic viscosity', { m: -1, kg: 1, s: -1 }], ['kinematic viscosity', { m: 2, s: -1 }], ['angle', { rad: 1 }], ['angular speed', { rad: 1, s: -1 }]
].map(([name, spec]) => [name, dims(spec)]);

export function quantityName(dimensions) {
    return quantities.find(([, known]) => known.every((value, index) => value === dimensions[index]))?.[0] ?? null;
}

const normalize = (text) => String(text ?? '').trim()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\bdeg(?:rees?)?\s*([CFR])\b/g, 'deg$1')
    .replace(/º/g, '°');

// A unit as written, read: its dimensions, its scale onto SI, its offset (an absolute temperature standing alone), what kind of
// quantity it is, and a note when it was read one way of two. Null for text the catalogue does not know.
export function parseUnit(text) {
    const written = normalize(text);
    // A bare C is degrees Celsius in an instrument's unit field far more often than a coulomb.
    if (written === 'C') return { text: written, dimensions: dims({ K: 1 }), scale: 1, offset: 273.15, kind: 'temperature', note: 'C read as degrees Celsius' };
    const whole = units.get(written);
    if (whole) return { text: written, dimensions: whole.dimensions, scale: whole.scale, offset: whole.absoluteOffset, kind: quantityName(whole.dimensions), note: null };
    const tokens = tokenize(written);
    if (!tokens || !tokens.length) return written === '' ? { text: '', dimensions: none, scale: 1, offset: 0, kind: 'dimensionless', note: null } : null;
    const result = evaluate(tokens);
    if (!result || !Number.isFinite(result.scale) || result.scale === 0) return null;
    // A single factor that is an absolute temperature keeps its offset (°C written as "°C1" never happens, but "degC" as a token may).
    const single = tokens.length === 1 && tokens[0].type === 'name' && tokens[0].power === 1 ? units.get(tokens[0].name) : null;
    return { text: written, dimensions: result.dimensions, scale: result.scale, offset: single?.absoluteOffset ?? 0, kind: quantityName(result.dimensions), note: null };
}

export function sameDimension(a, b) {
    return Boolean(a && b) && a.dimensions.every((value, index) => value === b.dimensions[index]);
}

const tidy = (value) => (Math.abs(value - Math.round(value)) < 1e-12 * Math.max(1, Math.abs(value)) ? Math.round(value) : Number(value.toPrecision(15)));

// The conversion from one unit to another, as a mapping applies it: value in `to` = value in `from` × scale + offset. Either unit
// may be given as text or as parseUnit's answer. { scale, offset, from, to, kind } or { error } (an unknown unit, or two kinds).
export function unitConversion(from, to) {
    const source = typeof from === 'string' ? parseUnit(from) : from;
    const target = typeof to === 'string' ? parseUnit(to) : to;
    if (!source) return { error: `"${from}" is not a unit Konjugate knows.` };
    if (!target) return { error: `"${to}" is not a unit Konjugate knows.` };
    const article = (kind) => (kind === 'dimensionless' ? 'a pure number' : /^[aeiou]/i.test(kind) ? `an ${kind}` : `a ${kind}`);
    // An angular speed and a frequency differ only by an angle: one revolution is taken as one cycle (rpm to Hz is a sixtieth). An
    // angle and a pure number (a model's angle without a unit) differ only by an angle too: the number is taken as radians.
    const angle = base.indexOf('rad');
    const time = base.indexOf('s');
    const onlyAngle = source.dimensions.every((value, index) => index === angle || value === target.dimensions[index])
        && Math.abs(source.dimensions[angle] - target.dimensions[angle]) === 1;
    const asCycles = onlyAngle && source.dimensions[time] < 0;
    if (!sameDimension(source, target) && !onlyAngle) {
        return { error: `${source.text || 'a pure number'} is ${source.kind ? article(source.kind) : 'another kind of quantity'}, and ${target.text || 'a pure number'} ${target.kind ? article(target.kind) : 'another kind'}: one cannot be turned into the other.` };
    }
    // SI value = written × scale + offset, on each side; so to = (from × fromScale + fromOffset − toOffset) / toScale.
    const cycle = asCycles ? (source.dimensions[angle] > target.dimensions[angle] ? 1 / (2 * Math.PI) : 2 * Math.PI) : 1;
    const scale = source.scale * cycle / target.scale;
    const offset = (source.offset - target.offset) / target.scale;
    return {
        scale: tidy(scale), offset: tidy(offset), from: source.text, to: target.text, kind: source.kind, identity: tidy(scale) === 1 && tidy(offset) === 0,
        ...(onlyAngle ? { note: asCycles ? 'one revolution taken as one cycle' : 'a pure number taken as radians' } : {})
    };
}

// A raw signal's range onto the quantity's: { low, high } of each (a transmitter's 4 and 20 mA, onto the 0 and 150 °C they stand for).
export function rangeConversion(raw, scaled) {
    if (![raw?.low, raw?.high, scaled?.low, scaled?.high].every(Number.isFinite) || raw.high === raw.low) return { error: 'A range needs a low and a high, and two different raw ends.' };
    const scale = (scaled.high - scaled.low) / (raw.high - raw.low);
    return { scale, offset: scaled.low - raw.low * scale };
}
