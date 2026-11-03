/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What a launcher may be given as files, beyond the text it reads (binary inputs and files it keeps), shared by the desktop (launcherHost.mjs)
// and the web edition (webLauncherBridge.mjs). No Node, no DOM: a name or a path is cut at its last separator here.

const fileBaseName = (path) => String(path).split(/[\\/]/).at(-1);

// A binary input (a file role declared `binary`): one large file the importer reads as bytes and turns into text
// files of its other roles. It is read from disk when the importer runs and is never kept in memory or in a session.
export const maximumBinaryInputBytes = 1024 * 1024 * 1024;
// And all of a role's binary files together: they are in the importer's memory at once.
export const maximumBinaryTotalBytes = 2 * 1024 * 1024 * 1024;

// The binary files chosen for a role ([{ path, size }]), checked: each within the limit for one, and all within the
// limit together. Returns them as pending inputs. Throws a message naming the file, or the total, that is too large.
export function binaryChoice(chosen, role) {
    for (const { path, size } of chosen) {
        if (size > maximumBinaryInputBytes) throw new Error(`${fileBaseName(path)} is larger than the ${maximumBinaryInputBytes / 1024 / 1024} MB limit.`);
    }
    const total = chosen.reduce((sum, item) => sum + item.size, 0);
    if (total > maximumBinaryTotalBytes) throw new Error(`These files come to ${Math.round(total / 1024 / 1024).toLocaleString('en')} MB, more than the ${maximumBinaryTotalBytes / 1024 / 1024} MB they may come to together.`);
    return chosen.map(({ path, size }) => ({ role, name: fileBaseName(path), path, binary: true, bytes: size, sample: false }));
}
// The kinds of file a window asks to keep, named by their endings (["osm.pbf"]): checked, the open dialog's filter (which
// goes by a name's last extension only, so "osm.pbf" offers .pbf files) and a check of each file chosen by its whole
// ending, in any case, so a file the dialog let through all the same is refused before anything is copied. No kinds
// named, any file is kept, as before.
export function storedFileKinds(accept) {
    if (accept === undefined || accept === null) return { filters: [], check: () => {} };
    if (!Array.isArray(accept) || !accept.length || accept.length > 8 || !accept.every((ending) => typeof ending === 'string' && /^[a-z0-9]{1,12}(\.[a-z0-9]{1,12}){0,2}$/i.test(ending))) {
        throw new Error('A window names the files it keeps as up to 8 endings, such as ["osm.pbf"].');
    }
    const endings = accept.map((ending) => `.${ending.toLowerCase()}`);
    const named = endings.length === 1 ? endings[0] : `${endings.slice(0, -1).join(', ')} or ${endings.at(-1)}`;
    return {
        filters: [{ name: named, extensions: [...new Set(accept.map((ending) => ending.split('.').at(-1).toLowerCase()))] }],
        check(path) {
            if (!endings.some((ending) => fileBaseName(path).toLowerCase().endsWith(ending))) throw new Error(`${fileBaseName(path)} was not kept: only ${named} files are kept here.`);
        }
    };
}
