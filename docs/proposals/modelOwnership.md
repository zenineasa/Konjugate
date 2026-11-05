---
type: Proposal
title: Model ownership and license metadata
description: Owner, copyright, license and contact details saved inside a .kjt project, with per-user defaults, a per-save override, export mapping, and the privacy policy changes they need.
tags: [proposals, kjt, metadata, license, privacy]
status: stable
implementation: complete
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Model ownership and license metadata

**Status: built.** Every stage of the plan below is implemented on the desktop and in the web edition; "As built" lists where the implementation departs from, or settles, the text that follows.

## Problem

A model someone builds in Konjugate can be proprietary work: a company's plant model, a consultant's deliverable, a researcher's published system. Today a saved `.kjt` says nothing about who made it, who owns it, or what anyone may do with it. Once the file is emailed or posted, that information is gone. Konjugate itself is licensed under MPL-2.0, and nothing in the product says that the models people create with it belong to them.

The goal is a small, optional block of metadata that travels with the project, that users can set once as a default and override when they save, and that carries through to what Konjugate exports.

## What exists today

- [Project document schema](../projectSchema.md) already lists an optional top-level `copyright` attribution string. Nothing in `src/` reads or writes it, so it is a reserved slot rather than a feature.
- Add-on manifests and plugin manifests already carry `copyright` and licensing metadata, and `examples/manifest.json` carries a copyright line. Models are the one artifact without it.
- `addonData` and `tuningSetup` set the pattern for project content the engine never sees: the canvas keeps it beside the model, writes it on save, reads it on open, and it never reaches the engine, validation, copy and paste or undo.
- `metadata` is already a top-level object holding `metadata.units`, so the new block should be a sibling rather than extend it.
- The [KJT container](../kjtFormat.md) has a JSON header that stays unencrypted even for an encrypted file. The model itself, including everything described here, is inside the encrypted payload.
- The save flow already has "Save encrypted…" and a "Choose saved content" dialog, which is where a per-save override naturally sits.

## Decisions

1. **The metadata is a notice, not an enforcement.** Anyone with the file can edit or remove it, and Konjugate does not try to stop that. It records the owner's claim and wishes in a form people and tools can read. Real protection for proprietary content is encryption, and the interface says so wherever the metadata is edited.
2. **It lives inside the payload, so encryption covers it.** An owner who encrypts a file may not want their name or contact visible without the password. An optional separate public notice can go in the cleartext header for people who want a "contact me for the password" label. It is off by default and is never filled in automatically.
3. **One license per file.** Inline C++ or Python providers in a project fall under the same license as the model. Per-component licensing is out of scope here and can be revisited if remixing of library components makes it necessary.

## The `ownership` block

A new optional top-level object, additive within schema version 1, omitted entirely when empty:

```json
"ownership": {
    "owner": "Acme Thermal Ltd",
    "copyright": "Copyright © {year} Acme Thermal Ltd",
    "license": { "id": "CC-BY-4.0" },
    "contact": "models@acme.example",
    "confidential": false,
    "derivedFrom": "Based on Heat Exchanger Example by Konjugate contributors, MPL-2.0",
    "revision": "2.1",
    "firstSavedAt": "2026-11-05T09:14:02Z",
    "lastSavedAt": "2026-11-12T16:40:31Z",
    "savedWith": "1.4.0",
    "title": "Plant cooling loop",
    "description": "Cooling loop for line 3, validated against 2026 site data."
}
```

- `owner`: a person or organisation, free text.
- `copyright`: the notice text. A `{year}` token is replaced with the current year when the project is saved, and stored already expanded, so a reader never sees the token.
- `license`: `{ id }` holds an SPDX identifier for a known license, with the extra choices *All rights reserved* and *Custom*. A custom license is `{ text }` and/or `{ url }`. The picker offers all rights reserved, MIT, Apache-2.0, MPL-2.0, CC-BY-4.0, CC-BY-SA-4.0, CC0-1.0, 0BSD (labelled "0BSD (no conditions)", a permissive license with no attribution requirement and no patent clause, which some company legal teams accept where they do not accept CC0) and custom.
- `contact`: an email address or URL, for whoever needs permission or the password.
- `confidential`: boolean, default `false`. It marks the model as one the owner does not want sent to third parties, and drives the assistant behaviour below. It is a flag for Konjugate's own behaviour, not a legal term.
- `derivedFrom`: free text naming the work this one is based on, so attribution requirements such as CC-BY survive remixing.
- `revision`: a user-chosen revision string, separate from the file format `version`.
- `title`, `description`: the project as a whole, parallel to node and edge `description`.

Konjugate also maintains three fields itself, which the user cannot edit:

