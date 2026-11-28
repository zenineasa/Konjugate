/* Copyright © 2026 Zenin Easa Panthakkalakath */

// An assistant conversation as Markdown (docs/proposals/assistantHistory.md): a record of what was asked, what the model
// assumed and proposed, what came of it and when, with which model, for a report or a design review. From the conversation as
// the history keeps it (src/assistantHistory.mjs); plain data in, text out.

const outcomeLabels = {
    applied: 'Applied', proposed: 'Proposed, not applied', discarded: 'Discarded', rejected: 'Rejected', asked: 'The assistant asked',
    unanswered: 'Not answered', error: 'Failed', cancelled: 'Cancelled', pending: 'No outcome'
};

// Markdown that a request or a reply cannot break out of: a line starting like a heading or a list is kept as text.
const escapeLine = (line) => line.replace(/^(\s*)([#>*+-]|\d+\.)(\s)/, '$1\\$2$3');
const escapeText = (text) => String(text ?? '').split('\n').map(escapeLine).join('\n');
const inline = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// The outcome's own words without the prefix it was kept with ("Applied: …" says Applied already).
const outcomeText = (outcome) => inline(String(outcome?.text ?? '').replace(/^(Proposed|Applied|Discarded|Rejected|Asked|Error):\s*/, ''));

export function conversationMarkdown(conversation, { exportedAt = Date.now(), formatTime = (time) => new Date(time).toISOString().replace('T', ' ').slice(0, 16) } = {}) {
    const lines = [`# ${inline(conversation.title) || 'Conversation'}`, ''];
    lines.push(`A conversation with Konjugate's model assistant, exported ${formatTime(exportedAt)}.`);
    if (conversation.forkedFrom) lines.push(`Forked from “${inline(conversation.forkedFrom.title)}”.`);
    lines.push('');
    conversation.turns.forEach((turn, index) => {
        lines.push(`## ${index + 1}. ${inline(turn.request).slice(0, 120) || 'Request'}`, '');
        const model = [turn.model?.configuration, turn.model?.model && turn.model.model !== 'default' ? turn.model.model : ''].filter(Boolean).join(', ');
        lines.push(`*${[formatTime(turn.createdAt), turn.project?.title ? `project “${inline(turn.project.title)}”` : '', model].filter(Boolean).join(' · ')}*`, '');
        if (turn.request && inline(turn.request).length > 120) lines.push(escapeText(turn.request), '');
        if (turn.reference?.summary) lines.push(`About an earlier proposal: ${inline(turn.reference.summary)}`, '');
        const kind = turn.outcome?.kind ?? 'pending';
        const said = outcomeText(turn.outcome);
        lines.push(`**${outcomeLabels[kind] ?? 'Outcome'}**${said ? `: ${escapeText(said)}` : ''}`, '');
        const reply = turn.reply;
        if (reply?.responseKind === 'proposal') {
            const assumptions = (reply.assumptions ?? []).filter((item) => typeof item === 'string' && item.trim());
            if (assumptions.length) lines.push('Assumptions:', '', ...assumptions.map((item) => `- ${inline(item)}`), '');
            const count = Array.isArray(reply.operations) ? reply.operations.length : 0;
            lines.push(`The proposal had ${count} ${count === 1 ? 'operation' : 'operations'}.`, '');
        }
        if (turn.versions?.length > 1) {
            const chosen = (turn.version ?? 0) + 1;
            lines.push(`Regenerated: ${turn.versions.length} versions, version ${chosen} ${kind === 'applied' ? 'applied' : 'kept'}.`, '');
            turn.versions.forEach((version, at) => {
                const said = version.note ? ` (asked: “${inline(version.note)}”)` : '';
                lines.push(`${at + 1}. ${inline(version.reply?.summary) || 'A proposal'}${said}${at + 1 === chosen ? ' ← this one' : ''}`);
            });
            lines.push('');
        }
        if (turn.problems?.length) lines.push('Problems found:', '', ...turn.problems.map((item) => `- ${inline(item)}`), '');
        if (turn.before && turn.after) lines.push('The model was kept before and after this change.', '');
    });
    if (!conversation.turns.length) lines.push('No turns yet.', '');
    return `${lines.join('\n').trimEnd()}\n`;
}
