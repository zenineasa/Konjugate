export default async function importData({ files, helpers, options }) {
    const text = files.find((file) => file.role === 'data')?.text ?? '';
    if (text.startsWith('boom')) throw new Error('boom');
    if (text.startsWith('hang')) await new Promise(() => {});
    if (text.startsWith('bad')) return { nope: true };
    if (text.startsWith('data-only')) return { ok: true, data: { received: options?.stage ?? null, files: files.length }, report: { errors: [], warnings: [], summary: {} } };
    if (text.startsWith('operations')) {
        const { document, references } = helpers.applyOperations([
            { kind: 'addNode', ref: 'a', name: 'Alpha' }, { kind: 'addState', nodeRef: 'a', ref: 'x', name: 'X', symbol: 'x', initialValue: 1 },
            { kind: 'addSourceTerm', nodeRef: 'a', outputStateRef: 'x', latex: '-x' }
        ]);
        return { ok: true, document, data: { references }, parameterIndex: [], report: { errors: [], warnings: [], summary: {} } };
    }
    const extra = await helpers.readPackageJson('data/extra.json');
    return {
        ok: true,
        document: { format: 'konjugate', version: 1, nodes: [], edges: [] },
        parameterIndex: [], report: { errors: [], warnings: [], summary: { text: text.trim(), extra: extra.value } }
    };
}
