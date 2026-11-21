/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The ownership block a project carries (`ownership`, docs/projectSchema.md; design in docs/proposals/modelOwnership.md): who made the
// model, the copyright notice, the license, a contact, and the times it was first and last saved. It is a notice, not an enforcement.
// Like add-on data and the tuning setup it sits beside the model, not in it: it is written when the project is saved and read when it is
// opened, and never reaches the engine, validation, the assistant or the undo history.
// A project file can be edited by hand, so everything is checked here on the way in; anything unusable is dropped, never thrown.

export const maximumFieldLength = 500;
export const maximumDescriptionLength = 4000;
export const maximumPublicNoticeLength = 300;

// The licenses the picker offers. `id` is an SPDX identifier where one exists; `all-rights-reserved` and `custom` are Konjugate's own.
export const licenseChoices = Object.freeze([
    { id: 'all-rights-reserved', label: 'All rights reserved' },
    { id: 'MIT', label: 'MIT' },
    { id: 'Apache-2.0', label: 'Apache-2.0' },
    { id: 'MPL-2.0', label: 'MPL-2.0' },
    { id: 'CC-BY-4.0', label: 'CC-BY-4.0' },
    { id: 'CC-BY-SA-4.0', label: 'CC-BY-SA-4.0' },
    { id: 'CC0-1.0', label: 'CC0-1.0' },
    { id: '0BSD', label: '0BSD (no conditions)' },
    { id: 'custom', label: 'Custom' }
]);
const licenseIds = new Set(licenseChoices.map((choice) => choice.id));

// Every project saved before this feature carried this string, put there by the application itself rather than written by anyone.
// It is not a claim a user made, so it is never shown as one.
export const legacyAutomaticCopyright = 'Copyright © 2026 Zenin Easa Panthakkalakath';

const textField = (value, limit = maximumFieldLength) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null);

