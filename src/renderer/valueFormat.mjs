// Copyright © 2026 Zenin Easa Panthakkalakath

// A state's number as a node's label writes it: short enough to read on a crowded canvas, with the whole number kept
// for the label's tooltip. Six significant digits at most, without padding zeros; a number too small or too large to
// read that way is written in scientific notation (1.069 × 10⁻⁵), where it was once every digit the engine holds
// (0.000010693069306930694).

const superscripts = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };

export function formatStateNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(number);
    if (number === 0) return '0';
    const size = Math.abs(number);
    if (size >= 1e-3 && size < 1e6) return String(Number(number.toPrecision(6)));
    const [mantissa, exponent] = number.toExponential(3).split('e');
    return `${Number(mantissa)} × 10${[...String(Number(exponent))].map((character) => superscripts[character]).join('')}`;
}

// The label's text and its tooltip: { text, exact }, each with the unit. The tooltip holds every digit.
export function stateValueText(value, unit = '') {
    const suffix = unit ? ` ${unit}` : '';
    return { text: `${formatStateNumber(value)}${suffix}`, exact: `${Number(value)}${suffix}` };
}
