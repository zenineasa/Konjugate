/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Release selection and compatibility (docs/proposals/packageCompatibility.md), against a fake GitHub: no network.

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { createPackageArchive, listInstalledPackages } from '../src/packageArchive.mjs';
import {
    assessFacts, assetNameFromDownloadUrl, checkEntryUpdate, createReleaseFactsCache, installFromRegistryEntry, listGithubReleases, selectCompatibleRelease
} from '../src/registryClient.mjs';

const packageId = 'example.toolbox';
const assetName = 'example.toolbox.kja';

// A real .kja at `version`, optionally needing a minimum Konjugate or an API version beyond this one.
function addon({ version = '1.0.0', minimum, api = 1, id = packageId } = {}) {
    return createPackageArchive({
        packageManifest: {
            format: 'konjugate-package', formatVersion: 1, packageType: 'addon', packageId: id, name: 'Example Toolbox', version,
            ...(minimum ? { minimumKonjugateVersion: minimum } : {}), contents: { manifest: 'addon.json' }
        },
        contributionManifest: {
            addonId: id, name: 'Example Toolbox', version, apiVersion: api, kind: 'resultVisualizer', entry: 'index.html', permissions: ['results.read'],
            contributes: { toolstrip: [{ commandId: 'open', label: 'Open', tooltip: 'Open', symbol: 'E', when: 'resultsActive', contexts: ['resultSession'] }] }
        },
        files: { 'index.html': '<!doctype html>' }
    });
}

// A fake GitHub repository. Each release: { tag, minimum, api, prerelease, draft, noAsset, corrupt, archive }. `archive` overrides the
// bytes; `file` the asset's file name. Records every API call and every download so a test can assert what was (not) fetched.
function fakeGithub(releases, { name = assetName, owner = 'example', repo = 'Toolbox' } = {}) {
    const calls = { api: 0, downloads: [] };
    const listUrl = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=20`;
    const bytesFor = new Map();
    const body = releases.map((release) => {
        const url = `https://github.com/${owner}/${repo}/releases/download/${release.tag}/${name}`;
        const bytes = release.archive ?? (release.corrupt ? strToU8('not an archive') : addon({ version: release.tag.replace(/^v/, ''), minimum: release.minimum, api: release.api }));
        bytesFor.set(url, bytes);
        return {
            tag_name: release.tag, draft: Boolean(release.draft), prerelease: Boolean(release.prerelease), html_url: `https://github.com/${owner}/${repo}/releases/tag/${release.tag}`,
            assets: release.noAsset ? [] : [{ name: release.file ?? name, browser_download_url: url }]
        };
    });
    const fetchImpl = async (url) => {
        if (url === listUrl) {
            calls.api += 1;
            return { ok: true, status: 200, json: async () => body };
        }
        if (bytesFor.has(url)) {
            calls.downloads.push(url);
            const bytes = bytesFor.get(url);
            return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
        }
        throw new Error(`Unexpected fetch to ${url}`);
    };
    const entry = {
        title: 'Example Toolbox', downloadUrl: `https://github.com/${owner}/${repo}/releases/latest/download/${name}`,
        packages: [{ packageType: 'addon', packageId }]
    };
    return { fetchImpl, entry, calls, listUrl };
}

const downloaded = (calls) => calls.downloads.map((url) => url.split('/').at(-2));

test('the asset name is the last part of the download address', () => {
    assert.equal(assetNameFromDownloadUrl('https://github.com/o/r/releases/latest/download/example.toolbox.kja'), 'example.toolbox.kja');
    assert.equal(assetNameFromDownloadUrl('https://github.com/o/r/releases/download/v1.0.0/with%20space.kja'), 'with space.kja');
    assert.equal(assetNameFromDownloadUrl('not a url'), '');
});

test('listing releases skips drafts and unreadable tags, hides pre-releases unless asked, and sorts by version', async () => {
    const { fetchImpl, entry } = fakeGithub([
        { tag: 'v1.0.0' }, { tag: 'v1.10.0' }, { tag: 'v1.9.0' }, { tag: 'v2.0.0', draft: true }, { tag: 'nightly' }, { tag: 'v1.11.0-beta.1', prerelease: true }
    ]);
    assert.deepEqual((await listGithubReleases(entry.downloadUrl, { fetchImpl })).map((release) => release.version), ['1.10.0', '1.9.0', '1.0.0']);
    assert.deepEqual((await listGithubReleases(entry.downloadUrl, { fetchImpl, includePrereleases: true })).map((release) => release.version), ['1.11.0-beta.1', '1.10.0', '1.9.0', '1.0.0']);
});

