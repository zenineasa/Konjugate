---
type: Proposal
title: The Welcome window as Konjugate's standing space
description: Design for the Welcome window as a surface people see at every launch — the permanent On-Ramp tutorials, a time-limited Featured slot for announcements and promotions, and the rules that keep both trustworthy and fast.
tags: [proposals, welcome, onboarding, content]
status: implemented
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# The Welcome window as Konjugate's standing space

**Status: built, all four steps.** Written down before any code, like [How Konjugate gets updated](../updates.md), so the decisions can be reviewed first.

## The decision this rests on

The Welcome window opens at **every launch** (and on macOS dock reactivation with no window open), and that stays. It is deliberately the app's standing space: people get used to it, so there is somewhere to put the Konjugate tutorials now and, later, announcements, new videos and promotions. Everything below follows from taking that seriously. A window seen every day has to open instantly, close easily, stay worth looking at, and be trusted, which is different from a one-time first-run screen.

## What it is today

In order: the version heading, the Updates section, the "About" paragraphs from `docs/welcome.md`, the Discord badge, the License and copyright, the one-time recommended-add-ons offer (when there is one), the six On-Ramp videos ("Get started"), and recent blog posts. Three problems stand out. About and License sit in the middle of the page, between the intro and the videos. The window waits for the blog feed (an 8-second timeout) and the add-on registry before it opens at all, so an offline or slow start delays it. And the Discord badge is loaded from `img.shields.io` on every launch, a third-party request that [Privacy.md](../../Privacy.md) does not mention.

## Layout

From top to bottom, with conditional parts only when they apply:

1. **The heading and a compact status line:** "Konjugate 1.1.8 · up to date · Check for updates · All releases". It expands into the full Updates card only when there is an update, an error, or the Store message ([updates.md](../updates.md)). Today a full card sits here in the most common state, which is nothing to do.
2. **Recommended for you** — the existing one-time starter-pack offer; it is the only thing on the page that asks for an action, so it moves up.
3. **What's new in this version** — shown once per version, on the first launch after an update: two or three lines and a link to the release notes.
4. **Featured** — one time-limited item (below).
5. **Learn Konjugate: the On-Ramp** — the six tutorial episodes (below). Permanent.
6. **More to watch** — other videos, newest first (below).
7. **Recent from the blog.**
8. **Community & help:** Discord, Documentation, and **Report a problem**, which opens GitHub's new-issue page with the report's sections and the system details (Konjugate version, operating system, install source, Electron and Chromium versions) already filled in through the page's URL parameters, so a report does not start with "which version?".
9. **A footer:** one line about Konjugate, then "Mozilla Public License 2.0 · © 2026 Zenin Easa Panthakkalakath". The three "About" paragraphs shrink to that one line; the full text stays in the ReadMe.

## The On-Ramp series is permanent

The six On-Ramp episodes are the tutorial, and people come back to refer to it. So this section never rotates, collapses, hides itself or gets replaced, however many launches have passed. Its list stays in the bundled `assets/welcome/videos.json`, whose order is the display order, and it renders from that file even if every network feed fails. Nothing except adding an episode there changes it. Its position stays predictable too: the only things above it are the compact status line and the optional Featured and What's new items.

- **A quiet "opened" tick** on an episode the person has clicked, kept on this computer and sent nowhere. It helps people working through the series. It only knows about clicks, not watching, so the wording is "opened", not "watched".
- **A "Watch the full playlist" link,** since the series already has one.
- **"Show all" after eight episodes.** If the series grows past eight, the first row is shown with a link to the rest, in the same order; it is never reordered.

## Other videos, announcements and promotions go elsewhere

- **Featured** is a single slot under What's new. An item has an `id`, a `kind` (`announcement`, `video` or `sponsored`), a title, text, an optional image, a link, optional start and end dates, and optional "show at most N launches". One eligible item is shown at a time, highest priority first.
- **More to watch** is a short row of non-tutorial videos, newest first. A video that leaves the Featured slot lands here, and never in the On-Ramp section.
- **Contextual placement** keeps most videos out of the Welcome window altogether: a causal-inference video on that feature's help page, a video per add-on in the Explorer (registry entries already support YouTube links), an example's video in its guide, a release demo in What's new.

A promotion that outlives its usefulness turns invisible, so the slot has rules: every item can have an end date, an item can be capped at N launches, and **dismissing an item is remembered** and not shown again.

## Trust rules for anything promotional

- **Anything paid is labelled "Sponsored".**
- **No ad networks, no tracking pixels, no click or impression tracking.** The feed is plain data.
- **Images are hosted in Konjugate's own repository and fetched by the main process** into data URLs (the way registry images already are), so the Welcome page's content-security policy gains no new hosts, and no third-party server learns that someone opened the app.
- **The feed is reviewed in git like the add-on registry:** a promotion cannot appear or change without a commit. An empty file is the kill switch.
- **Every new request is listed in Privacy.md before it ships.** That includes the existing gaps: the shields.io Discord badge (to be replaced by a local button, which also works offline) and the Blogger-hosted blog thumbnails.

## Opening fast and closing easily

The window opens **immediately** with the bundled content (the On-Ramp, the layout, the footer) and fills in the blog posts, the add-on offer and the Featured item as they arrive; a slow or absent network can no longer delay it. **Esc closes it.** (The window keeps its existing focus behaviour; Esc applies when it has focus.) If the Featured feed fails, the last good copy is used, then the bundled default (empty), so it never shows an error to someone who only wanted to start working.

There is no "Show at startup" opt-out in this design. If it turns out people resent the window, that is the first thing to add.

## What is stored

One small file in the user data folder, `welcomeState.json`, written atomically like the update skip store: the Featured ids that were dismissed, how many launches each shown item has had, the episode ids that were opened, and the last version whose What's new was shown. Nothing identifies the person and nothing is sent anywhere.

## Order of work

1. **Foundations, no new content types:** open instantly and fill in as content arrives; Esc to close; the footer (About and License moved down); the Community & help row with Report a problem; the compact status line; replace the shields.io badge and fix Privacy.md.
2. **On-Ramp polish:** the section heading, the playlist link, the "opened" tick, "Show all" past eight.
3. **What's new:** the last-seen version, shown once per release.
4. **Featured and More to watch:** the feed format and where it is hosted, the repository-hosted images, caching and the bundled fallback, dismiss and launch caps, the Sponsored label.

Each step leaves the window working. The state file arrives with step 2 (opened episodes) and grows from there.

## Decisions on the open questions

- **Where the Featured feed is hosted:** the repository, `welcome/featured.json` and `welcome/images/`, fetched from `raw.githubusercontent.com` (override with `KONJUGATE_WELCOME_FEED_URL`). It is never bundled in the app; the last good copy is cached in the user data folder.
- **What counts as a launch:** only automatic opens (app start and macOS dock reactivation). Clicking the Konjugate button does not use up a launch cap.
- **Sponsored items:** dismissible like any other, and the dismissal is remembered per item id.
