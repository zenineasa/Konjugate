/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The logic behind .github/workflows/cla.yml, kept in a plain file (not inline in the workflow) so
// tests/cla.test.mjs can run it against a fake GitHub client. It only reads pull request metadata
// and never runs anything from a pull request, which is what makes it safe under
// `pull_request_target`, where the token can write.

const crypto = require('node:crypto');
const fs = require('node:fs');

const CLA_FILE = 'CLA.md';
const SIGNATURES_BRANCH = 'cla-signatures';
const STATUS_CONTEXT = 'CLA';
const COMMENT_MARKER = '<!-- konjugate-cla -->';
const WRITE_ATTEMPTS = 4;

function parseVersion(claText) {
    const match = /^Version:\s*(\S+)\s*$/m.exec(claText);
    if (!match) {
        throw new Error(`${CLA_FILE} has no "Version: x.y" line`);
    }
    return match[1];
}

function signPhrase(version) {
    return `I have read the Konjugate CLA v${version} and I hereby sign it.`;
}

function signaturesPath(version) {
    return `signatures/cla-v${version}.json`;
}

function isExempt(user, repoOwner) {
    return (
        user.type === 'Bot' ||
        user.login.endsWith('[bot]') ||
        user.login.toLowerCase() === repoOwner.toLowerCase()
    );
}

// Everyone whose work is in the pull request: each commit's author plus the PR's opener. A commit
// whose author email is not linked to a GitHub account has no `author`, so nobody can sign for it.
function collectContributors(commits, prAuthor, repoOwner) {
    const byId = new Map();
    const unlinkedCommits = [];
    for (const commit of commits) {
        if (!commit.author) {
            unlinkedCommits.push(commit.sha.slice(0, 7));
            continue;
        }
        byId.set(commit.author.id, commit.author);
    }
    byId.set(prAuthor.id, prAuthor);
    const required = [...byId.values()].filter((user) => !isExempt(user, repoOwner));
    return { required, unlinkedCommits };
}

function hasSigned(signatures, user, version) {
    return signatures.some((entry) => entry.githubId === user.id && entry.claVersion === version);
}

async function loadSignatures(github, owner, repo, path) {
    try {
        const { data } = await github.rest.repos.getContent({ owner, repo, path, ref: SIGNATURES_BRANCH });
        const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
        return { signatures: parsed.signatures ?? [], sha: data.sha };
    } catch (error) {
        if (error.status === 404) {
            return { signatures: [], sha: null };
        }
        throw error;
    }
}

// The signatures live on an orphan branch so they never need to go through master's branch
// protection and never appear in the project's history.
async function ensureSignaturesBranch(github, owner, repo) {
    try {
        await github.rest.git.getRef({ owner, repo, ref: `heads/${SIGNATURES_BRANCH}` });
        return;
    } catch (error) {
        if (error.status !== 404) {
            throw error;
        }
    }
    const { data: tree } = await github.rest.git.createTree({
        owner,
        repo,
        tree: [
            {
                path: 'README.md',
                mode: '100644',
                type: 'blob',
                content:
                    'Signed Konjugate CLA records, one signatures/cla-v<version>.json per CLA version.\n' +
                    'Written only by .github/workflows/cla.yml on the default branch; do not edit by hand.\n'
            }
        ]
    });
    const { data: commit } = await github.rest.git.createCommit({
        owner,
        repo,
        message: 'Start the CLA signatures branch',
        tree: tree.sha,
        parents: []
    });
    await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${SIGNATURES_BRANCH}`, sha: commit.sha });
}

async function recordSignature(github, owner, repo, version, entry) {
    const path = signaturesPath(version);
    await ensureSignaturesBranch(github, owner, repo);
    for (let attempt = 1; ; attempt++) {
        const { signatures, sha } = await loadSignatures(github, owner, repo, path);
        if (signatures.some((existing) => existing.githubId === entry.githubId)) {
            return;
        }
        const content = JSON.stringify({ claVersion: version, signatures: [...signatures, entry] }, null, 4) + '\n';
        try {
            await github.rest.repos.createOrUpdateFileContents({
                owner,
                repo,
                path,
                branch: SIGNATURES_BRANCH,
                message: `${entry.githubLogin} signed CLA v${version} on #${entry.pullRequest}`,
                content: Buffer.from(content).toString('base64'),
                ...(sha ? { sha } : {})
            });
            return;
        } catch (error) {
            // Two people signing at once: the other write moved the file's sha, so reload and retry.
            if ((error.status === 409 || error.status === 422) && attempt < WRITE_ATTEMPTS) {
                continue;
            }
            throw error;
        }
    }
}

