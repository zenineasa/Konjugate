---
type: Proposal
title: "The best model a person has access to, with the least setup"
description: How the model assistant can use the models people already pay for or can reach — a Claude subscription through Claude Code, a ChatGPT plan through Sign in with ChatGPT, a Copilot subscription, OpenRouter and Hugging Face sign-in, local models — by detecting what is there, installing a vendor's own tool when needed, and signing in through the vendor's own flow; what each vendor's terms allow, where Anthropic's documentation is unclear, how a desktop app that shows Claude logins does it, and a staged plan.
tags: [proposals, assistant, providers, oauth, credentials, settings, claude-code]
status: draft
implementation: partial
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# The best model a person has access to, with the least setup

## The requirement

A person should be able to use the best model they already have access to through Konjugate, and getting there should be easy. Today every hosted provider needs an API key: create a developer account, add a payment method, make a key, paste it into **Settings › Model assistant**. Most people who would use the assistant never do that, but many already pay for a chat or coding subscription (Claude, ChatGPT, GitHub Copilot) or already have one of the vendors' tools installed.

So the assistant should:

1. **Find what the person already has**: a signed-in Claude Code, Copilot CLI or Codex, an Ollama with models, configurations saved before.
2. **Offer the best of it first**, with a one-click way to use it.
3. **Install what is missing**, when the vendor's own tool is the only allowed way in, with the person's consent and without sending them to a terminal.
4. **Sign in through the vendor's own flow** in the person's browser, never through a form of Konjugate's.
5. **Fall back to an API key** for everything else, as today.

