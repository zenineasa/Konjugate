/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { run, parseVersion, signPhrase, collectContributors, isExempt } = require('../.github/scripts/cla.cjs');

const CLA_TEXT = '# Title\n\nVersion: 1.0\n\nBody\n';
const OWNER = { id: 1, login: 'owner', type: 'User' };
const ALICE = { id: 2, login: 'alice', type: 'User' };
const BOB = { id: 3, login: 'bob', type: 'User' };

function notFound() {
    return Object.assign(new Error('Not Found'), { status: 404 });
}

// A just-enough fake of the GitHub client: one PR, one signatures branch held in memory.
function fakeGithub({ commits, prUser, files = {}, branchExists = true }) {
    const state = { files: { ...files }, branchExists, statuses: [], comments: [], writes: 0 };
    const github = {
        paginate: async (fn, args) => (fn === github.rest.pulls.listCommits ? commits : state.comments.filter(() => args)),
        rest: {
            pulls: {
                get: async () => ({ data: { user: prUser, head: { sha: 'headsha' } } }),
                listCommits: () => {}
            },
            repos: {
                getContent: async ({ path }) => {
                    if (!state.files[path]) {
                        throw notFound();
                    }
                    return {
                        data: { content: Buffer.from(state.files[path].content).toString('base64'), sha: state.files[path].sha }
                    };
                },
                createOrUpdateFileContents: async ({ path, content, sha }) => {
                    const current = state.files[path];
                    if (current && current.sha !== sha) {
                        throw Object.assign(new Error('conflict'), { status: 409 });
                    }
                    state.writes++;
                    state.files[path] = { content: Buffer.from(content, 'base64').toString('utf8'), sha: `sha${state.writes}` };
                    return {};
                },
                createCommitStatus: async (status) => state.statuses.push(status)
            },
            git: {
                getRef: async () => {
                    if (!state.branchExists) {
                        throw notFound();
                    }
                },
                createTree: async () => ({ data: { sha: 'tree' } }),
                createCommit: async () => ({ data: { sha: 'commit' } }),
                createRef: async () => {
                    state.branchExists = true;
                }
            },
            issues: {
                listComments: () => {},
                createComment: async ({ body }) => state.comments.push({ id: state.comments.length + 1, body }),
                updateComment: async ({ comment_id, body }) => {
                    state.comments.find((comment) => comment.id === comment_id).body = body;
                }
            }
        }
    };
    return { github, state };
}

function prContext(extra = {}) {
    return {
        repo: { owner: 'owner', repo: 'konjugate' },
        eventName: 'pull_request_target',
        payload: { repository: { default_branch: 'master' }, pull_request: { number: 7 }, ...extra }
    };
}

function commentContext(user, body) {
    return {
        repo: { owner: 'owner', repo: 'konjugate' },
        eventName: 'issue_comment',
        payload: {
            repository: { default_branch: 'master' },
            issue: { number: 7, pull_request: {} },
            comment: { body, user, created_at: '2026-01-01T00:00:00Z', html_url: 'https://example.test/c/1' }
        }
    };
}

test('parses the version and builds the signing phrase', () => {
    assert.equal(parseVersion(CLA_TEXT), '1.0');
    assert.equal(signPhrase('1.0'), 'I have read the Konjugate CLA v1.0 and I hereby sign it.');
    assert.throws(() => parseVersion('no version here'));
});

test('exempts the owner and bots only', () => {
    assert.equal(isExempt(OWNER, 'Owner'), true);
    assert.equal(isExempt({ id: 9, login: 'dependabot[bot]', type: 'Bot' }, 'owner'), true);
    assert.equal(isExempt(ALICE, 'owner'), false);
});

test('collects commit authors and the PR opener, and reports unlinked commits', () => {
    const { required, unlinkedCommits } = collectContributors(
        [{ sha: 'abcdef123', author: ALICE }, { sha: '1234567890', author: null }, { sha: 'ffffff1', author: OWNER }],
        BOB,
        'owner'
    );
    assert.deepEqual(required.map((user) => user.login).sort(), ['alice', 'bob']);
    assert.deepEqual(unlinkedCommits, ['1234567']);
});