- `firstSavedAt`: the system clock's time at the project's first save. It is written once and never changed by later saves. A project opened from a file keeps the value it arrived with, including after "Make this my own", because it records when this file first existed. A file with no `firstSavedAt` (saved before this feature) gets one at its next save, which is the best the file can say.
- `lastSavedAt`: the system clock's time at every save, replaced each time. A save to a new file with "Save as" updates it and leaves `firstSavedAt` alone.
- `savedWith`: the Konjugate version that made the save.

Both times are ISO 8601 in UTC, to the second. They come from the computer's clock and are not verified, so they are as much a notice as the rest of the block. They carry no personal information, but they do reveal when someone worked, which the privacy policy changes below mention. `revision` is never changed automatically: it is set by the user alone, which keeps files that live in version control free of a changing value on every save, and `lastSavedAt` is the field that tells you when a file was last written.

The legacy top-level `copyright` string stays readable: when `ownership.copyright` is absent, the old value is shown in its place, and a save writes only the new block. The engine never receives the block, in the same way as `addonData`, and the host strips it before validation and execution. Because this is an additive field, readers that do not know about it preserve or ignore it, per the unknown-fields rule.

When the cleartext public notice is enabled, the header gains `publicNotice`, a single short string with a maximum length well inside the header's 65,536-byte limit, holding only what the user typed for it.

## Defaults, projects and per-save overrides

There are three layers, and each is explicit:

1. **Preferences.** A "Model ownership" section holds default owner, copyright template, license, contact and whether new projects start confidential. On desktop these live in Konjugate's per-user application data folder, alongside other application settings. On the web edition they live in the browser's own storage and never leave it. Every default starts empty.
2. **The project.** A new project is seeded from the defaults once. After that the file owns its metadata. Changing the defaults later never rewrites existing files, and a "Project properties" dialog edits the file's own block at any time.
3. **The save.** The Save dialog shows the project's metadata prefilled, and edits there apply to that save only, without changing the open project. This is for sending out a copy under a different license, with a different contact, or with the metadata removed ("Strip ownership details from this copy").

**Someone else's model.** Opening a file whose owner differs from your defaults keeps the original block and shows it in Project properties. Saving never replaces another owner's details with yours. An explicit "Make this my own" action replaces the block with your defaults and fills `derivedFrom` from the old owner, license and title so attribution is not lost silently.

**No autofill.** Konjugate never derives the owner, copyright, license or contact from the operating system account name, the machine name, git configuration or a signed-in service, and there are none of the latter. Only what the user typed is stored there. The save times and the Konjugate version are the only automatic values.

**Encryption nudge.** When the license is *All rights reserved* or `confidential` is set and the user saves without encryption, the Save dialog mentions that encrypting is what actually protects the file. It does not block the save.

## The assistant and confidential models

The AI assistant sends a hosted provider "a structured description of the model" (see the privacy policy). Two rules follow:

- The ownership block is excluded from that description. The assistant does not need an owner's name or contact, so there is no reason to send them.
- When `confidential` is set and the configured provider is a hosted one, Konjugate warns before sending and asks the user to confirm each time the project is first used with it in a session. A local model such as Ollama is not affected. The warning does not block: the owner may be the same person who chooses to use the provider, and the policy already tells users not to share what they may not share.

## Exports

- **FMU export** writes `author`, `copyright` and `license` into `modelDescription.xml` from `owner`, `copyright` and the license identifier (or its custom text), since FMI has attributes for exactly these.
- **Standalone code export** adds a comment header with the copyright notice and license identifier to each generated source file.
- **Result CSV export** is unchanged. A CSV is plain data and a header line would break tools that read it; the embedded `.kjt` result keeps the metadata with the model.
- **Embedded results.** A `.kjt` saved with results carries the block like any other save. `--output-kjt` from the command line preserves the input project's block, updating only `lastSavedAt` and `savedWith`, as it is a save like any other.

The "Strip ownership details" option applies to exports as well: a stripped copy has nothing to map.

## Privacy policy changes

The core statement of [Privacy.md](../../Privacy.md), that the developer collects nothing, remains true: all of this is local. The policy still needs these changes, shipped together with the preferences defaults and the assistant exclusion:

