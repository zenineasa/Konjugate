---
type: Specification
title: Model assistant evaluation harness
description: How the model assistant is scored, covering the cases, assertions, reference answers, failure stages, the error-direction report, request pools and intake checks, and the commands for running them against any provider.
tags: [assistant, evaluation, testing, fine-tuning, ollama]
status: stable
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Model assistant evaluation harness

The assistant turns a request in plain language into a proposal of model operations, or into a question when it cannot act safely. This document specifies the harness that scores a provider on that job. It is how a model, a prompt change, a setting or a fine-tune is compared with another, and it is the measuring instrument for [the embedded assistant model proposal](proposals/embeddedAssistantModel.md). The provider side (adapters, registry, repair, history) is in [Model assistant provider architecture](aiProviderArchitecture.md), and the user-facing behaviour is in [Model Assistant Guide](aiAssistantGuide.md).

## Why a pass rate is not enough

A proposal can validate and still be wrong: it can set the wrong state, flip a relationship, or convert a unit incorrectly, and validation alone would call all of those a pass. So a case passes only if the model that results from applying the answer is the model the request asked for, with everything else unchanged. The harness also reports which way a model errs, because the two ways cost a user very differently: a question where the request was clear costs a reply, while an edit where a question was needed, or a valid edit that does the wrong thing, is something a user skimming a review can approve.

## What a run does

For each case the harness sends the request through the same registry and adapters as the app, with the same model summary the panel sends (`summarizeDocumentForAssistant` in `src/assistantOperations.mjs`, shared with the renderer so the two cannot drift) and the case's conversation history. It then does what the panel does with the answer: applies it to a copy of the starting model with `applyAssistantProposal`, validates the result with the native engine when it is built (`npm run build:engine`), and checks the result against the case. Only native errors the proposal introduced count against it, so a model that was already invalid, such as a blank one with no run configuration, is not blamed for that.

Every failure is attributed to the first stage it failed at:

* `generate`: the provider failed, timed out, or its output could not be repaired.
* `kind`: the model asked a question where a proposal was wanted, or proposed where a question was wanted.
* `apply`: host validation rejected the proposal (an unknown reference, an unsupported symbol, an equation that does not parse).
* `native`: the engine rejected the resulting model.
* `outcome`: the result is valid but is not what the request asked for, or a clarification did not offer the options the case requires.

## Cases

Cases live in `evals/assistant/cases/`, one `<domain>.json` file of hand-written cases and one `<domain>.generated.json` file of generated cases for each of the eight domains: thermal, electrical, mechanical, robotics, fluid, logistics, finance and general. Each file is `{ "copyright": ..., "cases": [...] }`, and `loadEvalCases` reads every file in the directory. A case has these fields:

* `id`: unique across all cases.
* `family`, `domain`, `style`: the three tags below.
* `split`: always `test`. Training material is kept apart (see request pools).
* `model`: the starting model: `blank`, a model kept in `evals/assistant/models/`, or a bundled example in `examples/`.
* `request`: exactly what the user types.
* `history` (only for the `history` family, and required for it): earlier turns as `{ "request": ..., "outcome": ... }`, where `outcome` starts with `Asked: `, `Proposed: `, `Applied: `, `Discarded: `, `Rejected: ` or `Error: `.
* `expect`: either `{ "touches": [...], "assertions": [...] }` for a case that wants a proposal, or `{ "kind": "clarification", "suggestionsInclude": [...] }` for one that wants a question.

`touches` lists the nodes and relationships the proposal may change. Everything else that existed before must come out exactly as it went in, compared by id, and a touched node covers the relationships attached to it, because removing or renaming a node legitimately changes what hangs off it. `suggestionsInclude` lists names the question's options must contain; a question with no options, or with different ones, fails at `outcome`, because naming the candidates is most of the value of asking.

### Tags

The vocabulary is in `evals/assistant/assistantEvalRequests.mjs`, and a test keeps every case inside it.

* **Family** (what is asked): `addNode`, `addState`, `addParameter`, `multiStep`, `setEquation`, `updateValue`, `updateParameter`, `updateNode`, `updateEdge`, `enableDisable`, `remove`, `units`, `reference` (picking among similar things by name), `clarification` and `history`.
* **Domain** (the field): the eight above. `evalDomainModels` says which models belong to each.
* **Style** (how it is worded): `terse`, `plain`, `conversational`, `indirect`, `verbose`, `loose`, `typos` and `multiPart`. The typos are real slips (transposed or dropped letters), including inside names.

### Assertions