What is allowed differs a great deal between vendors; this proposal records what each allows (checked on 2026-11-27 and 2026-11-28 against the vendors' own pages unless marked otherwise) and builds the design around it. It extends the existing [Model assistant provider architecture](../aiProviderArchitecture.md).

## What a person may have, and how Konjugate can use it

| What the person has | Best way in for Konjugate | What it costs them | Allowed? |
| --- | --- | --- | --- |
| A Claude subscription (Pro, Max, Team…) | Their own Claude Code, unmodified, signed in through Anthropic's flow; Konjugate runs it in print mode | Their Claude plan's limits | Unclear; needs a written answer from Anthropic (below) |
| A ChatGPT Plus or Pro plan | **Sign in with ChatGPT**, *ChatGPT plan usage*: Konjugate signs in directly and calls the Responses API | Their ChatGPT plan, within a weekly limit per app | Yes, documented for open-source, locally run apps; a preview; eligibility to confirm |
| A GitHub Copilot subscription | The Copilot CLI (or GitHub's Copilot SDK) in programmatic mode, signed in through GitHub's flow | One premium request per prompt from their monthly allowance | Licence allows shipping it inside an app; no clause found on apps invoking it; to confirm |
| A Google account | An API key from Google AI Studio (has a free tier) | Free tier, or their Cloud billing | Yes. Signing in through Gemini CLI for another app is **forbidden** |
| An OpenRouter account, or willing to make one | **Sign in with OpenRouter** (OAuth with PKCE); reaches Claude, GPT, Gemini, Llama and more | Their OpenRouter credits | Yes, self-serve |
| A Hugging Face account | **Sign in with Hugging Face** (`inference-api` scope) | Their Hugging Face account | Yes, after registering a free OAuth app |
| A capable computer | **Run a model on this computer** through Ollama (built) | Nothing | Yes |
| A developer API key from any provider | **Use an API key…** (built for OpenAI, Gemini, NVIDIA, Hugging Face; Anthropic to add) | Their API billing | Yes |

## Vendor by vendor

### Anthropic

#### What the documentation says

Anthropic's Claude Code *Legal and compliance* page, under *Authentication and credential use*:

> OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.

> Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

The same page allows something narrower. An end user may sign in to "the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code". Preinstalling or running Claude Code in a product "requires agreeing to our Commercial Terms of Service" and these conditions: the binary "must not be modified"; the product must not "remove, disable, or restrict any authentication method built into it"; it "may not pay for, resell, or intermediate Claude usage on their end users' behalf", each end user authenticating with their own key, subscription or cloud-provider credential; and it may say "in plain text, that your product has Claude Code preinstalled or that it runs Claude Code" but may not use Claude Code's or Anthropic's names or logos as part of its own product or feature names. Questions go to Anthropic's sales team.

Anthropic offers no "Sign in with Claude" OAuth for other developers' apps. Enforcement against third-party tools using subscription tokens began in January 2026 and the policy text was tightened in February and April 2026 (reported by the press; Anthropic's own announcement was not found).

#### How a desktop app shows Claude logins and usage

Orchestrator, a desktop app that runs several coding agents, lists Claude accounts with their plan, a five-hour session meter and weekly meters (the same figures as claude.ai's own usage page), and offers **Sign in again**, **Make default** and **Log out**. It does this without a Claude.ai login of its own:

- **Signing in** runs Claude Code's own `claude auth login`, with `CLAUDE_CONFIG_DIR` pointing at a folder per account. The browser sign-in is Anthropic's flow and the login is kept by Claude Code (in the keychain, keyed by that folder); Orchestrator never receives the OAuth tokens.
- **Who is signed in** comes from `claude auth status`, which reports the email, plan and organisation.
- **The meters** come from Claude Code too: Orchestrator starts the CLI in stream-JSON mode and sends a `get_usage` control request; the CLI reads the limits with its own login and Orchestrator only sees the answer. That is why the weekly meter matches claude.ai exactly.
- **Agents** are the unmodified binary from Anthropic's official installer.

That is the "unmodified Claude Code binary ... where a platform hosts Claude Code" allowance, not a contradiction of the ban on offering Claude.ai login. One part is less clear: it also accepts a token from `claude setup-token` (a long-lived subscription token Anthropic documents for CI and scripts), stores it in the account's folder and passes it to the binary as `CLAUDE_CODE_OAUTH_TOKEN`, which sits awkwardly next to "may not collect, store, or intermediate ... session tokens".

#### Where the documentation is unclear

The pages agree on the main point: a third-party app may not run its own Claude.ai sign-in or call Anthropic with a subscription token. They are unclear at the edges:

1. **The Agent SDK and the binary.** Products "using the Agent SDK" must use API keys, yet the SDK works by running the Claude Code binary, and a platform that hosts the unmodified binary may let people sign in with their subscription. Where "hosting Claude Code" ends and "building a product on the SDK" begins is not defined.
2. **Storing a setup token.** `claude setup-token` exists so a subscription can be used outside an interactive session, but storing someone's token for them reads as "store ... session tokens".
3. **Automation.** The consumer terms forbid access "through automated or non-human means" except with an API key "or where we otherwise explicitly permit it"; setup tokens for CI and scripts are such a permission, but the line between a person's own script and a product is not drawn.

Konjugate's use falls on point 1. Orchestrator hosts Claude Code as the agent a person works with; Konjugate would use Claude Code as the model behind one of its own features, which is closer to "a product that interacts with Claude's capabilities". The risk of guessing wrong falls on the people using Konjugate: Anthropic says it may enforce "without prior notice", and enforcement has meant refused requests and suspended accounts. So the Claude Code bridge is designed here but is not shipped without a written answer from Anthropic. If the answer is no, Claude stays reachable through an Anthropic API key and through OpenRouter.

#### What the Claude Code bridge would do

From Claude Code's CLI reference and setup pages:

- **Install** (when missing, after the person agrees): Anthropic's native installer (`curl -fsSL https://claude.ai/install.sh | bash` on macOS and Linux, `irm https://claude.ai/install.ps1 | iex` on Windows) puts it in `~/.local/bin` and `~/.local/share/claude` without administrator rights and keeps it updated in the background. Konjugate runs the installer as published (it does not download, repackage or pin the binary itself), shows its progress, and leaves updates on. An existing installation from Homebrew, WinGet, a Linux package or npm is used as it is.
- **Sign in**: `claude auth login` opens Anthropic's sign-in in the browser; `claude auth status` (JSON, exit code 1 when signed out) gives `authMethod` (`claude.ai` for a subscription), the email, plan and, from v2.1.318, `loginExpiresAt`. Konjugate stores nothing: the login stays where Claude Code keeps it. Konjugate does not offer the setup-token route.
- **Generate a proposal**: `claude -p` with `--output-format stream-json --verbose` (for the progress the panel shows), `--json-schema` with the proposal schema (the result arrives in `structured_output`, which may be missing, so the host validates as it does for every provider), `--tools ""` so the model can use no tools, `--system-prompt` with the assistant's prompt, `--max-turns 1`, `--model` when the person chose one (otherwise the plan's default), and `--safe-mode` in an empty working directory so the person's own CLAUDE.md, hooks, skills and MCP servers do not enter the request. `--bare` cannot be used: it never reads the subscription login.
- **Show the plan and limits** through the `get_usage` control request, as Orchestrator does, so a person sees how much of their plan the assistant is using.
- **Naming**: the configuration is shown as "Claude (through Claude Code)", which is the plain-text description the terms allow.

### OpenAI

OpenAI's *Sign in with ChatGPT* has two parts. Identity sign-in is "currently available to selected commercial partners through a limited trial". *ChatGPT plan usage*, which lets an app spend the person's ChatGPT plan instead of a developer's API key, "is available to all open-source partners and selected private clients", and its documentation is written for "open-source and locally hosted apps"; paid or remotely hosted apps are sent to an interest form. Konjugate is MPL-2.0 and runs on the person's computer, which is the case described, but the documentation does not say how an open-source project becomes a "partner", so eligibility is confirmed before building.

This is OpenAI's sanctioned route, and it needs no tool installed: Konjugate signs in and calls the API itself. From the documentation:

- A public client with PKCE (`S256`), no client secret and no partner API key.
- No registration in advance: the first authorization request uses `client_id=dynamic_agent_client` with a stable `ext_agent_host_id` the app chooses and keeps, and `agent_name_hint=Konjugate`; the callback returns an issued client ID (`oaiapp_…`) the app stores and uses from then on.
- The redirect is an HTTP listener on `127.0.0.1` (not `localhost`) started before the browser opens; the port may change between sign-ins, the scheme, host and path may not.
- Scopes `offline_access resource.invoke chatgpt.tokens.use.direct` with `resource=https://api.openai.com/v1`. A sign-in that did not grant `chatgpt.tokens.use.direct` cannot be used; `error=access_denied` at the callback means plan usage is not enabled for that person.
- Requests go to `POST https://api.openai.com/v1/responses` with the access token as a bearer token, `store: false` and `stream: true`, success only on `response.completed`; models from `GET /v1/models` with `visibility == "list"`. Not ChatGPT's own `backend-api`. The preview has no hosted tools (file search, code interpreter), which the assistant does not use.
- A plan limit arrives as `response.failed` with `subscription_sharing_usage_limit_exceeded` or `subscription_sharing_usage_unavailable`.

Konjugate's OpenAI adapter uses chat completions, so this needs a Responses API request path. OpenAI also documents running its open-source Codex CLI as an *app server* with such a token; Konjugate does not need that, since it only needs the Responses API. A person's existing Codex CLI login (`~/.codex/auth.json`) is not read: no page permits another app to use it.

### GitHub Copilot

A Copilot subscription is common among developers (and free for verified students and maintainers of popular open-source projects), and it reaches models from several vendors, Claude and GPT among them. The Copilot CLI's licence is not open source, but it allows redistribution, unmodified, "as part of an application or service that provides material functionality beyond the Software". It has a programmatic mode (`copilot -p`, `--output-format=json`, `--model`, and `--available-tools`/`--excluded-tools`/`--deny-tool` to give the model no tools), signs in through GitHub's own browser or device flow (`copilot login`), keeps the login in the system keychain, and each prompt uses one premium request. GitHub also documents a Copilot SDK for client applications, in which "your backend can pass each user's GitHub token when it creates or resumes an SDK session", which suggests GitHub intends apps to build on it.

No clause was found on third-party apps invoking the CLI or SDK for a person (GitHub's Copilot product terms were not read), so this needs reading and, if unclear, asking before it is built. What Konjugate will not do is what some community tools do: sign in with GitHub's device flow using another product's client ID to reach Copilot's model API directly.

### Google

Google's Gemini CLI terms say that "directly accessing the services powering Gemini CLI" from other software "is a violation of applicable terms and policies" and "may be grounds for suspension or termination of your account", naming third-party use of Gemini CLI's OAuth as the example. Free individual access and Google One plans also moved from Gemini CLI to Antigravity CLI on 18 June 2026. So Konjugate does not use a person's Google login through either tool (Antigravity's terms were not read but are expected to match). Signing in to the Gemini API with Google OAuth directly needs a sensitive scope and Google's app verification, which is not worth it while the API key path works: a key from Google AI Studio is free to make and has a free tier, so the settings page should make that path short ("Get a free key from Google AI Studio" opening the page, then a paste field).

### OpenRouter

OpenRouter's OAuth with PKCE sends the person to OpenRouter with a callback address and exchanges the returned code (with the PKCE verifier) at `/auth/keys` for an API key that belongs to the person's own account and that they can revoke. Localhost callbacks on any port are accepted, there is no registration and no client secret, and its API is OpenAI-compatible, so the existing `openAICompatibleProvider` serves it. One sign-in reaches models from every major vendor, which makes it the dependable way to reach Claude by signing in whatever Anthropic answers.

### Hugging Face

Hugging Face OAuth apps can be public (no client secret), and the `inference-api` scope grants "access to the Inference Providers ... on behalf of the user". Konjugate already has a Hugging Face adapter. One forum report says the token from a connected app did not work for inference, so the first step is a test against the real service.

## Design

The provider architecture stays as it is: credentials live in the main process, the renderer only ever sees public configuration, provider output is untrusted, and the host validates every proposal.

### Settings: what you have, then how to get more

**Settings › Model assistant** opens on **Use a model you have**, a short list of what Konjugate found on this computer, best first, each with one button:

- *Claude, through Claude Code — signed in as a…@… (Max plan)* · **Use**
- *GitHub Copilot — signed in as …* · **Use**
- *Ollama — 2 models installed* · **Use**

Below it, **Connect another**:

- **Sign in with ChatGPT**
- **Sign in with OpenRouter**
- **Sign in with Hugging Face**
- **Claude** (install Claude Code and sign in) · **GitHub Copilot** (install the Copilot CLI and sign in), for people who have the subscription but not the tool
- **Run a model on this computer** (as today)
- **Use an API key…** for every provider, including Anthropic, with "Get a free key from Google AI Studio" next to Gemini.

After any of these, Konjugate chooses the strongest model the account offers as the default and makes the configuration active, so one click gives a working assistant; the person can change the model. Each configuration shows who is signed in, the plan limit when the provider reports one, and **Sign out**. A plan-limit error says so plainly ("Your ChatGPT plan's limit for Konjugate is reached until …") and offers the other configurations, which is where a second account or provider earns its place.

### Finding what is installed

A new `src/aiDetection.mjs` in the main process looks for each vendor tool on the `PATH` and in its installer's usual places (`~/.local/bin/claude`, Homebrew, WinGet), asks its status command (`claude auth status`; the Copilot CLI's account check), and reports name, version, signed-in account and plan. It runs when the settings page opens and when the assistant has no configuration, never on a timer, and reads no credential files.

