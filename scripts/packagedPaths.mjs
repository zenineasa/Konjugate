// Copyright © 2026 Zenin Easa Panthakkalakath

import { join } from 'node:path';

// Matches the Makefile's `appName` and electron-packager's `${appName}-${platform}-${arch}`
// output folder naming (packageMacos/packageWindows/packageLinux).
const appName = 'Konjugate';

export function packagedAppDirectory(rootDirectory) {
    return join(rootDirectory, 'out', 'package', `${appName}-${process.platform}-${process.arch}`);
}

// Mirrors the packaged-vs-dev split in src/engineAdapter.mjs's resolveEnginePath(), but from
// outside the app -- these paths are the packaging layout electron-packager's --extra-resource
// produces (see packageMacos/packageWindows/packageLinux in the Makefile), not what the app
// resolves internally via app.getPath()/process.resourcesPath at runtime.
export function packagedEngineExecutable(rootDirectory) {
    const appDirectory = packagedAppDirectory(rootDirectory);
    const resourcesDirectory = process.platform === 'darwin'
        ? join(appDirectory, `${appName}.app`, 'Contents', 'Resources')
        : join(appDirectory, 'resources');
    return join(resourcesDirectory, 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
}

export function packagedAppExecutable(rootDirectory) {
    const appDirectory = packagedAppDirectory(rootDirectory);
    if (process.platform === 'darwin') return join(appDirectory, `${appName}.app`, 'Contents', 'MacOS', appName);
    if (process.platform === 'win32') return join(appDirectory, `${appName}.exe`);
    return join(appDirectory, appName);
}