test('listing releases says nothing rather than failing when it cannot', async () => {
    assert.equal(await listGithubReleases('https://example.org/x.kja'), null);
    assert.equal(await listGithubReleases(undefined), null);
    const failing = async () => ({ ok: false, status: 403, json: async () => ({}) });
    assert.equal(await listGithubReleases('https://github.com/o/r/releases/latest/download/x.kja', { fetchImpl: failing }), null);
    const throwing = async () => { throw new Error('offline'); };
    assert.equal(await listGithubReleases('https://github.com/o/r/releases/latest/download/x.kja', { fetchImpl: throwing }), null);
    const notAList = async () => ({ ok: true, status: 200, json: async () => ({ message: 'oops' }) });
    assert.equal(await listGithubReleases('https://github.com/o/r/releases/latest/download/x.kja', { fetchImpl: notAList }), null);
});

test('the newest release is chosen when this Konjugate can use it, and nothing older is downloaded', async () => {
    const { fetchImpl, entry, calls } = fakeGithub([{ tag: 'v1.5.0', minimum: '1.1.0' }, { tag: 'v1.4.0', minimum: '1.0.0' }]);
    const selection = await selectCompatibleRelease(entry, { appVersion: '1.2.0', fetchImpl });
    assert.equal(selection.chosen.release.version, '1.5.0');
    assert.deepEqual(selection.skipped, []);
    assert.ok(selection.chosen.bytes instanceof Uint8Array, 'the downloaded archive is handed back so installing does not fetch it twice');
    assert.deepEqual(downloaded(calls), ['v1.5.0']);
});

test('a newer release that needs a newer Konjugate is passed over for the newest one that works', async () => {
    const { fetchImpl, entry, calls } = fakeGithub([{ tag: 'v1.5.0', minimum: '1.2.0' }, { tag: 'v1.4.2', minimum: '1.0.0' }, { tag: 'v1.4.0' }]);
    const selection = await selectCompatibleRelease(entry, { appVersion: '1.1.9', fetchImpl });
    assert.equal(selection.chosen.release.version, '1.4.2');
    assert.deepEqual(selection.skipped, [{ version: '1.5.0', reason: 'app-version', required: '1.2.0' }]);
    assert.equal(selection.newest.version, '1.5.0');
    assert.deepEqual(downloaded(calls), ['v1.5.0', 'v1.4.2']);
});

test('a release using an API version this Konjugate lacks is passed over', async () => {
    const { fetchImpl, entry } = fakeGithub([{ tag: 'v2.0.0', api: 2 }, { tag: 'v1.9.0' }]);
    const selection = await selectCompatibleRelease(entry, { appVersion: '5.0.0', fetchImpl });
    assert.equal(selection.chosen.release.version, '1.9.0');
    assert.deepEqual(selection.skipped, [{ version: '2.0.0', reason: 'api-version', required: 2 }]);
});

test('an unusable release is passed over, and a release without the entry\'s file is ignored', async () => {
    const { fetchImpl, entry } = fakeGithub([{ tag: 'v1.3.0', corrupt: true }, { tag: 'v1.2.5', noAsset: true }, { tag: 'v1.2.0', file: 'other.kja' }, { tag: 'v1.1.0' }]);
    const selection = await selectCompatibleRelease(entry, { appVersion: '1.0.0', fetchImpl });
    assert.equal(selection.chosen.release.version, '1.1.0');
    assert.deepEqual(selection.skipped.map((item) => [item.version, item.reason]), [['1.3.0', 'invalid']]);
});

test('drafts and pre-releases are never chosen by default', async () => {
    const { fetchImpl, entry } = fakeGithub([{ tag: 'v2.0.0', draft: true }, { tag: 'v1.6.0-rc.1', prerelease: true }, { tag: 'v1.5.0' }]);
    assert.equal((await selectCompatibleRelease(entry, { appVersion: '1.0.0', fetchImpl })).chosen.release.version, '1.5.0');
    assert.equal((await selectCompatibleRelease(entry, { appVersion: '1.0.0', fetchImpl, includePrereleases: true })).chosen.release.version, '1.6.0-rc.1');
});

