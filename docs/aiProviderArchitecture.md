---
type: Architecture
title: Model assistant provider architecture
description: Design and security model for local (Ollama) and hosted (OpenAI, Anthropic, Gemini, NIM, HuggingFace, OpenRouter) model providers, and signing in to a provider in the browser.
tags: [assistant, architecture, security, credentials]
status: stable
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Model assistant provider architecture

## Design goals

The provider architecture separates model access from model mutation. Providers generate declarative proposals; Konjugate owns credentials, validation, preview, application and undo history.

The design aims to provide:

- interchangeable local and hosted providers;
- no provider-specific code in the renderer;
- no renderer access to persisted credentials;
- a stable, versioned proposal contract;
- deterministic host-side validation;
- bounded automatic repair;
- explicit user approval before mutation.

## Components

### Configuration store

`src/aiConfigurationStore.mjs` stores versioned provider configurations separately from credentials. Public configuration records indicate whether a credential exists but never contain the credential or its internal storage identifier.

Saved credentials are encrypted using Electron `safeStorage`. Draft resolution can combine unsaved fields with an existing stored credential without persisting the draft. This enables discovery and connection testing before Save.

### Provider registry

`src/aiProviderRegistry.mjs` presents one interface over every provider. It publishes safe descriptors and dispatches model discovery, connection testing and proposal generation.

The registry also:

- rejects unknown providers;
- limits proposal size;
- validates proposal structure;
- redacts credentials from propagated errors;
- performs bounded repairs for malformed or structurally invalid output.

### Provider adapters

`src/aiRemoteProviders.mjs` contains the built-in remote and local-service adapters:

| Provider | Protocol |
| --- | --- |
| Ollama | Ollama `/api/tags` and `/api/chat` |
| OpenAI | OpenAI models and chat-completions APIs |
| NVIDIA | OpenAI-compatible NVIDIA NIM endpoints |
| Hugging Face | OpenAI-compatible Inference Providers router |
| ChatGPT | ChatGPT plan usage: OAuth sign-in, then the Responses API with the person's plan |
| OpenRouter | OpenAI-compatible chat completions; models from `/v1/models/user`; OAuth sign-in |
| Anthropic | Messages API and Models API, through Anthropic's SDK (`@anthropic-ai/sdk`) |
| GitHub Copilot | The person's own Copilot CLI, run in print mode (`src/aiVendorTools.mjs`) |
| Claude Code | The person's own Claude Code, run in print mode (`src/aiVendorTools.mjs`) |
| Gemini | Gemini models and `generateContent` APIs |

Ollama uses portable JSON mode because its structured-output schema converter does not accept every construct in Konjugate's Draft 2020-12 operation schema. The complete schema remains in the prompt and the host remains the validation authority.

**What each provider's documentation says, and what the adapters do about it** (checked against the providers' own pages in October 2026):

- **OpenAI.** Schema mode (`response_format: json_schema`) is documented to need the schema's root to be an object and not `anyOf`; the operation schema's root is a `oneOf` of two shapes, and the documentation does not say what `strict: false` does with that. So the adapter asks for schema mode first and, if OpenAI answers HTTP 400 about the schema or `response_format`, asks again once in plain JSON mode. The host validates against the full schema either way.
- **NVIDIA.** The documentation supports `response_format: json_object` and streaming, and recommends `nvext.guided_json` for schema-constrained output. The adapter uses plain JSON mode and does not send `nvext`.
- **Hugging Face.** The chat-completion API takes `json_object` or `json_schema` and streams server-sent events with a bearer token; which of those a given model's provider honours varies. The adapter uses plain JSON mode.
- **Gemini.** The key goes in `x-goog-api-key` (which is what the adapter sends), and `streamGenerateContent?alt=sse` streams. Google has been retiring standard API keys for the Gemini API: unrestricted ones are rejected, with an HTTP 401 whose text talks about OAuth, and new keys made in Google AI Studio are the kind it accepts. A 401 from Gemini therefore carries a hint to create a new key. Reasoning summaries come from `generationConfig.thinkingConfig.includeThoughts`; the adapter does not send it, because models without thinking support can refuse the field, so Gemini shows no reasoning.
- **Ollama.** `/api/chat` streams newline-delimited JSON by default, takes `format: "json"`, and puts reasoning in `message.thinking` only when the `think` option is enabled. The adapter sends `think` only when a configuration sets it (**Reasoning** in Settings, `think` in the configuration: true, false, or unset for the model's own default), since a model that cannot reason may refuse the field. Its descriptor says `reasoningSetting: true`, which is what shows the setting.

- **OpenRouter.** Its API is OpenAI-compatible, so it is the same adapter as NVIDIA's and Hugging Face's, in plain JSON mode (structured output is supported per serving endpoint, not per model). The models listed are `/v1/models/user`, those the key may use after the account's own guardrails and privacy settings. Every request carries `HTTP-Referer` (the project's repository) and `X-OpenRouter-Title: Konjugate`, which name Konjugate on the person's activity page and change nothing about the request.

