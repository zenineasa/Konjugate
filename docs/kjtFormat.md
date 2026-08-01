<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# KJT container format, version 1

All integer fields are unsigned and big-endian. Limits are part of the format contract.

| Offset | Size | Meaning |
| --- | ---: | --- |
| 0 | 4 | ASCII magic `KJTF` |
| 4 | 1 | Container version, currently `1` |
| 5 | 1 | Flags: bit 0 gzip, bit 1 AES-256-GCM |
| 6 | 4 | UTF-8 JSON header length, maximum 65,536 bytes |
| 10 | variable | JSON header |
| following | variable | Encoded payload |

The decoded payload is a UTF-8 project document. The maximum decoded size is 1 GiB.

For gzip-only files, the header is `{"compression":"gzip"}` and the payload is gzip data.

For encrypted files, gzip is applied before encryption. The header additionally contains:

- `kdf`: scrypt with a 16-byte Base64 salt, cost 2^14 through 2^18, block size 8, parallelization 1 through 4, and a 32-byte derived key.
- `cipher`: AES-256-GCM with a 12-byte Base64 IV and 16-byte Base64 authentication tag.

`.kjt` is the only supported project-file format. Readers reject every other extension and any `.kjt` file without a valid versioned `KJTF` container.