1. **Where it lives.** "What stays on your computer" names the default ownership settings, and says that a `.kjt` can contain an owner, copyright, license and contact that the user typed, which travel with the file whenever it is shared, exported or attached to an email.
2. **No autofill, and what is automatic.** It states that Konjugate never fills the owner, copyright, license or contact from the user's account or computer. The only values it writes by itself are the first-saved and last-saved times from the computer's clock and the Konjugate version, which are stored in the file like the rest and go nowhere else.
3. **Assistant.** The assistant section states that the ownership block is not sent to a hosted provider, and that a model marked confidential shows a warning first.
4. **Web edition.** It states that the defaults are kept in the browser's storage and are not sent anywhere, and that the page counter does not see them.
5. **Exports.** It notes that FMU and code exports copy the owner, copyright and license into the files produced.
6. **Models belong to their authors.** One sentence, in the policy or the ReadMe's License section, that Konjugate's own MPL-2.0 license does not apply to, and gives the developer no rights in, the models users create.
7. **Effective date** is updated, as the policy's own "Changes" section requires.

## Staged plan

1. **Schema and codec.** Add `ownership` to the project schema, keep the legacy `copyright` readable, strip the block before validation and execution, and round-trip it through save and load in the desktop and web codecs. Tests cover absent, legacy-only, full, and encrypted round trips, and that the engine never receives it.
2. **Project properties.** The dialog to edit the block, the license picker, the `{year}` expansion on save, and the "Make this my own" action.
3. **Preferences and seeding.** The "Model ownership" defaults on desktop and web, seeding of new projects, and the privacy policy changes for them.
4. **Save-time override.** The metadata panel in the Save dialog, "Strip ownership details from this copy", and the encryption nudge.
5. **Assistant.** Exclusion from the description sent to a provider, and the confidential warning, with the matching policy text.
6. **Exports.** FMU `modelDescription` attributes and the code-export header.
7. **Public notice.** The optional cleartext header notice for encrypted files, last because it is the only part that puts anything outside the encrypted payload.

## As built

- **Where it is.** `src/ownership.mjs` holds the block's rules (cleaning, the year token, the save times, defaults, "make this my own", the export lines); `src/renderer/ownershipEditor.mjs` and the three dialogs in `index.html` edit it; `src/ownershipDefaultsStore.mjs` keeps the defaults in the user's data folder on the desktop, and the web shim keeps them in the browser's storage. The title bar's Project properties button (and the phone menu's entry) opens the first dialog, which links to the defaults.
- **The automatic stamp is gone.** The application used to write `copyright: "Copyright © 2026 Zenin Easa Panthakkalakath"` into every project it saved, a notice no user had written. It no longer does, and a file carrying exactly that string is not read as a claim. A different legacy `copyright` value is read as the notice, and a save writes only `ownership`.
- **When the save dialog appears.** The per-save override is offered on the first save of a project and on Save As, and only when the project names something a person wrote (a project with just save times is not asked about). A plain Save to an existing file does not interrupt, so the encryption nudge appears only in that dialog. What is typed there applies to that file only; the open project keeps its own details, though it takes the new save times. Because a Save As makes the new file the one being edited, the window remembers that this file is a copy with other details (or none) and a later plain Save to it writes the same kind of copy, so it never puts back what the copy was saved without. The project's own details are used again for the next Save As to another file, and editing them in Project properties ends the special treatment, since that is a choice to have them in the file.
- **Stripping.** "Strip ownership details from this copy" removes the whole block from the copy, the save times and version included.
- **New projects.** A new window's project is seeded from the defaults once, when they have loaded; a project that is opened is never seeded, and a file with no block stays without one until it is saved, when it gets only the save times.
- **Confidential and the assistant.** The block cannot reach the assistant because it is never part of the serialised model the assistant summarises, which a test pins. The confidential warning is a confirmation shown once per opened project in a window, for a hosted configuration only.
- **The header notice.** It is written only to an encrypted file and shown in the unlock prompt. It is not covered by the encryption's authentication tag, so a notice can be altered without the password; it is a label.
- **The shipped examples.** Each carries the block, written by `scripts/stampExampleOwnership.mjs` from one definition in `scripts/exampleOwnership.mjs` (which the tank-calibration generator also uses): the owner and copyright of the project, the title of its guide, `info@konjugate.com` as the contact, and the 0BSD license, with the license text in `examples/LICENSE` so that people may use, change and share them for any purpose. The save times are fixed at the time they were stamped, so the files are reproducible and a copy saved from an example reports when the example first existed. Opening one shows an owner other than the person's defaults, so a save keeps the attribution and "Make this my own" records where the work came from. The provider sources in `examples/providers/` stay under the project license.
- **Revision.** It is set by the user alone, as decided; `lastSavedAt` says when a file was last written.

## Open points

- Whether a signed authorship claim (reusing the package signature machinery) is worth building later. It is deliberately not part of this proposal, since decision 1 says the metadata is a notice.
- Whether library components and subsystems pasted in from another project should carry their own attribution automatically. Decision 3 leaves this out for now.
