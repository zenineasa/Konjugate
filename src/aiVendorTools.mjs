/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The model a person already has through a vendor's own tool (docs/proposals/assistantSignIn.md): their Claude subscription
// through Claude Code, or their GitHub Copilot subscription through the Copilot CLI. Konjugate runs the tool as it is, signed
// in by the vendor's own flow, and never sees a token: it finds the tool, asks it who is signed in, and runs it in print mode
// with no tools, in an empty folder, with the person's own customisations left out, so all it can produce is the proposal.
//
// Claude Code is registered only when KONJUGATE_EXPERIMENTAL_CLAUDE_CODE=1: Anthropic's terms are unclear about an app using a
// person's Claude Code as the model behind one of its features, and the proposal waits for Anthropic's written answer
// before offering it to anyone.

import { spawn as spawnProcess } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { AssistantProviderError } from './assistantProviders.mjs';
import { claudeOutputSchema, parseProposalText, proposalPrompt, historyText } from './aiRemoteProviders.mjs';

const maximumOutputCharacters = 2_000_000;
const maximumStderrCharacters = 4000;

// Where each tool's installers put it, besides the PATH: an app opened from the Finder or the Dock has a short PATH.
function candidateFolders({ platform, home, env }) {
    const fromPath = String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
    if (platform === 'win32') {
        const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
        const roaming = env.APPDATA ?? join(home, 'AppData', 'Roaming');
        return [...fromPath, join(home, '.local', 'bin'), join(local, 'Programs', 'claude'), join(roaming, 'npm'), join(local, 'Microsoft', 'WinGet', 'Links')];
    }
    return [...fromPath, join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.npm-global', 'bin'), join(home, '.volta', 'bin'), '/usr/bin'];
}

export function createVendorToolRunner({ spawn = spawnProcess, platform = process.platform, home = homedir(), env = process.env } = {}) {
    const names = (tool) => (platform === 'win32' ? [`${tool}.exe`, `${tool}.cmd`] : [tool]);
    return Object.freeze({
        // The tool's executable, or null when it is not installed where its installers put it.
        async find(tool) {
            for (const folder of [...new Set(candidateFolders({ platform, home, env }))]) {
                for (const name of names(tool)) {
                    const path = join(folder, name);
                    try {
                        await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
                        return path;
                    } catch { /* not here */ }
                }
            }
            return null;
        },
        // Runs it, giving `stdin`, telling `onLine` each line of its output as it comes, and resolving to { code, stdout, stderr }
        // (stdout only when there is no `onLine`). Ended by `signal` or after `timeoutMilliseconds`.
        run(path, args, { stdin = '', cwd, onLine, signal, timeoutMilliseconds = 30_000 } = {}) {
            return new Promise((resolve, reject) => {
                if (signal?.aborted) { reject(new DOMException('The request was cancelled.', 'AbortError')); return; }
                // A .cmd needs a shell on Windows; every argument here is Konjugate's own, never the person's text.
                const child = spawn(path, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: platform === 'win32' && path.endsWith('.cmd') });
                let stdout = '';
                let stderr = '';
                let pending = '';
                let ended = null;
                const stop = (reason) => { ended ??= reason; child.kill(); };
                const onAbort = () => stop('cancelled');
                signal?.addEventListener('abort', onAbort, { once: true });
                const timer = setTimeout(() => stop('timedOut'), timeoutMilliseconds);
                child.stdout.setEncoding('utf8');
                child.stdout.on('data', (chunk) => {
                    if (!onLine) { stdout += chunk; return; }
                    pending += chunk;
                    let newline;
                    while ((newline = pending.indexOf('\n')) >= 0) {
                        const line = pending.slice(0, newline).replace(/\r$/, '');
                        pending = pending.slice(newline + 1);
                        try { onLine(line); } catch (error) { ended ??= error; child.kill(); }
                    }
                });
                child.stderr.setEncoding('utf8');
                child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-maximumStderrCharacters); });
                child.on('error', (error) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error); });
                child.on('close', (code) => {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', onAbort);
                    if (onLine && pending.trim() && !ended) {
                        try { onLine(pending); } catch (error) { ended = error; }
                    }
                    if (ended === 'cancelled') reject(new DOMException('The request was cancelled.', 'AbortError'));
                    else if (ended === 'timedOut') reject(new AssistantProviderError('The tool did not finish in time.', 'requestTimedOut'));
                    else if (ended instanceof Error) reject(ended);
                    else resolve({ code, stdout, stderr });
                });
                child.stdin.on('error', () => { /* a tool that exits without reading its input */ });
                child.stdin.end(stdin);
            });
        }
    });
}

const lastLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).at(-1)?.slice(0, 300) ?? '';
const instructions = 'You are the Konjugate modelling assistant. Return only JSON matching the supplied schema -- either a proposal or, if the request is ambiguous or missing information, a clarification.';