test('an unsigned contributor fails the check and is prompted once', async () => {
    const { github, state } = fakeGithub({ commits: [{ sha: 'abcdef123', author: ALICE }], prUser: ALICE });
    await run({ github, context: prContext(), claText: CLA_TEXT });
    assert.equal(state.statuses.at(-1).state, 'failure');
    assert.equal(state.statuses.at(-1).context, 'CLA');
    assert.equal(state.comments.length, 1);
    assert.match(state.comments[0].body, /@alice/);
    await run({ github, context: prContext(), claText: CLA_TEXT });
    assert.equal(state.comments.length, 1);
});

test('signing records the signature and later runs pass', async () => {
    const { github, state } = fakeGithub({ commits: [{ sha: 'abcdef123', author: ALICE }], prUser: ALICE });
    await run({ github, context: prContext(), claText: CLA_TEXT });
    await run({ github, context: commentContext(ALICE, `  ${signPhrase('1.0')}\n`), claText: CLA_TEXT });
    assert.equal(state.statuses.at(-1).state, 'success');
    const record = JSON.parse(state.files['signatures/cla-v1.0.json'].content);
    assert.equal(record.claVersion, '1.0');
    assert.equal(record.signatures.length, 1);
    assert.equal(record.signatures[0].githubId, 2);
    assert.equal(record.signatures[0].claVersion, '1.0');
    assert.match(record.signatures[0].claSha256, /^[0-9a-f]{64}$/);
    assert.match(state.comments[0].body, /check passes/);

    await run({ github, context: prContext(), claText: CLA_TEXT });
    assert.equal(state.statuses.at(-1).state, 'success');
    assert.equal(state.writes, 1);
});

test('a signature for an older CLA version does not count for a newer one', async () => {
    const old = JSON.stringify({ signatures: [{ githubId: 2, githubLogin: 'alice', claVersion: '1.0' }] });
    const { github, state } = fakeGithub({
        commits: [{ sha: 'abcdef123', author: ALICE }],
        prUser: ALICE,
        files: { 'signatures/cla-v1.0.json': { content: old, sha: 'old' } }
    });
    await run({ github, context: prContext(), claText: CLA_TEXT });
    assert.equal(state.statuses.at(-1).state, 'success');
    await run({ github, context: prContext(), claText: CLA_TEXT.replace('1.0', '2.0') });
    assert.equal(state.statuses.at(-1).state, 'failure');
});

test('the owner and bots need no signature', async () => {
    const { github, state } = fakeGithub({
        commits: [{ sha: 'abcdef123', author: OWNER }, { sha: 'bbbbbbb1', author: { id: 9, login: 'x[bot]', type: 'Bot' } }],
        prUser: OWNER
    });
    await run({ github, context: prContext(), claText: CLA_TEXT });
    assert.equal(state.statuses.at(-1).state, 'success');
    assert.equal(state.comments.length, 0);
});

test('a commit not linked to a GitHub account fails even when everyone else signed', async () => {
    const { github, state } = fakeGithub({
        commits: [{ sha: 'abcdef123', author: ALICE }, { sha: '1234567890', author: null }],
        prUser: ALICE
    });
    await run({ github, context: commentContext(ALICE, signPhrase('1.0')), claText: CLA_TEXT });
    assert.equal(state.statuses.at(-1).state, 'failure');
    assert.match(state.comments[0].body, /not linked to a GitHub account/);
});

test('unrelated or wrong-version comments are ignored', async () => {
    const { github, state } = fakeGithub({ commits: [{ sha: 'abcdef123', author: ALICE }], prUser: ALICE });
    await run({ github, context: commentContext(ALICE, 'looks good'), claText: CLA_TEXT });
    await run({ github, context: commentContext(ALICE, signPhrase('0.9')), claText: CLA_TEXT });
    assert.equal(state.statuses.length, 0);
    assert.equal(state.writes, 0);
});

test('the signatures branch is created on first signature', async () => {
    const { github, state } = fakeGithub({
        commits: [{ sha: 'abcdef123', author: ALICE }],
        prUser: ALICE,
        branchExists: false
    });
    await run({ github, context: commentContext(ALICE, signPhrase('1.0')), claText: CLA_TEXT });
    assert.equal(state.branchExists, true);
    assert.equal(state.statuses.at(-1).state, 'success');
});
