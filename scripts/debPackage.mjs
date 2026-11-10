// Copyright © 2026 Zenin Easa Panthakkalakath

// The parts of the .deb build that are plain text or plain arithmetic, kept apart from
// createDebPackage.mjs so tests can import them without building or running anything.

// Electron's architecture names on the left (what the Makefile's hostArch holds), Debian's on the right.
export const debianArchitectures = { x64: 'amd64', arm64: 'arm64' };

// Where the packaged app lands. The snap and the AppImage use the same prefix.
export const installDirectory = '/usr/lib/konjugate';

// Chromium's sandbox helper; shipped setuid root so the sandbox starts where unprivileged user
// namespaces are restricted (Ubuntu 24.04 and later).
export const sandboxHelper = 'chrome-sandbox';

export const iconSizes = [16, 24, 32, 48, 64, 128, 256, 512];

// Some of these libraries were renamed with a t64 suffix in the 64-bit time_t transition (Ubuntu
// 24.04, Debian 13), so each has both spellings.
export const dependencies = [
    'libgtk-3-0t64 | libgtk-3-0',
    'libnotify4',
    'libnss3',
    'libxss1',
    'libxtst6',
    'xdg-utils',
    'libatspi2.0-0t64 | libatspi2.0-0',
    'libuuid1',
    'libsecret-1-0',
    'libasound2t64 | libasound2',
    'libcups2t64 | libcups2',
    'libgbm1',
    'libdrm2',
    'libxkbcommon0'
];

// The equation provider needs neither, so neither is required, but the inline Python and C++
// providers do, so both are recommended and apt installs them by default.
export const recommends = ['python3', 'g++ | c++-compiler'];

// Debian sorts "1.4.5-beta.1" after "1.4.5", so a prerelease needs "~" to sort before the release.
export function debianVersion(version, revision = '1') {
    if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`package.json version "${version}" is not one a .deb version can be made from.`);
    if (!/^[0-9A-Za-z.+~]+$/.test(revision)) throw new Error(`Debian revision "${revision}" may only contain letters, digits and . + ~`);
    return `${version.replace(/-/g, '~')}-${revision}`;
}

export function debFileName(version, architecture) {
    return `konjugate_${version}_${architecture}.deb`;
}

// A control file's long description: the summary on the first line, then each paragraph indented by
// one space, with " ." between paragraphs.
export function wrapDescription(summary, paragraphs, width = 78) {
    const lines = [summary];
    paragraphs.forEach((paragraph, index) => {
        if (index > 0) lines.push(' .');
        let line = '';
        for (const word of paragraph.split(/\s+/).filter(Boolean)) {
            if (line && line.length + 1 + word.length > width - 1) {
                lines.push(` ${line}`);
                line = word;
            } else {
                line = line ? `${line} ${word}` : word;
            }
        }
        if (line) lines.push(` ${line}`);
    });
    return lines.join('\n');
}

export function controlFile({ version, architecture, installedSizeKilobytes, maintainer, metadata }) {
    return `${[
        'Package: konjugate',
        `Version: ${version}`,
        `Architecture: ${architecture}`,
        `Maintainer: ${maintainer}`,
        `Installed-Size: ${installedSizeKilobytes}`,
        `Depends: ${dependencies.join(', ')}`,
        `Recommends: ${recommends.join(', ')}`,
        'Section: science',
        'Priority: optional',
        `Homepage: ${metadata.homepage}`,
        `Description: ${wrapDescription(metadata.summary, metadata.description)}`
    ].join('\n')}\n`;
}

// What /usr/bin/konjugate runs. The sandbox helper is installed setuid root, so Chromium's sandbox
// normally just works; the check below only matters if something has stripped that bit (a copy
// made without permissions, say), and then falls back exactly like the AppImage's launcher
// (packaging/linux/AppRun) and the snap's (distribution/snap/launch.sh) -- keep the three in step.
export function wrapperScript() {
    return `#!/bin/sh
# Copyright © 2026 Zenin Easa Panthakkalakath

appDir=${installDirectory}

if [ ! -u "$appDir/${sandboxHelper}" ]; then
    restrictedByAppArmor="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)"
    disabledBySysctl="$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)"

    if [ "$restrictedByAppArmor" = "1" ] || [ "$disabledBySysctl" = "0" ]; then
        set -- --no-sandbox "$@"
    fi
fi

exec "$appDir/Konjugate" "$@"
`;
}

// The desktop file is shared with the AppImage, where Exec= is the AppImage's own binary name. In
// the .deb the launcher is on the PATH as "konjugate".
export function desktopEntry(source) {
    if (!/^Exec=.*$/m.test(source)) throw new Error('The desktop file has no Exec= line to point at the launcher.');
    return source.replace(/^Exec=.*$/m, 'Exec=konjugate %f');
}

// The same two substitutions the Makefile's distributableLinux target applies to the AppImage's
// copy: the committed file's release entry and screenshot URL are only a last-known-good snapshot.
export function metainfoFor(source, version, date) {
    const updated = source
        .replace(/<release version="[^"]*" date="[^"]*" \/>/, `<release version="${version}" date="${date}" />`)
        .replace(/(raw\.githubusercontent\.com\/zenineasa\/Konjugate\/)v[0-9.]*(\/)/g, `$1v${version}$2`);
    if (!updated.includes(`<release version="${version}"`)) throw new Error('The metainfo file has no <release> entry to update.');
    return updated;
}

export function copyrightFile(metadata) {
    return `Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: ${metadata.name}
Upstream-Contact: ${metadata.bugtracker}
Source: ${metadata.homepage}

Files: *
Copyright: 2026 ${metadata.developerName}
License: ${metadata.license}

License: ${metadata.license}
 This Source Code Form is subject to the terms of the Mozilla Public License,
 v. 2.0. On Debian systems, the full text is in
 /usr/share/common-licenses/MPL-2.0.
 .
 This package also bundles Electron, Chromium and other third-party
 components under their own licenses. Their notices ship inside
 ${installDirectory}.
`;
}

// Date in the RFC 2822 form a changelog trailer wants, e.g. "Wed, 11 Nov 2026 10:00:00 +0000".
export function changelogDate(date) {
    return date.toUTCString().replace('GMT', '+0000');
}

export function changelogFile({ version, upstreamVersion, maintainer, date }) {
    return `konjugate (${version}) unstable; urgency=medium

  * Packaged from the upstream release ${upstreamVersion}. See
    https://github.com/zenineasa/Konjugate/releases for what changed.

 -- ${maintainer}  ${changelogDate(date)}
`;
}

// Electron's sandbox helper has to be setuid root; that is the package's whole reason for shipping it that way.
export function lintianOverrides() {
    return `# Chromium's sandbox helper must be setuid root to start where unprivileged user namespaces are restricted.
konjugate: elevated-privileges 4755 root/root [${installDirectory.slice(1)}/${sandboxHelper}]
`;
}
