---
type: Proposal
title: The Welcome window as Konjugate's standing space
description: Design for the Welcome window as a surface people see at every launch — Learn by doing (the next in-app tutorials), a highlight for the newest video or an announcement that ages out on its own, one Watch library of every video, and the rules that keep it trustworthy and fast.
tags: [proposals, welcome, onboarding, content]
status: stable
implementation: complete
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# The Welcome window as Konjugate's standing space

**Status: built, all five steps.** Step 5 replaced the On-Ramp section and the dismissable Featured slot once the tutorials ran inside the app (see below). Written down before any code, like [How Konjugate gets updated](../updates.md), so the decisions can be reviewed first.

## The decision this rests on

The Welcome window opens at **every launch** (and on macOS dock reactivation with no window open), and that stays. It is deliberately the app's standing space: people get used to it, so there is somewhere to put the Konjugate tutorials now and, later, announcements, new videos and promotions. Everything below follows from taking that seriously. A window seen every day has to open instantly, close easily, stay worth looking at, and be trusted, which is different from a one-time first-run screen.

## What it is today

In order: the version heading, the Updates section, the "About" paragraphs from `docs/welcome.md`, the Discord badge, the License and copyright, the one-time recommended-add-ons offer (when there is one), the six On-Ramp videos ("Get started"), and recent blog posts. Three problems stand out. About and License sit in the middle of the page, between the intro and the videos. The window waits for the blog feed (an 8-second timeout) and the add-on registry before it opens at all, so an offline or slow start delays it. And the Discord badge is loaded from `img.shields.io` on every launch, a third-party request that [Privacy.md](../../Privacy.md) does not mention.

## Layout

From top to bottom, with conditional parts only when they apply:

1. **The heading and a compact status line:** "Konjugate 1.1.8 · up to date · Check for updates · All releases". It expands into the full Updates card only when there is an update, an error, or the Store message ([updates.md](../updates.md)). Today a full card sits here in the most common state, which is nothing to do.
2. **Recommended for you** — the existing one-time starter-pack offer; it is the only thing on the page that asks for an action, so it moves up.
3. **What's new in this version** — shown once per version, on the first launch after an update: two or three lines and a link to the release notes.
4. **New on the channel** — the highlight: one item, usually the newest video, that ages out on its own (below).
5. **Learn by doing** — the next three in-app tutorials this person has not done, and the whole list one click away (below). Always there.
6. **Watch** — every video, newest first, with the On-Ramp series as one card for its playlist (below).
7. **Recent from the blog.**
8. **Community & help:** Discord, Documentation, and **Help & feedback**, which closes the Welcome window and opens the Help & feedback dialog in the project window (the same one the button at the bottom of the left rail opens). The dialog offers two ways to report a problem, both with the report's sections and the system details (Konjugate version, operating system, install source, Electron and Chromium versions) already filled in so a report does not start with "which version?": by email, where it shows info@konjugate.com and the message in a text box with buttons to copy the address and to copy everything (no mailto: link, since most people have no mail program set up for one), and on GitHub, which opens the new-issue page with the details in its URL parameters.
9. **A footer:** one line about Konjugate, then "Mozilla Public License 2.0 · © 2026 Zenin Easa Panthakkalakath". The three "About" paragraphs shrink to that one line; the full text stays in the ReadMe.

## Learn by doing

The tutorials run inside Konjugate ([tutorials.md](tutorials.md)): the person builds the model themselves, step by step, and can skip any step. A tutorial ends with a model they built; a video ends with one they watched being built. So the page leads with tutorials, and the six On-Ramp episodes, which taught the same things as video (getting started, organising, live parameters, tuning, structure from data, the assistant), are no longer a section of their own.

- **The next three not yet done,** in the Tutorials list's order: Start here first, then each area in turn. A new person is offered the first-model tour, which replaced the page's separate tour card; someone further along is offered what comes after what they have done. Which tutorials are done is the `tutorialsCompleted` list the tutorials already keep.
- **Start** closes the Welcome window and starts that tutorial in the project window it belongs to, as an example guide's "Take the tutorial" does.
- **"See all N tutorials"** closes the Welcome window and opens the Tutorials list in the project window, with "k of N done" beside it once any are.
- **Always present.** When every tutorial is done the section says so, and the list is still a click away.

## The highlight and the Watch library

