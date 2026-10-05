---
type: Reference
title: Package registry
description: Specification for package namespace prefixes, cryptographic key verification, and registry index files.
tags: [registry, security, crypto, packages]
status: stable
---

# Package registry

Every Konjugate package (`.kja` add-on, `.kjp` plugin) has a dot-namespaced id, like `konjugate.fintech.toolbox` — the same shape as a Java reverse-DNS package name or an npm scope. The `registry/` directory reserves a prefix of that namespace (its first segment or two) to a publisher, one JSON file per prefix, so a package id claiming to belong to a given author can be checked against a public key that author controls, via `signPackageArchive`/`verifyPackageArchive` in [`src/packageArchive.mjs`](../src/packageArchive.mjs). The same file also carries whatever a publisher wants to say about the prefix for discovery purposes — see Fields, below — loaded together by `loadNamespaceRegistry`.

This design, and the fuller "Extensions Explorer" it's the foundation for, is described in [docs/extensionsExplorer.md](extensionsExplorer.md); this document is the narrower, practical one — how to actually reserve a prefix and sign a package.

## What this is, and isn't

This is a namespace registry, not an app store review. Reserving a prefix here doesn't grant permission to publish, doesn't vet the quality or safety of anything published under it, and isn't required to write or distribute a Konjugate plugin at all — an unclaimed prefix, or a claimed prefix whose packages aren't signed, works exactly as it does today. What reservation adds is a way for a package's *identity claim* to be checkable: if `konjugate.fintech.toolbox` is signed with a key registered here under `konjugate.fintech`, a user (or the app) can confirm the package claiming that identity actually controls the key associated with it. Nothing in Konjugate's install or run path *requires* this check to pass, or even to exist — see the note on `verifyPackageArchive` in `packageArchive.mjs` for why that's deliberate: an unsigned or unverifiable package installs and runs exactly as it always has. This is a trust signal, not a gate.

## Reserving a prefix

Open a pull request adding `registry/<your-prefix>.json` (e.g. `registry/your.prefix.json`):

```json
{
    "format": "konjugate-namespace-entry",
    "formatVersion": 1,
    "owner": "Your name or organization",
    "contact": "A URL or address someone can reach you at",
    "publicKeys": ["-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"]
}
```

`owner`, `contact`, and `publicKeys` are the only required fields — an entry with just these three reserves the prefix without listing it anywhere for discovery, which is the intended way to express "reserved but private," not a gap to fill in another way.

- `publicKeys` is a list (not a single key) so a key can be rotated by adding the new one alongside the old, rather than needing every already-signed package re-signed atomically the moment a key changes.
- Reservations are first-come, first-served, reviewed the way any pull request is — there's no separate approval process beyond that, and it won't scale indefinitely if the ecosystem actually grows, but that's worth revisiting once volume makes it a real bottleneck, not before.
- A prefix must not already be reserved, or be a parent/child of one that is, by a different owner (`konjugate.fintech` and `konjugate.fintech.markets` can't be reserved by two different people — the longer prefix would make the shorter one's signature claim ambiguous).
- You don't need to reserve a prefix to publish under it. You need to reserve it if you want packages under it to be checkable as genuinely yours.

### Fields for discovery (all optional)

Add any of these to also make the prefix discoverable, once there's an Explorer to show it (see [docs/extensionsExplorer.md](extensionsExplorer.md)):