### Installing a vendor tool

A new `src/aiToolInstall.mjs` runs a vendor's published installer, only after the person presses the button, in a dialog that says what will be installed, by whom, where, and that it updates itself. It streams the installer's output into a progress line, can be cancelled, and installs into the person's own folders without administrator rights. It never downloads or repackages a vendor binary itself, so the tool stays the vendor's own, unmodified and updated by the vendor. Removing the configuration does not uninstall the tool; the dialog says how to.

### Vendor tools as providers

A *vendor tool* provider has the same shape as the others (`listModels`, `testConnection`, `generateProposal`), but its main-process side runs the tool as a child process: the prompt and schema on stdin, stream-JSON on stdout turned into the same `thinking`/`output` events the panel already shows, cancellation by ending the process, and the existing silence timeout. No credential passes through Konjugate; the tool signs in by itself. Each runs in an empty temporary working directory with the tool's customisations off and no tools available to the model, so a proposal is all it can produce.

### Direct sign-in

For OpenAI, OpenRouter and Hugging Face, Konjugate signs in itself:

- **Two kinds of credential.** `src/aiConfigurationStore.mjs` gains a sign-in record next to the API key string: access token, refresh token if any, expiry, the issued client ID where there is one (OpenAI), and the account's display name, encrypted with `safeStorage` like keys today. The public configuration gains `signedInAs`; it never carries a token. OpenRouter's sign-in produces an ordinary key and is stored as one.
- **One sign-in module.** `src/aiOAuth.mjs` generates the PKCE verifier and challenge and a `state`, starts a listener on `127.0.0.1` before opening the person's default browser with `shell.openExternal` (never a window inside the app, which providers refuse and which would let the app see the password), checks `state`, answers the browser with a short "You can return to Konjugate" page, exchanges the code, and can time out or be cancelled. A provider supplies its addresses, scopes and how to read its token answer.
- **Refresh.** Providers declare `auth: ['oauth', 'apiKey']` and supply `signIn` and `refresh`. The registry refreshes a token that expires within a minute before a call and saves the new one; a failed refresh turns into **Sign in again**, not a generic error. Redaction covers tokens as it covers keys.