// An empty folder of its own for each run, so the tool reads no project and writes nowhere that matters.
async function inEmptyFolder(task) {
    const folder = await mkdtemp(join(tmpdir(), 'konjugate-assistant-'));
    try { return await task(folder); } finally { await rm(folder, { recursive: true, force: true }).catch(() => {}); }
}

function claudeCodeProvider({ runner }) {
    const notInstalled = () => new AssistantProviderError('Claude Code is not installed on this computer.', 'toolNotInstalled');
    const notSignedIn = () => new AssistantProviderError('Claude Code is not signed in. Open a terminal, run “claude auth login”, then try again.', 'toolNotSignedIn');
    const executable = async () => (await runner.find('claude')) ?? Promise.reject(notInstalled());
    return {
        id: 'claudeCode', name: 'Claude (through Claude Code)', defaultEndpoint: '', defaultTimeoutSeconds: 180,
        credentialRequired: false, locality: 'online', vendorTool: 'claude',
        // Who is signed in, from Claude Code itself (`claude auth status`, JSON, exit 1 when signed out). Reads no file.
        async detect() {
            const path = await runner.find('claude');
            if (!path) return { installed: false };
            try {
                const { code, stdout } = await runner.run(path, ['auth', 'status'], { timeoutMilliseconds: 15_000 });
                const status = JSON.parse(stdout);
                const signedIn = code === 0 && status.loggedIn === true && status.authMethod !== 'none';
                return { installed: true, signedIn, account: signedIn ? String(status.email ?? '') : '', plan: signedIn ? String(status.subscriptionType ?? status.planTier ?? '') : '' };
            } catch {
                return { installed: true, signedIn: null };
            }
        },
        // Claude Code's own model names; "default" leaves the choice to Claude Code and the plan.
        async listModels() {
            await executable();
            return [
                { id: 'default', name: 'Default for your plan' },
                { id: 'opus', name: 'Claude Opus' },
                { id: 'sonnet', name: 'Claude Sonnet' },
                { id: 'haiku', name: 'Claude Haiku' }
            ];
        },
        suggestModel: () => 'default',
        async testConnection() {
            const status = await this.detect();
            if (!status.installed) throw notInstalled();
            if (status.signedIn === false) throw notSignedIn();
            return { connected: true, provider: 'claudeCode', modelCount: 4 };
        },
        async generateProposal({ configuration, context, request, history, repair, signal, operationSchema, onEvent }) {
            const path = await executable();
            const args = [
                '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
                // No tools: Claude Code then has only its StructuredOutput tool, which the JSON schema needs, and a few turns for it.
                '--tools', '', '--json-schema', JSON.stringify(claudeOutputSchema(operationSchema)), '--max-turns', '4',
                '--system-prompt', instructions,
                // The person's own CLAUDE.md, hooks, skills, plugins and MCP servers stay out; the sign-in stays in (which --bare would drop).
                '--safe-mode',
                ...(configuration.model && configuration.model !== 'default' ? ['--model', configuration.model] : [])
            ];
            let output = '';
            let result = null;
            let failure = '';
            const onLine = (line) => {
                if (!line.trim()) return;
                let event;
                try { event = JSON.parse(line); } catch { return; }
                if (event.type === 'stream_event') {
                    const delta = event.event?.type === 'content_block_delta' ? event.event.delta : null;
                    const text = delta?.type === 'text_delta' ? delta.text : delta?.type === 'input_json_delta' ? delta.partial_json : '';
                    if (text) {
                        output += text;
                        if (output.length > maximumOutputCharacters) throw new AssistantProviderError('The AI provider response is too large.', 'responseTooLarge');
                        onEvent?.({ type: 'output', text });
                    } else if (delta?.type === 'thinking_delta' && delta.thinking) {
                        onEvent?.({ type: 'thinking', text: delta.thinking });
                    } else onEvent?.({ type: 'activity' });
                } else if (event.type === 'assistant' && event.error) {
                    failure = event.error;
                } else if (event.type === 'result') {
                    result = event;
                } else onEvent?.({ type: 'activity' });
            };
            const { code, stderr } = await inEmptyFolder((cwd) => runner.run(path, args, {
                cwd, signal, onLine, stdin: historyText(history) + proposalPrompt(operationSchema, context, request, repair), timeoutMilliseconds: 20 * 60_000
            }));
            if (failure === 'authentication_failed') throw notSignedIn();
            if (!result) throw new AssistantProviderError(`Claude Code stopped without an answer${lastLine(stderr) ? `: ${lastLine(stderr)}` : ` (exit code ${code})`}.`, 'providerHttpError');
            if (result.is_error || result.subtype !== 'success') {
                const said = typeof result.result === 'string' ? result.result : (result.errors ?? []).join(' ');
                throw new AssistantProviderError(`Claude Code could not answer: ${String(said || result.subtype).slice(0, 300)}`, 'providerHttpError');
            }
            // The schema-checked answer when Claude Code gives one; its text otherwise. The host validates either way.
            return parseProposalText(result.structured_output != null ? JSON.stringify(result.structured_output) : result.result);
        }
    };
}

