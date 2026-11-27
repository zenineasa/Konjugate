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
class ProgramBackend;

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
    std::optional<std::vector<std::pair<std::string, double>>> initialNodeOutputs(const NodeProviderTask& task, std::span<const double> inputs,
                                                                                  double simulationTime) override;
    std::vector<std::byte> requestNodeCheckpoint(const NodeProviderTask& task) override;
    void requestNodeRestore(const NodeProviderTask& task, std::span<const std::byte> payload) override;

    // Version 2 programs (docs/proposals/programSdkV2.md): pure by their shape, so they take part in every stage; their memory and clocks.
    bool declaredPure(const std::string& processKey) const override;
    bool programAdvancesEachStep(EntityId owner) const override;
    double programClockPeriod(EntityId owner) const override;
    void advancePrograms(const std::vector<ProgramAdvanceCall>& calls, double time, double size) override;
    std::optional<std::vector<std::string>> programOutputDependencies(EntityId owner, const std::string& outputKey) const override;
    bool suppliesJacobian(const ContributionTask& task) const override;
    bool evaluateJacobianBatch(const std::vector<const ContributionTask*>& tasks, const std::vector<std::span<const double>>& inputs,
                               double simulationTime, double stepSize, std::vector<std::vector<double>>& derivatives) override;
    std::vector<ProgramMemoryState> programMemory() const override;
    void restoreProgramMemory(const std::vector<ProgramMemoryState>& memory, std::vector<std::string>* notes) override;
    // Every program with a clock: what it belongs to and its period, in the model's order.
    std::vector<std::pair<EntityId, double>> programClocks() const;
    // The name of the program of `owner` ("PidController"), empty for none.
    std::string programName(EntityId owner) const;

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
    struct ProgramEntry {
        ProgramBackend* backend = nullptr;
        std::uint64_t instanceId = 0;
    };
    std::unordered_map<std::string, ProgramBackend*> programBackends_;
    std::unordered_map<EntityId, ProgramEntry> programOwners_;
    std::vector<EntityId> programOrder_;
    std::uint64_t nextInstanceId_ = 1;
    bool initialized_ = false;
    bool shutdown_ = false;
};

bool planRequiresProviders(const ExecutionPlan& plan);

// Check program (docs/programs.md, "Testing a program"): a version 2 program loaded as a run loads it, and the standard checks run on it
// at `time` with these inputs (by key; one not given reads its default, or 0): every port declared once with a key a file can bind;
// evaluate() finite with every output set; purity (the first evaluation made twice and compared); the memory round trip (memory restored
// into a fresh instance advances and evaluates alike); a Jacobian, if given, against differences. The answer as JSON: { ok, program,
// kind, inputs, problems, outputs, memory }.
std::string checkProgram(const std::string& kind, const std::string& source, const ProviderConfiguration& configuration,
                         const std::unordered_map<std::string, double>& inputs, double time);

// Test (the code editor's Test, docs/engineCli.md): Check program's standard checks, and a trace of `steps` steps of `stepSize` (0: the
// clock's period, else 0.01 s) on an instance of its own with the inputs held. The answer is Check program's JSON with three more keys:
// checks (each standard check passed, failed or not run), problemDetails (each problem with its line, check, and step and time for one
// in the trace) and trace ({ stepSize, clocked, rows: [{ step, time, outputs, memory }] }).
struct ProgramTestRequest {
    int steps = 0;
    double stepSize = 0;
};
std::string testProgram(const std::string& kind, const std::string& source, const ProviderConfiguration& configuration,
                        const std::unordered_map<std::string, double>& inputs, double time, const ProgramTestRequest& test);

// What the ports are bound to, for describeProgram's conversions: an input's bound unit by key; an output's state by key (its unit, and
// whether it is a Rate state, which takes the unit per second).
struct ProgramPortUnits {
    struct State {
        std::string unit;
        bool rate = true;
    };
    std::unordered_map<std::string, std::string> inputs;
    std::unordered_map<std::string, State> outputs;
};

// Describe program (the code editor's Ports, docs/engineCli.md): a version 2 program loaded as a run loads it and initialized at these
// inputs (by key; one not given reads its default, or 0), nothing evaluated. The answer as JSON: { ok, language, program, kind, inputs,
// outputs, memory, clock, problems }: each port with its unit, the line that declares it and, when `ports` says what it is bound to,
// the conversion a run applies at it; each memory field with its value after initialize(); problems as { message, line }.
std::string describeProgram(const std::string& kind, const std::string& source, const ProviderConfiguration& configuration, const ProgramPortUnits& ports,
                            const std::unordered_map<std::string, double>& inputs);

}
