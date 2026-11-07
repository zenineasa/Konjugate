# Technical Proposals

* [Web Edition](webEdition.md) - WebAssembly and web-worker architecture for running Konjugate in the browser
* [Web Edition Packages](webEditionPackages.md) - Installing and running add-ons and plugins in the web edition: storage, a sandbox for third-party code, a mirrored registry, and a staged plan
* [Numerical Stability Diagnostics](numericalStabilityDiagnostics.md) - Runtime stability monitoring, divergence detection, and convergence checks
* [Causal Inference Input Replay](causalInferenceInputReplay.md) - Replaying external time series inputs through candidate relationships
* [Causal Inference Interaction Terms](causalInferenceInteractionTerms.md) - Multi-variable interaction term discovery
* [Causal Inference Design](causalInference.md) - Original design proposal for continuous-time causal inference
* [Continuous Time Conversion](continuousTimeConversion.md) - Converting discrete empirical coefficients to continuous-time differential equations
* [Launcher Add-ons](launcherAddons.md) - Sandbox host and permissions model for launcher add-on extensions
* [Component Library](componentLibrary.md) - Declarative library of reusable engineering components and ports
* [OpenStreetMap Traffic Simulation](openStreetMapTrafficSimulation.md) - Geographic network import and traffic twin simulation
* [In-App Auto-Updates](autoUpdates.md) - Background update checking and differential updates
* [Welcome Window](welcomeWindow.md) - The Welcome window as a standing space: the permanent On-Ramp tutorials, a time-limited Featured slot, and the trust rules for promotions
* [Guided Tour](guidedTour.md) - An optional, skippable first-model tour for the desktop and web editions, offered on first launch and from the Welcome window
* [Parameter Tuning Objectives](parameterTuningObjectives.md) - Tuning against a user-written objective (minimise or maximise) as well as measured data, and progress, estimates and stop-and-keep-best while a tuning runs
* [Tuning Editors and Programs](tuningEditorsAndPrograms.md) - The tuning objective in the shared equation editor, objectives written as C++ or Python programs, and the shared classes behind both
* [Digital Twin Connections](digitalTwinConnections.md) - How a running model reads the data a lab already records: Konjugate as a client of the lab's files, broker or server, the engine work that comes first, detaching into a sandbox, and proving it on a real recording
* [Live Engine Session](liveEngineSession.md) - Step 2 of the digital twin: an engine that stays running for a whole session and is driven to advance, rewind to a checkpoint with measured states replaced, and take input readings as they arrive, proved against the engine as it is
* [Prediction-Actual Comparison Window](predictionActualWindow.md) - A moving window in which a running model is reset to the measurements each time it moves, drift is watched through the size of those resets, and the speed budget keeps the model ahead of the data
* [Push Service](pushService.md) - Built: the fallback way into a live twin: a service a lab's own script sends readings to as JSON or protobuf over HTTP or a WebSocket, or over gRPC, with a named key per script, local by default and encrypted on the network
* [State Estimator](stateEstimator.md) - Built: an ensemble Kalman filter for the live twin, so readings correct the states nobody measures, the model is weighed against the sensors, and the forecast carries a band
* [The Twin's Control Room](controlRoom.md) - A live twin presented as a control room expects: a short setup naming the model, the source and the mapping (suggested by rules and memory, units converted and proposed), then a window of its own with a tile for every measured signal, an operator view by default and an engineer's to take over
* [Package Compatibility](packageCompatibility.md) - Minimum Konjugate version for packages, and installing the newest release the running app can use
* [Toolbox Mechanisms and Design Optimisation](toolboxMechanismsAndDesignOptimisation.md) - Toolbox-owned regions of a model rebuilt by merging, providers that solve a group of nodes and edges together, and optimisation towards a design objective with constraints
* [Model Ownership](modelOwnership.md) - Owner, copyright, license and contact details saved inside a project, with per-user defaults, a per-save override, export mapping and the privacy policy changes they need
* [Embedded Assistant Model](embeddedAssistantModel.md) - A small open model fine-tuned for the assistant and shipped inside the app through llama.cpp, with the decisions so far, the evidence from the evaluation harness, and the gates it must pass
