---
type: Proposal
title: "Suggested local models through Ollama"
description: Design for running the model assistant on the person's own computer in a few clicks, through Ollama, which the app links to but never downloads, with Qwen3.5 models we have measured suggested first, any Hugging Face model a person chooses as well, and the demonstration provider removed from the app and moved into the tests as a fake Ollama server.
tags: [proposals, assistant, local-models, ollama, hugging-face, settings]
status: draft
implementation: built
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Suggested local models through Ollama

**Status: built,** in the order of work below, with the open questions settled as proposed (no 9B until it is measured, no renaming of temporary references, no Remove, no gated models; reasoning is not measured in full). Three things differ from what was proposed: **Reasoning** is a choice of three (the model's own default, off, or on) rather than a checkbox, since a model that cannot reason refuses being told either way; the fake Ollama server answers by the demonstration's own rules, moved into the tests, rather than from `evals/assistant/reference.json`, since the interaction tests ask about the example they load; and the page reads the configurations afresh each time it opens. How it is used is in the [Model assistant guide](../aiAssistantGuide.md#run-a-model-on-this-computer).

## The problem

Konjugate opens with the assistant set to **Local demonstration**: a hard-coded provider that understands three kinds of request and answers everything else with a list of what it can do. People take it for the assistant itself, conclude that the feature is weak, and rarely find that it works with Ollama, OpenAI, NVIDIA, Hugging Face and Gemini. Running a real model on one's own computer already works through the Ollama provider, but nothing in the app says so, which model to choose, or how to get it.

## Decisions taken

1. **Local models run through Ollama.** The app does not ship a runtime of its own. Ollama already handles GPUs on every platform, downloads, storage, memory and its own updates, and the Ollama provider exists. Every local result we have measured was through Ollama, so a person gets the setup the measurements describe. This is the way local models are offered now. A fine-tuned model embedded in the app ([An embedded model for the assistant](embeddedAssistantModel.md)) is still the long-term aim, and would be added beside it.
2. **The app links to Ollama's download page and never downloads Ollama itself.** Installing software on the person's computer is theirs to do, from its makers' own page. The app finds out whether Ollama is running, and says so.
3. **Models we have measured are suggested first.** Qwen3.5 4B is recommended, and Qwen3.5 2B is offered for slower computers. A person can still browse Hugging Face and use any model they want, told plainly that it has not been measured.
4. **Reasoning is a setting a person can turn on,** off by default, with what it was measured to cost shown beside it.
5. **The demonstration provider is removed from the app.** The tests that use it use a fake Ollama server instead (see [Tests without the demonstration](#tests-without-the-demonstration)).

## What the measurements say

From [Assistant model findings](../assistantModelFindings.md), on 70 cases, on an 8 GB M1, through Ollama, with thinking off:

| Model | Download | Passed | Asked when it should have acted | Acted when it should have asked | Median time |
|---|---|---|---|---|---|
| Qwen3.5 0.8B | 1.2 GB | 34% | 100% | 0% | 2 s |
| Qwen3.5 2B | 3.1 GB | 47% | 86% | 2% | 8 s |
| **Qwen3.5 4B** | 4.0 GB | **59 to 61%** | 55 to 75% | 5% | 19 s |

These come from two separate samples of 70 cases. The second also measured Dory 4B (NVIDIA Nemotron Labs Dory 1.0) with reasoning off, at 67% but 53 s a case, and Qwen3.5 4B with thinking on, which took about 3½ minutes a case. Neither is worth the wait for a person working through their model one request at a time. The 0.8B never proposed an edit, so suggesting it would bring back the impression this proposal is meant to remove.

## Settings › Model assistant

The page gets a section at the top, **Run a model on this computer**, above the list of model configurations. What it shows depends on what the app finds.

### Ollama is not running

The app asks Ollama for its version (`GET /api/version` on the configured endpoint, `http://127.0.0.1:11434` by default) when the page opens. If nothing answers:

> **Run a model on this computer, for free and in private.** Konjugate runs models through Ollama, a free app made by others. Install it from its website, open it, then come back here.
>
> **Open the Ollama website** · **Check again**

**Open the Ollama website** opens `https://ollama.com/download` in the person's browser (`shell.openExternal`). The app never fetches an installer. **Check again** asks again, and so does opening the page. On Linux, the note says that Ollama's site gives a one-line install command, and the app does not copy that command for the person. A person whose Ollama listens elsewhere changes the endpoint in an Ollama model configuration, and the section uses it.

### Ollama is running

The suggested models, one card each:

| | |
|---|---|
| **Qwen3.5 4B** · Recommended | About 4 GB. Needs 8 GB of memory. About 20 seconds an answer on a recent laptop. |
| **Qwen3.5 2B** · For slower computers | About 3 GB. Needs 8 GB of memory. Faster, and asks more questions it does not need to. |

Each card shows one of:

* **Download.** Asks Ollama to pull the model (`POST /api/pull`, streamed) and shows Ollama's own progress (`completed` of `total` bytes, per layer) on the card, with **Stop**. Closing Settings does not stop it, and reopening Settings shows it again. Ollama stores the model where Ollama keeps its models: the app stores nothing.
* **Use it.** The model is in Ollama's list (`GET /api/tags`). Pressing it creates an Ollama model configuration for it, named after the model, with `think: false`, which is the setup that was measured, and makes it the one in use. If such a configuration already exists, it is made the one in use instead.
* **In use.** It is the configuration in use.

The memory line is compared with this computer's (`os.totalmem()`). A model that needs more than the computer has is still offered, with "This computer has 4 GB: it may be very slow or fail to load." The app never decides for the person.

Removing a downloaded model is Ollama's job (`ollama rm`, or Ollama's own app). The card says so, and the app does not delete it from Ollama. *Open question 3.*

### Reasoning

Some models can reason before they answer (Ollama's `think`). Every model configuration gets a setting for it, **Reasoning**, shown when the provider supports it (`reasoningSetting` on its descriptor): the model's own default, **Off: answers quickly**, or **Reason before answering: slow**. It is off for the suggested models, which is how they were measured.

The Ollama provider sends `think` when a configuration sets it (`src/aiRemoteProviders.mjs`), and the configuration store keeps it (`think`: true, false, or null for the model's default).

Under the setting, when reasoning is on, what it was measured to cost:

> Much slower. In a test on an 8 GB M1, Qwen3.5 4B took about 3½ to 10 minutes an answer with reasoning on, against about 20 seconds with it off. It fixed one of two requests it had got wrong. While the model reasons, the assistant shows its reasoning as it is written.

That rests on a quick test, not a full run. It used two cases Qwen3.5 4B had failed with reasoning off, through Ollama, with no time limit:

| Case | Reasoning off | Reasoning on |
|---|---|---|
| `actSupplyNine`: asked a needless question | failed, about 20 s | **passed**, 210 s, at the first attempt |
| `blankAddNode`: named a new node outside lowerCamelCase | failed, about 25 s | failed again, 597 s, over three attempts |

The two cases took 13½ minutes together, against under a minute with reasoning off. Each answer took 10 to 20 times as long. At that pace, a full run of 70 cases would take 4 to 6 hours, and many answers would pass the 240 seconds the measurements allow. Reasoning may help with needless questions, the most common failure, but not with naming. Two cases are too few to say how much it helps, and a full run was judged not worth the hours.

A configuration with reasoning on shows "Reasons before answering: slow" beside its name in the assistant's list, so a person who waits minutes knows why.

### Browse Hugging Face

**Browse Hugging Face…** below the cards opens a search within the page:

* It searches Hugging Face's public model list for models published as GGUF files (`GET https://huggingface.co/api/models?filter=gguf&search=…&sort=downloads`), the format Ollama loads, sorted by downloads.
* Choosing a model lists its quantized files, by size, read from its files (`GET https://huggingface.co/api/models/<repo>/tree/main`). Each is marked against this computer's memory, as on the cards. The model's licence comes from its card data, and **Open on Hugging Face** opens its page in the browser.
* **Download** pulls it through Ollama as `hf.co/<repo>:<quantization>`, which Ollama supports directly, with the same progress and **Use it** as a suggested model.
* Above the results: "These models have not been tried with Konjugate. Some will not follow the assistant's format, and their proposals may be wrong more often. Every proposal is still reviewed before it changes your model."

No account or key is needed, and nothing about the person's model is sent: the request carries only what was typed in the search. Gated or private repositories are not offered, because Ollama would need the person's Hugging Face key to pull them. *Open question 4.*

### Where the suggestions are written

The suggested models are data, in one file (`src/suggestedLocalModels.mjs`, no DOM): for each, the Ollama name (`qwen3.5:4b`), the title, the line under it, the download size, the memory it needs, the configuration it is used with (`think: false`), and a link to the findings it rests on. Changing a suggestion after a new measurement changes this file and the findings, and nothing else.

## What changes when nothing is set up

With the demonstration gone, a new installation has no model configuration. The assistant panel then says:

> **Choose a model for the assistant.** Run one on this computer for free, or use an account with an online provider.
>
> **Set up a model…**

The button opens Settings › Model assistant. The prompt field stays disabled until a configuration exists. A person whose configurations file still names the demonstration provider has that configuration removed when the file is read, and is shown the same message. Nothing else of theirs changes. The configuration store's version goes up by one, and older files are read and moved forward as they are now.

## Tests without the demonstration

The tests that use the demonstration (the interaction scenarios that ask the assistant for an edit, apply it and undo it) use a **fake Ollama server** instead: a small HTTP server the test starts on a free local port (`tests/fixtures/fakeOllama.mjs`). It answers:

* `/api/version` and `/api/tags`, with the models it was started with;
* `/api/pull`, with a few progress lines and success, so the Settings flow can be tested end to end;
* `/api/chat`, streamed as Ollama streams (with a line of reasoning first when asked to reason). It reads the model context, the request and the turns so far out of the prompt the app sends, and answers by the rules the demonstration used, moved into `tests/fixtures/demonstrationAssistant.mjs`.

A test sets the Ollama configuration's endpoint to the fake server's address. This tests more of the real path than the demonstration did: the Ollama provider, streaming, parsing, repair and validation are all run. The evaluation harness's `localDemonstration` provider is removed, and its `reference` provider stays as it is.

What is removed from the app: the `localDemonstration` provider in `src/assistantProviders.mjs`, its built-in configuration and fixed id in `src/aiConfigurationStore.mjs`, its special cases in `src/renderer/renderer.mjs`, and its mentions in the assistant guide and the evaluation docs.

## Web edition

The web edition has no assistant yet (the driver reports `aiAssistant: false`). When it gets one, a browser page can reach a local Ollama only if Ollama allows that page's origin (`OLLAMA_ORIGINS`), which is a setting on the person's side. The web edition would show the online providers, and say that running a model on this computer needs the desktop app. It would not walk a person through changing Ollama's settings.

## Order of work

1. **The fake Ollama server, and the tests moved to it,** while the demonstration still exists, so the tests are known to pass before anything is removed.
2. **Remove the demonstration,** add the "Choose a model" message, and move older configuration files forward.
3. **Run a model on this computer:** finding out whether Ollama is running, the link, the suggested models, pulling with progress, and **Use it**. **Reason before answering** is added to the configuration store and form, with its note.
4. **Browse Hugging Face.**
5. **Docs:** the assistant guide's first section becomes "Run a model on this computer", Settings and the findings are updated, and this proposal is marked as built.

## Questions left open

1. **Whether to suggest Qwen3.5 9B as a third model,** for computers with 16 GB of memory or more. It has not been measured: it would need one run of the same 70 cases first.
2. **Whether to fix temporary references in lower camel case while reading an answer** (`Ambient Air` read as `ambientAir`). Five of Qwen3.5 4B's 29 failures in the second sample were only this. It would change what the harness measures, so it would be measured before and after.
3. **Whether the cards offer Remove,** through Ollama's `DELETE /api/delete`. Proposed: no, since the models are Ollama's, and another app may be using one.
4. **Whether gated Hugging Face models are offered,** which needs the person's Hugging Face key given to Ollama, not to Konjugate.

## Non-goals

* Downloading or installing Ollama, or any other software, for the person.
* A runtime of the app's own. That is [An embedded model for the assistant](embeddedAssistantModel.md).
* Ranking or reviewing Hugging Face models. Those not suggested are offered as they are, with a warning.
