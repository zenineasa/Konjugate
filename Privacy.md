<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Konjugate Privacy Policy

Effective date: 5 October 2026

Konjugate is an open-source desktop application for building engineering simulations and digital twins, developed by Zenin Easa Panthakkalakath. This policy describes what the application does with your data. In short: Konjugate has no accounts, no analytics and no telemetry, and the developer does not receive any of your data.

## What the developer collects

Nothing. Konjugate does not ask you to sign in, does not send usage statistics, crash reports or analytics to the developer or to anyone else, and does not contain advertising.

## What stays on your computer

Your projects (`.kjt` files), simulation results, installed add-ons and plugins, application settings, and your AI assistant configuration are stored on your own computer, either where you choose to save them or in Konjugate's per-user application data folder. If you configure a hosted AI provider (see below), its API key is stored encrypted using your operating system's credential protection and is only ever sent to that provider. Nothing in this section is transmitted anywhere by Konjugate itself.

Simulations run locally. If you write an inline C++ or Python provider, your code is compiled or run on your own machine with the compiler or interpreter you have installed; it is not sent anywhere.

## Network requests Konjugate makes

Konjugate makes a small number of network requests to third-party services. None of them includes your projects or any personal information, but, as with any internet request, the service receiving it can see your IP address.

- **Update check.** When Konjugate starts, it asks GitHub's public releases API (`api.github.com`) whether a newer version exists. GitHub's privacy statement applies.
- **Add-on registry.** To show recommended add-ons, to browse the Add-on Explorer, to check installed add-ons for updates, and to download an add-on or plugin you choose to install, Konjugate fetches public files from GitHub (`api.github.com`, `raw.githubusercontent.com`, and the add-on's own GitHub repository).
- **Welcome window.** It shows recent posts from the Konjugate blog (`www.konjugate.com`, which is hosted by Google Blogger) and video thumbnails loaded from YouTube's image servers (`img.youtube.com`). Opening a link from the Welcome window opens your web browser, where the destination site's own policy applies.

## The AI assistant (optional, off until you configure it)

The model assistant only runs if you set up a model configuration yourself. It can use:

- **A local model (such as Ollama) on your own machine.** Requests go to a local address (by default `http://127.0.0.1:11434`) and do not leave your computer.
- **A hosted provider that you choose and supply your own API key for:** currently OpenAI, Google Gemini, NVIDIA NIM or Hugging Face. When you submit a request, Konjugate sends that provider the text of your request, your recent conversation history with the assistant (the last five exchanges), and a structured description of the model you are editing, which can include node and edge names, parameters, and equations. That provider receives and processes this data under its own terms and privacy policy, not this one. Do not use a hosted provider with a model that contains information you are not permitted to share with it.

If you never configure the assistant, none of this happens.

## Children

Konjugate is a general-purpose engineering tool and is not directed at children. It does not knowingly collect any personal information from anyone.

## Your choices

You can use Konjugate entirely offline apart from the update check, registry and Welcome-window requests above, which fail quietly if there is no connection. You can remove all locally stored data by uninstalling Konjugate and deleting its application data folder.

## Changes to this policy

If Konjugate's behavior changes in a way that affects this policy, this file will be updated and the effective date above changed. The full history is visible in the project's public repository.

## Contact

Questions or concerns can be raised by opening an issue at https://github.com/zenineasa/Konjugate/issues.