// An ISO 8601 UTC time to the second ("2026-11-05T09:14:02Z"), or null for anything else.
export function normalizeTimestamp(value) {
    if (typeof value !== 'string') return null;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return null;
    return new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function formatTimestamp(date) {
    return new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeLicense(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const license = {};
    if (typeof raw.id === 'string' && licenseIds.has(raw.id)) license.id = raw.id;
    const text = textField(raw.text, maximumDescriptionLength);
    const url = textField(raw.url);
    // A license that names nothing known but gives its own words or address is a custom one.
    if (!license.id && (text || url)) license.id = 'custom';
    if (!license.id) return null;
    if (license.id === 'custom') {
        if (text) license.text = text;
        if (url) license.url = url;
    }
    return license;
}

// The block a project file carries, made safe to use, or null when it carries nothing. A file saved before this feature has only the
// old top-level `copyright` string; that is read as the notice, unless it is the one the application itself used to write.
export function normalizeOwnership(raw, legacyCopyright = null) {
    const block = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const result = {};
    const owner = textField(block.owner);
    if (owner) result.owner = owner;
    let copyright = textField(block.copyright);
    if (!copyright && !raw) {
        const legacy = textField(legacyCopyright);
        if (legacy && legacy !== legacyAutomaticCopyright) copyright = legacy;
    }
    if (copyright) result.copyright = copyright;
    const license = normalizeLicense(block.license);
    if (license) result.license = license;
    const contact = textField(block.contact);
    if (contact) result.contact = contact;
    if (block.confidential === true) result.confidential = true;
    const derivedFrom = textField(block.derivedFrom, maximumDescriptionLength);
    if (derivedFrom) result.derivedFrom = derivedFrom;
    const revision = textField(block.revision, 60);
    if (revision) result.revision = revision;
    const title = textField(block.title);
    if (title) result.title = title;
    const description = textField(block.description, maximumDescriptionLength);
    if (description) result.description = description;
    const publicNotice = textField(block.publicNotice, maximumPublicNoticeLength);
    if (publicNotice) result.publicNotice = publicNotice;
    const firstSavedAt = normalizeTimestamp(block.firstSavedAt);
    if (firstSavedAt) result.firstSavedAt = firstSavedAt;
    const lastSavedAt = normalizeTimestamp(block.lastSavedAt);
    if (lastSavedAt) result.lastSavedAt = lastSavedAt;
    const savedWith = textField(block.savedWith, 60);
    if (savedWith) result.savedWith = savedWith;
    return Object.keys(result).length ? result : null;
}

// The fields a person fills in, as opposed to the three Konjugate keeps itself.
export const userFields = Object.freeze(['owner', 'copyright', 'license', 'contact', 'confidential', 'derivedFrom', 'revision', 'title', 'description', 'publicNotice']);

// Whether the block holds anything a person wrote. A project with only save times is not one anyone claimed.
export function hasUserDetails(block) {
    return Boolean(block) && userFields.some((field) => block[field] !== undefined);
}

// "Copyright © {year} Acme" -> "Copyright © 2026 Acme", the year of `now`.
export function expandCopyright(text, now = new Date()) {
    if (typeof text !== 'string') return text;
    return text.replaceAll('{year}', String(new Date(now).getUTCFullYear()));
}

// The block as it is written by a save: the year token worked out, the first save time kept (or set, the first time), the last save
// time and the Konjugate version replaced. Returns null when there is nothing to write.
export function stampOwnership(block, { now = new Date(), version = null } = {}) {
    const stamp = formatTimestamp(now);
    const next = { ...(normalizeOwnership(block) ?? {}) };
    if (next.copyright) next.copyright = expandCopyright(next.copyright, now);
    if (!next.firstSavedAt) next.firstSavedAt = stamp;
    next.lastSavedAt = stamp;
    const savedWith = textField(version, 60);
    if (savedWith) next.savedWith = savedWith;
    return normalizeOwnership(next);
}

// A project's saved JSON as it is after one more save by something that did not edit it (the command line's --output-kjt): the same
// content with only the ownership block's save times and Konjugate version brought up to date, and every other field as it was. Content
// that is not a project document is returned unchanged.
export function stampProjectContent(content, options = {}) {
    try {
        const document = JSON.parse(content);
        if (!document || typeof document !== 'object' || Array.isArray(document) || document.format !== 'konjugate') return content;
        const ownership = stampOwnership(normalizeOwnership(document.ownership, document.copyright), options);
        return `${JSON.stringify({ ...document, ...(ownership ? { ownership } : {}) }, null, 4)}\n`;
    } catch {
        return content;
    }
}

// The notice an encrypted file shows before it is unlocked, as it is written in the file's header: short text the person typed for it, or
// null. It is the only part of the block kept outside the encrypted payload, so it is read from a header with care.
export function normalizePublicNotice(value) {
    return textField(value, maximumPublicNoticeLength);
}

// The notice a project's saved content asks to have shown in its header, or null.
export function publicNoticeOf(content) {
    try {
        return normalizePublicNotice(JSON.parse(content)?.ownership?.publicNotice);
    } catch {
        return null;
    }
}

// The defaults a person sets in the preferences, and the block a new project starts from. Every default starts empty. The copyright
// keeps its {year} token here and is worked out at each save.
const defaultFields = ['owner', 'copyright', 'license', 'contact', 'confidential'];

export function normalizeOwnershipDefaults(raw) {
    const normalized = normalizeOwnership(raw && typeof raw === 'object' ? Object.fromEntries(defaultFields.filter((field) => raw[field] !== undefined).map((field) => [field, raw[field]])) : null);
    return normalized ?? {};
}

export function seedOwnership(defaults) {
    const normalized = normalizeOwnershipDefaults(defaults);
    return Object.keys(normalized).length ? normalized : null;
}

// Whether an opened file names an owner other than the one the person's defaults would give: it is somebody else's work, so a save
// keeps what it says.
export function isSomeoneElses(block, defaults) {
    if (!block?.owner) return false;
    const mine = normalizeOwnershipDefaults(defaults).owner;
    return block.owner !== mine;
}

// "Make this my own": the person's defaults replace the block, and what the old one said about where the work came from is kept in
// derivedFrom, so attribution is not lost silently. The first save time stays, as it records when this file first existed.
export function makeOwnershipMine(block, defaults) {
    const previous = normalizeOwnership(block) ?? {};
    const mine = normalizeOwnershipDefaults(defaults);
    const next = { ...mine };
    const was = [
        previous.title ?? null,
        previous.owner ? `by ${previous.owner}` : null,
        previous.license ? `license ${licenseText(previous.license)}` : null
    ].filter(Boolean).join(', ');
    const derived = [was, previous.derivedFrom].filter(Boolean).join('; ');
    if (derived) next.derivedFrom = derived.slice(0, maximumDescriptionLength);
    if (previous.firstSavedAt) next.firstSavedAt = previous.firstSavedAt;
    return normalizeOwnership(next);
}

// A license in words, for a file header or an FMU's modelDescription: its SPDX id, "All rights reserved", or the custom text or address.
export function licenseText(license) {
    if (!license?.id) return '';
    if (license.id === 'all-rights-reserved') return 'All rights reserved';
    if (license.id === 'custom') return license.text ?? license.url ?? 'Custom license';
    return license.id;
}

// The lines a generated source file opens with when its project names an owner or a copyright. Without a comment prefix; empty when
// the block says nothing a reader should be told.
export function exportNoticeLines(block, now = new Date()) {
    const lines = [];
    if (block?.copyright) lines.push(expandCopyright(block.copyright, now));
    else if (block?.owner) lines.push(`Owner: ${block.owner}`);
    if (block?.license) lines.push(`License: ${licenseText(block.license)}`);
    if (block?.contact) lines.push(`Contact: ${block.contact}`);
    return lines;
}

// The FMI modelDescription attributes the block maps to: author, copyright and license.
export function fmiAttributes(block, now = new Date()) {
    const attributes = {};
    if (block?.owner) attributes.author = block.owner;
    if (block?.copyright) attributes.copyright = expandCopyright(block.copyright, now);
    if (block?.license) attributes.license = licenseText(block.license);
    return attributes;
}

// Whether the Save dialog should mention that encrypting is what protects the file: the license reserves every right, or the model is
// marked confidential, and the save is not encrypted.
export function suggestsEncryption(block, encrypted) {
    if (encrypted || !block) return false;
    return block.confidential === true || block.license?.id === 'all-rights-reserved';
}