- **Anthropic.** The adapter uses Anthropic's own SDK, constructed for each call with the configuration's key, endpoint and the adapters' shared `fetch` (so the tests' mocked fetch serves it too); a key passed in is the only credential the SDK uses, and it does not read `ANTHROPIC_API_KEY` or a local sign-in. It streams `messages.stream` and turns `text_delta` and `thinking_delta` events into the panel's output and thinking, and every other event into activity, which keeps the silence timeout from firing while the model thinks. Proposals are asked for with structured outputs (`output_config.format`, `json_schema`), using a copy of the operation schema reduced to what structured outputs accept (`claudeOutputSchema`: `oneOf` as `anyOf`, no string, number or array limits, no patterns); if the API answers HTTP 400 about the format, it asks again without it. No `thinking` setting is sent, since models differ in which they accept: each model's default is used, and current models think without showing it, so the panel shows no reasoning. `max_tokens` is 32,000, room for the model's thinking, billed only as used. A `refusal` stop is reported as `providerRefused`, not repaired. The SDK's errors are converted: a cancel stays an `AbortError`, an HTTP error keeps its status, a failed connection is `connectionFailed`.
- **Key pages.** A provider's descriptor can name `keyPage`, where its keys are made, and `keyPageLabel` (by default "Get a key from …"). The configuration's page shows it under **API key**, and `aiOpenKeyPage` opens only the address in that provider's own descriptor, and only an `https:` one. Gemini's is Google AI Studio, whose keys are free and have a free tier.

### Signing in to a provider

A provider can offer signing in, in the person's own browser, instead of a pasted key ([proposal](proposals/assistantSignIn.md)). Its descriptor then says `signIn: true`, with `signInDescription` for the settings page, and the adapter supplies `signIn({ openExternal, signal })`, resolving to `{ credential }`, and `suggestModel(models)`, the model a new sign-in starts with.

`src/aiOAuth.mjs` holds what every flow shares. `loopbackAuthorization` makes a PKCE verifier and S256 challenge and a random `state`, listens on this computer's loopback address on a port the system chooses (for a redirect to `localhost`, on both `127.0.0.1` and `::1`, since a browser may resolve the name to either), opens the provider's page with `openExternal`, and waits for the browser to come back to `/callback`. Anything else is answered 404; a callback with a different `state` is answered 400 and ignored, since another page on the computer could send one; a callback with no `state` is accepted only where the provider sets `requireState: false`, which is safe only where the code is useless without the verifier, which never leaves the main process. A refusal (`error=access_denied`) ends it as `signInDenied`; Cancel, or the window closing, aborts it; five minutes without an answer ends it as `signInTimedOut`. The listener is closed however it ends. The browser is always the person's own, never a window of the app's, so the provider's page is the only thing that sees their password.

OpenRouter's flow sends the browser to `https://openrouter.ai/auth` with the challenge, `state` and `key_label=Konjugate`, and exchanges the code and verifier at `POST /api/v1/auth/keys` for an ordinary key on the person's account. Its documentation names `localhost` callbacks, so that is the redirect host, and it returns `state` when the person allows access, but is not relied on to (`requireState: false`): the PKCE exchange is what binds the code to this sign-in.