test('selection gives up after five candidates and reports what it passed over', async () => {
    const releases = ['v1.7.0', 'v1.6.0', 'v1.5.0', 'v1.4.0', 'v1.3.0', 'v1.2.0'].map((tag) => ({ tag, minimum: '9.0.0' }));
    releases.push({ tag: 'v1.1.0' });
    const { fetchImpl, entry, calls } = fakeGithub(releases);
    const selection = await selectCompatibleRelease(entry, { appVersion: '1.0.0', fetchImpl });
    assert.equal(selection.chosen, null);
    assert.equal(selection.skipped.length, 5);
    assert.equal(calls.downloads.length, 5);
    assert.equal(selection.newest.version, '1.7.0');
});

test('it is not available for an address that is not GitHub Releases', async () => {
    assert.equal(await selectCompatibleRelease({ downloadUrl: 'https://example.org/x.kja', packages: [] }, { appVersion: '1.0.0' }), null);
});

test('what is learned about a release is remembered, so a second look downloads nothing', async () => {
    const { fetchImpl, entry, calls } = fakeGithub([{ tag: 'v1.5.0', minimum: '1.2.0' }, { tag: 'v1.4.0' }]);
    const saved = [];
    const factsCache = createReleaseFactsCache({ onChange: (facts) => saved.push(facts) });
    await selectCompatibleRelease(entry, { appVersion: '1.1.0', fetchImpl, factsCache });
    assert.equal(calls.downloads.length, 2);
    const again = await selectCompatibleRelease(entry, { appVersion: '1.1.0', fetchImpl, factsCache });
    assert.equal(calls.downloads.length, 2, 'the verdict is recomputed from remembered facts');
    assert.equal(again.chosen.release.version, '1.4.0');
    assert.equal(again.chosen.bytes, null);
    assert.equal(saved.length, 2);
    assert.deepEqual(saved.at(-1)['example/Toolbox@v1.5.0'], { minimumKonjugateVersion: '1.2.0', unsupportedApiVersion: null });
});

test('remembered facts are not verdicts: a newer Konjugate makes a held-back release usable without downloading again', async () => {
    const { fetchImpl, entry, calls } = fakeGithub([{ tag: 'v1.5.0', minimum: '1.2.0' }, { tag: 'v1.4.0' }]);
    const factsCache = createReleaseFactsCache();
    assert.equal((await selectCompatibleRelease(entry, { appVersion: '1.1.0', fetchImpl, factsCache })).chosen.release.version, '1.4.0');
    const afterUpdate = await selectCompatibleRelease(entry, { appVersion: '1.2.0', fetchImpl, factsCache });
    assert.equal(afterUpdate.chosen.release.version, '1.5.0');
    assert.equal(afterUpdate.chosen.bytes, null);
    assert.equal(calls.downloads.length, 2);
});

test('facts can be restored from what was saved', async () => {
    const { fetchImpl, entry, calls } = fakeGithub([{ tag: 'v1.5.0', minimum: '1.2.0' }, { tag: 'v1.4.0' }]);
    const factsCache = createReleaseFactsCache({ initial: { 'example/Toolbox@v1.5.0': { minimumKonjugateVersion: '1.2.0', unsupportedApiVersion: null }, 'example/Toolbox@v1.4.0': { minimumKonjugateVersion: null, unsupportedApiVersion: null } } });
    const selection = await selectCompatibleRelease(entry, { appVersion: '1.1.0', fetchImpl, factsCache });
    assert.equal(selection.chosen.release.version, '1.4.0');
    assert.equal(calls.downloads.length, 0);
});