Names are matched case-insensitively as substrings, so `Motor` also matches `Motor housing`. Numeric checks take a relative `tolerance` (default one part in a million).

| Assertion | Holds when |
|---|---|
| `nodesAdded` `{count}` / `edgesAdded` `{count}` | exactly that many new nodes or relationships exist |
| `hasNode` `{name}` | a node with that name exists |
| `state` `{node, symbol?, initialValue?, unit?, tolerance?}` | some state of the node matches. Without a symbol any state may match, because a model is free to name the symbol of a state it creates but not to give it the wrong value or unit |
| `hasEdge` `{from, to, directionality?, either?}` | a relationship connects the two (either direction with `either`), optionally with that directionality |
| `edgeName` `{from, to, name, either?}` | such a relationship carries that name |
| `edgeEquation` `{from, to, uses?, excludes?, changed?, either?}` | its equation contains every `uses` token, none of the `excludes`, and, with `changed`, differs from before. The tokens are substrings of the LaTeX, so these checks confirm intent, not mathematical equivalence |
| `edgeParameter` `{from, to, symbol?, value?, unit?, tolerance?, all?, either?}` | the relationship carries the parameter. With `all`, every parameter with that symbol between the two must match, for a quantity the model repeats on several relationships |
| `enabled` `{node or edge, value}` | the entity is enabled or disabled |
| `removed` `{node or edge}` | the entity no longer exists |
| `field` `{node, path, value}` | a dotted path on the node holds the value, for what has no check of its own (`appearance.shape`, `numerics.substepsPerGlobalStep`) |

### Starting models

The starting models are the bundled examples plus models kept with the evaluation in `evals/assistant/models/`: a port logistics fixture, a small company-finance model, and ten small models for topics outside the other domains (an epidemic, predator and prey, a web service queue, home solar with a battery, drug dosing, a lake catchment, a subscriber funnel, a stirred reactor, a cruising vehicle and a crop field), all grouped under the `general` domain. They were built from assistant operations and validated by the native engine. Seven models are **held out** (`heldOutModels`): the two-room building, battery-powered joint, four-bar linkage, position-controlled joint, stirred reactor, vehicle and crop field. Requests on them belong to the test only, so that a model trained on a request pool can be judged on models it has not seen. A domain with a single model (fluid, logistics, finance) cannot spare one, so its test scores say less about generalisation than the others do.

### Hand-written and generated cases

About a quarter of the cases are hand-written, in the domain files. The rest are generated in `<domain>.generated.json` by a seeded script that is not kept in the repository: for each model it takes real states, parameters and relationships, fills many wording templates per style, derives the assertions and the reference answer from the same data, and keeps a balanced sample across models. Generated cases are good at catching regressions such as a model that has learned to ask about everything. They are templated, so the hand-written cases remain the better check on fluency with natural phrasing. To add a case by hand, add it to the domain's `.json` file and give it a reference answer.

## Reference answers

`evals/assistant/reference.json` holds a known-good answer for every case, and the `reference` provider replays them through the whole pipeline: `node scripts/evalAssistant.mjs reference`. It must pass every case. That shows each case can be passed (the native validator, for example, requires an equation on every relationship, so a case that connects things cannot be satisfied by a bare connection) and that the harness is sound. `tests/assistantEval.test.mjs` replays the reference answers without the engine on every test run. Replay is matched by request text, so two cases must never share a request; the same test checks that, and that no case is already satisfied by the model it starts from, since passing by doing nothing would measure nothing. Reference answers were also checked in the other direction: deliberately wrong answers (a changed value, a question instead of an edit, and the reverse) must fail their cases.

## The report

The report gives, per family, domain and style, the pass rate, the first-attempt pass rate (passing without the registry having to ask the model to repair its output), the mean number of attempts and the median time, so a model that only passes through repair is visible as such. Below that is the conduct report, which counts errors by direction, each as a share of the cases that could have gone that way:

* **Acted when it should have asked** (`wrongProceed`): a clarification was expected and the model proposed an edit anyway. This is the dangerous direction for guessing.
* **Asked when it should have acted** (`needlessAsk`): a proposal was expected and the model asked a question. This costs a reply and trains users to ignore the assistant.
* **Valid but wrong edit** (`confidentWrong`): a proposal was expected and the model gave one that applies cleanly but fails the outcome. This is the other dangerous direction.

A change counts as an improvement only if it does not raise the two dangerous rates. Lowering needless questions alone is easy and, as the findings in [the embedded model proposal](proposals/embeddedAssistantModel.md) show, can be bought by guessing.