function buildComment({ pending, unlinkedCommits, version, claUrl, passed }) {
    if (passed) {
        return `${COMMENT_MARKER}\nThe CLA check passes: everyone on this pull request has signed CLA v${version}.`;
    }
    const lines = [COMMENT_MARKER];
    if (pending.length > 0) {
        const names = pending.map((user) => `@${user.login}`).join(', ');
        lines.push(
            `Thank you for the contribution! ${names}: before this pull request can be merged, please read the [Konjugate Contributor Copyright Assignment Agreement (v${version})](${claUrl}) and, if you agree, sign it by posting the following as a comment on this pull request:`,
            '',
            '```',
            signPhrase(version),
            '```',
            '',
            'You only need to do this once; it covers your future pull requests too, until the CLA changes. If you have already signed and this still shows, comment `recheck`.'
        );
    }
    if (unlinkedCommits.length > 0) {
        lines.push(
            '',
            `Commit${unlinkedCommits.length > 1 ? 's' : ''} ${unlinkedCommits.join(', ')} ${unlinkedCommits.length > 1 ? 'were' : 'was'} authored with an email address that is not linked to a GitHub account, so the author cannot sign. Please add that email to your GitHub account (or re-author the commits with a linked one) and comment \`recheck\`.`
        );
    }
    return lines.join('\n');
}

async function upsertComment(github, owner, repo, issueNumber, body, createIfMissing) {
    const comments = await github.paginate(github.rest.issues.listComments, {
        owner,
        repo,
        issue_number: issueNumber
    });
    const existing = comments.find((comment) => comment.body?.includes(COMMENT_MARKER));
    if (existing) {
        if (existing.body !== body) {
            await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
        }
    } else if (createIfMissing) {
        await github.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
    }
}

async function run({ github, context, core, claText = fs.readFileSync(CLA_FILE, 'utf8') }) {
    const { owner, repo } = context.repo;
    const version = parseVersion(claText);
    const claHash = crypto.createHash('sha256').update(claText).digest('hex');
    const defaultBranch = context.payload.repository.default_branch;
    const claUrl = `https://github.com/${owner}/${repo}/blob/${defaultBranch}/${CLA_FILE}`;

    let prNumber;
    let signer = null;
    let signingComment = null;
    if (context.eventName === 'issue_comment') {
        if (!context.payload.issue.pull_request) {
            return;
        }
        prNumber = context.payload.issue.number;
        const body = context.payload.comment.body.trim();
        if (body === signPhrase(version)) {
            signer = context.payload.comment.user;
            signingComment = context.payload.comment;
        } else if (body.toLowerCase() !== 'recheck') {
            return;
        }
    } else {
        prNumber = context.payload.pull_request.number;
    }

    const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const commits = await github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number: prNumber });
    const { required, unlinkedCommits } = collectContributors(commits, pr.user, owner);

    if (signer && signer.type !== 'Bot') {
        await recordSignature(github, owner, repo, version, {
            githubId: signer.id,
            githubLogin: signer.login,
            claVersion: version,
            claSha256: claHash,
            signedAt: signingComment.created_at,
            pullRequest: prNumber,
            commentUrl: signingComment.html_url
        });
    }

    const { signatures } = await loadSignatures(github, owner, repo, signaturesPath(version));
    const pending = required.filter((user) => !hasSigned(signatures, user, version));
    const passed = pending.length === 0 && unlinkedCommits.length === 0;

    let description = 'All contributors have signed the CLA';
    if (!passed) {
        description = pending.length > 0 ? `Waiting for CLA signature: ${pending.map((user) => user.login).join(', ')}` : 'A commit author is not linked to a GitHub account';
    } else if (required.length === 0) {
        description = 'No CLA signature required';
    }
    await github.rest.repos.createCommitStatus({
        owner,
        repo,
        sha: pr.head.sha,
        state: passed ? 'success' : 'failure',
        context: STATUS_CONTEXT,
        description: description.slice(0, 140),
        target_url: claUrl
    });
    await upsertComment(
        github,
        owner,
        repo,
        prNumber,
        buildComment({ pending, unlinkedCommits, version, claUrl, passed }),
        !passed
    );
    core?.info(`PR #${prNumber}: ${passed ? 'passed' : 'failed'} (${pending.length} pending, ${unlinkedCommits.length} unlinked)`);
}

module.exports = { run, parseVersion, signPhrase, signaturesPath, isExempt, collectContributors, hasSigned, buildComment };
