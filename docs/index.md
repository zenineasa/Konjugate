---
title: Konjugate Documentation
okf_version: "0.2"
---

# Specifications & Formats

* [Project Document Schema](projectSchema.md) - Version 1 project schema for .kjt models, nodes, edges, equations, and subsystems
* [KJT Container Format](kjtFormat.md) - Binary container format specification for Konjugate project files
* [Embedded Result Storage](resultFileFormat.md) - Binary simulation result segment format embedded within .kjt files
* [Code & FMU Export](codeExport.md) - Specification for standalone C++ and FMI 2.0/3.0 FMU simulation code generation

# Core Architecture

* [Protobuf Architecture](protobufArchitecture.md) - IPC protocol and streaming transport between the desktop application and native simulation engine
* [Engine Job Protocol](jobProtocol.md) - Live control and event streaming contract for engine runs
* [AI Provider Architecture](aiProviderArchitecture.md) - Architecture for local (Ollama) and hosted (OpenAI, Gemini, NIM, HuggingFace) model providers
* [Parallel Execution](parallelExecution.md) - Native execution backends: serial loop, shared thread pool, and communication-aware partitions
* [Provider Execution Transports](providerExecution.md) - Runtime execution and IPC options for user-defined C++ and Python providers
* [Subsystems](subsystems.md) - Authoring-hierarchy container model and automatic boundary port resolution
* [Edge Groups](edgeGroups.md) - Shared relationship definitions expanding into a mesh of edges across member nodes
* [Edge Directionality](edgeDirectionality.md) - Directed relationship pairs and conservative physical exchange semantics

# Developer & Contributor Guides

* [Development Setup](developmentSetup.md) - Prerequisites, toolchain setup, and build instructions for Konjugate core and native engine
* [Add-on Development](addonDevelopment.md) - Building launcher and visualizer add-ons (.kja) with the visualizer bridge and window state
* [Plugin Development](pluginDevelopment.md) - Authoring .kjp packages with numerical behavior and declarative component templates
* [Package Development](packageDevelopment.md) - Building and distributing portable .kja and .kjp packages
* [Package Registry](registry.md) - Publisher key registration, namespace prefixes, and cryptographic archive signing
* [Package Manager Distribution](packageManagerDistribution.md) - Packaging and automated distribution for Homebrew, Flathub, and Windows stores
* [Release Packaging](releasePackaging.md) - Platform packaging and release pipeline for desktop DMGs, EXEs, and AppImages
* [How Konjugate Gets Updated](updates.md) - Who updates each install channel, what the in-app update notice does, and the Store and AppImage decisions

# Modeling & User Guides

* [Model Assistant Guide](aiAssistantGuide.md) - Using the natural-language assistant to propose structured graph operations
* [Graph Selection & Editing](graphEditing.md) - Canvas navigation, multi-node movement, and clipboard interactions
* [Result Exploration](resultExploration.md) - Paced playback, parameter interventions, and scenario branching
* [Causal Inference](causalInference.md) - Structure discovery and parameter tuning from measured time-series data
* [Extensions Explorer](extensionsExplorer.md) - Discovering, installing, and managing extensions from the registry
* [Hello World Add-on](helloWorldAddon.md) - Walkthrough of the minimal visualizer add-on
* [Welcome](welcome.md) - Getting started overview and community links
* [Causal Inference Help](causalInferenceInteractionHelp.md) - Interactive help documentation for structure discovery

# References & Strategy

* [Engine CLI Contract](engineCli.md) - CLI commands, arguments, exit codes, and headless execution contract
* [Interaction Providers](interactionProviders.md) - Detailed contract for numerical step execution and algebraic terms
* [Product Strategy](productStrategy.md) - Long-term product roadmap and engineering foundations

# Technical Proposals

* [Proposals Index](proposals/index.md) - Technical RFCs and architectural proposals for Konjugate
