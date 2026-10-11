/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What the assistant panel says while a request is under way, from the progress snapshot the provider
// registry publishes. Plain data in, plain strings out; nothing here is HTML, because the text can
// include what the model wrote.

export function describeAssistantProgress(progress, elapsedSeconds) {
    const { attempt = 1, attempts = 1, phase = 'sending', outputCharacters = 0, thinking = '', repairReason = '' } = progress ?? {};
    const retry = attempt > 1 ? `Attempt ${attempt} of ${attempts}: ` : '';
    let headline;
    if (phase === 'validating') headline = 'Checking the proposal…';
    else if (outputCharacters > 0) headline = `The model is writing the proposal… ${outputCharacters.toLocaleString('en-US')} characters`;
    else if (thinking) headline = 'The model is thinking…';
    else headline = 'Waiting for the model…';
    const lines = [];
    if (attempt > 1 && repairReason) lines.push(`The previous proposal was rejected, so the model was asked again: ${repairReason}`);
    return { headline: `${retry}${headline} (${Math.max(0, Math.floor(elapsedSeconds))} s)`, notes: lines };
}
