# Copyright © 2026 Zenin Easa Panthakkalakath

# Lets FMPy run an FMU's binary for an ARM processor on Linux or Windows, which FMPy (0.3.32 and earlier) does not know: its
# supported_platforms() lists binaries/<architecture>-<system> only for x86, so simulate_fmu() refuses an FMU whose binary is in
# binaries/aarch64-linux ("cannot be simulated on the current platform (linux64)") although its own FMI 3.0 loader looks there,
# and its FMI 1.0/2.0 loader looks only in binaries/linux64 or win64, which mean x86-64. Konjugate files such a binary under the
# FMI 3.0 platform tuple for both versions (src/fmiExport.mjs, platformDirectory), as the FMI Reference FMUs do.
#
# Imported by the FMPy drivers of the FMU checks (fmpyPlatforms in tests/engine/fixtures/fmuFidelityFixture.mjs) before they
# use FMPy. Elsewhere (macOS, x86 Linux and Windows) it changes nothing; on an ARM Linux or Windows machine it only adds what
# FMPy left out: the FMU still runs in FMPy's own simulator, from the binary that is there.

import os
import zipfile

import fmpy
import fmpy.fmi1

_applies = fmpy.architecture == 'aarch64' and fmpy.system in ('linux', 'windows')


def _tuple_binary_names(filename):
    if isinstance(filename, (str, os.PathLike)) and os.path.isdir(filename):
        directory = os.path.join(filename, 'binaries', fmpy.platform_tuple)
        return os.listdir(directory) if os.path.isdir(directory) else []
    with zipfile.ZipFile(filename, 'r') as archive:
        return [name.split('/')[-1] for name in archive.namelist() if name.startswith(f'binaries/{fmpy.platform_tuple}/')]


_supported_platforms = fmpy.supported_platforms


def supported_platforms(filename):
    platforms = _supported_platforms(filename)
    if _applies and fmpy.platform not in platforms and any(name.endswith(fmpy.sharedLibraryExtension) for name in _tuple_binary_names(filename)):
        platforms.append(fmpy.platform)
    return platforms


_initialize = fmpy.fmi1._FMU.__init__


def _initialize_from_tuple(self, guid, modelIdentifier, unzipDirectory, instanceName=None, libraryPath=None, *args, **kwargs):
    if _applies and libraryPath is None:
        candidate = os.path.join(unzipDirectory, 'binaries', fmpy.platform_tuple, modelIdentifier + fmpy.sharedLibraryExtension)
        if os.path.isfile(candidate):
            libraryPath = candidate
    _initialize(self, guid, modelIdentifier, unzipDirectory, instanceName, libraryPath, *args, **kwargs)


fmpy.supported_platforms = supported_platforms
fmpy.fmi1._FMU.__init__ = _initialize_from_tuple
