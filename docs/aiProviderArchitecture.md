---
type: Architecture
title: Model assistant provider architecture
description: Design and security model for local (Ollama) and hosted (OpenAI, Gemini, NIM, HuggingFace) model providers.
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
| Gemini | Gemini models and `generateContent` APIs |

Ollama uses portable JSON mode because its structured-output schema converter does not accept every construct in Konjugate's Draft 2020-12 operation schema. The complete schema remains in the prompt and the host remains the validation authority.

**What each provider's documentation says, and what the adapters do about it** (checked against the providers' own pages in October 2026):

- **OpenAI.** Schema mode (`response_format: json_schema`) is documented to need the schema's root to be an object and not `anyOf`; the operation schema's root is a `oneOf` of two shapes, and the documentation does not say what `strict: false` does with that. So the adapter asks for schema mode first and, if OpenAI answers HTTP 400 about the schema or `response_format`, asks again once in plain JSON mode. The host validates against the full schema either way.
- **NVIDIA.** The documentation supports `response_format: json_object` and streaming, and recommends `nvext.guided_json` for schema-constrained output. The adapter uses plain JSON mode and does not send `nvext`.
- **Hugging Face.** The chat-completion API takes `json_object` or `json_schema` and streams server-sent events with a bearer token; which of those a given model's provider honours varies. The adapter uses plain JSON mode.
- **Gemini.** The key goes in `x-goog-api-key` (which is what the adapter sends), and `streamGenerateContent?alt=sse` streams. Google has been retiring standard API keys for the Gemini API: unrestricted ones are rejected, with an HTTP 401 whose text talks about OAuth, and new keys made in Google AI Studio are the kind it accepts. A 401 from Gemini therefore carries a hint to create a new key. Reasoning summaries come from `generationConfig.thinkingConfig.includeThoughts`; the adapter does not send it, because models without thinking support can refuse the field, so Gemini shows no reasoning.
- **Ollama.** `/api/chat` streams newline-delimited JSON by default, takes `format: "json"`, and puts reasoning in `message.thinking` only when the `think` option is enabled. The adapter does not send `think`, for the same reason, so reasoning appears only for models that produce it by default.

### Main-process boundary

`src/main.mjs` owns configuration resolution, credentials, timeouts, provider calls and active-request cancellation. The preload exposes narrow IPC methods rather than raw network or credential access.

Provider errors are converted into structured IPC results before reaching the renderer. Intentional cancellation is kept distinct from a deadline timeout.

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

The renderer keeps a bounded window of the last five exchanges, each a compact `{ request, outcome }` summary rather than the full proposal JSON, and sends it with every `generateProposal` call as `history`. Adapters fold it in however suits their API: `openAICompatibleProvider` expands it into real alternating `user`/`assistant` messages ahead of the current turn; `ollamaProvider` and `geminiProvider`, which only ever send one text blob, prepend a `CONVERSATION SO FAR:` block instead. The local demonstration provider, having no real language understanding, only ever falls back to history when the plain request alone can't be resolved (an ambiguous target, a missing value, an unrecognized shape) — trying the request exactly as typed first keeps an unrelated, already self-sufficient new request from being derailed by an earlier turn's own numbers or names.

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

## Testing

Provider adapters use mocked fetch implementations in `tests/aiRemoteProviders.test.mjs`. Registry dispatch, validation, repair and redaction are covered in `tests/aiProviderRegistry.test.mjs`. Secure configuration behavior is covered in `tests/aiConfigurationStore.test.mjs`. The Electron interaction suite verifies configuration management and proposal review across the IPC boundary.

The mocked tests cannot show that a provider's real behaviour still matches them. `KONJUGATE_AI_KEY=... node scripts/checkAIProvider.mjs <provider> <model>` sends one request through the same registry and adapter code to the real service and reports what it saw: whether the request was accepted, whether the reply streamed, whether the provider sent reasoning, how many attempts it took, and whether the proposal passed validation. The key comes from the environment, never an argument, and is never printed.

## Evaluating a model

`node scripts/evalAssistant.mjs <provider> <model>` scores a provider on the assistant's actual job, through the same registry and adapters as the app, and is how a model, a prompt change or a fine-tune is compared with another. The cases, assertions, reference answers, error-direction report, request pools and commands are specified in [Model assistant evaluation harness](assistantEvaluation.md), and the plan that motivates it is in [An embedded model for the assistant](proposals/embeddedAssistantModel.md).