ChatGPT plan usage (`chatGpt`, `signInOnly`, so it is not offered for a typed key) follows OpenAI's documentation for open-source, locally run apps. The first sign-in sends `client_id=dynamic_agent_client`, the installation's host id (`ext_agent_host_id`, a `urn:uuid:` made once by the configuration store's `hostIdentifier()` and kept in its file) and `agent_name_hint=Konjugate`, to `https://auth.openai.com/api/accounts/authorize`, with the redirect on `127.0.0.1` at `/auth/callback` (OpenAI's documentation rules out `localhost`), scopes `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, `resource=https://api.openai.com/v1`, a nonce and PKCE. The listener takes port 1455, the port in OpenAI's own example, when it is free, and any free port otherwise. The callback names the client OpenAI issued (`client_id`, `oaiapp_…`); it is kept at once in the configuration store (`registeredClient`, apart from any configuration), so that a sign-in whose exchange fails, or a configuration deleted, does not lose it: OpenAI's documentation says to retain the issued client and start a fresh authorization with it rather than register again. A later first sign-in from this computer uses it (without `agent_name_hint`); one OpenAI refuses as `invalid_client` is forgotten, so the next sign-in registers again. The code is exchanged, form-encoded, at `/api/accounts/oauth/token` for that client; a refusal is reported with OpenAI's own `error_description`. The ID token is checked for issuer, audience (the issued client) and nonce; its signature is not checked, since it came straight from the token endpoint over TLS, which OpenID Connect accepts in its place. A grant without `chatgpt.tokens.use.direct` is refused (`planUsageNotAllowed`) and nothing is kept. The credential is one JSON string (`kind: 'chatGptSignIn'`: the issued client, host id, `sub`, email, ID token, access and refresh tokens, expiry, scope), stored encrypted like a key; the email is the configuration's `account`. **Sign in again** sends the issued client and the ID token as `id_token_hint`, without registering again.

An access token lasts an hour. Before a request, an adapter whose token expires within a minute refreshes it (`grant_type=refresh_token`), one refresh per refresh token at a time, since OpenAI replaces the refresh token on each use, and returns the renewed credential through `onCredential`, which the main process saves over the configuration's with the store's `replaceCredential`. A refresh refused as ended (`invalid_grant`, `refresh_token_reused` and the others OpenAI lists) asks the person to sign in again (`signInExpired`). Requests go to `POST /v1/responses` with `store: false` and `stream: true`, `instructions` and the history and request as `input`, and a `text.format` JSON schema; whether plan usage accepts that format is not documented, so a refusal of it (HTTP 400, or `subscription_sharing_unsupported_capability`) is answered by asking again without it. The stream is read through to `response.completed`; one that ends without it is an error. OpenAI's own error codes are explained: the plan's limit (`planLimitReached`, linking to the usage page), a plan or workspace that cannot be used (`planNotEligible`), plan checks unavailable for now, and an ended sign-in. Models are `GET /v1/models`, those with `visibility: "list"` in OpenAI's order, the first being the one a sign-in starts with. Deleting a signed-in configuration calls the provider's `signOut` first (for ChatGPT, revoking the refresh token at the `revocation_endpoint` OpenAI publishes, used only if it is on `auth.openai.com`), within ten seconds and as best it can; the configuration is removed either way.

Hugging Face sign-in is built but offered only once Konjugate's own Hugging Face OAuth app exists: `huggingFaceClientId` in `src/aiRemoteProviders.mjs` (or `KONJUGATE_HUGGING_FACE_CLIENT_ID`) is empty until then, and the provider then has no `signIn`. The app is to be registered at huggingface.co/settings/applications/new as a public app (no secret) with the redirect `http://127.0.0.1/callback`; Hugging Face accepts any port on a registered loopback redirect. The flow asks for `openid profile inference-api` with PKCE at `/oauth/authorize`, exchanges the code (form-encoded, with the verifier and no secret) at `/oauth/token`, refuses a grant without `inference-api`, keeps the access token as the configuration's key (the router takes it as a bearer token the same way), and shows `preferred_username` from the ID token. Hugging Face documents neither how long such a token lasts nor how it is renewed, so an ended sign-in is refused at its next request and the person signs in again. Whether the router accepts these tokens for chat completions is to be confirmed with a real sign-in before the client id is filled in.

