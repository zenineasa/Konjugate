/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createVendorToolProviders, createVendorToolRunner, parsePlanUsage } from '../src/aiVendorTools.mjs';

const schema = { oneOf: [{ type: 'object', additionalProperties: false, properties: { proposalVersion: { const: 1 } } }] };
const proposal = { responseKind: 'proposal', proposalVersion: 1, operations: [{ kind: 'addNode', ref: 'newNode', name: 'New node' }] };
const input = (overrides = {}) => ({ configuration: { provider: 'x', model: 'default' }, context: { nodes: [], edges: [] }, request: 'Add a node', ...overrides });

// Fake vendor tools: Node scripts that answer as the real tools do (shapes captured from Claude Code 2.1.332 and Copilot CLI
// 1.0.117), chosen by FAKE_MODE, and write what they were given to FAKE_LOG.
const fakeClaude = `
const fs = require('fs');
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, 'utf8');
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ args, stdin, cwd: process.cwd(), configDirectory: process.env.CLAUDE_CONFIG_DIR ?? null }));
const mode = process.env.FAKE_MODE;
const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
// With CLAUDE_CONFIG_DIR, a sign-in of its own, kept in that folder; without, the terminal's (signed in unless FAKE_MODE says not).
const own = process.env.CLAUDE_CONFIG_DIR ? require('path').join(process.env.CLAUDE_CONFIG_DIR, 'signedIn') : null;
if (args[0] === 'auth' && args[1] === 'login') { if (own) fs.writeFileSync(own, 'x'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'logout') { if (own) fs.rmSync(own, { force: true }); process.exit(0); }
if (args[0] === '-p' && args[1] === '/usage') {
    say({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, total_cost_usd: 0, local_command: 'usage',
        result: 'You are currently using your subscription to power your Claude Code usage\\n\\nCurrent session: 16% used · resets Nov 28 at 11:50pm (Asia/Calcutta)\\nCurrent week (all models): 59% used · resets Dec 2 at 3:30am (Asia/Calcutta)\\n\\nLast 24h · 12 requests' });
    process.exit(0);
}
if (args[0] === 'auth') {
    if (mode === 'signedOut' || (own && !fs.existsSync(own))) { say({ loggedIn: false, authMethod: 'none' }); process.exit(1); }
    say({ loggedIn: true, authMethod: 'claude.ai', email: 'person@example.com', subscriptionType: 'pro', planTier: 'pro' });
    process.exit(0);
}
say({ type: 'system', subtype: 'init', tools: ['StructuredOutput'], model: 'claude-opus-5-5' });
if (mode === 'signedOut' || (own && !fs.existsSync(own))) {
    say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }, error: 'authentication_failed' });
    say({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' });
    process.exit(1);
}
const text = ${JSON.stringify(JSON.stringify(proposal))};
say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Planning.' } } });
say({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: text.slice(0, 9) } } });
say({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: text.slice(9) } } });
say({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { response: JSON.parse(text) } });
`;
const fakeCopilot = `
const fs = require('fs');
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, 'utf8');
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ args, stdin, cwd: process.cwd() }));
const mode = process.env.FAKE_MODE;
const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
if (mode === 'signedOut') {
    process.stderr.write('Error: No authentication information found.\\n');
    say({ type: 'result', exitCode: 1 });
    process.exit(1);
}
const text = ${JSON.stringify(JSON.stringify(proposal))};
say({ type: 'assistant.message_delta', data: { deltaContent: text.slice(0, 10) } });
say({ type: 'assistant.message_delta', data: { deltaContent: text.slice(10) } });
say({ type: 'assistant.message', data: { content: text } });
say({ type: 'result', exitCode: 0 });
`;

