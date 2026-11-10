// Copyright © 2026 Zenin Easa Panthakkalakath

// Wraps the already-packaged Linux app folder (out/package/Konjugate-linux-<arch>, the same one
// the AppImage and the snap wrap) into a .deb for Debian and Ubuntu. Linux-only in practice:
// it needs dpkg-deb.
//
// Usage: node scripts/createDebPackage.mjs <packagedAppDirectory> <outputDirectory> <x64|arm64>
//
// The file is named konjugate_<version>-<revision>_<amd64|arm64>.deb. The Debian revision comes from
// DEB_REVISION (default 1): raise it to republish a package without a new app version. The maintainer
// line comes from DEB_MAINTAINER.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { load } from 'js-yaml';
import { rootDirectory } from './developmentEnvironment.mjs';
import {
    changelogFile, controlFile, copyrightFile, debFileName, debianArchitectures, debianVersion, desktopEntry, iconSizes,
    installDirectory, lintianOverrides, metainfoFor, sandboxHelper, wrapperScript
} from './debPackage.mjs';

const [packagedDirectoryArgument, outputDirectoryArgument, electronArchitecture] = process.argv.slice(2);
if (!packagedDirectoryArgument || !outputDirectoryArgument || !electronArchitecture) {
    console.error('Usage: node scripts/createDebPackage.mjs <packagedAppDirectory> <outputDirectory> <x64|arm64>');
    process.exit(64);
}
const packagedDirectory = resolve(packagedDirectoryArgument);
const outputDirectory = resolve(outputDirectoryArgument);

const architecture = debianArchitectures[electronArchitecture];
if (!architecture) throw new Error(`Unsupported architecture "${electronArchitecture}" -- expected x64 or arm64.`);

const appPackage = JSON.parse(await readFile(join(rootDirectory, 'package.json'), 'utf8'));
const metadata = load(await readFile(join(rootDirectory, 'packaging', 'appMetadata.yml'), 'utf8'));
const version = debianVersion(appPackage.version, process.env.DEB_REVISION ?? '1');
const maintainer = process.env.DEB_MAINTAINER ?? `${metadata.developerName} <info@konjugate.com>`;
const desktopId = metadata.appId;

function run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout || result.error}`);
    return result.stdout;
}

async function filesUnder(directory) {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...await filesUnder(path));
        else if (entry.isFile()) found.push(path);
    }
    return found;
}

for (const required of ['Konjugate', sandboxHelper]) {
    if (!(await stat(join(packagedDirectory, required)).catch(() => null))?.isFile()) {
        throw new Error(`${join(packagedDirectory, required)} is missing -- is ${packagedDirectory} the packaged Linux app?`);
    }
}

const stage = await mkdtemp(join(tmpdir(), 'konjugateDeb-'));
try {
    const appDestination = join(stage, installDirectory);
    await mkdir(appDestination, { recursive: true });
    // cp -a keeps the executable bits and symlinks Electron and the engine rely on.
    run('cp', ['-a', `${packagedDirectory}/.`, appDestination]);
    // Normalise permissions so the package does not depend on the build machine's umask, then set
    // the one deliberate exception: the sandbox helper is setuid root.
    run('chmod', ['-R', 'u+rwX,go+rX,go-w', appDestination]);
    await chmod(join(appDestination, sandboxHelper), 0o4755);

    await mkdir(join(stage, 'usr', 'bin'), { recursive: true });
    await writeFile(join(stage, 'usr', 'bin', 'konjugate'), wrapperScript(), { mode: 0o755 });
    await chmod(join(stage, 'usr', 'bin', 'konjugate'), 0o755);

    const applications = join(stage, 'usr', 'share', 'applications');
    await mkdir(applications, { recursive: true });
    await writeFile(join(applications, `${desktopId}.desktop`), desktopEntry(await readFile(join(rootDirectory, 'packaging', 'linux', `${desktopId}.desktop`), 'utf8')));

    const metainfo = join(stage, 'usr', 'share', 'metainfo');
    await mkdir(metainfo, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    await writeFile(join(metainfo, `${desktopId}.metainfo.xml`), metainfoFor(await readFile(join(rootDirectory, 'packaging', 'linux', `${desktopId}.metainfo.xml`), 'utf8'), appPackage.version, today));

    for (const size of iconSizes) {
        const source = join(rootDirectory, 'assets', 'icons', 'png', `${size}.png`);
        if (!(await stat(source).catch(() => null))) throw new Error(`${source} is missing -- run "make iconsPng" first.`);
        const destination = join(stage, 'usr', 'share', 'icons', 'hicolor', `${size}x${size}`, 'apps');
        await mkdir(destination, { recursive: true });
        await cp(source, join(destination, `${desktopId}.png`));
    }

    const documentation = join(stage, 'usr', 'share', 'doc', 'konjugate');
    await mkdir(documentation, { recursive: true });
    await writeFile(join(documentation, 'copyright'), copyrightFile(metadata));
    await writeFile(join(documentation, 'changelog.Debian.gz'), gzipSync(changelogFile({ version, upstreamVersion: appPackage.version, maintainer, date: new Date() }), { level: 9 }));

    // The setuid sandbox helper is deliberate; tell lintian so its warning does not look like a defect.
    const overrides = join(stage, 'usr', 'share', 'lintian', 'overrides');
    await mkdir(overrides, { recursive: true });
    await writeFile(join(overrides, 'konjugate'), lintianOverrides());

    const installedSizeKilobytes = Number.parseInt(run('du', ['-sk', join(stage, 'usr')]), 10);
    await mkdir(join(stage, 'DEBIAN'), { recursive: true });
    await writeFile(join(stage, 'DEBIAN', 'control'), controlFile({ version, architecture, installedSizeKilobytes, maintainer, metadata }));

    const sums = [];
    for (const file of (await filesUnder(join(stage, 'usr'))).sort()) {
        sums.push(`${createHash('md5').update(await readFile(file)).digest('hex')}  ${relative(stage, file)}`);
    }
    await writeFile(join(stage, 'DEBIAN', 'md5sums'), `${sums.join('\n')}\n`);

    await mkdir(outputDirectory, { recursive: true });
    const outputPath = join(outputDirectory, debFileName(version, architecture));
    await rm(outputPath, { force: true });
    // xz rather than the newer zstd, so it also installs on older dpkg versions.
    run('dpkg-deb', ['--build', '--root-owner-group', '-Zxz', stage, outputPath]);

    // The one thing this package exists to get right: the sandbox helper must come out setuid root.
    const contents = run('dpkg-deb', ['--contents', outputPath]).split('\n');
    const sandboxLine = contents.find((line) => line.endsWith(`.${installDirectory}/${sandboxHelper}`));
    if (!sandboxLine || !/^-rws\S* root\/root /.test(sandboxLine)) {
        throw new Error(`${sandboxHelper} did not come out setuid root in ${outputPath}: ${sandboxLine ?? 'not found'}`);
    }
    console.log(`Created ${outputPath}`);
} finally {
    await rm(stage, { recursive: true, force: true });
}