The main process's `aiSignIn` runs one sign-in at a time. The credential is saved like a typed key, in the configuration an earlier sign-in to that provider made (keeping its name, model and timeout) or a new one named after the provider, with `credentialSource: 'signIn'` so the settings page can say it is signed in; a key typed on the configuration's page later clears that mark. A new configuration starts with the provider's suggested model from its model list (asked with a 30-second limit; a list that does not come leaves the model to be chosen), and the configuration is put in use. The renderer is told only the saved public configuration. `aiCancelSignIn` aborts the sign-in its own window started.

### The vendors' own tools

`src/aiVendorTools.mjs` offers a model a person already has through a vendor's own command-line tool ([proposal](proposals/assistantSignIn.md)). Its providers have `vendorTool` set (`'copilot'`, `'claude'`), no endpoint and no credential: the tool signs in by itself, and Konjugate never handles a token. `createVendorToolRunner` finds a tool on the PATH and in its installers' folders (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, npm's and Volta's folders, and on Windows the user's `Programs`, npm and WinGet folders), and runs it with its prompt on standard input, reading its output a line at a time, ended by the request's cancel or a time limit. Each request runs in a new empty temporary folder, removed afterwards. The registry's `detectTools()` asks each tool's `detect()` and the main process's `aiDetectTools` gives the result to **Use a model you have**.

- **GitHub Copilot CLI** (`copilotCli`), always offered when installed. It has no status command and keeps its login in the system's credential store, which Konjugate does not read, so whether it is signed in shows on first use. A request runs `copilot -s --output-format=json --stream on --available-tools= --no-ask-user --no-auto-update --no-custom-instructions --disable-builtin-mcps` (and `--model=` when one is chosen) with the instructions, history and prompt on standard input (`-p` would ignore piped input, and would put the prompt on the command line). The JSONL is read as GitHub's Copilot SDK documents its events: `assistant.message_delta` (`data.deltaContent`) as output, `assistant.reasoning_delta` as thinking, `assistant.message` (`data.content`) as the whole reply, and the final `result` line's `exitCode`. A signed-out run was observed (Copilot CLI 1.0.117): "No authentication information found" on standard error and `{"type":"result","exitCode":1}`; it is reported as `toolNotSignedIn`, with `copilot login` to run. A signed-in run's events have not been observed here (no Copilot subscription to run one with) and are read as documented.
- **Claude Code** (`claudeCode`), always offered when installed: the person's own, unmodified Claude Code, signed in by its own login, as Orchestrator and similar apps host it. Anthropic's terms allow a platform to host it; whether they allow an app to use it as the model behind one of its features is unclear, and the maintainer chose to offer it (see the [proposal](proposals/assistantSignIn.md)). `detect()` runs `claude auth status` (JSON, exit code 1 when signed out: `loggedIn`, `authMethod`, `email`, `subscriptionType`, `planTier`, `loginExpiresAt`, as seen with Claude Code 2.1.332). A request runs `claude -p --output-format stream-json --verbose --include-partial-messages --tools "" --json-schema <claudeCodeSchema> --max-turns 4 --system-prompt <instructions> --safe-mode` (and `--model` unless the configuration says `default`) with the prompt on standard input. With no tools, Claude Code's only tool is `StructuredOutput`, which the JSON schema uses, so a few turns are allowed for it; `--safe-mode` leaves out the person's CLAUDE.md, hooks, skills, plugins and MCP servers while keeping the sign-in, which `--bare` would drop. Two things about the schema were found by running it for real (Claude Code 2.1.332): Claude Code checks `--json-schema` strictly and refuses draft 2020-12's `prefixItems`, so `claudeOutputSchema` turns a tuple into an array of its item types; and it gives the schema to the API as the input of its `StructuredOutput` tool, which must be an object, so `claudeCodeSchema` puts the proposal-or-clarification choice in a `response` property, unwrapped again from the answer. `stream_event` deltas (`text_delta`, `input_json_delta`, `thinking_delta`) are shown as they come; the `result` line's `structured_output.response` (or its `result` text) is the proposal. A real run with a Pro plan's default model answered a small request in about five seconds with a proposal that passed validation. A signed-out run (observed: an `assistant` line with `error: "authentication_failed"`, then a `result` with `is_error: true`, exit code 1) is reported as `toolNotSignedIn`, with `claude auth login` to run.

Installing and signing in. A vendor-tool provider can supply `installer(platform)` (`{ command, args, source, extraEnv }`, or null where Konjugate cannot install it), `installNotice`, `install({ signal, onOutput })` and `signInWithTool({ signal, onOutput })`. Installing runs the vendor's own published installer as published, so the tool stays the vendor's own, unmodified and updated by the vendor: for the Copilot CLI, `curl -fsSL https://gh.io/copilot-install | bash` with `PREFIX=~/.local` (GitHub's script installs into `$PREFIX/bin`, and only offers to edit a shell profile when it can read from a terminal, which a child process cannot), or `winget install --id GitHub.Copilot` on Windows; for Claude Code, `curl -fsSL https://claude.ai/install.sh | bash` or `irm https://claude.ai/install.ps1 | iex`, both into `~/.local`. Neither needs administrator rights, and both put the tool where `createVendorToolRunner` looks. The main process's `aiInstallTool` first shows a native dialog naming the tool, what will happen and the installer's source, and runs nothing unless the person presses **Install**; `aiSignInWithTool` runs the tool's own sign-in (`copilot login --web-flow`, `claude auth login`), which opens the vendor's page in the browser. Both run one at a time, within ten and five minutes, send every line the tool prints to the window (`aiToolProgress`, so a sign-in's link or code is never skipped), can be stopped (`aiCancelToolTask`, or the window closing), and look for the tools again afterwards. Whether each tool's sign-in completes from a process with no terminal has not been tried here; the row says it can also be done from a terminal.

### Running a model on this computer

`src/localModels.mjs` is the main process's side of **Settings › Model assistant › Run a model on this computer** ([proposal](proposals/suggestedLocalModels.md)): whether Ollama is running (`/api/version`, `/api/tags`), pulling a model with progress (`/api/pull`, streamed, cancellable, one at a time per model), and finding GGUF models on Hugging Face that Ollama can pull (`/api/models?filter=gguf`, and a repository's `tree/main` for its files by quantization). It only asks an Ollama on this computer, never downloads Ollama, and stores no model itself. The suggested models, and the setup each was measured with, are data in `src/suggestedLocalModels.mjs`. The window reaches it through `window.localModels` (`src/preload.mjs`); pull progress is sent to every project window. The only pages it opens are Ollama's download page and a model's page on Hugging Face.

