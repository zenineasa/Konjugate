/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const shapesDir = join(currentDir, '..', 'assets', 'shapes');
const manifestPath = join(shapesDir, 'manifest.json');

test('shape library manifest contains valid shapes across standard domains with multi-category support', () => {
    assert.ok(existsSync(manifestPath), 'manifest.json should exist');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.ok(Array.isArray(manifest.shapes), 'shapes should be an array');
    assert.ok(manifest.shapes.length >= 20, 'should have at least 20 bundled shapes');

    const expectedDomains = new Set(['mechanical', 'structural', 'electrical', 'fluid', 'robotics']);
    const seenDomains = new Set();
    const seenIds = new Set();
    const seenFiles = new Set();
    let multiDomainCount = 0;

    for (const shape of manifest.shapes) {
        assert.ok(shape.id && typeof shape.id === 'string', `Invalid shape id: ${shape.id}`);
        assert.ok(!seenIds.has(shape.id), `Duplicate shape id: ${shape.id}`);
        seenIds.add(shape.id);

        assert.ok(shape.name && typeof shape.name === 'string', `Invalid shape name: ${shape.name}`);

        const domains = Array.isArray(shape.domains)
            ? shape.domains
            : (shape.domain ? [shape.domain] : []);
        assert.ok(domains.length > 0, `Shape ${shape.id} must have non-empty domains array`);
        for (const domain of domains) {
            assert.ok(typeof domain === 'string' && domain.length > 0, `Invalid domain item in ${shape.id}`);
            seenDomains.add(domain);
        }
        if (domains.length > 1) multiDomainCount += 1;

        assert.ok(['stl', 'step', 'stp'].includes(shape.format), `Unsupported format for ${shape.id}: ${shape.format}`);
        assert.ok(shape.file && typeof shape.file === 'string', `Invalid file path for ${shape.id}`);
        assert.ok(!seenFiles.has(shape.file), `Duplicate file referenced: ${shape.file}`);
        seenFiles.add(shape.file);

        assert.ok(Array.isArray(shape.tags) && shape.tags.length > 0, `Shape ${shape.id} must have non-empty tags array`);

        const filePath = join(shapesDir, shape.file);
        assert.ok(existsSync(filePath), `Shape file does not exist on disk: ${filePath}`);

        const bytes = readFileSync(filePath);
        assert.ok(bytes.length > 84, `Shape file is too small to be valid: ${filePath}`);

        if (shape.format === 'stl') {
            const triangleCount = bytes.readUInt32LE(80);
            const expectedSize = 84 + triangleCount * 50;
            assert.equal(
                bytes.length,
                expectedSize,
                `STL file ${shape.file} size mismatch: expected ${expectedSize} bytes for ${triangleCount} triangles, got ${bytes.length}`
            );
        } else if (shape.format === 'step' || shape.format === 'stp') {
            const text = bytes.toString('utf8', 0, Math.min(bytes.length, 256));
            assert.match(text, /^ISO-10303-21;/, `STEP file ${shape.file} missing ISO-10303-21 header`);
        }
    }

    for (const domain of expectedDomains) {
        assert.ok(seenDomains.has(domain), `Expected domain "${domain}" missing from manifest`);
    }
    assert.ok(multiDomainCount >= 8, `Expected at least 8 cross-disciplinary shapes with multiple domains, found ${multiDomainCount}`);
});

test('bundled robotics shapes include all core manipulator, actuation, and mobility assets', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const roboticsShapes = manifest.shapes.filter((shape) => {
        const domains = Array.isArray(shape.domains)
            ? shape.domains
            : (shape.domain ? [shape.domain] : []);
        return domains.includes('robotics');
    });
    const roboticsIds = new Set(roboticsShapes.map((shape) => shape.id));

    const expectedRobotics = [
        'robotics/servoActuator',
        'robotics/articulatedLink',
        'robotics/parallelGripper',
        'robotics/driveWheel',
        'robotics/propellerRotor'
    ];

    for (const id of expectedRobotics) {
        assert.ok(roboticsIds.has(id), `Missing expected robotics shape: ${id}`);
    }

    const servo = manifest.shapes.find((s) => s.id === 'robotics/servoActuator');
    const servoDomains = servo.domains ?? [servo.domain];
    assert.ok(
        servoDomains.includes('robotics') && servoDomains.includes('electrical') && servoDomains.includes('mechanical'),
        'Servo actuator should belong to robotics, electrical, and mechanical domains'
    );
});
