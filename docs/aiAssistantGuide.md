---
type: Guide
title: Model assistant guide
description: How Konjugate's model assistant converts natural-language requests into structured, undoable model-operation proposals.
tags: [assistant, llm, proposals, ollama, gemini]
status: stable
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Model assistant guide

## Overview

Konjugate's model assistant converts a natural-language request into a structured proposal for changing the active model. A proposal can add, update or remove nodes, state variables, source terms, edges, parameters and equations.

The assistant does not edit the model immediately. Konjugate validates the proposal, shows its assumptions and proposed changes, then waits for the user to apply or discard it. Applying a proposal creates one undoable model transaction.

When a request is ambiguous or missing information the assistant needs, it can ask a clarifying question instead of guessing, sometimes with suggested answers shown as buttons. Selecting a suggestion fills in the prompt rather than sending it immediately, so it can still be edited before the reply is sent.

The assistant needs a model. Until one is set up, its panel says so and **Set up a model…** opens **Settings › Model assistant**: sign in to a provider ([below](#sign-in-to-a-provider)), run one on this computer for free ([Run a model on this computer](#run-a-model-on-this-computer)), or add a configuration with an API key ([Hosted providers](#hosted-providers)).

## Use a model you have

At the very top of **Settings › Model assistant**, **Use a model you have** is for a subscription you already pay for that comes with the vendor's own tool:

- **Claude (through Claude Code)**: your Claude subscription (Pro, Max and others), through Anthropic's Claude Code. The row says who Claude Code is signed in as and on which plan.
- **GitHub Copilot**: your Copilot subscription, through GitHub's Copilot command-line tool (`copilot`); a Copilot subscription is free for verified students and for maintainers of many popular open-source projects.

- If the tool is not installed, **Install…** asks first, in a dialog that names the vendor's installer, then runs it as the vendor publishes it, into your own folders without administrator rights: for Claude Code, Anthropic's `claude.ai/install.sh` (or `install.ps1` on Windows); for the Copilot CLI, GitHub's `gh.io/copilot-install` (WinGet's `GitHub.Copilot` on Windows). What the installer prints is shown as it runs, and **Stop** stops it.
- **Sign in** runs the tool's own sign-in, which opens the vendor's page in your browser; if it prints a link or a code to enter, the row shows it. You can also sign in from a terminal with `claude auth login` or `copilot login`.
- **Use it** makes a configuration for it with its default model and puts it in use.

Konjugate runs the tool as it is, signed in as you by the tool's own sign-in, and never sees your password or token. Each request runs the tool once, in an empty temporary folder, with no tools of its own and without your own settings (for Claude Code: your CLAUDE.md, hooks, skills, plugins and MCP servers; for Copilot: your custom instructions and built-in extensions), so all it can do is write the proposal. Requests count against your subscription's limits like any other use of the tool (each Copilot request uses one premium request). If the tool is not signed in, the assistant says so. A Claude Code configuration's model is "Default for your plan" unless you choose Claude Opus, Sonnet or Haiku on its page.

Konjugate looks for the tools on your PATH and where their installers put them (for example `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`), because an app opened from the Finder or the Start menu sees a shorter PATH than a terminal does.

## Sign in to a provider

Below it, **Sign in to a provider** sets the assistant up without making or pasting an API key. It offers:

- **ChatGPT**: your ChatGPT Plus or Pro plan pays for the assistant's requests, within the plan's limits, with no API key and no separate bill.
- **OpenRouter**: one account for models from Anthropic (Claude), OpenAI (GPT), Google (Gemini) and many others, paid for per use from credits on your OpenRouter account.

### ChatGPT

**Sign in with ChatGPT** opens OpenAI's sign-in page in your browser. The first time, it asks you to allow Konjugate to use your ChatGPT plan; allow it, and the browser comes back to Konjugate, which makes a **ChatGPT** configuration with the first model your plan offers and puts it in use. Konjugate is registered with your account as "Konjugate" and appears in ChatGPT's settings among the apps you have connected, where it can also be disconnected. If you sign in but do not allow plan usage, Konjugate says so and keeps nothing.

Plan usage needs a Plus or Pro plan on a personal account, and a workspace plan only where its owner allows it. An account that cannot share its plan (Free, Go, or a workspace that does not allow it) is turned down after you sign in, with a message that says so; use another way to reach a model, or sign in with an account that has Plus or Pro. Requests count against your plan's limits (on Plus, a limit shared with your other uses of ChatGPT over five hours). When the limit is reached, the assistant says so and links to [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage); use another configuration until then. OpenAI offers plan usage as a preview for open-source apps that run on your own computer, and may change it.

Konjugate keeps the sign-in encrypted on this computer and renews it by itself (the access OpenAI gives lasts an hour and is renewed for up to thirty days at a time each time it is used). **Sign in again** renews an ended sign-in with the same account. Deleting the configuration also signs Konjugate out at OpenAI. The configuration has no API key field: a ChatGPT plan is reached only by signing in. Konjugate sends OpenAI only what the assistant needs for the request, and asks it not to keep the conversation (`store: false`).

### OpenRouter

**Sign in with OpenRouter** opens OpenRouter's own page in your browser, where you sign in (or make an account) and allow Konjugate; the page can also set a spending limit and an expiry for what Konjugate is given. While it waits, the section says "Waiting for your browser…" and **Cancel** stops it; it gives up by itself after five minutes. When you allow it, the browser comes back to Konjugate on this computer, Konjugate is given a key for your account, and it makes an **OpenRouter** configuration with a model chosen for you and puts it in use, so the assistant is ready. The model chosen is the newest Claude Sonnet your account can use, or else the newest GPT, or else the newest Gemini Pro: strong at the assistant's job and priced for everyday use. The largest models cost several times more per request, so they are left for you to choose on the configuration's page.

Your password goes only to OpenRouter's page; Konjugate never sees it. The key is kept encrypted like any other ([Credentials and privacy](#credentials-and-privacy)), and you can see, limit or revoke it on OpenRouter under **Settings › API Keys**, where it is named "Konjugate". Once signed in, the row shows the model and offers **Use it** (when another configuration is in use) and **Sign in again**, which replaces the key and keeps the configuration's name and model. Deleting the configuration removes the key from this computer; revoke it on OpenRouter to end it there too.

## Run a model on this computer

Below signing in, **Run a model on this computer** runs a model privately and for free, through [Ollama](https://ollama.com/), a free app made by others. Konjugate does not download or install Ollama: if it is not running, the section says so, **Open the Ollama website** opens its download page in your browser, and **Check again** looks for it once it is installed and open. On Linux, Ollama's website gives a one-line command to install it.

Once Ollama is running, the section suggests models we have measured with the [evaluation harness](assistantEvaluation.md) ([findings](assistantModelFindings.md)):

| Model | Download | Notes |
|---|---|---|
| **Qwen3.5 4B** (recommended) | about 4 GB | About 20 seconds an answer on a recent laptop with 8 GB of memory. |
| **Qwen3.5 2B** (for slower computers) | about 3 GB | Faster, and asks more questions it does not need to. |

**Download** asks Ollama to fetch the model and shows its progress; **Stop** stops it, and closing Settings does not. Once it is downloaded, **Use it** makes a configuration for it, with reasoning off as it was measured, and the assistant uses it. The model is kept by Ollama, which is also where it is removed (`ollama rm`, or Ollama's own app). A card says when a model needs more memory than this computer has.

**Browse Hugging Face…** searches Hugging Face for any model published as GGUF files, the format Ollama runs. Choose one to see its files by quantization, their sizes, whether each fits this computer's memory, and its licence; **Download** fetches it through Ollama (as `hf.co/<repository>:<quantization>`), and **Use it** uses it. Only what you type in the search is sent to Hugging Face. Models that need a Hugging Face account to download are not listed. A model found this way has not been tried with Konjugate: some will not follow the assistant's format, and their proposals may be wrong more often. Every proposal is still reviewed before it changes your model.

The section asks the Ollama that the assistant's Ollama configuration uses, or Ollama's own address on this computer (`http://127.0.0.1:11434`) if there is none; it only ever asks one on this computer.

### Reasoning

Some models can reason before they answer. An Ollama configuration's **Reasoning** setting is the model's own default, **Off** (the suggested models, as measured) or **Reason before answering**. Reasoning is much slower: in a test on an 8 GB M1, Qwen3.5 4B took about 3½ to 10 minutes an answer with reasoning on, against about 20 seconds with it off, and fixed one of two requests it had got wrong. While the model reasons, the panel shows its reasoning as it is written, and a configuration that reasons is marked "Reasons before answering: slow" in the assistant's list.

## History

Every conversation with the assistant is kept for you on this computer, whichever project it was about, so something done in one project can be found and reused in another. **☰** in the panel's header opens **History**: the conversations, most recently used first, each with its title (its first request), the project it was last about, the model and when; the search finds a conversation by any word of its title, requests or outcomes. Opening one shows its turns again, each earlier proposal folded under its turn with its summary and assumptions, and writing continues it, about the model open now. **+** starts a new conversation.

An applied proposal keeps the model as it was just before and just after it, in its conversation. Under that turn, **Show what changed** lists what it added, changed and removed (matched by each node's and relationship's own id, so a change is found wherever it sits) and selects on the canvas the nodes it touched that are in the model now; **Restore before** and **Restore after** put the model open now back as it was then, as one step you can undo, after asking. This works in any project, so a model from one conversation can be brought into another.

Any earlier proposal, applied or not, offers **Apply again**, which prepares it again against the model open now and shows it to review and apply as a new turn. A proposal names existing nodes and relationships by their ids, so one made for another project could change other things here; the proposal then says so at its top. **Ask about this** is usually the better way to reuse work from another project: it shows "About …" above the prompt, and your next request is sent with that proposal as a reference the model is told to adapt to the model open now ("do what this did, but with three cells"), using this model's own nodes. The turn shows what it was about.

Any turn can be forked from. **Fork from here** continues the conversation from that turn as a conversation of its own; **Edit and resend** does the same from the turn before it and puts that turn's request in the prompt to change and send. Each asks where:

- **In this window**: the model open now goes back to how it was at that point in the conversation (as the last change before it left it), after asking and as one step you can undo, and the panel shows the fork.
- **In a new window**: a new, unsaved project opens holding the model as it was at that point, with the fork in its panel.

A fork starts with copies of the turns and checkpoints up to that point and says which conversation it was forked from, with **Open it** while that conversation is kept. Nothing else ties them: deleting either leaves the other whole.

The history keeps within 500 MB: past that, the least recently used conversations' checkpoints are deleted first (their turns stay, and say a checkpoint is no longer kept), then whole conversations, never the one in use.

**⤓** on a conversation in History exports it as Markdown, to a file you choose: each request, when and in which project it was made and with which model, what came of it (applied, discarded, rejected, a question), the assumptions each proposal stated and how many operations it had, and the problems found. It is a record for a report or a design review, written from what the history kept.

**☆** beside a request you sent saves it (it turns into **★**; click it again to stop saving it). **★** beside the prompt lists your saved prompts, newest first: click one to put it in the prompt to change, or **Run** to send it straight away, about the model open now; **×** removes one. Saved prompts are yours, kept apart from any conversation: deleting a conversation leaves them, and **Clear history…** asks separately whether to delete them too.

**×** on a conversation in History deletes it with everything it kept: its turns, the replies and the model checkpoints. **Settings › Model assistant › History** says how many conversations are kept and how much space they take, and **Clear history…** deletes them all. What is deleted is removed from Konjugate's history; Konjugate does not claim it cannot be recovered from the disk or from the computer's backups. The history is not encrypted: an encrypted project protects a model you share, and the history is your own working record.

Keeping everything does not change what is sent to the model: the current request, the model summary and the last five turns of the conversation, as below.

## Conversation memory

The assistant panel keeps a scrollable transcript of the last five exchanges. That history is sent along with every new request, so a reply to a clarifying question, or a follow-up like "make it 10 K warmer instead," is understood in context rather than as an unrelated new request. History is not cleared by applying, discarding or closing the panel — only the **New conversation** button (or switching to a different model configuration, since a different model has no memory of what was said to the previous one) starts a fresh transcript.

## Model configurations

The selector below the assistant prompt chooses the active model configuration. The adjacent ⚙ button opens the configurations in **Settings › Model assistant** ([Settings](settings.md); Settings also opens from ⚙ in the titlebar, or ⌘,).

The page provides:

- **Run a model on this computer** ([above](#run-a-model-on-this-computer));
- a searchable list of saved configurations;
- local and hosted provider settings;
- model discovery before saving;
- connection testing;
- custom model identifiers;
- configurable request timeouts;
- whether an Ollama model reasons before answering;
- seamless editing and deletion.

The page lists the configurations, the one in use marked **In use**. A row opens that configuration on a page of its own, and **Add configuration…** opens a new one; **‹ Model assistant** goes back to the list. Selecting a saved configuration in the assistant panel makes it active, and saving one in Settings also does. Unlike the rest of Settings, a configuration is kept only when **Save** is pressed, since its API key is stored only then; leaving it or closing Settings with changes not saved asks first.

## Ollama

Ollama runs models locally. Konjugate uses `http://127.0.0.1:11434` as its default Ollama endpoint. [Run a model on this computer](#run-a-model-on-this-computer) does the steps below in a few clicks; to set up a configuration by hand instead:

1. Install Ollama from [ollama.com](https://ollama.com/).
2. Download at least one model using Ollama.
3. Ensure the Ollama service is running.
4. Create a configuration and select **Ollama**.
5. Allow discovery to complete or select **Discover**.
6. Choose an installed model, test the connection and save the configuration.

If Ollama is not reachable, Konjugate prompts the user to install or start it. Running `ollama serve` is not necessary when the desktop application or an existing background service is already listening on port `11434`.

Local models vary significantly in their ability to follow the proposal format. Small models may work for simple changes but struggle with multi-node models, equations or reference-heavy operations. A larger instruction-following model will generally produce more reliable proposals.

New Ollama configurations use a longer default timeout because a model may need to load into memory before responding. The timeout can be increased in the configuration manager.

## Hosted providers

Konjugate currently supports:

- OpenAI;
- NVIDIA NIM;
- Hugging Face Inference Providers;
- OpenRouter ([or sign in instead](#sign-in-to-a-provider));
- Anthropic (Claude);
- Google Gemini.

Create an API key through the chosen provider, enter it in the configuration manager, discover or enter a model and test the connection before saving. Below the **API key** field, a link opens the page where that provider's keys are made, in your browser; for Gemini it is **Get a free key from Google AI Studio ›**, since keys made there are free and come with a free tier. An Anthropic key is made in the Claude Console; a Claude subscription (Pro, Max) is not an API key and cannot be used here, but Claude models are also reachable by [signing in to OpenRouter](#sign-in-to-a-provider).

Provider documentation:

- [OpenAI API](https://platform.openai.com/docs/overview)
- [NVIDIA NIM APIs](https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html)
- [Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers/index)
- [Gemini API](https://ai.google.dev/gemini-api/docs)
- [OpenRouter API](https://openrouter.ai/docs/api-reference/overview)
- [Claude API](https://platform.claude.com/docs)

Provider availability, model identifiers, account requirements and pricing are controlled by the provider and may change independently of Konjugate.

## Credentials and privacy

API keys are handled by Electron's main process. Saved keys are encrypted through the operating system's secure-storage facility and are not returned by renderer-facing configuration APIs. Konjugate refuses to persist a key when the available Linux storage backend would keep it as plain text.

A key entered while discovering models or testing a draft configuration remains transient. It is persisted only when **Save** is selected. Leaving the key field blank while editing a saved configuration preserves and securely reuses the existing key.

When an online provider is selected, the request, a summary of the active model, and the conversation history described above are sent to that provider. Users should not send confidential model information to a service they are not authorised to use. Ollama remains local when its endpoint points to localhost; changing it to a remote endpoint changes that privacy boundary.

Remote endpoints must use HTTPS. Plain HTTP is accepted only for loopback addresses such as `127.0.0.1` and `localhost`.

## Proposal lifecycle

The assistant workflow is:

1. Konjugate prepares a compact summary of the current model and recent conversation history.
2. The provider generates either a versioned operation proposal or a clarifying-question response.
3. If it's a clarifying question, Konjugate shows it (with any suggestions) and waits for a reply — it never reaches validation or the active model.
4. Otherwise, Konjugate validates the proposal structure.
5. Correctable output errors are returned to the provider for a bounded number of repair attempts.
6. Konjugate prepares the resulting model without modifying the active document.
7. The native validator checks the prepared model.
8. If the prepared model is rejected (by the structure checks or the native validator), the proposal and its problems, each naming what it is about, go back to the provider once more to be fixed, and whatever comes back is prepared and checked again. A second rejection is shown as it is.
9. The user reviews the summary, any problems, the assumptions and the individual changes.
10. The user applies or discards the proposal.

Invalid intermediate proposals are never applied. Authentication failures, connection failures and timeouts remain visible because repeating the same request cannot normally correct them.

## The assistant's panel

The panel reads like a chat. The conversation fills it and scrolls: each request you sent, what came of it, and the reply to the latest request (a question or a proposal) as a card at the end. The prompt stays pinned below the conversation, and grows as you type, up to a few lines. While a proposal is open, **Discard** and **Apply changes** stay in sight at the bottom of the conversation however long the proposal is.

- **Resize** the panel by dragging any edge or corner. The size is kept for next time; a smaller window shrinks the panel to fit, and a larger one gives the size back. Double-click the header to return to the panel's own size and place.
- **Dock** it with **⇥** in its header: it then fills the height of the window against the right edge, and its left edge sets its width. **⧉** floats it again. In a window narrower than 1100 or shorter than 600 pixels the panel docks by itself, until you choose either way. Docked, the inspector opens over the panel; closing the inspector shows it again.
- On a phone-sized window the panel fills the screen.

A proposal of more than eight changes is folded into one group for each node or relationship its changes touch, in the order the proposal touches them; open a group to see its changes. Problems come first, under **Problems to fix**, each naming the node or relationship it is about, and the group a problem concerns is opened and marked **Needs fixing**.

## What a request uses

Under each turn, the panel says what the request used, as the provider reported it: the tokens sent (and how many of them the provider read from its cache, which costs less), the tokens written, and, where the provider reports one, the cost: OpenRouter in dollars of credit, Claude Code as its own estimate at API prices. A subscription (Claude through Claude Code, a ChatGPT plan, GitHub Copilot) is not charged by the token, but its usage counts against the plan's limits, which the line says; Copilot counts premium requests. History shows each conversation's total.

The instructions Konjugate sends are the same for every request and come first, so providers that cache a repeated start of a prompt (Anthropic, OpenAI, Gemini) charge less for them after the first request; where the provider enforces the response's format, the format's description is not sent a second time.

## Another proposal

If you don't like a proposal, choose **Regenerate…** beside **Discard**. You can say what should be different ("use five cells, not ten") or leave it empty, then choose **Regenerate**. Konjugate sends the same request again, with the proposals you didn't take and your note, and asks for a different approach. A local model is asked to vary its answer for that request, since it otherwise gives the same answer every time. The new proposal is checked like any other, and if the checks find problems, the model gets one round to fix them.

Each answer is another version of the same turn, not a new turn. The arrows beside the proposal's summary (‹ 2 of 3 ›) move between versions, and **Apply changes** applies the one on screen. That version is also what the model is told about the turn later. Every version is kept in the history, and the exported conversation lists them with the note each was asked with and which one was applied. Each regenerate is a request to the model, so it costs what a request costs; the line under the turn adds them up.

A turn with many actions shows the two most used ones and puts the rest under **More**.

## The same request again

If you send exactly the same request about the same, unchanged model, after the same turns, to the same model, Konjugate shows the answer it got before and sends nothing, so it costs nothing. The line under the turn says when that answer was given. If you want a new answer, choose **Ask the model instead**. An answer you discarded is never reused.

## While the assistant works

The panel shows what is happening as the assistant's turn in the conversation, under the request you sent: waiting for the model, whether it is thinking or writing the proposal, checking the proposal, with how long it has been going, and, when a proposal was rejected, that the model was asked to fix it and why. **What the model is doing** opens the model's reasoning, where the provider shares it, and the proposal text as it is written. **Cancel** stops the request at any time.

A model's timeout counts silence: the request is stopped only when nothing has arrived from the model for that many seconds, so a slow model that keeps writing is not cut off, and a repair attempt starts a fresh clock. A request is also stopped after 20 minutes in total. If a model needs a long time to load or to start answering, raise the timeout in its configuration.

## Reviewing a proposal

Review the assistant's assumptions as engineering decisions, not merely explanatory text. Inspect referenced nodes and edges where available. Pay particular attention to:

- units and initial values;
- source and target directionality;
- state-variable ownership;
- parameter modes and values;
- equation signs, symbols and output states;
- inferred geometry or appearance;
- deletions and their cascading effects.

Applying a proposal does not imply that the resulting model is physically complete or suitable for a particular engineering decision. The user remains responsible for model formulation, numerical settings and interpretation.

## Troubleshooting

### The API key can't be read

A saved key is encrypted by the operating system, and reading it needs its permission. If that is refused, Konjugate says it could not read the configuration's API key, and how to get it back:

* **macOS:** the Keychain asked whether Konjugate may use "konjugate Safe Storage", and Deny was chosen. Quit and reopen Konjugate, and choose **Allow** (or **Always Allow**) when macOS asks again. A choice made earlier can be changed in the Keychain Access app, on that item's Access Control tab.
* **Linux:** the keyring is locked. Unlock it, or sign in to the desktop session again, then quit and reopen Konjugate.
* **Anywhere:** enter the key again in the configuration and save it.

Only configurations that use a key ask for it. An Ollama configuration never does.

### Ollama is not reachable

Confirm that Ollama is installed and running, then test `http://127.0.0.1:11434`. If another endpoint is configured, verify its address and transport security.

### The request timed out

The model sent nothing for the configuration's timeout. Increase the timeout or choose a faster model. Local models may take longer on their first request while loading into memory.

### The proposal could not be repaired

The model was given the problems and asked to fix them, and its second proposal had problems too; they are listed under **Problems to fix**. Try a more capable model or divide the request into smaller changes. State units, values, intended node roles and connection direction explicitly.

### A hosted provider rejects the request

Check the API key, endpoint, model identifier, provider account access and quota. Use model discovery when the provider supports it.

### The desired model is not listed

Select **Custom model ID…** and enter the provider's model identifier manually.
