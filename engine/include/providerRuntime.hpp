/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include "executionPlan.hpp"
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace konjugate {

// Chosen internally by the engine (via ProviderConfiguration), never surfaced as an
// end-user-facing setting. pipeWorker is the always-available default. sharedMemoryWorker cuts
// per-evaluation round-trip latency for cppProvider tasks but is POSIX-only. inProcess is
// fastest still (no IPC at all — the provider is dlopen'd/LoadLibrary'd directly into the
// engine) but gives up process isolation entirely: a crash or hang in the provider's own code
// takes the whole engine down, so this is meant to stay an explicit opt-in for trusted/vetted
// providers, never a default. ProviderRuntime falls back down this list (inProcess ->
// sharedMemoryWorker -> pipeWorker) for a given provider process if a higher tier fails to
// start, so a single unsupported/misconfigured host never blocks a whole run.
enum class ProviderExecutionMode { pipeWorker, sharedMemoryWorker, inProcess };

struct ProviderConfiguration {
    std::string cppCompiler;
    std::string cppSdkPath;
    std::string pythonInterpreter;
    std::string pythonSdkPath;
    std::string buildDirectory;
    ProviderExecutionMode executionMode = ProviderExecutionMode::pipeWorker;
};

class ProviderBackend;

// A hazard of the older program format that changes no number but is worth saying (docs/proposals/programSdkV2.md,
// decision 8). "inputUnbound": a declared input of the program at entityIds[0] (an edge, a source term or a node) has no
// binding, so it reads 0; `port` names it. "sharedCheckpoint": a Python node program serves the nodes in entityIds from one
// object and returned a non-empty checkpoint(), so they share its memory. The engine knows only ids; the app names them.
struct ProgramWarning {
    std::string code;
    std::vector<EntityId> entityIds;
    std::string port;
    ContributionImplementation implementation = ContributionImplementation::pythonProvider;
};

class ProviderRuntime final : public ProviderEvaluator {
public:
    explicit ProviderRuntime(ProviderConfiguration configuration);
    ~ProviderRuntime();

    ProviderRuntime(const ProviderRuntime&) = delete;
    ProviderRuntime& operator=(const ProviderRuntime&) = delete;

    void initialize(const ExecutionPlan& plan);

    std::vector<double> evaluateBatch(const std::vector<const ContributionTask*>& tasks,
                                      const std::vector<std::span<const double>>& inputs,
                                      double simulationTime,
                                      double stepSize) override;

    std::vector<std::pair<std::string, double>> evaluateNode(const NodeProviderTask& task,
                                                              std::span<const double> inputs,
                                                              double simulationTime,
                                                              double stepSize) override;
    std::vector<std::byte> requestNodeCheckpoint(const NodeProviderTask& task) override;
    void requestNodeRestore(const NodeProviderTask& task, std::span<const std::byte> payload) override;

    void shutdown() noexcept;

    // The warnings found so far: unbound inputs once the programs have started, a shared checkpoint once one is taken.
    const std::vector<ProgramWarning>& warnings() const noexcept { return warnings_; }

private:
    void recordInstance(EntityId entityId, const std::string& processKey, ContributionImplementation implementation,
                        const std::vector<CompiledBinding>& bindings);
    void noteUnboundInputs();

    struct InstanceRecord {
        EntityId entityId = 0;
        std::string processKey;
        ContributionImplementation implementation = ContributionImplementation::pythonProvider;
        std::vector<std::string> boundKeys;
    };
    std::vector<InstanceRecord> instanceRecords_;
    std::unordered_map<std::string, std::vector<EntityId>> nodesByProcess_;
    std::vector<std::string> sharedCheckpointWarned_;
    std::vector<ProgramWarning> warnings_;

    ProviderConfiguration configuration_;
    std::unordered_map<std::string, std::unique_ptr<ProviderBackend>> processes_;
    std::unordered_map<EntityId, std::uint64_t> taskInstanceIds_;
    std::uint64_t nextInstanceId_ = 1;
    bool initialized_ = false;
    bool shutdown_ = false;
};

bool planRequiresProviders(const ExecutionPlan& plan);

}
