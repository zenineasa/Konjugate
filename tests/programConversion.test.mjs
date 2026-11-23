/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Converting a program from the older program format to version 2 (docs/proposals/programSdkV2.md, Migration from version 1).

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { convertProgramToVersion2 } from '../src/programConversion.mjs';
import { olderNodeProviderSource, olderProviderSource, programSourceVersion } from '../src/providerTemplate.mjs';

const root = join(import.meta.dirname, '..');

test('the older relationship templates convert completely, in each language', () => {
    for (const kind of ['cpp', 'python']) {
        const converted = convertProgramToVersion2(kind, olderProviderSource(kind, [{ key: 'sourceTemperature' }, { key: 'conductance' }], 'gradient', 'Thermal coupling'));
        assert.equal(converted.complete, true, `${kind}: ${converted.notes}`);
        assert.equal(converted.kind, 'relationship');
        assert.equal(programSourceVersion(kind, converted.source), 2);
        assert.doesNotMatch(converted.source, /konjugate::sdk::v1|RelationshipProvider|describe\(|add_?[gG]radient\(0/);
    }
    const cpp = convertProgramToVersion2('cpp', olderProviderSource('cpp', [{ key: 'sourceTemperature' }], 'gradient', 'Thermal coupling')).source;
    assert.match(cpp, /k::Input sourceTemperature\{this, "sourceTemperature"\};/);
    assert.match(cpp, /k::Output gradient\{this, "gradient"\};/);
    assert.match(cpp, /class ThermalCoupling final : public k::Relationship/);
    assert.match(cpp, /std::unique_ptr<k::Program> createProgram\(\)/);
    const python = convertProgramToVersion2('python', olderProviderSource('python', [{ key: 'sourceTemperature' }], 'gradient', 'Thermal coupling')).source;
    assert.match(python, /^from konjugate\.v2 import Input, Output, Relationship$/m);
    assert.match(python, /^    source_temperature = Input\(\)$/m);
    assert.match(python, /^class ThermalCoupling\(Relationship\):$/m);
});

test('reads become x[...] and an added gradient a return, a local of the same name read through this->', () => {
    const source = olderProviderSource('cpp', [{ key: 'hot' }, { key: 'cold' }], 'warming', 'Conduction').replace('        output.addGradient(0);',
        '        const double hot = context.inputs.at("hot");\n        output.addGradient(0.5 * (hot - context.inputs.at("cold")) + context.simulationTime);');
    const converted = convertProgramToVersion2('cpp', source);
    assert.ok(converted.complete);
    assert.match(converted.source, /const double hot = x\[this->hot\];/);
    assert.match(converted.source, /return 0\.5 \* \(hot - x\[cold\]\) \+ t;/);
    const python = olderProviderSource('python', [{ key: 'hot' }], 'warming', 'Conduction').replace('        outputs.add_gradient(0)',
        '        outputs.add_gradient(2 * inputs["hot"])\n        outputs.add_gradient(context.simulation_time)');
    const both = convertProgramToVersion2('python', python).source;
    assert.match(both, /result = 0\.0\n[\s\S]*result \+= 2 \* x\.hot\n\s+result \+= t\n\s+return result/, 'Several additions to one output are its sum.');
});

test('a node program\'s outputs are each set and summed', () => {
    for (const kind of ['cpp', 'python']) {
        const converted = convertProgramToVersion2(kind, olderNodeProviderSource(kind, [{ key: 'level' }], [{ key: 'rate' }, { key: 'shownLevel' }], 'Tank'));
        assert.equal(converted.kind, 'node');
        assert.equal(converted.complete, true, `${kind}: ${converted.notes}`);
        if (kind === 'cpp') {
            assert.match(converted.source, /class Tank final : public k::Node/);
            assert.match(converted.source, /y\[rate\] = 0\.0;\n\s+y\[shownLevel\] = 0\.0;/);
            assert.match(converted.source, /y\[shownLevel\] \+= 0\.0;/);
            assert.doesNotMatch(converted.source, /checkpoint|restore/);
        } else {
            assert.match(converted.source, /return self\.outputs\(rate=out_rate, shown_level=out_shown_level\)/);
            assert.doesNotMatch(converted.source, /def checkpoint|def restore/);
        }
    }
});

test('a program that keeps memory is converted as far as its ports, every place to decide marked, and not called finished', async () => {
    const converted = convertProgramToVersion2('python', await readFile(join(root, 'examples', 'providers', 'piControllerNode.py'), 'utf8'));
    assert.equal(converted.complete, false);
    assert.ok(converted.notes.some((note) => /checkpoint\(\) saved state by hand/.test(note)));
    assert.ok(converted.notes.some((note) => /__init__\(\) sets attributes/.test(note)));
    assert.match(converted.source, /# Konjugate: this attribute changes in evaluate\(\): declare it as memory \(Memory\) and change it in advance\(\)/);
    assert.match(converted.source, /# Konjugate: evaluate\(\) is given no step size/);
    assert.match(converted.source, /^    level = Input\("m"\)$/m, 'Units declared in describe() are kept.');
    assert.match(converted.source, /^    level_rate = Output\("m\/s"\)$/m);
});

test('the library\'s PID, which integrates in evaluate(), is not called finished', async () => {
    const library = JSON.parse(await readFile(join(root, 'assets', 'componentLibrary', 'pidParallel.json'), 'utf8'));
    const find = (value) => (value && typeof value === 'object' ? value.implementation?.source ?? Object.values(value).map(find).find(Boolean) : null);
    const converted = convertProgramToVersion2('cpp', find(library));
    assert.equal(converted.complete, false);
    assert.match(converted.source, /\/\/ Konjugate: this member changes in evaluate\(\)/);
});

test('a source of a shape the converter does not know keeps the older program, commented, below the template', () => {
    const converted = convertProgramToVersion2('python', 'print("not a program")\n');
    assert.equal(converted.complete, false);
    assert.match(converted.source, /^from konjugate\.v2 import Input, Output, Relationship$/m);
    assert.match(converted.source, /^# print\("not a program"\)$/m);
});

test('the plugin example converts, its unused del of the context dropped', async () => {
    const converted = convertProgramToVersion2('python', await readFile(join(root, 'examples', 'providers', 'helloWorld.py'), 'utf8'));
    assert.ok(converted.complete);
    assert.doesNotMatch(converted.source, /\bdel\b/);
    assert.match(converted.source, /return 2\.0 \* x\.input/);
});