test('a bundle is as demanding as its most demanding package', async () => {
    const other = addon({ id: 'example.toolbox.helper', version: '1.0.0', minimum: '1.3.0' });
    const bundle = zipSync({ 'a.kja': addon({ version: '1.0.0', minimum: '1.0.0' }), 'b.kja': other });
    const old = zipSync({ 'a.kja': addon({ version: '0.9.0' }), 'b.kja': addon({ id: 'example.toolbox.helper', version: '0.9.0' }) });
    const { fetchImpl, entry } = fakeGithub([{ tag: 'v1.0.0', archive: bundle }, { tag: 'v0.9.0', archive: old }], { name: 'example-bundle.zip' });
    entry.packages = [{ packageType: 'addon', packageId }, { packageType: 'addon', packageId: 'example.toolbox.helper' }];
    const selection = await selectCompatibleRelease(entry, { appVersion: '1.2.0', fetchImpl });
    assert.equal(selection.chosen.release.version, '0.9.0');
    assert.deepEqual(selection.skipped, [{ version: '1.0.0', reason: 'app-version', required: '1.3.0' }]);
});

test('assessFacts reports why a release does not suit', () => {
    assert.deepEqual(assessFacts({ minimumKonjugateVersion: null, unsupportedApiVersion: null }, '1.0.0'), { compatible: true });
    assert.deepEqual(assessFacts({ minimumKonjugateVersion: '1.2.0', unsupportedApiVersion: null }, '1.1.0'), { compatible: false, reason: 'app-version', required: '1.2.0' });
    assert.deepEqual(assessFacts({ minimumKonjugateVersion: '1.0.0', unsupportedApiVersion: 3 }, '1.1.0'), { compatible: false, reason: 'api-version', required: 3 });
    assert.deepEqual(assessFacts({ invalid: true }, '1.1.0'), { compatible: false, reason: 'invalid', required: null });
});

// ---- Update checking ----

test('an up-to-date package costs one API call and no download', async () => {
    const { fetchImpl, entry, calls } = fakeGithub([{ tag: 'v1.4.0' }, { tag: 'v1.3.0' }]);
    const result = await checkEntryUpdate(entry, ['1.4.0'], { appVersion: '1.0.0', fetchImpl });
    assert.equal(result.status, 'current');
    assert.equal(calls.api, 1);
    assert.equal(calls.downloads.length, 0);
});

test('a newer compatible release is an update', async () => {
    const { fetchImpl, entry } = fakeGithub([{ tag: 'v1.5.0', minimum: '1.1.0' }, { tag: 'v1.4.0' }]);
    const result = await checkEntryUpdate(entry, ['1.4.0'], { appVersion: '1.2.0', fetchImpl });
    assert.equal(result.status, 'update');
    assert.equal(result.latest.version, '1.5.0');
    assert.equal(result.latest.url, 'https://github.com/example/Toolbox/releases/tag/v1.5.0');
    assert.equal(result.heldBack, null);
});

test('a newer release this Konjugate cannot use is held back, not offered', async () => {
    const { fetchImpl, entry } = fakeGithub([{ tag: 'v1.5.0', minimum: '1.2.0' }, { tag: 'v1.4.0' }]);
    const result = await checkEntryUpdate(entry, ['1.4.0'], { appVersion: '1.1.9', fetchImpl });
    assert.equal(result.status, 'held-back');
    assert.deepEqual(result.heldBack, { version: '1.5.0', required: '1.2.0', reason: 'app-version' });
});

test('an update to an older release than the newest reports both', async () => {
    const { fetchImpl, entry } = fakeGithub([{ tag: 'v1.6.0', minimum: '1.3.0' }, { tag: 'v1.5.0' }, { tag: 'v1.4.0' }]);
    const result = await checkEntryUpdate(entry, ['1.4.0'], { appVersion: '1.1.0', fetchImpl });
    assert.equal(result.status, 'update');
    assert.equal(result.latest.version, '1.5.0');
    assert.deepEqual(result.heldBack, { version: '1.6.0', required: '1.3.0', reason: 'app-version' });
});

test('when the compatible release is the one already installed, only the held-back note remains', async () => {
    const { fetchImpl, entry } = fakeGithub([{ tag: 'v1.6.0', minimum: '1.3.0' }, { tag: 'v1.4.0' }]);
    const result = await checkEntryUpdate(entry, ['1.4.0'], { appVersion: '1.1.0', fetchImpl });
    assert.equal(result.status, 'held-back');
    assert.equal(result.latest.version, '1.4.0');
});

test('a bundle is outdated if any installed package is', async () => {
    const { fetchImpl, entry } = fakeGithub([{ tag: 'v1.5.0' }]);
    assert.equal((await checkEntryUpdate(entry, ['1.5.0', '1.4.0'], { appVersion: '1.0.0', fetchImpl })).status, 'update');
});