There is no built-in model. A new installation has no configuration, and the configuration store's version 2 moves a version 1 file forward without the demonstration configuration it used to start with. The tests drive the assistant through a fake Ollama server (`tests/fixtures/fakeOllama.mjs`), which answers by fixed rules (`tests/fixtures/demonstrationAssistant.mjs`) through the app's own Ollama provider.

### Main-process boundary

`src/main.mjs` owns configuration resolution, credentials, timeouts, provider calls and active-request cancellation. The preload exposes narrow IPC methods rather than raw network or credential access.

Provider errors are converted into structured IPC results before reaching the renderer. Intentional cancellation is kept distinct from a deadline timeout.

Every assistant failure the main process meets is also logged with `console.warn` as `[assistant] <what was being done>: <message> (<code>, HTTP <status>, <provider's code>)`, which prints it in the terminal and records it in the diagnostics panel. That covers generating a proposal, listing models, testing a connection, signing in and out, installing or signing in with a vendor tool, and the failures that are otherwise passed over on purpose (a model list that does not come after a sign-in, a sign-out at the provider that does not go through, a renewed sign-in that cannot be saved). Where an adapter keeps the provider's error response (ChatGPT's token endpoint does), it is logged as well, size-limited, since an error response carries no token. Only messages, codes and error responses are logged, with the configuration's key taken out wherever a provider repeated it; cancels are not logged. The settings page and the assistant panel also log the errors they show with `console.warn`, so they appear in the window's own developer console.

### Renderer

The renderer selects configurations, collects draft fields and displays proposals. It receives public configuration metadata and proposal data only. It never receives a persisted API key.

The renderer prepares a proposed document in memory, invokes the native validator and enables **Apply changes** only after validation succeeds.

## Proposal contract

The canonical contract is `schemas/assistantOperations.schema.json`, a top-level `oneOf` between two response shapes distinguished by `responseKind`. A proposal has a version, optional summary and assumptions, and an ordered list of operations.

