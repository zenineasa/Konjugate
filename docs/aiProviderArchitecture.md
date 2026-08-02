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

### Main-process boundary

`src/main.mjs` owns configuration resolution, credentials, timeouts, provider calls and active-request cancellation. The preload exposes narrow IPC methods rather than raw network or credential access.

Provider errors are converted into structured IPC results before reaching the renderer. Intentional cancellation is kept distinct from a deadline timeout.

### Renderer

The renderer selects configurations, collects draft fields and displays proposals. It receives public configuration metadata and proposal data only. It never receives a persisted API key.

The renderer prepares a proposed document in memory, invokes the native validator and enables **Apply changes** only after validation succeeds.

## Proposal contract

The canonical contract is `schemas/assistantOperations.schema.json`. A proposal has a version, optional summary and assumptions, and an ordered list of operations.

```json
{
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

Temporary references are lower-camel-case identifiers used by later operations in the same proposal. References to existing entities use their UUIDs exactly. Operation ordering is significant.

Supported operation families include:

- adding nodes, states, source terms, edges and parameters;
- assigning edge equations;
- updating existing nodes, states, edges and parameters;
- removing entities.

The schema describes transport structure. `src/assistantOperations.mjs` performs semantic preparation and checks ownership, references, symbols, values, shapes, directionality and equations.

## Automatic repair

Provider output is untrusted. When a proposal is malformed or fails structural validation, the registry can send the provider:

- the original user request;
- the unchanged model context;
- the rejected proposal when it could be parsed;
- the precise validation error.

The provider must return a complete replacement proposal, not a patch or explanation. Repair attempts are bounded to prevent unending requests, unexpected cost and repeated low-quality output.

Network errors, authentication errors, insecure endpoints and timeouts are not repaired by the model. They require an environmental or configuration change.

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
    async generateProposal({ configuration, credential, context, request, repair, signal }) {}
}
```

Provider identifiers use lower camel case. Adapters should honour the supplied abort signal, avoid logging credentials, bound error content and return plain serialisable data.

`generateProposal` must return a parsed proposal object. It should request JSON output through the strongest portable capability offered by the provider. Host validation remains mandatory even when a provider claims strict structured output.

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
5. No proposal mutates the active model before host and native validation.
6. The user explicitly approves the final proposal.
7. Cancellation and timeouts release request state.
8. Draft testing does not persist configuration fields or credentials.

## Testing

Provider adapters use mocked fetch implementations in `tests/aiRemoteProviders.test.mjs`. Registry dispatch, validation, repair and redaction are covered in `tests/aiProviderRegistry.test.mjs`. Secure configuration behavior is covered in `tests/aiConfigurationStore.test.mjs`. The Electron interaction suite verifies configuration management and proposal review across the IPC boundary.
