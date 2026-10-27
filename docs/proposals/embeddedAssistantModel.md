---
type: Proposal
title: An embedded model for the assistant
description: Plan for a small open model, fine-tuned for Konjugate's assistant and shipped inside the app through llama.cpp, with the decisions taken so far, the evidence from the evaluation harness, and the gates it has to pass before it ships.
tags: [proposals, assistant, fine-tuning, local-models, llama-cpp]
status: draft
implementation: partial
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# An embedded model for the assistant

**Status: partly built.** The measuring side exists: the [evaluation harness](../assistantEvaluation.md), its cases, models, request pools and reference answers. The model itself does not: nothing has been trained, and nothing is embedded. This document records the idea, what the harness has already shown, the decisions that were taken and the ones that are open, so that the work can be picked up without the conversation that produced it.

## The problem

The [model assistant](../aiAssistantGuide.md) works well with a strong hosted model, which needs an account, a key, a network connection and money, and sends the user's model to a third party. The local alternative is Ollama with a small model, and that works poorly: a model of a few billion parameters either asks a question about almost everything, including requests that name their target and value, or, when pushed not to, starts guessing at ambiguous requests. Neither is acceptable for a feature whose proposals a person reviews quickly. The aim is an assistant that works offline, privately and for free, which needs a small model that has actually learned this job.

## What was decided

* **Fine-tune a small open model rather than prompt a general one.** Prompting was tried and does not close the gap (see the findings). The judgement the assistant needs, when to act and when to ask, is something training can teach and wording cannot.
* **Embed it with llama.cpp (Option B), not by bundling Ollama.** The app would load a quantised GGUF file in-process through `node-llama-cpp`, which avoids shipping and supervising a second server, and allows constrained decoding later. Ollama stays available as a provider for users who have it.
* **Measure first.** Before anything is trained there is a harness that scores a model on the real job, counts errors by direction, and holds back models and test cases so that generalisation can be judged. That is built.
* **Do not use another vendor's outputs in a way their terms forbid.** A strong hosted model is the obvious source of training answers ("distillation"), but its terms may restrict using its outputs to train other models. That is a legal question the project has chosen not to risk, so the teacher question is open and the plan below has a route that needs no teacher.

## What the harness showed

All runs use the same sample of 70 cases (21 original cases and 49 cases built to test asking versus acting), one model at a time, on an 8 GB M1.

### Qwen3-4B-Instruct-2507, untuned

| Setup | Pass rate | Acted when it should have asked | Asked when it should have acted | Valid but wrong edit |
|---|---|---|---|---|
| Original prompt, default sampling | 24% (21 cases only) | not measured | not measured | not measured |
| Original prompt, `temperature 0`, 8192 context | 59% | 0 of 42 | 21 of 28 (75%) | 0 of 28 |
| Plus reading a quoted id as a number | 61% | 0 of 42 | 21 of 28 (75%) | 1 of 28 (4%) |
| A "decisive" prompt telling the model to ask less | 49% | 8 of 42 (19%) | 7 of 28 (25%) | 1 of 28 (4%) |
| The decisive prompt plus three contrast examples, and the id fix | 64% | **12 of 42 (29%)** | 6 of 28 (21%) | **3 of 28 (11%)** |

What this says:

* **The untuned model is safe and hesitant.** It almost never guesses, and it asks a question about three in four clear requests ("Drag coefficient 0.27" gets "What type of equation…?").
* **Prompt wording trades one error for the other.** Telling the model to ask less cut needless questions from 75% to 21%, and raised guessing from 0% to 29%: it picked "Suction Line 1, as the primary line" among three lines, invented "100 kg" rabbits, and ignored a missing value. A 4B model cannot be taught to tell an ambiguous request from a clear one by wording alone. The decisive prompt was reverted.
* **Settings and parsing are real but small gains.** Sampling and context settings changed little; reading a quoted `"2"` as the id 2 removed most `apply` failures (the model cited ids as strings), and is kept.
* **Forcing the output with a grammar is risky.** Passing the whole operation schema to Ollama made a small model loop for over an hour on one case. Any constrained decoding needs an output cap.

### Smaller models

Qwen3.5 0.8B, 2B and 4B (released this year under Apache 2.0, available through Ollama) are being measured the same way. Results are added to the table below as they come in; none has been fine-tuned.