async function withFakes(task) {
    const root = await mkdtemp(join(tmpdir(), 'konjugate-vendor-'));
    const bin = join(root, 'bin');
    await mkdir(bin);
    for (const [name, body] of [['claude', fakeClaude], ['copilot', fakeCopilot]]) {
        await writeFile(join(bin, name), `#!${process.execPath}\n${body}`);
        await chmod(join(bin, name), 0o755);
    }
    const log = join(root, 'log.json');
    const env = (mode = 'ok') => ({ PATH: bin, FAKE_MODE: mode, FAKE_LOG: log });
    try {
        await task({ root, bin, env, logged: async () => JSON.parse(await readFile(log, 'utf8')) });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

const providersFor = (env, home, claudeConfigDirectory = null) => createVendorToolProviders({
    operationSchema: schema, claudeConfigDirectory,
    runner: createVendorToolRunner({ env, home, platform: 'linux' })
});

const unixOnly = { skip: process.platform === 'win32' && 'The fake tools are shell scripts' };

test('The person\'s own Claude Code and Copilot CLI are both offered', unixOnly, () => withFakes(async ({ env, root }) => {
    assert.deepEqual(providersFor(env(), root).map((provider) => provider.id), ['claudeCode', 'copilotCli']);
}));

test('A vendor tool is found where its installer puts it, and Claude Code says who is signed in', unixOnly, () => withFakes(async ({ env, root }) => {
    const [claude, copilot] = providersFor(env(), root);
    assert.deepEqual(await claude.detect(), { installed: true, signedIn: true, account: 'person@example.com', plan: 'pro' });
    assert.deepEqual(await copilot.detect(), { installed: true, signedIn: null });
    const [signedOut] = providersFor(env('signedOut'), root);
    assert.deepEqual(await signedOut.detect(), { installed: true, signedIn: false, account: '', plan: '' });
    // Not on the PATH, but in ~/.local/bin, where Claude Code's own installer puts it.
    const home = join(root, 'home');
    await mkdir(join(home, '.local'), { recursive: true });
    const { symlink } = await import('node:fs/promises');
    await symlink(join(root, 'bin'), join(home, '.local', 'bin'));
    const [fromHome] = providersFor({ ...env(), PATH: '/nonexistent' }, home);
    assert.equal((await fromHome.detect()).installed, true);
    const [missing] = providersFor({ ...env(), PATH: '/nonexistent' }, join(root, 'nobody'));
    assert.deepEqual(await missing.detect(), { installed: false });
    await assert.rejects(missing.generateProposal(input()), { code: 'toolNotInstalled' });
}));

test('Claude Code runs in print mode with no tools, the schema, the person\'s customisations off, in an empty folder', unixOnly, () => withFakes(async ({ env, root, logged }) => {
    const [claude] = providersFor(env(), root);
    const events = [];
    assert.deepEqual(await claude.generateProposal(input({ onEvent: (event) => events.push(event) })), proposal);
    const { args, stdin, cwd } = await logged();
    assert.equal(args[0], '-p');
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.ok(args.includes('--safe-mode'));
    assert.equal(args.includes('--bare'), false, '--bare would drop the sign-in.');
    // A tool's input must be an object, so the choice of shapes sits in `response`.
    assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]), { type: 'object', additionalProperties: false, required: ['response'], properties: { response: { anyOf: schema.oneOf } } });
    assert.equal(args.includes('--model'), false, 'The default model is Claude Code\'s own choice.');
    assert.match(stdin, /USER REQUEST:\nAdd a node/);
    assert.match(cwd, /konjugate-assistant-/);
    assert.deepEqual(events.filter((event) => event.type === 'thinking').map((event) => event.text), ['Planning.']);
    assert.equal(events.filter((event) => event.type === 'output').map((event) => event.text).join(''), JSON.stringify(proposal));
    await claude.generateProposal(input({ configuration: { provider: 'claudeCode', model: 'opus' } }));
    const chosen = (await logged()).args;
    assert.equal(chosen[chosen.indexOf('--model') + 1], 'opus');
}));