```json
{
    "responseKind": "proposal",
    "proposalVersion": 1,
    "summary": "Add two thermal bodies and connect them.",
    "assumptions": [
        "Temperatures are represented in kelvin."
    ],
    "operations": [
        {
            "kind": "addNode",
            "ref": "hotBody",
            "name": "Hot body"
        }
    ]
}
```

Temporary references are lower-camel-case identifiers used by later operations in the same proposal. References to existing entities use their numeric IDs exactly. Operation ordering is significant.

Supported operation families include:

- adding nodes, states, source terms, edges and parameters;
- assigning edge equations;
- updating existing nodes, states, edges and parameters;
- removing entities.

The schema describes transport structure. `src/assistantOperations.mjs` performs semantic preparation and checks ownership, references, symbols, values, shapes, directionality and equations.

### Clarification contract

A provider that judges a request ambiguous or missing required information may return a clarification instead of a proposal:

```json
{
    "responseKind": "clarification",
    "question": "Which node should I update?",
    "suggestions": ["Battery module", "Enclosed air"]
}
```

`suggestions` is optional and capped at five short strings. A clarification carries no operations, so it never reaches `applyAssistantProposal` or native validation — the registry returns it to the renderer directly, which shows it and waits for the user's reply. The reply becomes a new request, sent together with the conversation history described below so the provider has the original request and its own question in context.

## Repair after the native validator

The registry's own repair (below) sees only what it can check itself. The renderer prepares the proposal and runs the native validator afterwards; when either rejects it, it asks once more, in the same request, with `generateProposal(…, repair)` (`{ error, proposal }`), which the main process passes to the registry as `initialRepair`: the first attempt then already carries the correction, and the progress says the model is fixing the proposal (`fixingProblems`). The error sent is the problems as the panel lists them, each naming the node or relationship it is about (for a relationship to a node with no states, the validator's own message names the node). Whatever comes back is prepared and validated again and shown as it is; there is no second round. A proposal the native validator could not check at all (no engine) is not sent back.

## A reference to an earlier proposal

`generateProposal(…, repair, reference)` takes an earlier proposal (`{ summary, assumptions, operations }`, at most 60,000 characters as JSON) the person asked the model to draw on (**Ask about this** in the panel). The main process appends it to the request, after the request's own 8,000-character check, as a `REFERENCE PROPOSAL` the model is told to adapt to the current model context: to refer to the entities the context has, by their own ids, to use temporary refs for anything new, and to copy no id the context does not have. A repair round sends the same reference again. The history keeps the turn's reference by its summary.

## Automatic repair

Provider output is untrusted. When a proposal is malformed or fails structural validation, the registry can send the provider:

- the original user request;
- the unchanged model context;
- the rejected proposal when it could be parsed;
- the precise validation error.

The provider must return a complete replacement proposal, not a patch or explanation. Repair attempts are bounded to prevent unending requests, unexpected cost and repeated low-quality output.

Only output the model itself got wrong is repaired: JSON that does not parse (`invalidProposalJson`), no text at all (`emptyProviderOutput`), or a proposal the validator rejects. Network errors, authentication errors, insecure endpoints, timeouts and malformed transport (a non-JSON HTTP body or stream, `invalidProviderResponse`) are not repaired by the model. They require an environmental or configuration change.

A clarification response is not repaired against the operation schema — it isn't an operation proposal to begin with, and asking again isn't a malformed-output condition. The registry returns it as soon as its own light shape check (a non-empty question, and string suggestions if present) passes.

## Streaming, progress and timeouts

Every adapter asks its provider to stream the reply (server-sent events for the OpenAI-compatible providers and Gemini, newline-delimited JSON for Ollama) and falls back to reading a plain JSON body when the server does not stream. `src/aiStreaming.mjs` reads the stream; each adapter reports what arrives through an `onEvent` callback as `{ type: 'thinking' | 'output' | 'activity', text }`. The adapter still returns one complete proposal, and the registry still validates it as a whole: streaming changes what can be seen and when a request is judged stuck, not what is accepted.

Reasoning is shown only where the provider sends it: `reasoning_content` or `reasoning` on OpenAI-compatible streams, `message.thinking` from Ollama, and parts marked `thought` from Gemini (which sends none unless asked, and Konjugate does not ask, because models without thinking support reject the option). The model's output, which is the proposal JSON as it is written, is always available.