## Running it

```
node scripts/evalAssistant.mjs <provider> <model> [options]
node scripts/evalAssistant.mjs --compare before.json after.json
```

`<provider>` is `reference`, `localDemonstration`, `ollama`, `openAi`, `nvidia`, `huggingFace` or `gemini`. A key, if one is needed, is read from `KONJUGATE_AI_KEY` and never printed. Options:

| Option | Meaning |
|---|---|
| `--cases a,b` | limit the run to case ids, families, domains or styles |
| `--cases-file <path>` | another case file or directory |
| `--repeat <n>` | run the set several times to see variance |
| `--out <file>` | save the results as JSON (provider, model, date, summary and every result) |
| `--no-native` | skip engine validation |
| `--think true\|false` | Ollama's `think` setting for models that can reason; unset leaves the model's own default |
| `--timeout <seconds>` | per-case limit, default 240, so one runaway generation cannot stall a run |
| `--verbose` | print the messages for failures |
| `--compare` | print the change per group and the conduct report, and list the cases that regressed or started passing |

A local 4B model takes about 9 seconds per case on an 8 GB M1, so the full set takes hours and was found to strain that machine. Sample with `--cases` (a domain, a family, or a list of ids) and run one model at a time.

### What the Ollama adapter sends

The adapter sends `format: "json"`, `temperature: 0`, a context of 8192 tokens (Ollama's default of 4096 is barely larger than the prompt), and an output cap of 4096 tokens, which a proposal never approaches and which only stops a model that has started to loop. `think` is sent only when set. Passing the full operation schema as Ollama's `format` was tried and abandoned: Ollama rejects the schema's tuple form, and with a simplified copy a small model looped indefinitely under the grammar.

A quoted entity id (`"stateRef": "2"`) is read as the number 2 when a response is parsed. A temporary reference must start with a letter, so a string of digits can only mean the id, and reading it as one cannot select a different entity. Small models do this often, and it was the cause of most of their `apply` failures.

## Request pools and training material

Training material must stay clear of the test, or a model is simply tested on what it learned. `evals/assistant/pool/` holds candidate training requests, each with a stated expected outcome. `node scripts/writeRequestGenerationPrompt.mjs --domain <name> --count <n>` prints instructions for an agent that writes requests, with the catalog of the domain's models taken from the live models, and `node scripts/checkGeneratedRequests.mjs <file> --for train|test [--out accepted.json]` checks what comes back.

The check rejects an unknown tag, a model that does not belong to the domain, a missing expected outcome, a request that repeats an earlier one, and any request that repeats or nearly repeats (word overlap of 70% or more) a test request. For training it also refuses requests on the held-out models. It then prints warnings, which reject nothing, for a person to look at: an expected outcome that gives a node a state it does not have (a heuristic: "the Tank liquid level becomes" when the tank only has a pressure), and a batch in which more than a quarter of the requests on existing models quote a long catalog name word for word, which no person does and which would teach a model to expect exact names. The generation prompt asks the agent to avoid both.

A pool entry is only half of a training example. The answers still have to be produced and filtered with the same apply and native validation used here, and the expected outcomes are not machine-checked.

## Tests

`tests/assistantEval.test.mjs` covers the scoring (every assertion, untouched-entity comparison, the conduct counts), that every case is inside the vocabulary and starts from a model of its domain, the uniqueness checks above, the reference replay, and the intake checks. `tests/aiRemoteProviders.test.mjs` covers the Ollama settings and the numeric reference handling.

## Where it lives and what ships

The harness code (`assistantEval.mjs`, `assistantEvalFiles.mjs`, `assistantEvalRequests.mjs`) sits in `evals/assistant/` beside its data, and imports from `src/` but is never imported by it. The packaged app leaves the whole `evals/` directory out (see `scripts/packageElectron.mjs`, with a test in `tests/packagingIgnore.test.mjs`), as it does `docs/` and `tests/`. The command-line scripts in `scripts/` are not excluded from the package, as is the case for every script there.

## Known limits

* A generated case is as natural as its template. Real requests will phrase things in ways no template does.
* Equation checks confirm that the equation changed in the intended way (a token, a function, a delay), not that it is mathematically right. The native validator confirms it is well-formed and well-posed, not that it means what the user wanted.
* Suggestion matching is by name, so a model that asks the right question but offers differently worded options fails the case.
* A single local run has noise: a difference of one case is not a result. Compare rates over enough cases, and repeat when it matters.
* The harness measures the proposal, not the review panel, the undo path, or how a person reads a proposal.
