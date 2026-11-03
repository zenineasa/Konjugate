/* Copyright © 2026 Zenin Easa Panthakkalakath */

// MD5, in steps, for the web edition: a launcher's large download is checked against the sum its server publishes beside it (a map extract's
// .md5 file), as the desktop checks it with node:crypto, and WebCrypto has no MD5 and cannot hash a file it has not got whole. Used only to
// tell a file that arrived intact from one that did not, never to protect anything. No Node, no DOM.

const sines = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0);
const roundShifts = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];

export function createMd5() {
    let a = 0x67452301; let b = 0xefcdab89; let c = 0x98badcfe; let d = 0x10325476;
    const block = new Uint8Array(64);
    let filled = 0;
    let length = 0;
    const words = new Uint32Array(16);
    const compress = (bytes, offset) => {
        for (let index = 0; index < 16; index += 1) {
            const at = offset + index * 4;
            words[index] = (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
        }
        let x = a; let y = b; let z = c; let w = d;
        for (let step = 0; step < 64; step += 1) {
            let f; let g;
            if (step < 16) { f = (y & z) | (~y & w); g = step; }
            else if (step < 32) { f = (w & y) | (~w & z); g = (5 * step + 1) % 16; }
            else if (step < 48) { f = y ^ z ^ w; g = (3 * step + 5) % 16; }
            else { f = z ^ (y | ~w); g = (7 * step) % 16; }
            const sum = (x + f + sines[step] + words[g]) >>> 0;
            x = w; w = z; z = y;
            y = (y + ((sum << roundShifts[step]) | (sum >>> (32 - roundShifts[step])))) >>> 0;
        }
        a = (a + x) >>> 0; b = (b + y) >>> 0; c = (c + z) >>> 0; d = (d + w) >>> 0;
    };
    return {
        update(bytes) {
            length += bytes.length;
            let offset = 0;
            if (filled) {
                const take = Math.min(64 - filled, bytes.length);
                block.set(bytes.subarray(0, take), filled);
                filled += take;
                offset = take;
                if (filled < 64) return this;
                compress(block, 0);
                filled = 0;
            }
            for (; offset + 64 <= bytes.length; offset += 64) compress(bytes, offset);
            if (offset < bytes.length) { block.set(bytes.subarray(offset), 0); filled = bytes.length - offset; }
            return this;
        },
        // The sum as 32 lower-case hexadecimal digits. Ends this hash.
        digest() {
            const bits = length * 8;
            const padding = new Uint8Array(((filled < 56 ? 56 : 120) - filled) + 8);
            padding[0] = 0x80;
            const view = new DataView(padding.buffer);
            view.setUint32(padding.length - 8, bits >>> 0, true);
            view.setUint32(padding.length - 4, Math.floor(bits / 2 ** 32) >>> 0, true);
            this.update(padding);
            const out = new DataView(new ArrayBuffer(16));
            [a, b, c, d].forEach((value, index) => out.setUint32(index * 4, value, true));
            return [...new Uint8Array(out.buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        }
    };
}