### Web edition

Nothing now: the assistant is not in the web edition yet. When it is, OpenRouter's flow works from a browser with an HTTPS callback; the loopback flows and vendor tools do not.

### Tests

- A fake OAuth server in `tests/fixtures/`, like the fake Ollama server, drives sign-in, a denied sign-in, refresh, an expired refresh token, cancellation and a timeout.
- Fake `claude` and `copilot` executables answer the status, print-mode and usage requests by fixed rules, so detection, installation-free runs, streaming and cancellation are tested without the vendors.
- Provider tests check that no token reaches public configuration, errors or progress text.
- `scripts/checkAIProvider.mjs` gains signed-in configurations and vendor tools for the real-service check.

## Stages

1. **Built: direct sign-in plumbing and OpenRouter** (`src/aiOAuth.mjs`, the OpenRouter adapter, **Sign in to a provider** at the top of the settings page; described in the [provider architecture](../aiProviderArchitecture.md#signing-in-to-a-provider) and the [guide](../aiAssistantGuide.md#sign-in-to-a-provider)). An OpenRouter key is an ordinary key, so the sign-in record with a refresh token waits for ChatGPT plan usage, the first provider that needs it.
2. **Built: Anthropic with an API key**, through the Messages API with Anthropic's SDK and structured outputs, and a link to each provider's key page under **API key** ("Get a free key from Google AI Studio ›" for Gemini).
3. **Built: ChatGPT plan usage**, with the Responses API request path, dynamic registration and refresh-token rotation, as OpenAI documents it for open-source, locally run apps. Whether OpenAI counts Konjugate among those apps (it is also distributed through app stores) is still to be confirmed with OpenAI before it is announced.
4. **Detection and vendor-tool providers**, with the Claude Code bridge built behind a switch that stays off until Anthropic answers, and the Copilot provider once GitHub's terms are confirmed.
5. **Installing vendor tools** from the settings page, for the tools whose vendors have said yes.
6. **Hugging Face sign-in**, after the token is shown to work for inference.

## Questions to settle before the stages that need them

- **Anthropic (stage 4):** may a free, open-source desktop app run a person's own, unmodified Claude Code, signed in with their own subscription through Anthropic's flow, as the model behind one of its features, and install Claude Code for them with its official installer? Does Konjugate need to accept Anthropic's Commercial Terms to do so? This needs a written answer, sought by the maintainer.
- **OpenAI (stage 3):** is Konjugate an eligible open-source app for ChatGPT plan usage, given it is also distributed through app stores? What do the *token reference* and *profiles and sessions* pages say about token lifetimes and refresh?
- **GitHub (stage 4):** do the Copilot product terms allow an app to run the Copilot CLI or SDK for a person with their own sign-in?

## Sources

Checked on 2026-11-27 and 2026-11-28.

- Anthropic: [Legal and compliance (Claude Code)](https://code.claude.com/docs/en/legal-and-compliance), [Authentication](https://code.claude.com/docs/en/authentication), [Setup](https://code.claude.com/docs/en/setup), [CLI reference](https://code.claude.com/docs/en/cli-reference), [Headless mode](https://code.claude.com/docs/en/headless), [Consumer terms](https://www.anthropic.com/legal/consumer-terms)
- WinBuzzer, [Anthropic bans Claude subscription OAuth in third-party apps](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/) (press report)
- OpenAI: [Sign in with ChatGPT quickstart](https://developers.openai.com/siwc/quickstart), [ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source), [Sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [Codex app server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), [Request a client ID](https://developers.openai.com/siwc/request-client-id), [Codex repository](https://github.com/openai/codex)
- GitHub: [Copilot CLI repository](https://github.com/github/copilot-cli) and [licence](https://github.com/github/copilot-cli/blob/main/LICENSE.md), [Authenticate Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli), [Run the CLI programmatically](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically), [Programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)
- Google: [Gemini CLI repository](https://github.com/google-gemini/gemini-cli), [Gemini CLI terms and privacy](https://www.geminicli.com/docs/resources/tos-privacy), [Quota and pricing](https://www.geminicli.com/docs/resources/quota-and-pricing), [Gemini API: authentication with OAuth](https://ai.google.dev/gemini-api/docs/oauth)
- OpenRouter: [OAuth](https://openrouter.ai/docs/guides/overview/auth/oauth)
- Hugging Face: [OAuth](https://huggingface.co/docs/hub/oauth), and the forum thread [How to access Inference API using connected developer app](https://discuss.huggingface.co/t/how-to-access-inference-api-using-connected-developer-app/138626)
