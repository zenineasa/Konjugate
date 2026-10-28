---
type: Report
title: Assistant model findings
description: What the evaluation harness showed about small untuned local models on the assistant's job, above all how they keep asking for more information on requests that are already clear, with the runs, numbers, examples and caveats.
tags: [assistant, evaluation, local-models, findings, qwen]
status: stable
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Assistant model findings

This is the record of what was measured when small open models were run through the [evaluation harness](assistantEvaluation.md) without any fine-tuning, and what that means for the [embedded model proposal](proposals/embeddedAssistantModel.md). It is a snapshot from October 2026 on one 8 GB Apple M1, and it will go stale as models and the harness change. The numbers are the evidence, the reading of them is judgement, and the two are kept apart below.

## The one-paragraph version

Every small model tried is hesitant rather than reckless. Given a clear request that names its target and its value, such as "Set the DC supply voltage to 12 V.", the models answer with a clarifying question three times in four or more, and the smaller the model the worse it gets. They very seldom act on a request that should have been questioned. Changing the prompt wording moves errors between the two directions without removing them. Newer or differently sized models in the same family did not change the picture. The behaviour looks like something a model has to be taught, not told.

## How the runs were made

* **Sample.** 70 cases drawn from the 1,032 in the harness: 21 original cases plus 49 built to separate acting from asking. 28 of the 70 are cases where the right answer is a proposal ("should act") and 42 are cases where the right answer is a question ("should ask"). One case is therefore worth about 1.4 points of overall pass rate, and one should-act case is worth 3.6 points of the asking rate.
* **Setup.** Ollama on the same Mac, one model at a time, the same prompt the app sends, `temperature 0`, 8192 tokens of context, at most 4096 tokens of output, 240 seconds per case, native validation on, one run per model. Qwen3.5 models were run with thinking turned off.
* **What counts as a pass.** The proposal, if one is made, must apply, pass the native engine and leave the model as the request asked, and a question must offer the options the case lists. See [the assertions](assistantEvaluation.md#assertions).
* **Single runs.** Each row is one run. Differences of a few points between models are within noise. The gaps called out below are far larger than that.

## Results

| Model | Size | Passed | Asked when it should have acted | Acted when it should have asked | Valid but wrong edit | Median time |
|---|---|---|---|---|---|---|
| Qwen3-4B-Instruct-2507 | 2.5 GB | 43 of 70 (61%) | 21 of 28 (75%) | 0 of 42 | 0 of 28 | 9.9 s |
| Qwen3.5 0.8B | 1.2 GB | 24 of 70 (34%) | 28 of 28 (100%) | 0 of 42 | 0 of 28 | 2.2 s |
| Qwen3.5 2B | 3.1 GB | 33 of 70 (47%) | 24 of 28 (86%) | 1 of 42 (2%) | 1 of 28 | 8.0 s |
| Qwen3.5 4B | about 3.5 GB | 43 of 70 (61%) | 21 of 28 (75%) | 2 of 42 (5%) | 0 of 28 | 19.7 s |

Where the failures were, by the stage of the harness that caught them:

| Model | Wrong kind of answer | Did not apply | Failed to generate | Applied but not what was asked |
|---|---|---|---|---|
| Qwen3-4B-Instruct-2507 | 21 | 1 | 0 | 5 |
| Qwen3.5 0.8B | 28 | 0 | 0 | 18 |
| Qwen3.5 2B | 25 | 0 | 4 | 8 |
| Qwen3.5 4B | 23 | 1 | 1 | 2 |

"Wrong kind of answer" is the stage that matters most. In the three larger models it is almost entirely a question where a proposal was expected, which is the asking problem described next. For the 0.8B the 18 "applied but not what was asked" failures are questions on should-ask cases whose offered options did not match, so its 24 passes are mostly the cases where asking happened to be right.

## The asking problem

### What it looks like

The should-act cases are requests a person would regard as complete. These are real answers from the runs.

* **"Set the DC supply voltage to 12 V."** The model has a DC supply node with a voltage state, and the request names both it and a value. All four models asked. Qwen3-4B asked "What specific state or parameter should be updated to set the DC supply voltage to 12 V?" and offered five choices, among them "Add a new parameter to control voltage" and "Adjust the node's name or type to reflect a 12 V supply". Qwen3.5 4B asked whether to set the voltage state or "change the node's type from a Voltage source to a Constant Current Source".
* **"Set the number of foxes to 100."** Qwen3-4B asked "Do you mean to set the head count of foxes to 100, or is there a different state or entity you'd like to modify?", and its first offered answer was "Set the head count of foxes to 100", which is the request restated.
* **"Add a tank called Reservoir with a pressure of 200000 Pa."** Every model asked. Qwen3.5 4B asked whether the tank should be a cylinder and, in the same question, observed that the model it was given was empty.
* **"Make the vehicle mass 1.6 tonnes."** A unit conversion the harness expects to be done. The three Qwen3.5 models asked. Qwen3-4B acted but did not convert correctly.
* **"330"**, sent as the reply to an earlier question about a temperature. All four models asked again, Qwen3-4B with "What temperature (in K) should Battery module be set to?" and a menu of 330 K, 330.15 K, 330.5 K, 331 K and 332 K.

### What the questions have in common

* **They ask for what the model already holds.** The prompt includes the model's nodes, states, edges and ids. The smaller models still ask "What is the symbol for the DC supply voltage in this model?" (0.8B), "Which specific edge ID corresponds to the 'Discharge' relationship?" (0.8B and 2B) and "Which node should be set to 12 V? Is it the 'DC supply' (node ID 1) or another node?" (2B). A person using the app would not know an edge id, and the answer is in the prompt.
* **They invent ambiguity.** Menus of options are offered on nearly every question (all 21 of Qwen3-4B's and all 21 of Qwen3.5 4B's), and the extra options are often things nobody asked about, such as changing a node's type, adding a time-varying schedule, or removing the node. The ambiguity named is hypothetical.
* **They grow with the model.** The mean question is 73 characters for the 0.8B, 145 for Qwen3-4B, 173 for the 2B and 271 for Qwen3.5 4B. The longest are the most hedged, for example "The user request 'Set the DC supply to 12 V' is ambiguous regarding whether this refers to updating the initial value of the existing state or changing the node's type…". A larger newer model argues for the ambiguity more eloquently, not less often.
* **They are not consistent.** The two 4B models asked about the same number of should-act cases (21 of 28) but not the same ones: they agreed on which five to act on in only three. Four models asked about the same 16 of the 28, and the other 12 split. If these requests were truly ambiguous, the models would hesitate on the same ones. The scatter says the decision is close to arbitrary rather than a reading of the request.
* **They are worst on the simplest requests.** Setting a named value ("Set X to V", the `reference`, `updateValue` and `units` families) is where asking is highest: Qwen3-4B passed 2 of the 11 `reference` cases and Qwen3.5 4B 1 of 11. Removing and switching things off, which are structurally more drastic, are the ones it acts on most readily.
* **A question is a valid answer.** The harness's repair loop retries a proposal that fails to apply, but a clarification is a legitimate response, so nothing retries it. A model that asks every time is never corrected in the app either.

### Why this probably happens

These are hypotheses, not findings.

* **The prompt invites asking.** It offers a clarification as a first-class way out when a request is ambiguous, and a small model that is uncertain takes it. The cost of a question looks low to the model and is high to the person.
* **Small models cannot calibrate.** Telling an ambiguous request from a clear one needs a judgement of what is missing, and a 4B model cannot be coached into it by words. The experiments with prompt wording below support this.
* **The model's chat training favours caution.** Instruction-tuned models are rewarded for checking before doing. The effect is strongest in the smallest.
* **The prompt is long.** About 3,000 tokens of schema and rules, mostly irrelevant to a single request, leave a small model with less attention for the request. This was not tested.

### The prompt does not fix it

| Setup (Qwen3-4B-Instruct-2507) | Asked when it should have acted | Acted when it should have asked | Valid but wrong edit |
|---|---|---|---|
| Original prompt | 75% | 0% | 0 to 4% |
| A prompt telling the model to ask less | 25% | 19% | 4% |
| The same plus three contrast examples | 21% | 29% | 11% |

The needless questions fall, and the dangerous errors rise. The wrong guesses included picking "Suction Line 1, as the primary line" out of three, inventing "100 kg" rabbits, and ignoring a missing value. The decisive prompt was reverted. See the [proposal](proposals/embeddedAssistantModel.md#what-the-harness-showed) for the other settings tried.

## The opposite error

The dangerous direction, acting when it should have asked, was rare, but it happened in the larger Qwen3.5 models, and the examples are instructive.

* **"Remove everything."** Qwen3.5 4B proposed deleting every node, edge and state in the thermal model, recording as its assumption "a clean slate". The case expects a question about what is meant.
* **"The link is not needed any more."** The articulated arm has three links. Qwen3.5 4B assumed all three, and their motor connections, were meant, and removed all of them. The case expects a question about which link.
* **"Set the displacement to 0.2 m."** Qwen3.5 2B invented a parameter on an edge instead of asking which of several things the displacement referred to.

Every proposal is reviewed and undoable, which is the safety net, but a fast reviewer who sees a small change does not expect a deletion of the whole model. The gate in the proposal caps this rate at about 5%, and Qwen3.5 4B sits exactly at it.

## Other failures

* **Temporary references.** Qwen3.5 2B failed on three cases and Qwen3.5 4B on one with "ref must be a lower camel case temporary reference". These are the names a proposal gives to things it creates, and the small models wrote forms the schema rejects. The repair loop did not recover.
* **Wrong kind of reference.** On the same multi-step case (`taxReserveFlow`) Qwen3.5 4B cited a node ("taxReserve") where a state was needed, and Qwen3-4B wrote an equation using a name the model did not define ("balance"). Neither applied.
* **Runaway generation.** One Qwen3.5 2B case reached the 240-second limit, and one 0.8B case took 126 seconds. An earlier run with no output cap hung for about 20 minutes, which is why every request now has a token and time cap.
* **Quoted ids.** Qwen3-4B cited ids as strings ("2"). This is now read as a number, which removed most `apply` failures. It was a real gain, but a small one.

## What this settles and what it does not

Settled, on this sample:

* No model tried is usable untuned. Even the best passes about three in five of the sample and asks about three in four clear requests.
* Within the Qwen family, size trades capability for speed with no useful middle: the 0.8B is quick and never proposes, the 2B is no faster than the older 4B in practice, and the newer 4B is twice as slow with no better result.
* The behaviour is the same across models and is not reached by wording, so the lever is training.

Not settled:

* **Thinking mode.** Qwen3.5 can reason before answering. It might ask less, at a large cost in time. Not measured.
* **Other models.** Qwen3 1.7B and 0.6B, Gemma 4 E2B, Granite 3.3 2B and SmolLM3 3B were not run.
* **Whether the cases are all fair.** The should-act labels are the case authors' judgement. A few are arguable, for instance a history case whose request is a bare number, and a reviewer could rightly call a handful of the 28 ambiguous. That would lower the measured rate but not change the reading: 16 of the 28 were asked about by every model, which includes plain requests such as "Set the DC supply voltage to 12 V."
* **Noise.** One run per model on 70 cases. The results should be repeated, and the whole 1,032-case set run, before a decision rests on a small difference.
* **Real use.** The harness uses written cases. Real requests phrase things differently and may be asked more or less often.

## What to do with it

* Treat the asking rate and the wrong-proceed rate as the two numbers a tuned model must move, and watch both together. A model that fixes one by trading the other has not improved.
* Teach the judgement with data, not wording: include clear requests with the right proposal, ambiguous requests with a good question, and a mix of both near the one-in-five ratio of the tests. See the [proposal](proposals/embeddedAssistantModel.md#the-approach).
* Test the thinking-on setting before concluding that asking is hard-wired in these models.
* Keep the model-agnostic fixes made on the way: output caps, per-case time limits, numeric id handling and the conduct report.
