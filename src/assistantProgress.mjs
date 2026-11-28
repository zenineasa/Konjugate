/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What the assistant panel says while a request is under way, from the progress snapshot the provider
// registry publishes. Plain data in, plain strings out; nothing here is HTML, because the text can
// include what the model wrote.

const slowStartSeconds = 15;

// `attemptElapsedSeconds` is how long the current attempt has been going; the wait for a first reply is
// judged by that, not by the whole request, so a repair attempt does not start out "still waiting".
// Elapsed time as a person reads it: seconds under a minute, then minutes and seconds (1:52).
export function formatElapsed(seconds) {
    const whole = Math.max(0, Math.floor(seconds));
    return whole < 60 ? `${whole} s` : `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

// `fixingProblems`: the request is the model fixing the problems the engine found in its last proposal (repairReason says which).
export function describeAssistantProgress(progress, elapsedSeconds, attemptElapsedSeconds = elapsedSeconds) {
    const { attempt = 1, attempts = 1, phase = 'sending', outputCharacters = 0, thinking = '', repairReason = '', fixingProblems = false } = progress ?? {};
    const retry = attempt > 1 ? `Attempt ${attempt} of ${attempts}: ` : '';
    let headline;
    if (phase === 'validating') headline = 'Checking the proposal…';
    else if (outputCharacters > 0) headline = fixingProblems ? 'The model is fixing the proposal…' : 'The model is writing the proposal…';
    else if (thinking) headline = 'The model is thinking…';
    else headline = 'Waiting for the model…';
    const lines = [];
    if (fixingProblems && repairReason) lines.push(`The engine found problems in the last proposal, so the model was asked to fix them: ${repairReason}`);
    else if (attempt > 1 && repairReason) lines.push(`The previous proposal was rejected, so the model was asked again: ${repairReason}`);
    // A hosted model can queue a request for a while before it sends its first word; without a word on that,
    // a long silence looks like a hang.
    if (phase !== 'validating' && !outputCharacters && !thinking && attemptElapsedSeconds >= slowStartSeconds) {
        lines.push('Still waiting for the first reply. Hosted models can take a while to start, especially when busy. The request is stopped only if nothing arrives for the timeout set in this model\'s configuration.');
    }
    return { headline: `${retry}${headline} · ${formatElapsed(elapsedSeconds)}`, notes: lines };
}
