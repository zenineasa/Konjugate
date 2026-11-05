---
type: Proposal
title: Model ownership and license metadata
description: Owner, copyright, license and contact details saved inside a .kjt project, with per-user defaults, a per-save override, export mapping, and the privacy policy changes they need.
tags: [proposals, kjt, metadata, license, privacy]
status: draft
implementation: none
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Model ownership and license metadata

**Status: proposed, nothing built.** This records the design agreed so far so it can be built in the order given under "Staged plan".

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
    "title": "Plant cooling loop",
    "description": "Cooling loop for line 3, validated against 2026 site data."
}
```

- `owner`: a person or organisation, free text.
- `copyright`: the notice text. A `{year}` token is replaced with the current year when the project is saved, and stored already expanded, so a reader never sees the token.
- `license`: `{ id }` holds an SPDX identifier for a known license, with the extra choices *All rights reserved* and *Custom*. A custom license is `{ text }` and/or `{ url }`. The picker offers all rights reserved, MIT, Apache-2.0, MPL-2.0, CC-BY-4.0, CC-BY-SA-4.0, CC0-1.0 and custom.
- `contact`: an email address or URL, for whoever needs permission or the password.
- `confidential`: boolean, default `false`. It marks the model as one the owner does not want sent to third parties, and drives the assistant behaviour below. It is a flag for Konjugate's own behaviour, not a legal term.
- `derivedFrom`: free text naming the work this one is based on, so attribution requirements such as CC-BY survive remixing.
- `revision`: a user-chosen revision string, separate from the file format `version`.
- `title`, `description`: the project as a whole, parallel to node and edge `description`.

Konjugate also writes `createdAt`, `modifiedAt` and `savedWith` (the Konjugate version) on save. These carry no personal information and help someone who receives the file.

The legacy top-level `copyright` string stays readable: when `ownership.copyright` is absent, the old value is shown in its place, and a save writes only the new block. The engine never receives the block, in the same way as `addonData`, and the host strips it before validation and execution. Because this is an additive field, readers that do not know about it preserve or ignore it, per the unknown-fields rule.

When the cleartext public notice is enabled, the header gains `publicNotice`, a single short string with a maximum length well inside the header's 65,536-byte limit, holding only what the user typed for it.

## Defaults, projects and per-save overrides

There are three layers, and each is explicit:

1. **Preferences.** A "Model ownership" section holds default owner, copyright template, license, contact and whether new projects start confidential. On desktop these live in Konjugate's per-user application data folder, alongside other application settings. On the web edition they live in the browser's own storage and never leave it. Every default starts empty.
2. **The project.** A new project is seeded from the defaults once. After that the file owns its metadata. Changing the defaults later never rewrites existing files, and a "Project properties" dialog edits the file's own block at any time.
3. **The save.** The Save dialog shows the project's metadata prefilled, and edits there apply to that save only, without changing the open project. This is for sending out a copy under a different license, with a different contact, or with the metadata removed ("Strip ownership details from this copy").

**Someone else's model.** Opening a file whose owner differs from your defaults keeps the original block and shows it in Project properties. Saving never replaces another owner's details with yours. An explicit "Make this my own" action replaces the block with your defaults and fills `derivedFrom` from the old owner, license and title so attribution is not lost silently.

**No autofill.** Konjugate never derives any of these values from the operating system account name, the machine name, git configuration or a signed-in service, and there are none of the latter. Only what the user typed is stored.

**Encryption nudge.** When the license is *All rights reserved* or `confidential` is set and the user saves without encryption, the Save dialog mentions that encrypting is what actually protects the file. It does not block the save.

## The assistant and confidential models

The AI assistant sends a hosted provider "a structured description of the model" (see the privacy policy). Two rules follow:

- The ownership block is excluded from that description. The assistant does not need an owner's name or contact, so there is no reason to send them.
- When `confidential` is set and the configured provider is a hosted one, Konjugate warns before sending and asks the user to confirm each time the project is first used with it in a session. A local model such as Ollama is not affected. The warning does not block: the owner may be the same person who chooses to use the provider, and the policy already tells users not to share what they may not share.

## Exports

- **FMU export** writes `author`, `copyright` and `license` into `modelDescription.xml` from `owner`, `copyright` and the license identifier (or its custom text), since FMI has attributes for exactly these.
- **Standalone code export** adds a comment header with the copyright notice and license identifier to each generated source file.
- **Result CSV export** is unchanged. A CSV is plain data and a header line would break tools that read it; the embedded `.kjt` result keeps the metadata with the model.
- **Embedded results.** A `.kjt` saved with results carries the block like any other save. `--output-kjt` from the command line preserves the input project's block unchanged.

The "Strip ownership details" option applies to exports as well: a stripped copy has nothing to map.

## Privacy policy changes

The core statement of [Privacy.md](../../Privacy.md), that the developer collects nothing, remains true: all of this is local. The policy still needs these changes, shipped together with the preferences defaults and the assistant exclusion:

1. **Where it lives.** "What stays on your computer" names the default ownership settings, and says that a `.kjt` can contain an owner, copyright, license and contact that the user typed, which travel with the file whenever it is shared, exported or attached to an email.
2. **No autofill.** It states that Konjugate never fills these from the user's account or computer.
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

## Open points

- Whether `revision` should increment automatically on save, or stay purely user-set. The proposal assumes user-set to avoid noisy diffs in files kept in version control.
- Whether a signed authorship claim (reusing the package signature machinery) is worth building later. It is deliberately not part of this proposal, since decision 1 says the metadata is a notice.
- Whether library components and subsystems pasted in from another project should carry their own attribution automatically. Decision 3 leaves this out for now.