The registry turns those events into a progress snapshot (attempt, stage, character count, and bounded tails of the reasoning and the output) and passes it to the optional `onProgress` callback. The main process sends the latest snapshot to the panel a few times a second over `aiProgress`; the panel shows it as plain text, never HTML.

A configuration's timeout is how long the model may stay silent, not how long a request may take. `src/aiRequestTiming.mjs` restarts that clock on every progress snapshot, including the start of each repair attempt, so a model that keeps producing output is never cut off by it and a repair does not share one deadline with the attempts before it. A fixed maximum of 20 minutes for the whole request still ends one that never finishes. The silence timeout reports `requestTimedOut` with a message that says which limit was reached.

## Conversation history

The renderer keeps a bounded window of the last five exchanges, each a compact `{ request, outcome }` summary rather than the full proposal JSON, and sends it with every `generateProposal` call as `history`. Adapters fold it in however suits their API: `openAICompatibleProvider` expands it into real alternating `user`/`assistant` messages ahead of the current turn; `ollamaProvider` and `geminiProvider`, which only ever send one text blob, prepend a `CONVERSATION SO FAR:` block instead.

## Adding a provider

A provider adapter supplies an identifier, display metadata and supported operations. A typical adapter has this shape:

```javascript
{
    id: 'exampleProvider',
    name: 'Example Provider',
    defaultEndpoint: 'https://api.example.com',
    defaultTimeoutSeconds: 60,
    credentialRequired: true,
    locality: 'online',
    async listModels({ configuration, credential, signal }) {},
    async testConnection({ configuration, credential, signal }) {},
    async generateProposal({ configuration, credential, context, request, history, repair, signal }) {}
}
```

Provider identifiers use lower camel case. Adapters should honour the supplied abort signal, avoid logging credentials, bound error content and return plain serialisable data.

`generateProposal` must return a parsed proposal object, or a clarification object (see above) when the request is ambiguous or underspecified. It should request JSON output through the strongest portable capability offered by the provider. Host validation remains mandatory even when a provider claims strict structured output.

Register the adapter through `createRemoteAIProviders`, then add tests covering:

- the default endpoint;
- authentication headers;
- discovery response conversion;
- generation request structure;
- malformed provider responses;
- missing credentials;
- insecure remote endpoints;
- cancellation and timeout behaviour;
- proposal repair.

## Security rules

Provider changes must preserve these invariants:

1. Persisted credentials never cross into renderer-visible configuration data.
2. Credentials are not written to logs, proposal errors or model context.
3. Remote endpoints require HTTPS; HTTP is restricted to loopback hosts.
4. Provider output is treated as untrusted data.
5. No proposal mutates the active model before host and native validation. A clarification response never reaches that path at all.
6. The user explicitly approves the final proposal.
7. Cancellation and timeouts release request state, and progress text is shown as text.
8. Draft testing does not persist configuration fields or credentials.
9. Signing in happens in the person's own browser, never a window of the app's; the loopback listener answers only its callback with the `state` it sent, and closes when the sign-in ends.

## Testing

Provider adapters use mocked fetch implementations in `tests/aiRemoteProviders.test.mjs`. Registry dispatch, validation, repair and redaction are covered in `tests/aiProviderRegistry.test.mjs`. Secure configuration behavior is covered in `tests/aiConfigurationStore.test.mjs`. The Electron interaction suite verifies configuration management and proposal review across the IPC boundary.

The mocked tests cannot show that a provider's real behaviour still matches them. `KONJUGATE_AI_KEY=... node scripts/checkAIProvider.mjs <provider> <model>` sends one request through the same registry and adapter code to the real service and reports what it saw: whether the request was accepted, whether the reply streamed, whether the provider sent reasoning, how many attempts it took, and whether the proposal passed validation. The key comes from the environment, never an argument, and is never printed.

## Evaluating a model

`node scripts/evalAssistant.mjs <provider> <model>` scores a provider on the assistant's actual job, through the same registry and adapters as the app, and is how a model, a prompt change or a fine-tune is compared with another. The cases, assertions, reference answers, error-direction report, request pools and commands are specified in [Model assistant evaluation harness](assistantEvaluation.md), and the plan that motivates it is in [An embedded model for the assistant](proposals/embeddedAssistantModel.md).