- **New on the channel** (the highlight) is one item under What's new. An item has an `id`, a `kind` (`announcement`, `video` or `sponsored`), a title, text, an optional image, a link, optional start and end dates, and optional "show at most N launches". One eligible item is shown at a time, highest priority first.
- **Nothing is dismissed.** A highlight ages out instead: by its end date (a new video is given one about a month after it was published), by its launch cap, or, for a single video, as soon as the person has opened it. The same video stays under Watch for good, so nothing is ever lost by being shown.
- **A video item brings its own picture.** A `video` item takes a plain YouTube watch link, and its card shows that video's thumbnail from YouTube's public thumbnail CDN, so nothing needs to be added to `welcome/images/`; an explicit `image` still wins. To highlight a whole playlist, give its `https://www.youtube.com/playlist?list=...` link and a `thumbnailVideoId`, the 11-character id of one of its videos (usually the first); the card is then labelled "New playlist on the channel" with a "Watch playlist" button. The picture and the title open the item, like the button.
- **Watch** is every video, newest first as `moreToWatch` lists them (up to 24), shorts mixed in, without the one the highlight is showing; then the On-Ramp series as one card for its playlist, from the bundled `assets/welcome/videos.json`. Nine are shown, the rest behind "Show all", then "More on YouTube" for the channel. A video the person has opened gets a quiet "Opened" mark, kept on this computer and sent nowhere; it only knows about clicks, so the wording is "opened", not "watched". A new upload is added to the top of `moreToWatch`, and given a highlight with an end date if it should be announced.
- **Contextual placement** keeps most videos where they belong as well: a causal-inference video on that feature's help page, a video per add-on in the Explorer (registry entries already support YouTube links), an example's video in its guide, a release demo in What's new.

## Trust rules for anything promotional

- **Anything paid is labelled "Sponsored".**
- **No ad networks, no tracking pixels, no click or impression tracking.** The feed is plain data.
- **Images are hosted in Konjugate's own repository and fetched by the main process** into data URLs (the way registry images already are), so the Welcome page's content-security policy gains no new hosts, and no third-party server learns that someone opened the app.
- **The feed is reviewed in git like the add-on registry:** a promotion cannot appear or change without a commit. An empty file is the kill switch.
- **Every new request is listed in Privacy.md before it ships.** That includes the existing gaps: the shields.io Discord badge (to be replaced by a local button, which also works offline) and the Blogger-hosted blog thumbnails.

## Opening fast and closing easily

The window opens **immediately** with the bundled content (Learn by doing, the On-Ramp card, the layout, the footer) and fills in the blog posts, the add-on offer, the highlight and the Watch videos as they arrive; a slow or absent network can no longer delay it. **Esc closes it.** (The window keeps its existing focus behaviour; Esc applies when it has focus.) If the feed fails, the last good copy is used, then the bundled default (empty), so it never shows an error to someone who only wanted to start working.

There is no "Show at startup" opt-out in this design. If it turns out people resent the window, that is the first thing to add.

## What is stored

One small file in the user data folder, `welcomeState.json`, written atomically like the update skip store: how many launches each highlighted item has had, the video ids that were opened (kept as `openedEpisodes`, its name from when only On-Ramp episodes could be), the tutorials completed, and the last version whose What's new was shown. Its `dismissedFeatured` list, from before step 5, is still read so an old file loads, but nothing uses it. Nothing identifies the person and nothing is sent anywhere.

## Order of work

1. **Foundations, no new content types:** open instantly and fill in as content arrives; Esc to close; the footer (About and License moved down); the Community & help row with Report a problem; the compact status line; replace the shields.io badge and fix Privacy.md.
2. **On-Ramp polish:** the section heading, the playlist link, the "opened" tick, "Show all" past eight.
3. **What's new:** the last-seen version, shown once per release.
4. **Featured and More to watch:** the feed format and where it is hosted, the repository-hosted images, caching and the bundled fallback, dismiss and launch caps, the Sponsored label.
5. **Tutorials first, nothing to dismiss:** Learn by doing in place of the On-Ramp section and the tour card; the highlight ages out by date, launch cap or being opened, and cannot be dismissed; one Watch library with the On-Ramp as a playlist card.

Each step leaves the window working. The state file arrives with step 2 (opened episodes) and grows from there.

## Decisions on the open questions

- **Where the feed is hosted:** the repository, `welcome/featured.json` and `welcome/images/`, fetched from `raw.githubusercontent.com` (override with `KONJUGATE_WELCOME_FEED_URL`). It is never bundled in the app; the last good copy is cached in the user data folder.
- **What counts as a launch:** only automatic opens (app start and macOS dock reactivation). Clicking the Konjugate button does not use up a launch cap.
- **Sponsored items:** like any other item, they cannot be dismissed (since step 5), so a sponsored item should always carry an end date or a launch cap.
