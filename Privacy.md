<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Konjugate Privacy Policy

Effective date: 5 November 2026

Konjugate is an open-source desktop application for building engineering simulations and digital twins, developed by Zenin Easa Panthakkalakath. This policy describes what the application does with your data. In short: Konjugate has no accounts, no analytics and no telemetry, and the developer does not receive any of your data.

## What the developer collects

Nothing. Konjugate does not ask you to sign in, does not send usage statistics, crash reports or analytics to the developer or to anyone else, and does not contain advertising.

## What stays on your computer

Your projects (`.kjt` files), simulation results, installed add-ons and plugins, application settings, and your AI assistant configuration are stored on your own computer, either where you choose to save them or in Konjugate's per-user application data folder. If you configure a hosted AI provider (see below), its API key is stored encrypted using your operating system's credential protection and is only ever sent to that provider. Nothing in this section is transmitted anywhere by Konjugate itself.

Project properties. A project can record who made it and on what terms: an owner, a copyright notice, a license, a contact and a short title and description, which you type in the Project properties window, and, if you set them, defaults for new projects in the same place. These details are stored inside the `.kjt` file (and your defaults in Konjugate's per-user application data folder, or in the browser's own storage in the web edition), and nowhere else. They travel with the file whenever you share, attach, upload or export it, so enter only what you are happy for its recipients to read. Konjugate never fills them in from your operating system account, your computer's name or any service you are signed in to, and has no accounts. The only values Konjugate writes into a project by itself are the time of its first save, the time of its last save (both read from your computer's clock) and the Konjugate version, which reveal when the file was worked on and are stored in the file like the rest. If you save a project encrypted you can also choose a short notice to show without the password, for example who to ask for it: that text, and only that text, is stored unencrypted in the file's header. These details are a notice for the people who receive the file; they do not stop anyone from copying or changing it, and encrypting the file is what keeps it private. Konjugate's own license does not apply to, and gives the developer no rights in, the models you create: they belong to you.

Simulations run locally. If you write an inline C++ or Python provider, your code is compiled or run on your own machine with the compiler or interpreter you have installed; it is not sent anywhere.

## Network requests Konjugate makes

Konjugate makes a small number of network requests to third-party services. None of them includes your projects or any personal information, but, as with any internet request, the service receiving it can see your IP address.

- **Update check.** When Konjugate starts, it asks GitHub's public releases API (`api.github.com`) whether a newer version exists. GitHub's privacy statement applies.
- **Add-on registry.** To show recommended add-ons, to browse the Discover tab of the Extensions window, to check installed add-ons for updates, and to download an add-on or plugin you choose to install, Konjugate fetches public files from GitHub (`api.github.com`, `raw.githubusercontent.com`, and the add-on's own GitHub repository). This includes the screenshots shown for an add-on, which are downloaded when you open its details. An add-on can also list video links; these are only links, and nothing is requested from the video site until you click one, when it opens in your web browser.
- **Welcome window.** It shows recent posts from the Konjugate blog (`www.konjugate.com`, which is hosted by Google Blogger, including the post thumbnails it serves from `blogger.googleusercontent.com`) and video thumbnails loaded from YouTube's image servers (`img.youtube.com`). It also fetches a small public "Featured" file from the Konjugate repository (`raw.githubusercontent.com`) that can announce a new video, a release or a labelled sponsored item, along with that item's picture, which is hosted in the same repository. The file is plain data, with no advertising network and no tracking of clicks or views. Opening a link from the Welcome window opens your web browser, where the destination site's own policy applies. The Welcome window remembers on this computer, and sends nowhere, which Featured items you dismissed, which tutorial videos you opened, and the last version whose release highlights it showed.

## The web edition

The desktop application above has no analytics. The web edition at `web.konjugate.com` counts page views with GoatCounter (`goatcounter.com`), an open-source counter that sets no cookies and stores nothing in your browser. Each visit sends GoatCounter the page address, the referring site, your browser and screen size, and a country derived from your IP address; your IP address is not stored, and nothing is used to follow you across visits or across other sites. Your projects never leave your browser, and neither do the Project properties defaults you set, which the web edition keeps in your browser's own storage; the visit counter does not see them. If your browser sends Do Not Track, or you block `gc.zgo.at`, no count is made.

## The AI assistant (optional, off until you configure it)

The model assistant only runs if you set up a model configuration yourself. It can use:

- **A local model (such as Ollama) on your own machine.** Requests go to a local address (by default `http://127.0.0.1:11434`) and do not leave your computer.
- **A hosted provider that you choose and supply your own API key for:** currently OpenAI, Google Gemini, NVIDIA NIM or Hugging Face. When you submit a request, Konjugate sends that provider the text of your request, your recent conversation history with the assistant (the last five exchanges), and a structured description of the model you are editing, which can include node and edge names, parameters, and equations. That provider receives and processes this data under its own terms and privacy policy, not this one. The details recorded in Project properties (owner, copyright, license, contact and save times) are not part of that description and are never sent. If you mark a project confidential, Konjugate asks before sending it to a hosted provider, once for each project you open, and sends nothing if you decline; a local model is not asked about, since nothing leaves your computer. Do not use a hosted provider with a model that contains information you are not permitted to share with it.

If you never configure the assistant, none of this happens.

## Exports

When you export simulation code or an FMU, the owner, copyright notice, license and contact from Project properties are written into the file you create (as comments at the top of the generated code, and as the author, copyright and license of the FMU), so that the people you give it to can see them. Nothing else about the project's details is added, and a project that names none produces no such lines. Exporting writes the file where you choose and sends it nowhere.

## Children

Konjugate is a general-purpose engineering tool and is not directed at children. It does not knowingly collect any personal information from anyone.

## Your choices

You can use Konjugate entirely offline apart from the update check, registry and Welcome-window requests above, which fail quietly if there is no connection. You can remove all locally stored data by uninstalling Konjugate and deleting its application data folder.

## Changes to this policy

If Konjugate's behavior changes in a way that affects this policy, this file will be updated and the effective date above changed. The full history is visible in the project's public repository.

## Contact

Questions or concerns can be raised by opening an issue at https://github.com/zenineasa/Konjugate/issues, or by email to info@konjugate.com. Konjugate's Help & feedback dialog shows that address and a message with your Konjugate version and system details already written in, for you to copy into an email yourself: Konjugate sends nothing, and does not open your email program.