- `title`, `description` — human-readable.
- `license` — an SPDX identifier or expression, not a plain open-source boolean (a boolean can't say "AGPLv3 and also a commercial option"; SPDX's `OR` syntax can: `AGPL-3.0-or-later OR LicenseRef-Commercial`). Pair with `commercialLicenseUrl` if there's a separate commercial option to point at.
- `domain` — reuses the app's existing example-domain vocabulary (`finance`, `robotics`, `mechanical`, ...).
- `url` — one link to the project, typically its repository.
- `packages` — the package(s) this prefix's reservation covers, each `{ "packageType": "addon" | "plugin", "packageId": "..." }`. Every listed `packageId` must actually fall under this entry's own prefix — a registry entry can't name another prefix's package (see the Multi-package bundles section of `docs/extensionsExplorer.md` for why: it would let one entry borrow another's verified status by association).
- `image` — a cover picture for the entry: the thumbnail beside it in Discover and Installed, the picture at the top of its detail pane, and its card on konjugate.com's toolbox gallery. Commit the file to this registry's own `images/` directory in the same pull request as the entry and name it there (`"image": "images/example.fintech.webp"`); a URL, or a path anywhere else, is rejected. Keeping it here rather than in the publisher's repository means the picture is reviewed along with the entry and can't be swapped for something else afterwards, and it ships inside the app, so Discover shows it with no network access at all. PNG, JPEG or WebP, at most 512 KB; aim for a 1280×720 WebP under 300 KB, cropped to the model itself rather than the whole window, since it's shown as small as 72 px wide. **To change an image, commit it under a new file name** and point `image` at that: an app keeps showing the copy it shipped with for as long as the entry names the same file. An entry without one shows its initial instead. Images not bundled with an installed release (an entry published after it) are downloaded from this repository and cached for a day (see the `packageRegistryImage` handler in `src/main.mjs`), so the project window's `img-src 'self' data:` policy stays as strict as it is. `scripts/verifyPackagedRegistry.mjs` checks, after every packaging run, that every file here made it into the app.
- `screenshots` — pictures of the add-on at work, shown as a strip of thumbnails (each expands when clicked) in Discover's detail pane: a list of one to six `{ "image": "screenshots/example.fintech.1.webp", "caption": "..." }`, where every `image` is a file in this registry's own `screenshots/` directory (not `images/`) and every `caption` (at most 140 characters) is required, because it is also the picture's alternative text. They are committed in the same pull request as the entry, for the same reason `image` is: reviewed with it and not swappable afterwards. PNG, JPEG or WebP, at most 512 KB each, so the same advice applies (a WebP around 1280×720 under 300 KB, cropped to the model rather than the whole window). Unlike `image`, screenshots are **not bundled with the app**: they only matter next to an Install button, which needs the network anyway, so Konjugate downloads them when an entry's detail pane is opened and caches them for a day (see the `packageRegistryScreenshot` handler in `src/main.mjs`), and a screenshot that can't be downloaded simply doesn't appear. `scripts/packageElectron.mjs` leaves `registry/screenshots/` out of the packaged app on purpose, and `scripts/verifyPackagedRegistry.mjs` still checks that every screenshot an entry names exists. To change a screenshot, commit it under a new file name.
- `videos` — links to videos about the add-on, shown as a "Videos" list in Discover's detail pane: a list of one to four `{ "title": "...", "url": "https://www.youtube.com/watch?v=..." }`. Only YouTube's two plain watch-link forms are accepted (`https://www.youtube.com/watch?v=<11-character id>` and `https://youtu.be/<id>`), with nothing after the video id, so an entry can't link a playlist, a redirect or any other page. A video is only a link: Konjugate never embeds or fetches it, so nothing is requested from YouTube until a person clicks one, and it opens in their own browser (the main process re-checks the link against the entry it already knows before opening it, so the app window never supplies a URL itself).
- `downloadUrl` — where to get every package `packages` lists, as one archive (in the common case, a release zip containing all of them — see `docs/extensionsExplorer.md`'s Multi-package bundles section on why a bundle is one download, not one per package).
- `recommended` — `true` to appear in the Welcome window's one-time starter-pack offer (see the Recommended add-ons section of `docs/extensionsExplorer.md`). Requires `downloadUrl` and `packages` to already be set, same as any other installable entry — there's nothing to recommend installing otherwise.

## Signing a package

```js
import { signPackageArchive } from './src/packageArchive.mjs';
const signed = signPackageArchive(archiveBytes, { privateKey: privateKeyPem, prefix: 'your.prefix' });
```

The private key never appears in this repository — only the corresponding public key does, in the registry entry. Keep the private key wherever you keep other release secrets (a CI secret store, for instance); losing it means registering a new key here, not recovering the old one.

## Loading the registry

```js
import { loadNamespaceRegistry, verifyPackageArchive } from './src/packageArchive.mjs';
const namespaces = await loadNamespaceRegistry('registry');
const result = verifyPackageArchive(archiveBytes, { namespaces });
```

`loadNamespaceRegistry` reads every `*.json` file in the given directory, keyed by each file's own name (minus `.json`) rather than anything declared inside it — the prefix is where the file lives, not a field that could disagree with it. It throws on a malformed entry rather than skipping it silently, so a broken registry entry fails loudly in review or CI, not invisibly.
