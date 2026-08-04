// Copyright © 2026 Zenin Easa Panthakkalakath

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const values = Object.fromEntries(process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf('=');
    return separator < 0 ? [argument, ''] : [argument.slice(0, separator), argument.slice(separator + 1)];
}));
if (!values['--icons'] || !values['--output']) {
    throw new Error('Pass --icons=<PNG directory> and --output=<ICNS path>.');
}

const iconTypes = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024]
];
const chunks = [];
for (const [type, size] of iconTypes) {
    const image = await readFile(join(resolve(values['--icons']), `${size}.png`));
    if (image.subarray(1, 4).toString('ascii') !== 'PNG') {
        throw new Error(`${size}.png is not a PNG image.`);
    }
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32BE(header.length + image.length, 4);
    chunks.push(header, image);
}

const body = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write('icns', 0, 'ascii');
header.writeUInt32BE(header.length + body.length, 4);
const outputPath = resolve(values['--output']);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, Buffer.concat([header, body]));
