<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Model assistant guide

## Overview

Konjugate's model assistant converts a natural-language request into a structured proposal for changing the active model. A proposal can add, update or remove nodes, state variables, source terms, edges, parameters and equations.

The assistant does not edit the model immediately. Konjugate validates the proposal, shows its assumptions and proposed changes, then waits for the user to apply or discard it. Applying a proposal creates one undoable model transaction.

## Model configurations

The selector below the assistant prompt chooses the active model configuration. The adjacent configuration button opens the model manager.

The manager provides:

- a searchable list of saved configurations;
- a protected built-in demonstration configuration;
- local and hosted provider settings;
- model discovery before saving;
- connection testing;
- custom model identifiers;
- configurable request timeouts;
- seamless editing and deletion.

Selecting a saved configuration in the assistant panel makes it active. Saving a configuration from the manager also selects it.

## Ollama

Ollama runs models locally. Konjugate uses `http://127.0.0.1:11434` as its default Ollama endpoint.

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
- Google Gemini.

Create an API key through the chosen provider, enter it in the configuration manager, discover or enter a model and test the connection before saving.

Provider documentation:

- [OpenAI API](https://platform.openai.com/docs/overview)
- [NVIDIA NIM APIs](https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html)
- [Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers/index)
- [Gemini API](https://ai.google.dev/gemini-api/docs)

Provider availability, model identifiers, account requirements and pricing are controlled by the provider and may change independently of Konjugate.

## Credentials and privacy

API keys are handled by Electron's main process. Saved keys are encrypted through the operating system's secure-storage facility and are not returned by renderer-facing configuration APIs. Konjugate refuses to persist a key when the available Linux storage backend would keep it as plain text.

A key entered while discovering models or testing a draft configuration remains transient. It is persisted only when **Save configuration** is selected. Leaving the key field blank while editing a saved configuration preserves and securely reuses the existing key.

When an online provider is selected, the request and a summary of the active model are sent to that provider. Users should not send confidential model information to a service they are not authorised to use. Ollama remains local when its endpoint points to localhost; changing it to a remote endpoint changes that privacy boundary.

Remote endpoints must use HTTPS. Plain HTTP is accepted only for loopback addresses such as `127.0.0.1` and `localhost`.

## Proposal lifecycle

The assistant workflow is:

1. Konjugate prepares a compact summary of the current model.
2. The provider generates a versioned operation proposal.
3. Konjugate validates the proposal structure.
4. Correctable output errors are returned to the provider for a bounded number of repair attempts.
5. Konjugate prepares the resulting model without modifying the active document.
6. The native validator checks the prepared model.
7. The user reviews the summary, assumptions and individual changes.
8. The user applies or discards the proposal.

Invalid intermediate proposals are never applied. Authentication failures, connection failures and timeouts remain visible because repeating the same request cannot normally correct them.

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

### Ollama is not reachable

Confirm that Ollama is installed and running, then test `http://127.0.0.1:11434`. If another endpoint is configured, verify its address and transport security.

### The request timed out

Increase the configuration timeout or choose a faster model. Local models may take longer on their first request while loading into memory.

### The proposal could not be repaired

Try a more capable model or divide the request into smaller changes. State units, values, intended node roles and connection direction explicitly.

### A hosted provider rejects the request

Check the API key, endpoint, model identifier, provider account access and quota. Use model discovery when the provider supports it.

### The desired model is not listed

Select **Custom model ID…** and enter the provider's model identifier manually.
