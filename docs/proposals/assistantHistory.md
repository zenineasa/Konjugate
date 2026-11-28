---
type: Proposal
title: "Assistant history: conversations kept for the person, checkpoints, reuse and forks"
description: Keeping every model-assistant conversation for the person (not per project), so work from one project can be reused in another; a checkpoint of the model before and after each applied proposal, to restore or compare; applying a past proposal again; forking a conversation from any turn, in this window or a new one; exporting a conversation as a record; and saved prompts. Stored in a small content-addressed history of Konjugate's own rather than Git.
tags: [proposals, assistant, history, checkpoints, undo, privacy]
status: draft
implementation: none
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Assistant history: conversations kept for the person, checkpoints, reuse and forks

## Why

Today a conversation with the model assistant lives only in memory: five short summaries ("Proposed: …", "Applied: …"), gone with the window. The proposals themselves (their operations, assumptions and problems) are dropped once applied or discarded, and an applied proposal is one undo step with nothing to say which request made it. So a person cannot go back to what the assistant did last week, cannot take a change made in one project into another, and cannot try two directions and compare them.

## Decisions made

1. **History belongs to the person, not to a project.** Every conversation is kept in one history on this computer, whichever project it was about, so something done in one project can be found and reused, a little differently, in another. A project file carries none of it.
2. **Checkpoints of the model** before and after each applied proposal, to restore either or see what changed, kept in a history shaped like Git's (below).
3. **A past proposal can be applied again** to the model open now.
4. **A conversation can be forked from any turn**, either in this window (the model restored to that turn's checkpoint, as one undoable step) or in a new window (a new project holding that checkpoint, continuing the fork).
5. **A conversation can be exported** as a record of what was asked, assumed and applied.
6. **Requests can be saved** and run again.

## Git, or a history of Konjugate's own

Git's model is the right one: content-addressed snapshots (an unchanged model is stored once, however many turns refer to it) and a graph of commits with parents (a fork is a second child of the same turn). Running real Git underneath is not, for four reasons:

- **Encryption.** A project can be encrypted with a password. A Git repository in the app's data would hold plain copies of every checkpoint, quietly undoing that. Konjugate's own store can encrypt what it keeps (below) or refuse to keep it.
- **Something to ship.** Git is a program to bundle and keep updated on three platforms, or a JavaScript reimplementation of it as a new dependency, for a fraction of what Git does: nothing here merges, rebases or talks to a remote.
- **The web edition.** The same store can be written over the browser's storage (IndexedDB); Git cannot run there.
- **Control.** Size limits, deleting one conversation, and clearing everything are a few lines in a store of its own, and history rewriting in a repository.

So the store is Git-shaped but Konjugate's own, in about the size of one module:

- **Snapshots** are model documents, compressed with fflate (already a dependency) and named by the SHA-256 of their content: `snapshots/<hash>.bin`. A model that did not change between turns is one file.
- **Turns** are the commits: the request, the full reply (proposal with its operations and assumptions, or the question), what came of it (applied, discarded, rejected, with its problems), the model and provider that answered, the time, the project's title and path when it had one, and, for an applied turn, the snapshots before and after. Each turn names its parent turn; a fork is a second turn with the same parent.
- **Conversations** are the branches: a title (the first request, editable), the turn each branch ends at, and when it was last used.

Kept in the app's data folder (`userData/assistantHistory/`), written atomically, read lazily. A future feature that versions the model in the person's own project folder with real Git, for collaboration, is a separate question this does not decide.

## Privacy

- The history stays on this computer and is never sent anywhere by being kept. What is sent to a model is unchanged: the current request, the model summary and a bounded number of recent turns (below), never the whole history.
- **Encrypted projects:** checkpoints of a project saved with a password are encrypted with the operating system's key store (`safeStorage`, as API keys are), and the conversation's text with them; where secure storage is unavailable, no checkpoint is kept for that project and the turn says so.
- **Confidential projects** (ownership marked confidential) are treated the same way.
- **Settings › Model assistant › History** shows how much is kept, with **Clear history**, and each conversation can be deleted on its own. A size limit (by default 500 MB) removes the least recently used conversations' checkpoints first, then the conversations.

## What the person sees

- **History** in the assistant panel's header: the conversations, newest first, each with its title, the project it was about, the model and when; a search over their requests and summaries; and **New conversation**.
- Opening a conversation shows its turns as now, with each reply as a card that keeps everything it had: a proposal with its changes, assumptions and problems, marked **Applied**, **Discarded** or **Rejected**; a question with its answer. Writing in an opened conversation continues it, about the model open now, whatever project it began in.
- On an **applied** turn: **Restore the model to before this** and **…to after this** (each one undoable step on the model open now, after asking if that model has changed since), and **Show what changed**, which highlights those nodes and relationships on the canvas.
- On **any proposal**: **Apply again**, which prepares and validates it against the model open now and shows it as a new proposal (the IDs it named may no longer be there; the checks and the repair round deal with it); and **Ask about this**, which puts the proposal in the prompt as a reference ("do what this did, but with three cells"), so the model adapts it to the current model rather than replaying it.
- On **any turn**: **Edit and resend** (a fork from the turn before it) and **Fork from here**, each with **In this window** (the model restored to that turn's checkpoint, as one undoable step, and the conversation continuing on the new branch) or **In a new window** (a new, unsaved project holding that checkpoint, named after the conversation, with the fork open in its panel). A conversation with forks shows "Branch 2 of 3" with arrows on the turn where they part.
- **Export as Markdown** on a conversation: each request, the reply's summary and assumptions, what was applied when and with which model, and the problems found.
- **Saved prompts**: the star on a request in the conversation saves it; saved prompts are offered in the prompt (and in **History**) and run with one click against the model open now.

## What the model is sent

Keeping everything does not change what is sent: the current request, the model summary, and the recent turns of the branch being continued, five as now, as compact summaries. **Ask about this** adds the referenced proposal's operations (bounded) to the request. A summary of older turns may be added later; it is not part of this.

## Stages

1. **The store and History.** `src/assistantHistory.mjs` in the main process (conversations, turns, compressed content-addressed snapshots, the size limit, clearing), the IPC for it, every turn kept as it happens, **History** in the panel, reopening and continuing a conversation, and **Settings › Model assistant › History** with **Clear history**.
2. **Checkpoints.** The snapshots before and after each applied proposal; **Restore …** and **Show what changed**; encrypted and confidential projects' checkpoints encrypted.
3. **Reuse.** **Apply again** and **Ask about this**.
4. **Forks.** **Edit and resend**, **Fork from here** in this window or a new one, branches in the conversation.
5. **Export** as Markdown.
6. **Saved prompts.**

Each stage has its own tests (the store's unit tests against a temporary folder, and interaction scenarios driven by the fake Ollama), and the full suites run once at the end.

## Open questions

- Should applied assumptions also be kept with the project? A project has no notes field today; the export covers the record without one, and a notes field is a separate decision.
- The default size limit (500 MB) and whether the least recently used checkpoints should go before whole conversations, as proposed.
