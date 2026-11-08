/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The dialogs that edit a project's ownership block (docs/proposals/modelOwnership.md): Project properties, the defaults for new projects,
// and the save-time override. All three show the same fields, copied from one <template>, and read them back by name. The block itself
// is checked and cleaned in src/ownership.mjs; this file only moves it between that form and the page.

import { licenseChoices, normalizeOwnership, suggestsEncryption } from '../ownership.mjs';

const fieldNames = ['title', 'description', 'owner', 'copyright', 'contact', 'derivedFrom', 'revision', 'publicNotice'];

// Copies the fields into `host` for one of the scopes: 'properties' shows every field, 'defaults' only those a new project can start
// with, 'save' the ones worth changing for a single copy.
const scopeFields = {
    properties: null,
    defaults: ['owner', 'copyright', 'license', 'contact', 'confidential'],
    save: ['owner', 'copyright', 'license', 'contact', 'confidential', 'publicNotice']
};

function buildFields(host, scope) {
    host.replaceChildren(document.getElementById('ownershipFields').content.cloneNode(true));
    const select = host.querySelector('select[name="license"]');
    select.append(new Option('None chosen', ''), ...licenseChoices.map((choice) => new Option(choice.label, choice.id)));
    const allowed = scopeFields[scope];
    if (allowed) {
        host.querySelectorAll('[name]').forEach((control) => {
            // The custom license's terms and address belong with the license choice.
            const field = control.name.startsWith('license') ? 'license' : control.name;
            if (!allowed.includes(field)) control.closest('label').remove();
        });
    }
    const showCustom = () => host.querySelectorAll('[data-license="custom"]').forEach((label) => { label.hidden = select.value !== 'custom'; });
    select.addEventListener('change', showCustom);
    showCustom();
}

const control = (host, name) => host.querySelector(`[name="${name}"]`);

function fillFields(host, block) {
    for (const name of fieldNames) {
        const input = control(host, name);
        if (input) input.value = block?.[name] ?? '';
    }
    const license = control(host, 'license');
    if (license) {
        license.value = block?.license?.id ?? '';
        const text = control(host, 'licenseText');
        const url = control(host, 'licenseUrl');
        if (text) text.value = block?.license?.text ?? '';
        if (url) url.value = block?.license?.url ?? '';
        license.dispatchEvent(new Event('change'));
    }
    const confidential = control(host, 'confidential');
    if (confidential) confidential.checked = block?.confidential === true;
}

// The fields shown, as a block. Fields not shown (another scope) are left out, so `{ ...kept, ...read }` replaces only what was edited.
function readFields(host) {
    const raw = {};
    for (const name of fieldNames) {
        const input = control(host, name);
        if (input) raw[name] = input.value;
    }
    const license = control(host, 'license');
    if (license) {
        raw.license = license.value ? { id: license.value, text: control(host, 'licenseText')?.value, url: control(host, 'licenseUrl')?.value } : null;
    }
    const confidential = control(host, 'confidential');
    if (confidential) raw.confidential = confidential.checked;
    return raw;
}

const shownFieldNames = (host) => [...host.querySelectorAll('[name]')].map((input) => input.name);

// Replaces, in `block`, every field the form shows with what was typed; the others (and the save times) stay as they were.
function applyFields(block, host) {
    const shown = shownFieldNames(host);
    const kept = Object.fromEntries(Object.entries(block ?? {}).filter(([name]) => !shown.includes(name)));
    return normalizeOwnership({ ...kept, ...readFields(host) });
}

function openDialog(dialog, { submit, cancel, extra = [] }) {
    return new Promise((resolve) => {
        const form = dialog.querySelector('form');
        const cleanups = [];
        const finish = (result) => {
            cleanups.forEach((cleanup) => cleanup());
            dialog.close();
            resolve(result);
        };
        const listen = (target, type, handler) => { target.addEventListener(type, handler); cleanups.push(() => target.removeEventListener(type, handler)); };
        listen(form, 'submit', (event) => { event.preventDefault(); finish(submit()); });
        listen(dialog, 'cancel', (event) => { event.preventDefault(); finish(null); });
        listen(cancel, 'click', () => finish(null));
        for (const [button, result] of extra) listen(button, 'click', () => finish(result()));
        dialog.showModal();
    });
}

const formatTime = (value) => (value ? new Date(value).toLocaleString() : null);

// Project properties. Resolves { block } to keep the edits, { makeMine: true } for "Make this my own", { defaults: true } when the person
// asked to edit the defaults (the dialog closes first, so the two never stack), or null for cancel.
export function editProjectProperties({ block, someoneElses = false }) {
    const dialog = document.getElementById('ownershipDialog');
    const host = document.getElementById('ownershipFieldsHost');
    buildFields(host, 'properties');
    fillFields(host, block);
    document.getElementById('ownershipSomeoneElses').hidden = !someoneElses;
    document.getElementById('ownershipMakeMine').hidden = !someoneElses;
    document.getElementById('ownershipError').textContent = '';
    const times = [
        block?.firstSavedAt ? `First saved ${formatTime(block.firstSavedAt)}` : null,
        block?.lastSavedAt ? `last saved ${formatTime(block.lastSavedAt)}` : null,
        block?.savedWith ? `with Konjugate ${block.savedWith}` : null
    ].filter(Boolean).join(' · ');
    document.getElementById('ownershipSaveTimes').textContent = times ? `${times}. Konjugate keeps these itself, from this computer's clock.` : '';
    return openDialog(dialog, {
        submit: () => ({ block: applyFields(block, host) }),
        cancel: document.getElementById('ownershipCancel'),
        extra: [
            [document.getElementById('ownershipMakeMine'), () => ({ makeMine: true })],
            [document.getElementById('ownershipDefaultsOpen'), () => ({ defaults: true })]
        ]
    });
}

// The defaults for new projects, as Settings › New projects shows them: the fields built in `host` and filled from `defaults`, and
// `onChange(defaults)` told what to keep each time one is changed (they are kept as they are typed, as the rest of Settings is).
export function showOwnershipDefaults(host, { defaults, onChange }) {
    buildFields(host, 'defaults');
    fillFields(host, defaults);
    const changed = () => onChange(applyFields({}, host) ?? {});
    host.oninput = changed;
    host.onchange = changed;
}

// The save-time override: resolves { block } (what to write in this copy, which may be the project's own unchanged), { strip: true } to
// write none, or null for cancel. The open project's own block is never changed by what is typed here.
export function editSaveOwnership({ block, encrypted }) {
    const dialog = document.getElementById('saveOwnershipDialog');
    const host = document.getElementById('saveOwnershipFieldsHost');
    const strip = document.getElementById('saveOwnershipStrip');
    const note = document.getElementById('saveOwnershipEncryptionNote');
    buildFields(host, 'save');
    fillFields(host, block);
    strip.checked = false;
    const refresh = () => {
        host.hidden = strip.checked;
        note.hidden = strip.checked || !suggestsEncryption(applyFields(block, host), encrypted);
    };
    strip.onchange = refresh;
    host.oninput = refresh;
    host.onchange = refresh;
    refresh();
    return openDialog(dialog, {
        submit: () => (strip.checked ? { strip: true } : { block: applyFields(block, host) }),
        cancel: document.getElementById('saveOwnershipCancel')
    });
}
