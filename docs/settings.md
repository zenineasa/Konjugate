---
type: Guide
title: Settings
description: The Settings sheet, its pages and what each keeps on this computer, how it opens and searches, how changes are kept, and how a page is added.
tags: [settings, preferences, user-interface]
status: stable
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Settings

Settings holds what belongs to the person using Konjugate, kept on this computer: never what belongs to a project. Add-ons and plugins are not in it either: the [Extensions Explorer](extensionsExplorer.md) is a place to browse and install, with a button of its own in the titlebar beside Settings (and in the tool rail). A project's own owner, copyright and license are in **Project properties**, its run settings in the **Run** dialog, and its data connections in **Connections**; they travel with the project, while Settings stays with the person from one project to the next.

## Opening it

**⚙** in the titlebar, or **⌘,** on macOS and **Ctrl+,** elsewhere, opens Settings where it was last (General the first time). Other places open it on the page they are about: the model assistant's ⚙ opens **Model assistant**, the push service's chip and the twin window's link open **Push service**, and **Defaults for new projects…** in Project properties opens **New projects** and returns to Project properties when Settings is closed.

The pages are down the left and the open page on the right, as an operating system's settings are laid out. The search box above the pages finds a page by its title, by the words it is about (searching *midi* finds Controllers, *python* finds Providers) or by what the page says; **Enter** opens the first page found, and the arrow keys move along the list. **Escape** or **×** closes it. On a phone, Settings opens on the list of pages; a page has **‹ Settings** to go back to the list, and Escape goes back too.

## The pages

| Page | What it keeps | Where |
| --- | --- | --- |
| General | The version shown; the interface size, as A− and A+ in the titlebar set it; the Welcome window and the guided tour, opened again. | The interface size is the window's own. |
| Model assistant | The model configurations the assistant uses: provider, endpoint, model, API key, timeout ([Model assistant guide](aiAssistantGuide.md#model-configurations)). | `ai/` in the user's data folder, the keys encrypted by the operating system. |
| Providers | The C++ compiler and Python interpreter that build and run inline providers, and the C++ provider execution mode ([Provider execution](providerExecution.md)). | `providers/toolchains.json` |
| Controllers | Gamepad, MIDI and keyboard bindings to live parameters, and how big a change of a moving control must be to be recorded ([Steering by hand](resultExploration.md#steering-by-hand)). | `inputBindings.json` |
| Push service | The service a lab's own script sends readings to for a live twin: its port, whether it listens on the network (encrypted, with its certificate), the keys each script uses, and examples to copy ([Connecting a data source](connectingADataSource.md)). Start and Stop are here too; while it listens, a chip in the toolbar says so and opens this page. Desktop only: a web page cannot listen on a port. | `push/` in the user's data folder |
| New projects | The owner, copyright notice, license and contact a new project starts with, and whether it starts confidential ([Model ownership](proposals/modelOwnership.md)). | `ownershipDefaults.json` |

The web edition keeps the same things in the browser's own storage, for that browser only.

## How changes are kept

A change is kept as it is made, with no Save button, as an operating system's settings are. A compiler or interpreter path is checked before it is kept, and says beside it when it could not be; blank goes back to the one found on the machine. The defaults for new projects are kept a moment after the last key, and at once when Settings closes. The one exception is a model configuration: its API key is stored only when **Save configuration** is pressed, so that page keeps its Save and Test buttons, and leaving it with changes not saved asks first.

## Adding a page

The pages are listed once, in `src/renderer/settingsPages.mjs` (id, title, icon, the words a search finds it by, and what a window must have to offer it, such as the push service); the sidebar, its search and the phone's list are made from that list. A page's content is a `<section data-settings-page="id">` in `src/renderer/index.html`, and the window says what it does when it is shown in the `opened` hooks given to `createSettingsSheet` (`src/renderer/settingsSheet.mjs`). `openSettings('id')` opens Settings on it from anywhere. A setting that belongs to a project does not go here.
