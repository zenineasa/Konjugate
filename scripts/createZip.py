#!/usr/bin/env python3
# Copyright © 2026 Zenin Easa Panthakkalakath

"""Create a shareable ZIP archive from a packaged application directory."""

from __future__ import annotations

import argparse
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def createZip(sourceDir: Path, outputPath: Path) -> None:
    if not sourceDir.is_dir():
        raise ValueError(f"Source directory does not exist: {sourceDir}")

    outputPath.parent.mkdir(parents=True, exist_ok=True)

    with ZipFile(outputPath, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for sourcePath in sorted(sourceDir.rglob("*")):
            if sourcePath.is_file():
                archivePath = Path(sourceDir.name, sourcePath.relative_to(sourceDir))
                archive.write(sourcePath, archivePath)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sourceDir", type=Path)
    parser.add_argument("outputPath", type=Path)
    args = parser.parse_args()
    createZip(args.sourceDir, args.outputPath)


if __name__ == "__main__":
    main()