test('an update check that cannot find out says so and never throws', async () => {
    assert.equal((await checkEntryUpdate({ downloadUrl: 'https://example.org/x.kja', packages: [] }, ['1.0.0'], { appVersion: '1.0.0' })).status, 'unknown');
    const { entry } = fakeGithub([{ tag: 'v1.5.0' }]);
    const offline = async () => { throw new Error('offline'); };
    assert.equal((await checkEntryUpdate(entry, ['1.0.0'], { appVersion: '1.0.0', fetchImpl: offline })).status, 'unknown');
    const noReleases = fakeGithub([]);
    assert.equal((await checkEntryUpdate(noReleases.entry, ['1.0.0'], { appVersion: '1.0.0', fetchImpl: noReleases.fetchImpl })).status, 'unknown');
    const downloadFails = fakeGithub([{ tag: 'v2.0.0' }]);
    const brokenDownload = async (url) => (url.includes('/releases/download/') ? { ok: false, status: 500 } : downloadFails.fetchImpl(url));
    assert.equal((await checkEntryUpdate(downloadFails.entry, ['1.0.0'], { appVersion: '1.0.0', fetchImpl: brokenDownload })).status, 'unknown');
});

// ---- Installing ----

async function withDirectory(action) {
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-compat-'));
    try {
        return await action(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

const installed = async (directory) => (await listInstalledPackages(directory)).map((pkg) => `${pkg.packageId}@${pkg.version}`);

test('installing picks the newest compatible release and says what was held back', async () => {
    await withDirectory(async (directory) => {
        const { fetchImpl, entry, calls } = fakeGithub([{ tag: 'v1.5.0', minimum: '1.2.0' }, { tag: 'v1.4.2', minimum: '1.0.0' }]);
        const results = await installFromRegistryEntry(entry, { fetchImpl, directory, namespaces: { prefixes: {} }, appVersion: '1.1.9' });
        assert.equal(results[0].version, '1.4.2');
        assert.deepEqual(results[0].heldBack, { version: '1.5.0', required: '1.2.0', reason: 'app-version' });
        assert.deepEqual(await installed(directory), [`${packageId}@1.4.2`]);
        assert.deepEqual(downloaded(calls), ['v1.5.0', 'v1.4.2'], 'the chosen archive is installed from the bytes already downloaded');
    });
});

test('installing the newest release reports nothing held back', async () => {
    await withDirectory(async (directory) => {
        const { fetchImpl, entry } = fakeGithub([{ tag: 'v1.5.0' }, { tag: 'v1.4.0' }]);
        const results = await installFromRegistryEntry(entry, { fetchImpl, directory, namespaces: { prefixes: {} }, appVersion: '1.0.0' });
        assert.equal(results[0].version, '1.5.0');
        assert.equal('heldBack' in results[0], false);
    });
});

test('installing refuses clearly when no recent release suits this Konjugate', async () => {
    await withDirectory(async (directory) => {
        const { fetchImpl, entry } = fakeGithub([{ tag: 'v1.5.0', minimum: '2.0.0' }, { tag: 'v1.4.0', minimum: '1.9.0' }]);
        await assert.rejects(
            () => installFromRegistryEntry(entry, { fetchImpl, directory, namespaces: { prefixes: {} }, appVersion: '1.1.0' }),
            (error) => error.code === 'NO_COMPATIBLE_RELEASE' && /Example Toolbox 1\.5\.0 needs Konjugate 2\.0\.0 or later; this is Konjugate 1\.1\.0/.test(error.message)
        );
        assert.deepEqual(await installed(directory), []);
    });
});

test('an incompatible installed version is replaced by the newest compatible one', async () => {
    await withDirectory(async (directory) => {
        const modern = fakeGithub([{ tag: 'v1.5.0', minimum: '1.2.0' }]);
        await installFromRegistryEntry(modern.entry, { fetchImpl: modern.fetchImpl, directory, namespaces: { prefixes: {} }, appVersion: '1.2.0' });
        assert.deepEqual(await installed(directory), [`${packageId}@1.5.0`]);
        const both = fakeGithub([{ tag: 'v1.5.0', minimum: '1.2.0' }, { tag: 'v1.4.0' }]);
        await installFromRegistryEntry(both.entry, { fetchImpl: both.fetchImpl, directory, namespaces: { prefixes: {} }, appVersion: '1.1.0' });
        assert.deepEqual(await installed(directory), [`${packageId}@1.4.0`], 'rolled back, and the newer one is gone');
        assert.deepEqual((await readdir(join(directory, 'addons', packageId))).sort(), ['1.4.0']);
    });
});

test('a specific release can be chosen, if it suits this Konjugate', async () => {
    await withDirectory(async (directory) => {
        const { fetchImpl, entry } = fakeGithub([{ tag: 'v1.5.0', minimum: '1.2.0' }, { tag: 'v1.4.0' }, { tag: 'v1.3.0' }]);
        const results = await installFromRegistryEntry(entry, { fetchImpl, directory, namespaces: { prefixes: {} }, appVersion: '1.1.0', release: 'v1.3.0' });
        assert.equal(results[0].version, '1.3.0');
        await assert.rejects(
            () => installFromRegistryEntry(entry, { fetchImpl, directory, namespaces: { prefixes: {} }, appVersion: '1.1.0', release: '1.5.0' }),
            { code: 'INCOMPATIBLE_RELEASE' }
        );
        await assert.rejects(
            () => installFromRegistryEntry(entry, { fetchImpl, directory, namespaces: { prefixes: {} }, appVersion: '1.1.0', release: 'v9.9.9' }),
            { code: 'RELEASE_NOT_FOUND' }
        );
        await assert.rejects(
            () => installFromRegistryEntry(entry, { fetchImpl, directory, namespaces: { prefixes: {} }, release: 'v1.3.0' }),
            { code: 'NO_APP_VERSION' }
        );
    });
});

test('a package from a newer Konjugate is still recognised as the declared package, so the message is about compatibility', async () => {
    await withDirectory(async (directory) => {
        const { fetchImpl, entry } = fakeGithub([{ tag: 'v2.0.0', api: 2 }]);
        await assert.rejects(
            () => installFromRegistryEntry(entry, { fetchImpl, directory, namespaces: { prefixes: {} }, appVersion: '5.0.0' }),
            (error) => error.code === 'NO_COMPATIBLE_RELEASE' && /API version 2/.test(error.message)
        );
    });
});

test('without a Konjugate version the entry is downloaded as before and nothing is judged', async () => {
    await withDirectory(async (directory) => {
        const archive = addon({ version: '3.0.0', minimum: '9.0.0' });
        const entry = { downloadUrl: 'https://example.org/direct.kja', packages: [{ packageType: 'addon', packageId }] };
        const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) });
        const results = await installFromRegistryEntry(entry, { fetchImpl, directory, namespaces: { prefixes: {} } });
        assert.equal(results[0].version, '3.0.0');
    });
});

