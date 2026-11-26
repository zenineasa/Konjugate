/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Root ports on the canvas (docs/proposals/rootPorts.md, stage 2): what a project's top-level port terminal says, where it
// stands, and the node Add › Input port and Add › Output port make for one. No DOM and no three.js, so `npm test` runs it;
// the canvas turns the positions into terminals drawn as a subsystem's inside view draws its own.

// The mark a terminal carries, as a subsystem's terminals do.
export function portBadge(direction) {
    return direction === 'in' ? '→ In' : direction === 'out' ? 'Out →' : '⇄ Both';
}

// In ports stand on the left of what is shown, out ports and ports both ways on the right.
export function portSide(direction) {
    return direction === 'in' ? 'left' : 'right';
}

// How a direction is said in a list: "In", "Out", "In and out".
export function portDirectionLabel(direction) {
    return direction === 'in' ? 'In' : direction === 'out' ? 'Out' : 'In and out';
}

// Whether a port takes a value from outside: an in port, or one both ways.
export const takesFromOutside = (port) => port.direction !== 'out';

// What a port does when the project runs on its own: an in port nothing in the project reaches holds its start value,
// said plainly ("nothing connected · stays at 20 °C"); '' when something reaches it or it only offers a value outside.
export function rootPortStatus(port, startText) {
    if (!takesFromOutside(port) || port.reached) return '';
    return `nothing connected · stays at ${startText}`;
}

// A terminal's text: `{ badge, name, detail, tooltip }`. `startText` is the port's start value written with its unit.
export function rootPortTerminalText(port, { startText }) {
    const status = rootPortStatus(port, startText);
    const unit = port.unit ? port.unit : '';
    const detail = status || [port.symbol, unit].filter(Boolean).join(' · ');
    const kind = port.direction === 'in' ? 'Input port' : port.direction === 'out' ? 'Output port' : 'Port both ways';
    const when = status ? ` When this model runs on its own, nothing is connected to it, so it stays at ${startText}.` : '';
    return {
        badge: portBadge(port.direction),
        name: port.name,
        detail,
        tooltip: `${kind} “${port.name}”, offering ${port.symbol}${unit ? ` (${unit})` : ''} outside.${when} Click to see this model's ports; drag to move it.`
    };
}

// Where each terminal stands: `Map(key → { position: [x, y, z], side })`. In ports to the left of `bounds`, the others to
// its right, `gap` beyond it, each side stacked along `stackAxis` (1 for y, 2 for z) by the height of its port's node, so
// few dotted lines cross, `spacing` apart and centred on the middle. A position the person has dragged a terminal to
// (`saved`, the block's `terminalPositions`) is kept.
export function layoutRootPortTerminals(ports, { bounds, stackAxis = 1, stackSign = 1, nodeHeight = () => null, saved = [], spacing = 1.35, gap = 4 }) {
    const centre = bounds.centre;
    const sides = { left: [], right: [] };
    ports.forEach((port) => sides[portSide(port.direction)].push(port));
    const positions = new Map();
    Object.entries(sides).forEach(([side, items]) => {
        const height = (port) => nodeHeight(port.nodeId) ?? centre[stackAxis];
        const ordered = [...items].sort((a, b) => stackSign * (height(b) - height(a)) || a.key - b.key);
        ordered.forEach((port, index) => {
            const position = [...centre];
            position[0] = side === 'left' ? bounds.min[0] - gap : bounds.max[0] + gap;
            position[stackAxis] = centre[stackAxis] + stackSign * ((ordered.length - 1) / 2 - index) * spacing;
            positions.set(port.key, { position, side });
        });
    });
    (saved ?? []).forEach((entry) => {
        const placed = positions.get(entry.portKey);
        if (placed && Array.isArray(entry.position) && entry.position.length === 3 && entry.position.every(Number.isFinite)) placed.position = [...entry.position];
    });
    return positions;
}

