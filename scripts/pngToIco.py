#!/usr/bin/env python3
"""Combine square PNG images into a multi-resolution Windows ICO file."""

from __future__ import annotations

import argparse
import struct
from pathlib import Path

pngSignature = b"\x89PNG\r\n\x1a\n"


def pngSize(data: bytes, path: Path) -> tuple[int, int]:
    if len(data) < 24 or data[:8] != pngSignature or data[12:16] != b"IHDR":
        raise ValueError(f"{path} is not a valid PNG file")
    return struct.unpack(">II", data[16:24])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--output", "-o", required=True, type=Path)
    args = parser.parse_args()

    entries: list[tuple[int, bytes]] = []
    for path in args.images:
        data = path.read_bytes()
        width, height = pngSize(data, path)
        if width != height or not 1 <= width <= 256:
            raise ValueError(f"{path} must be square and between 1 and 256 pixels")
        entries.append((width, data))

    if len({size for size, _ in entries}) != len(entries):
        raise ValueError("each ICO image must have a unique size")

    entries.sort()
    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = len(header) + 16 * len(entries)
    directory = bytearray()
    payload = bytearray()

    for size, data in entries:
        icoSize = 0 if size == 256 else size
        directory.extend(
            struct.pack("<BBBBHHII", icoSize, icoSize, 0, 0, 1, 32, len(data), offset)
        )
        payload.extend(data)
        offset += len(data)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(header + directory + payload)


if __name__ == "__main__":
    main()