test('A Claude Code that is not signed in says how to sign in', unixOnly, () => withFakes(async ({ env, root }) => {
    const [claude] = providersFor(env('signedOut'), root);
    await assert.rejects(claude.generateProposal(input()), (error) => error.code === 'toolNotSignedIn' && /claude auth login/.test(error.message));
    await assert.rejects(claude.testConnection(), { code: 'toolNotSignedIn' });
}));

test('The Copilot CLI gets the prompt on standard input, with no tools and no custom instructions, and its streamed reply is read', unixOnly, () => withFakes(async ({ env, root, logged }) => {
    const [, copilot] = providersFor(env(), root);
    const events = [];
    assert.deepEqual(await copilot.generateProposal(input({ onEvent: (event) => events.push(event) })), proposal);
    const { args, stdin } = await logged();
    assert.equal(args.includes('-p'), false, 'Piped input is ignored when -p is given.');
    for (const flag of ['-s', '--output-format=json', '--available-tools=', '--no-ask-user', '--no-custom-instructions', '--disable-builtin-mcps']) assert.ok(args.includes(flag), flag);
    assert.match(stdin, /Konjugate modelling assistant[\s\S]*USER REQUEST:\nAdd a node/);
    assert.equal(events.filter((event) => event.type === 'output').map((event) => event.text).join(''), JSON.stringify(proposal));
    const [, signedOut] = providersFor(env('signedOut'), root);
    await assert.rejects(signedOut.generateProposal(input()), (error) => error.code === 'toolNotSignedIn' && /copilot login/.test(error.message));
}));

