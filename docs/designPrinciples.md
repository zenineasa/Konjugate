---
type: Guide
title: Design principles
description: One source of truth, and how to build on it without copying - the rules contributors follow when a fact about the model has to be known in more than one place.
tags: [architecture, contributing, design, maintainability]
status: stable
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Design principles

## One source of truth

Every fact about the model - what fields a node has, which of them an edit leaves alone, which of them hold an id that must change when a copy is made - is written down in exactly one place, and everything else derives from it. When you find yourself writing a second list of the same things, stop and ask what the first list could become so that the second is not needed. Copying a list is cheap on the day and expensive on every day after: the copies drift, the drift is silent, and the failure turns up far from the cause.

This is the same instinct as inheritance in object-oriented code, applied to data and to functions. State what is common once, in a base, and let each case add or override only what makes it different. A new case then costs only its difference, and a change to the common part reaches every case without anyone remembering to make it.

## Why this is written down

Adding an optional `description` to nodes and edges meant editing a dozen places that each held their own copy of a node's or relationship's fields: four that read a document (opening a file, and pasting), two that wrote one, and four that took or restored an undo snapshot, plus the places that create a definition from a builder or a template. The snapshot pair was missed. Nothing failed to compile and no unit test noticed; typing a description simply did nothing, because the undo snapshot copied a fixed list of fields and the new one was not on it. Only an interaction test caught it. The same copying had already left a pasted relationship without its C++ or Python program, because the paste path's list of fields did not include `implementation`.

## What to do instead

- **Derive, do not repeat.** If a second place needs the shape of a node, import the function that already describes it. The four functions in `src/modelCodec.mjs` are the only code that converts a node or relationship between the project document and the canvas's own definition; opening a file, saving, pasting and placing a template all call them.
- **Default to keeping a field, not to dropping it.** A list of what to copy fails by omission, and an omission is invisible. A list of what to leave out fails by inclusion, which shows up straight away. `src/modelDefinition.mjs` therefore names the few fields an editor snapshot leaves alone, and a new field is saved and restored by undo without anyone touching it. In the same way the codec writes back, unchanged, any field it has never heard of, so a document from a newer Konjugate loses nothing by passing through an older one.
- **Find ids by what they are, not by where they live.** Copying a graph must give every entity a new id and rewrite every reference to it. `src/graphClipboard.mjs` does that by walking the whole structure and rewriting any `id`, `...Id` or `...Ids` field that names a copied entity, not by listing the places an id can appear; a new kind of binding is handled before it exists.
- **Share the common part and state the difference.** A template, a preset or a default that is mostly another one should say which one it extends and list only what it changes, not carry a pasted copy of it.
- **Put the guard in a test that cannot be forgotten.** The round-trip tests in `tests/modelCodec.test.mjs` read a document that has every field the schema allows, write it back, and require the same document. A field the codec forgets makes that test fail; a field nobody adds to the test still survives, because of the rule above.

## When you add a field to the schema

1. Add it to the codec (`src/modelCodec.mjs`) in both directions, and to the document schema (`projectSchema.md`). If a document without the field must keep saving exactly as before, write it only when it is not the default.
2. Decide whether an editor snapshot should leave it alone. If it should not, do nothing: that is the default. If it should, add it to the exclusion list in `src/modelDefinition.mjs` with a reason.
3. If it can hold an id, give it a name ending in `Id` (or `Ids` for a list) and it is renumbered on paste with no further work.
4. Add it to the kitchen-sink document in `tests/modelCodec.test.mjs`.
5. If you find yourself editing a fifth place, that is the sign of another copy. Remove the copy instead of adding to it.

## Where this applies beyond the model

The same question is worth asking of a UI that repeats a validation, a template format that repeats the canvas's capabilities, and a schema that is described once in code and again in prose. The answer is usually one definition that the others read: the native validator is the source of truth for model correctness, the `.proto` file is the source of truth for the engine's wire format, and `projectSchema.md` describes the document the codec reads and writes.