function copilotProvider({ runner }) {
    const notInstalled = () => new AssistantProviderError('The GitHub Copilot CLI is not installed on this computer.', 'toolNotInstalled');
    const notSignedIn = () => new AssistantProviderError('GitHub Copilot is not signed in. Open a terminal, run “copilot login”, then try again.', 'toolNotSignedIn');
    const executable = async () => (await runner.find('copilot')) ?? Promise.reject(notInstalled());
    return {
        id: 'copilotCli', name: 'GitHub Copilot', defaultEndpoint: '', defaultTimeoutSeconds: 180,
        credentialRequired: false, locality: 'online', vendorTool: 'copilot',
        // The Copilot CLI has no status command and keeps its login in the system's credential store, which Konjugate does not
        // read; whether it is signed in shows when it is first used.
        async detect() {
            const path = await runner.find('copilot');
            if (!path) return { installed: false };
            return { installed: true, signedIn: null };
        },
        async listModels() {
            await executable();
            return [{ id: 'default', name: 'Copilot’s default' }];
        },
        suggestModel: () => 'default',
        async testConnection() {
            await executable();
            return { connected: true, provider: 'copilotCli', modelCount: 1 };
        },
        async generateProposal({ configuration, context, request, history, repair, signal, operationSchema, onEvent }) {
            const path = await executable();
            // The prompt goes in on standard input (piped input is ignored when -p is given), which also keeps it off the command line.
            const args = [
                '-s', '--output-format=json', '--stream', 'on', '--available-tools=', '--no-ask-user', '--no-auto-update',
                '--no-custom-instructions', '--disable-builtin-mcps',
                ...(configuration.model && configuration.model !== 'default' ? [`--model=${configuration.model}`] : [])
            ];
            let streamed = '';
            let finalMessage = '';
            let failure = '';
            let result = null;
            const onLine = (line) => {
                if (!line.trim()) return;
                let event;
                try { event = JSON.parse(line); } catch { return; }
                const data = event.data ?? {};
                if (event.type === 'assistant.message_delta' && typeof data.deltaContent === 'string') {
                    streamed += data.deltaContent;
                    if (streamed.length > maximumOutputCharacters) throw new AssistantProviderError('The AI provider response is too large.', 'responseTooLarge');
                    onEvent?.({ type: 'output', text: data.deltaContent });
                } else if (event.type === 'assistant.reasoning_delta' && typeof data.deltaContent === 'string') {
                    onEvent?.({ type: 'thinking', text: data.deltaContent });
                } else if (event.type === 'assistant.message' && typeof data.content === 'string' && data.content.trim()) {
                    finalMessage = data.content;
                } else if (event.type === 'session.error' || event.type === 'error') {
                    failure = String(data.message ?? event.message ?? 'error');
                } else if (event.type === 'result') {
                    result = event;
                } else onEvent?.({ type: 'activity' });
            };
            const prompt = `${instructions}\n\n${historyText(history)}${proposalPrompt(operationSchema, context, request, repair)}`;
            const { code, stderr } = await inEmptyFolder((cwd) => runner.run(path, args, { cwd, signal, onLine, stdin: prompt, timeoutMilliseconds: 20 * 60_000 }));
            if (/no authentication information|not (?:logged|signed) in|authenticate/i.test(`${stderr} ${failure}`)) throw notSignedIn();
            const exitCode = result?.exitCode ?? code;
            if (exitCode !== 0) {
                const said = failure || lastLine(stderr);
                throw new AssistantProviderError(`GitHub Copilot could not answer${said ? `: ${said}` : ` (exit code ${exitCode})`}.`, 'providerHttpError');
            }
            return parseProposalText(finalMessage || streamed);
        }
    };
}

// The vendor-tool providers this installation offers: Copilot always, Claude Code only with the experimental switch.
export function createVendorToolProviders({ runner = createVendorToolRunner(), env = process.env, operationSchema } = {}) {
    if (!operationSchema) throw new Error('Vendor tool providers require an operation schema.');
    return [
        ...(env.KONJUGATE_EXPERIMENTAL_CLAUDE_CODE === '1' ? [claudeCodeProvider({ runner })] : []),
        copilotProvider({ runner })
    ].map((provider) => Object.freeze({ ...provider, generateProposal: (input) => provider.generateProposal({ ...input, operationSchema }) }));
}
