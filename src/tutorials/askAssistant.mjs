/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Ask the model assistant" (docs/proposals/tutorials.md), starting from the Thermal Management example: the assistant set up with a
// model (Ollama on the person's own computer, with a suggested model downloaded, or a cloud provider with their own key: only they can do
// that, so its skip opens the page and waits), a change asked for in plain words, its proposal read (each change listed, the whole checked
// by the engine before it is offered), and applied as one step that Undo takes back. Desktop only, as the assistant is.

export const askAssistantValues = Object.freeze({
    request: 'Add an ambient boundary at 298 K and connect it to the battery with a conductance of 15 W/K.',
    nodesBefore: 3
});
const values = askAssistantValues;

// A proposal applied (whatever it changed), or the model grown by one.
const applied = (document, ui) => ui.assistantApplied || (document?.nodes ?? []).length > values.nodesBefore;

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Ask the model assistant',
        text: 'The model assistant changes a model from a request in plain words. It never changes anything by itself: it proposes, the engine checks the proposal, and you read it and decide. Here you will ask it to add a part to this battery\'s model.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'open',
        title: 'Open the assistant',
        text: 'Press Model assistant in the title bar (the ✦).',
        target: '#assistantButton', skip: 'openAssistant',
        done: ({ document, ui }) => ui.assistantOpen || applied(document, ui)
    },
    {
        id: 'setUp',
        title: 'Give it a model to think with',
        text: 'The assistant needs a language model. If it says none is set up, press "Set up a model…". To keep everything on this computer, install Ollama (the page links to it), then Download the suggested model and press "Use it". Or add a cloud provider\'s configuration with your own key. Close Settings when one is in use.',
        target: (ui) => (ui.settingsOpen ? '#settingsClose' : '#assistantSetUpModel'), skip: 'openAssistantSetup',
        done: ({ document, ui }) => ui.assistantReady || applied(document, ui)
    },
    {
        id: 'ask',
        title: 'Ask for a change',
        text: `Type a request, as you would say it: "${values.request}" Then press Generate proposal. A local model takes a little while; the panel shows what it is doing.`,
        target: '#assistantPrompt', skip: 'askAssistant', request: values.request,
        done: ({ document, ui }) => ui.proposalReady || applied(document, ui)
    },
    {
        id: 'review',
        title: 'Read the proposal, and apply it',
        text: 'The proposal lists every change it would make, each one clickable to see where it goes, with any assumptions it made; it has already passed the engine\'s validation. If it is not what you meant, type more and press Revise proposal. When it is right, press Apply.',
        target: '#applyAssistantProposal', skip: 'applyAssistant', request: values.request,
        done: ({ document, ui }) => applied(document, ui)
    },
    {
        id: 'finish',
        title: 'You have asked the model assistant',
        text: 'Applied, the proposal is one step: Undo takes all of it back. When a request is ambiguous, the assistant asks a question with suggestions instead of guessing. Settings › Model assistant keeps several configurations, local or cloud, and which one is used; a local one sends nothing off this computer.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const askAssistant = Object.freeze({
    id: 'askAssistant',
    title: 'Ask the model assistant',
    summary: 'Set up the model assistant, ask it for a change in plain words, read its proposal and apply it.',
    minutes: 4,
    area: 'modelling',
    tags: ['assistant', 'AI', 'model assistant', 'language model', 'LLM', 'Ollama', 'local model', 'proposal', 'natural language', 'chat'],
    start: { from: 'example', example: 'thermalManagement.kjt' },
    editions: ['desktop'],
    steps
});