test('an address that is not GitHub Releases is judged when the package is installed', async () => {
    await withDirectory(async (directory) => {
        const archive = addon({ version: '3.0.0', minimum: '9.0.0' });
        const entry = { downloadUrl: 'https://example.org/direct.kja', packages: [{ packageType: 'addon', packageId }] };
        const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) });
        await assert.rejects(() => installFromRegistryEntry(entry, { fetchImpl, directory, namespaces: { prefixes: {} }, appVersion: '1.0.0' }), { code: 'INCOMPATIBLE_APP_VERSION' });
        assert.deepEqual(await installed(directory), []);
    });
});

test('if the release list cannot be read, the entry is downloaded and judged at install', async () => {
    await withDirectory(async (directory) => {
        const archive = addon({ version: '1.0.0' });
        const entry = { downloadUrl: 'https://github.com/example/Toolbox/releases/latest/download/example.toolbox.kja', packages: [{ packageType: 'addon', packageId }] };
        const fetchImpl = async (url) => (url.startsWith('https://api.github.com/')
            ? { ok: false, status: 403, json: async () => ({}) }
            : { ok: true, status: 200, arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) });
        const results = await installFromRegistryEntry(entry, { fetchImpl, directory, namespaces: { prefixes: {} }, appVersion: '1.0.0' });
        assert.equal(results[0].version, '1.0.0');
    });
});
