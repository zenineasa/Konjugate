export default async function importData({ files, helpers }) {
    const text = files.find((file) => file.role === 'data')?.text ?? '';
    if (text.startsWith('boom')) throw new Error('boom');
    if (text.startsWith('hang')) await new Promise(() => {});
    if (text.startsWith('bad')) return { nope: true };
    const extra = await helpers.readPackageJson('data/extra.json');
    return {
        ok: true,
        document: { format: 'konjugate', version: 1, nodes: [], edges: [] },
        parameterIndex: [], report: { errors: [], warnings: [], summary: { text: text.trim(), extra: extra.value } }
    };
}
