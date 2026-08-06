/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include "executionPlan.hpp"
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace konjugate {

struct ProviderConfiguration {
    std::string cppCompiler;
    std::string cppSdkPath;
    std::string pythonInterpreter;
    std::string pythonSdkPath;
    std::string buildDirectory;
};

class ProviderProcess;

class ProviderRuntime final : public ProviderEvaluator {
public:
    explicit ProviderRuntime(ProviderConfiguration configuration);
    ~ProviderRuntime();

    ProviderRuntime(const ProviderRuntime&) = delete;
    ProviderRuntime& operator=(const ProviderRuntime&) = delete;

    void initialize(const ExecutionPlan& plan);

    double evaluate(const ContributionTask& task,
                    const std::vector<double>& inputs,
                    double simulationTime,
                    double stepSize) override;

    void shutdown() noexcept;

private:
    ProviderConfiguration configuration_;
    std::unordered_map<std::string, std::unique_ptr<ProviderProcess>> processes_;
    std::unordered_map<EntityId, std::string> taskProcessKeys_;
    std::unordered_map<EntityId, std::uint64_t> taskInstanceIds_;
    std::uint64_t nextInstanceId_ = 1;
    bool initialized_ = false;
    bool shutdown_ = false;
};

bool planRequiresProviders(const ExecutionPlan& plan);

}
