/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include "executionPlan.hpp"
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace konjugate {

// Chosen internally by the engine (via ProviderConfiguration), never surfaced as an
// end-user-facing setting. pipeWorker is the always-available default; sharedMemoryWorker cuts
// per-evaluation round-trip latency for cppProvider tasks but is POSIX-only, and
// ProviderRuntime falls back to pipeWorker for a given provider process if it fails to start.
enum class ProviderExecutionMode { pipeWorker, sharedMemoryWorker };

struct ProviderConfiguration {
    std::string cppCompiler;
    std::string cppSdkPath;
    std::string pythonInterpreter;
    std::string pythonSdkPath;
    std::string buildDirectory;
    ProviderExecutionMode executionMode = ProviderExecutionMode::pipeWorker;
};

class ProviderBackend;

class ProviderRuntime final : public ProviderEvaluator {
public:
    explicit ProviderRuntime(ProviderConfiguration configuration);
    ~ProviderRuntime();

    ProviderRuntime(const ProviderRuntime&) = delete;
    ProviderRuntime& operator=(const ProviderRuntime&) = delete;

    void initialize(const ExecutionPlan& plan);

    std::vector<double> evaluateBatch(const std::vector<const ContributionTask*>& tasks,
                                      const std::vector<std::vector<double>>& inputs,
                                      double simulationTime,
                                      double stepSize) override;

    void shutdown() noexcept;

private:
    ProviderConfiguration configuration_;
    std::unordered_map<std::string, std::unique_ptr<ProviderBackend>> processes_;
    std::unordered_map<EntityId, std::uint64_t> taskInstanceIds_;
    std::uint64_t nextInstanceId_ = 1;
    bool initialized_ = false;
    bool shutdown_ = false;
};

bool planRequiresProviders(const ExecutionPlan& plan);

}