| Model | Size on disk | Notes |
|---|---|---|
| Qwen3.5 0.8B | 1.2 GB | untuned, thinking off: 24 of 70 (34%). It answered all 70 cases with a question and never produced a proposal, so it asked when it should have acted on 28 of 28 and, trivially, never acted when it should have asked. About 2 seconds per case, against 9 for the 4B |
| Qwen3.5 2B | 3.1 GB | being measured |
| Qwen3.5 4B | about 3.5 GB | not yet downloaded |

Other candidates noted but not yet tried: Qwen3 1.7B and 0.6B (Apache 2.0, text-only), Gemma 4 E2B (2.3B effective parameters, Apache 2.0), Granite 3.3 2B and SmolLM3 3B. Check each model's licence on its model card before relying on it.

## The approach

### Data

A training example is the prompt the model sees now plus a verified answer. There are two sources, and they can be combined:

1. **Programmatic examples.** The same technique that builds the generated test cases produces (request, correct answer) pairs from a model's own states, parameters and relationships, with no AI involved: value edits, unit conversions, parameter edits, switching things off, removals, and the should-ask cases (an ambiguous target, a missing value, something not in the model). This needs no teacher and no terms question. It must use **different wording templates and only the non-held-out models** from the test cases, or the test scores are inflated. It covers templated phrasing only.
2. **Teacher answers for free-form requests.** An open-weights teacher whose licence allows this, or a hosted one if its terms allow it, answers the request pools in `evals/assistant/pool/`. An answer is kept only if it applies cleanly, passes the native engine, and is judged consistent with the stated expected outcome. The pools hold 267 requests today; growing them to a few thousand with agent-written batches through the intake check is cheap.

Both sources keep the ratio of should-ask to should-act cases near its test value (about one in five), so that the model does not learn to always act or always ask.

### Training

A LoRA adapter on the chosen base model, merged and quantised to GGUF. The development Mac (an M1 with 8 GB) can run inference but cannot train a model of this size, so training would use a rented GPU: roughly 27 million training tokens per run for 3,000 examples of 3,000 tokens over three epochs, in the range of one to two hours on an A100 80GB, a few dollars a run at published rates ([Jarvislabs](https://jarvislabs.ai/blog/a100-price), [RunPod guide](https://www.hivenet.com/post/runpod-pricing-complete-guide-to-gpu-cloud-costs)). These are estimates, and the sources conflict on price, so check live rates before booking. Several runs are expected, including a smaller base model for comparison.

### A shorter prompt for the embedded model

Today's prompt is about 3,000 tokens, mostly the schema and the equation rules, which accounts for most of the 8 to 10 seconds a local 4B model takes. A fine-tuned model no longer needs the rules spelled out, so a compact prompt for the embedded model would cut training cost and latency substantially. The remote providers would keep the full prompt. This is a design change to the prompt layer, to be made when the model exists to test it against.

## Gates

Nothing ships until it clears these on the harness:

1. **Teacher check, if a teacher is used.** On the test cases the teacher passes about 90%, with no wrong guesses on the should-ask cases. If it does not, the cases or the prompt are at fault and training would copy the flaw.
2. **Better than the untuned baseline** on pass rate across the full set.
3. **Neither dangerous rate above about 5%:** acting when it should ask, and valid but wrong edits.
4. **Generalisation:** within about 10 points of its score on models it trained on, when run on the held-out models.
5. **Fit for a laptop:** a download of one to three gigabytes, a median answer time acceptable on an 8 GB Mac, and no runaway generation (every request capped).

## Open questions

* **Which teacher, if any,** and whether its terms permit the use. The programmatic route avoids the question for the structured request types.
* **Which base model:** the sizes are a trade between capability (does 0.8B cope with a large model and a long prompt?) and cost (download, memory, speed). The bake-off with the harness answers this before any money is spent on training.
* **Where the generator of test and training examples lives.** It is not in the repository today, which means extending or regenerating the generated cases needs it rewritten.
* **How to ship and update the file,** and whether the app offers the download on demand rather than bundling it, given its size.
* **Review of real use.** The harness cannot show how people phrase requests or how they read a proposal. The first release should keep the review step prominent, and any measurement of how often proposals are rejected must be local and consented.

## Non-goals

* Replacing the hosted providers. They remain the best-quality option.
* A general-purpose model. The embedded model only needs to do this one job.
* Training on users' models or requests.
