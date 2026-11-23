/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Every operation an equation can use, in a stiff model of three states that stay where each operation is defined.
const binding = (stateId, symbol) => ({ kind: 'state', nodeId: 1, stateId, symbol });
const bindings = [binding(11, 'x'), binding(12, 'y'), binding(13, 'z'), { kind: 'time', symbol: 't' }];
const term = (id, state, stateId, mathJson) => ({ id, state, expression: 'f', expressionModel: { latex: '', bindings, output: { stateId }, mathJson } });
export const everyOperationDocument = () => ({
    format: 'konjugate', version: 1, metadata: { units: 'SI' },
    nodes: [{ id: 1, name: 'Everything', position: [0, 0, 0], appearance: { type: 'primitive', shape: 'box', color: '#2f6970' },
        states: [{ id: 11, name: 'X', symbol: 'x', initialValue: 0.8, unit: '' }, { id: 12, name: 'Y', symbol: 'y', initialValue: 0.4, unit: '' },
            { id: 13, name: 'Z', symbol: 'z', initialValue: 0.6, unit: '' }],
        sourceTerms: [
            term(101, 'x', 11, ['Add', ['Multiply', '-50', 'x', 'y'], ['Sin', 'z'], ['Negate', ['Divide', ['Exp', ['Negate', 'x']], ['Add', '1', ['Power', 'y', '2']]]],
                ['Multiply', '0.1', ['Abs', ['Add', 'y', '-0.5']]], ['Multiply', '0.01', ['Power', ['Add', '1', ['Power', 'x', '2']], 'y']]]),
            term(102, 'y', 12, ['Add', ['Multiply', '-2', 'y'], ['Multiply', ['Sqrt', ['Add', 'x', '1']], ['Cos', 't']], ['Ln', ['Add', '1', 'z']], ['Tan', ['Multiply', '0.1', 'x']],
                ['Negate', ['Arctan', 'y']], ['Arctan2', 'z', ['Add', 'x', '1']], ['Tanh', 'x'], ['Negate', ['Min', 'x', 'y']], ['Max', 'z', '0.2']]),
            term(103, 'z', 13, ['Add', ['Which', ['Greater', 'x', '0.5'], ['Multiply', '-1000', 'z'], 'True', ['Multiply', '-500', 'z']],
                ['Arcsin', ['Multiply', '0.1', 'y']], ['Arccos', ['Multiply', '0.1', 'z']], ['Multiply', '0.001', ['Power', ['Add', '2', 'x'], ['Add', '1', 'y']]]])
        ] }],
    edges: []
});