// A terminal moved to `position` (or put back to the automatic layout, `null`), in a block's `terminalPositions`; the
// field is left out when nothing is placed. Returns the new list or undefined.
export function placedTerminalPositions(entries, portKey, position) {
    const others = (entries ?? []).filter((entry) => entry.portKey !== portKey);
    const next = position ? [...others, { portKey, position: [...position] }] : others;
    return next.length ? next : undefined;
}

// The symbol of the state Add › Input port makes from the port's name, in lower camel case as every symbol is ("Room
// temperature" → roomTemperature, "2nd input" → u2ndInput); 'u' for an input and 'y' for an output when nothing usable is left.
export function portSymbolFromName(name, direction = 'in') {
    const words = String(name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const fallback = direction === 'out' ? 'y' : 'u';
    if (!words.length) return fallback;
    const joined = words.map((word, index) => (index ? word[0].toUpperCase() + word.slice(1) : word)).join('');
    return /^[a-z]/.test(joined) ? joined : `${fallback}${joined[0].toUpperCase()}${joined.slice(1)}`;
}

// The node Add › Input port or Output port makes, as a project document's node: one Update state of the port's name and
// unit starting at 0, at `position`. `ids` gives the node's and the state's ids.
export function portNodeDocument({ name, unit = '', direction, position, ids, saysKinds = true }) {
    const title = String(name ?? '').trim() || (direction === 'out' ? 'Output' : 'Input');
    return {
        id: ids.nodeId, name: title, position: [...position], rotation: [0, 0, 0], scale: [1, 1, 1],
        states: [{ id: ids.stateId, name: title, symbol: portSymbolFromName(title, direction), initialValue: 0, unit: String(unit ?? '').trim(), ...(saysKinds ? { kind: 'update' } : {}) }],
        sourceTerms: [], appearance: { type: 'primitive', shape: 'sphere', color: direction === 'out' ? '#7a5a34' : '#34727a' }
    };
}

// How many in and out ports a project offers, said for a summary ("2 in, 1 out"; "1 in and out"); '' for none.
export function portCountText(ports) {
    const count = (direction) => ports.filter((port) => (port.direction ?? 'both') === direction).length;
    return [[count('in'), 'in'], [count('out'), 'out'], [count('both'), 'in and out']]
        .filter(([number]) => number > 0).map(([number, label]) => `${number} ${label}`).join(', ');
}

const counted = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// The component bar's interface line (docs/proposals/rootPorts.md, Opening a component file): "PID controller is a component:
// 2 in ports, 1 out port, 3 exposed parameters."
export function componentInterfaceLine(name, ports, exposedParameters = 0) {
    const count = (direction) => ports.filter((port) => (port.direction ?? 'both') === direction).length;
    const parts = [
        count('in') ? counted(count('in'), 'in port') : null,
        count('out') ? counted(count('out'), 'out port') : null,
        count('both') ? counted(count('both'), 'port in and out', 'ports in and out') : null,
        exposedParameters ? counted(exposedParameters, 'exposed parameter') : null
    ].filter(Boolean);
    return `${name} is a component: ${parts.length ? parts.join(', ') : 'no ports yet'}.`;
}

const listed = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// What saving a component file changes for the models that link it, from interfaceChanges' conflicts (ports and parameters
// removed or changed) and the open projects known to link the file, by name: '' when nothing would be asked.
export function linkedChangeWarning(conflicts, linkingNames = []) {
    if (!conflicts.length) return '';
    const removed = conflicts.filter((item) => item.change === 'removed').map((item) => `‘${item.name}’`);
    const changed = conflicts.filter((item) => item.change !== 'removed').map((item) => `‘${item.name}’`);
    const about = [removed.length ? `removing ${listed(removed)}` : null, changed.length ? `the change to ${listed(changed)}` : null].filter(Boolean).join(' and ');
    if (!linkingNames.length) return `Saving changes its interface: models that link this file will be asked about ${about}.`;
    const who = linkingNames.length === 1 ? `1 open project linked to this file (${linkingNames[0]}) will be asked` : `${linkingNames.length} open projects linked to this file (${listed(linkingNames)}) will be asked`;
    return `Saving changes its interface: ${who} about ${about}.`;
}