test('Cancelling a vendor tool ends its process', unixOnly, () => withFakes(async ({ bin, root }) => {
    await writeFile(join(bin, 'copilot'), `#!${process.execPath}\nsetInterval(() => {}, 1000);`);
    const [, copilot] = providersFor({ PATH: bin }, root);
    const controller = new AbortController();
    const pending = copilot.generateProposal(input({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, { name: 'AbortError' });
}));

// A runner that records what it is asked to run and answers as told, for the installers and sign-ins.
const recordingRunner = ({ platform = 'linux', code = 0, lines = [], found = '/home/person/.local/bin/copilot' } = {}) => {
    const runs = [];
    return {
        runs, platform, home: '/home/person',
        find: async () => found,
        run: async (command, args, options = {}) => {
            runs.push({ command, args, extraEnv: options.extraEnv ?? {} });
            for (const line of lines) options.onLine?.(line);
            return { code, stdout: '', stderr: code ? 'Error: could not write to the folder' : '' };
        }
    };
};

test('Installing a tool runs its vendor\'s own published installer into the person\'s own folders', async () => {
    const runner = recordingRunner({ lines: ['Installing GitHub Copilot CLI...', '✓ GitHub Copilot CLI installed'] });
    const [claude, copilot] = createVendorToolProviders({ runner, operationSchema: schema });
    const heard = [];
    assert.equal(await copilot.install({ onOutput: (line) => heard.push(line) }), true);
    assert.deepEqual(runner.runs[0], { command: '/bin/bash', args: ['-c', 'curl -fsSL https://gh.io/copilot-install | bash'], extraEnv: { PREFIX: '/home/person/.local' } });
    assert.deepEqual(heard, ['Installing GitHub Copilot CLI...', '✓ GitHub Copilot CLI installed']);
    await claude.install({});
    assert.deepEqual(runner.runs[1].args, ['-c', 'curl -fsSL https://claude.ai/install.sh | bash']);
    const windows = recordingRunner({ platform: 'win32' });
    const [, copilotOnWindows] = createVendorToolProviders({ runner: windows, operationSchema: schema });
    await copilotOnWindows.install({});
    assert.equal(windows.runs[0].command, 'winget');
    assert.ok(windows.runs[0].args.includes('GitHub.Copilot'));
    const failing = recordingRunner({ code: 1 });
    const [, copilotFailing] = createVendorToolProviders({ runner: failing, operationSchema: schema });
    await assert.rejects(copilotFailing.install({}), (error) => error.code === 'installFailed' && /could not write/.test(error.message));
});

test('Signing in with a tool runs the tool\'s own sign-in and passes on what it prints', async () => {
    const runner = recordingRunner({ lines: ['Open https://github.com/login/device and enter ABCD-1234'] });
    const [claude, copilot] = createVendorToolProviders({ runner, operationSchema: schema });
    const heard = [];
    await copilot.signInWithTool({ onOutput: (line) => heard.push(line) });
    assert.deepEqual(runner.runs[0].args, ['login', '--web-flow']);
    assert.deepEqual(heard, ['Open https://github.com/login/device and enter ABCD-1234']);
    await claude.signInWithTool({});
    assert.deepEqual(runner.runs[1].args, ['auth', 'login']);
    const notInstalled = recordingRunner({ found: null });
    const [, missing] = createVendorToolProviders({ runner: notInstalled, operationSchema: schema });
    await assert.rejects(missing.signInWithTool({}), { code: 'toolNotInstalled' });
});

test('Konjugate\'s Claude Code is signed in on its own, in its own folder, apart from the terminal\'s, and signs out and in again there', unixOnly, () => withFakes(async ({ env, root, logged }) => {
    const folder = join(root, 'konjugate', 'claudeCode');
    const [claude] = providersFor(env(), root, folder);
    assert.equal(claude.ownSignIn, true);
    // The terminal's Claude Code is signed in; Konjugate's is not yet, and says who the terminal's is.
    assert.deepEqual(await claude.detect(), { installed: true, signedIn: false, account: '', plan: '', elsewhere: 'person@example.com' });
    await assert.rejects(claude.generateProposal(input()), (error) => error.code === 'toolNotSignedIn' && /Settings › Model assistant/.test(error.message));
    await claude.signInWithTool({});
    assert.equal((await logged()).configDirectory, folder, 'The sign-in was not Konjugate\'s own.');
    assert.deepEqual(await claude.detect(), { installed: true, signedIn: true, account: 'person@example.com', plan: 'pro' });
    await claude.generateProposal(input());
    assert.equal((await logged()).configDirectory, folder, 'A request did not run as Konjugate\'s Claude Code.');
    await claude.signOutOfTool();
    assert.equal((await logged()).configDirectory, folder);
    assert.equal((await claude.detect()).signedIn, false);
    // Without a folder of its own, it is the terminal's Claude Code, as before.
    const [terminal] = providersFor(env(), root);
    await terminal.generateProposal(input());
    assert.equal((await logged()).configDirectory, null);
}));

test('The plan\'s session and weekly limits come from Claude Code\'s own /usage, which asks the model nothing', unixOnly, () => withFakes(async ({ env, root, logged }) => {
    const folder = join(root, 'claudeCode');
    const [claude] = providersFor(env(), root, folder);
    assert.deepEqual(await claude.planUsage(), { windows: [
        { kind: 'session', label: 'Session (5 h)', percent: 16, resets: 'Nov 28 at 11:50pm (Asia/Calcutta)' },
        { kind: 'week', label: 'Week', percent: 59, resets: 'Dec 2 at 3:30am (Asia/Calcutta)' }
    ] });
    const { args, configDirectory, cwd } = await logged();
    assert.deepEqual(args, ['-p', '/usage', '--output-format', 'json']);
    assert.equal(configDirectory, folder);
    assert.match(cwd, /konjugate-assistant-/);
}));

test('Reading the plan\'s limits keeps each limit it recognises, with a model-specific week named, and nothing else', () => {
    assert.deepEqual(parsePlanUsage('Current session: 100% used\nCurrent week (Sonnet only): 7.5% used · resets Dec 2 at 3:30am\nSomething else: 3% used'), { windows: [
        { kind: 'session', label: 'Session (5 h)', percent: 100, resets: '' },
        { kind: 'week', label: 'Week, Sonnet only', percent: 7.5, resets: 'Dec 2 at 3:30am' }
    ] });
    assert.equal(parsePlanUsage('You are using an API key.'), null);
    assert.equal(parsePlanUsage(undefined), null);
});
