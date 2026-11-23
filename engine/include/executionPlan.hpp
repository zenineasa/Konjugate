/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <boost/property_tree/ptree.hpp>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <limits>
#include <memory>
#include <span>
#include <stdexcept>
#include <unordered_map>
#include <utility>
#include <vector>

namespace konjugate {

using EntityId = std::uint64_t;
using EntityValues = std::unordered_map<EntityId, double>;
using StateValues = std::vector<double>;
using NodeParameterValues = std::vector<std::vector<double>>;

enum class ExpressionOperation {
    literal,
    symbol,
    add,
    multiply,
    negate,
    divide,
    power,
    squareRoot,
    absolute,
    exponential,
    logarithm,
    sine,
    cosine,
    tangent,
    arcsine,
    arccosine,
    arctangent,
    // Arctan2(y, x): the angle of the point (x, y), from -pi to pi.
    arctangent2,
    hyperbolicTangent,
    minimum,
    maximum,
    // Piecewise support: MathJSON "Which" (LaTeX \begin{cases}) plus the comparisons and logic
    // its conditions are built from. Comparisons and logic evaluate to 1 or 0; the validator only
    // allows them in condition positions, so they never leak into a numeric result.
    conditional,
    less,
    lessEqual,
    greater,
    greaterEqual,
    equal,
    notEqual,
    logicalAnd,
    logicalOr,
    logicalNot
};

// What one instruction of an expression program does. Each works on a stack of values: literal and symbol push one;
// the arithmetic ones replace the top value, or the top two, with their result; compare replaces the top two, a left
// and a right, with the right and whether the pair holds (index names the comparison, as ExpressionOperation orders
// them from less), so a chain can go on from the right; the jumps go to the instruction at index, the conditional ones
// popping the value they test; fail throws (index names why). In an algebraic relationship's programs a symbol is read
// as what it is: a state (index its place in the plan's states), a value resolved for the instant (a parameter or the
// time, index its symbol) or a definition (index its number), worked out when first read.
enum class InstructionCode : std::uint8_t {
    literal, symbol, state, resolved, definition, add, multiply, negate, divide, power, squareRoot, absolute, exponential, logarithm, sine, cosine, tangent,
    arcsine, arccosine, arctangent, arctangent2, hyperbolicTangent, minimum, maximum, compare, logicalNot,
    jump, jumpIfZero, jumpIfNonzero, pop, fail
};

struct ExpressionInstruction {
    InstructionCode code = InstructionCode::literal;
    std::uint32_t index = 0;
    double value = 0;
};

// An expression as a flat list of instructions, run from first to last with a stack at most `depth` deep: the same
// operations in the same order as walking its tree, so the same value to the last bit, and the same choices left
// unworked (a Which's branches not taken, the rest of a chained comparison or of And and Or once settled). Empty when
// the expression has none, and the tree is walked instead.
struct ExpressionProgram {
    std::vector<ExpressionInstruction> instructions;
    std::size_t depth = 0;
};

struct CompiledExpression {
    ExpressionOperation operation = ExpressionOperation::literal;
    double literal = 0;
    std::string symbol;
    std::size_t symbolIndex = std::numeric_limits<std::size_t>::max();
    std::vector<CompiledExpression> arguments;

    double evaluate(const std::vector<double>& symbols) const;
    std::size_t operationCount() const noexcept;
};

// simulationTime: an equation's time binding ({ kind: "time" }) -- the substep's start time for a
// differential contribution, its end time for an algebraic (setsValue) one.
enum class BindingSource { localState, synchronizationSnapshot, parameter, simulationTime };
enum class ContributionImplementation { equation, cppProvider, pythonProvider };

struct CompiledBinding {
    std::string symbol;
    BindingSource source = BindingSource::localState;
    EntityId valueId = 0;
    std::size_t valueIndex = std::numeric_limits<std::size_t>::max();
    std::size_t parameterIndex = std::numeric_limits<std::size_t>::max();
};

struct ParameterSchedule;

struct CompiledParameter {
    EntityId id = 0;
    double value = 0;
    bool live = false;
    // The id live overrides and schedules are keyed by. Equal to `id` for an ordinary parameter;
    // for one linked to a project-level shared parameter it is that shared parameter's id, so a
    // single control value reaches every relationship that links to it.
    EntityId controlId = 0;
    // A shared parameter's stored schedule (sharedParameters[].schedule, docs/projectSchema.md):
    // the parameter's own value then follows this series over simulation time instead of being a
    // constant. Live overrides and recorded interventions still take precedence over it, exactly as
    // they do over a constant value. Shared, since every parameter linked to the same shared one
    // compiles to the same schedule.
    std::shared_ptr<const ParameterSchedule> schedule = nullptr;
};

// A recorded, timestamped intervention (docs/resultExploration.md's "Parameter interventions"),
// distinct from RunControl::parameterValues' instantaneous overrides: the parameter's effective
// value becomes a function of simulationTime rather than a single most-recently-set scalar. When
// more than one schedule exists for the same parameter (a later intervention layered onto an
// earlier one), the one with the latest startTime that has already begun governs -- see
// resolveParameterValues' selection logic in executionPlan.cpp.
struct ParameterSchedule {
    enum class Mode { step, ramp, pulse, piecewise, waveform };
    enum class Shape { sine, square, triangle, sawtooth, noise };
    EntityId parameterId = 0;
    Mode mode = Mode::step;
    double startTime = 0;
    // Ramp: time to reach targetValue. Pulse: width of the pulse. Unused for step/piecewise.
    double duration = 0;
    // Step/ramp/pulse target; ignored for piecewise.
    double targetValue = 0;
    // Ramp's starting value and pulse's outside-the-window value.
    double baseValue = 0;
    // Piecewise only: explicit, chronologically sorted {time, value} points, linearly
    // interpolated and edge-held outside their range (the same convention as
    // src/providerTemplate.mjs's replayProviderSource()).
    std::vector<std::pair<double, double>> samples;
    // Piecewise only: hold each sample's value until the next sample's time (a staircase) rather
    // than interpolating -- for a series of per-period rates, such as a daily volume, whose total
    // over each period must be kept.
    bool hold = false;
    // Waveform only (docs/jobProtocol.md): a signal around baseValue, from startTime for duration (0 for the rest of
    // the run), reading baseValue outside that.
    Shape shape = Shape::sine;
    double amplitude = 0;
    double frequency = 0;
    double phaseDegrees = 0;
    double dutyCycle = 0;
    std::uint64_t seed = 0;
    // An input stream (a session's AppendInputSamples): readings of what was really done, held between them, which drive the
    // parameter from the first of them on whether or not it is live, ahead of every other value it could have.
    bool input = false;
    // An input stream that, past followFrom, follows a state of the model: the session adds the state's value at the end of every
    // step after it as the stream's next reading, within followMinimum and followMaximum, and sets the state to the stream's value
    // before the step over followFrom. 0 for none.
    EntityId followStateId = 0;
    double followFrom = 0;
    double followMinimum = -std::numeric_limits<double>::infinity();
    double followMaximum = std::numeric_limits<double>::infinity();
};

double evaluateParameterSchedule(const ParameterSchedule& schedule, double simulationTime);

struct ContributionTask {
    std::size_t sequence = 0;
    EntityId sourceId = 0;
    EntityId outputStateId = 0;
    std::size_t outputStateIndex = std::numeric_limits<std::size_t>::max();
    std::vector<CompiledBinding> bindings;
    std::vector<CompiledParameter> parameters;
    CompiledExpression expression;
    // The expression's program, built once its symbols are bound (see compileExecutionPlan).
    ExpressionProgram program;
    ContributionImplementation implementation = ContributionImplementation::equation;
    std::string providerSource;
    std::string providerOutputKey;
    // Precomputed once by bindTask() at plan-compile time: providerProcessKey() used to
    // concatenate "cpp:"/"py:" with the entire inline source text on every single evaluation
    // call, which is invisible next to an IPC round trip but was measurable overhead in its
    // own right once nothing else dominates (e.g. the in-process transport). Empty for
    // equation tasks, which never call providerProcessKey().
    std::string providerProcessKeyCache;
    // Under event location (docs/proposals/integrators.md, Event location): the latch each comparison of a condition reads instead of
    // comparing, as extra symbols after the bindings (symbol bindings.size() + k reads latch latchSlots[k]). Empty for every task that
    // is not a whole-model stage's copy of a term with switching conditions.
    std::vector<std::size_t> latchSlots;
    // True for the complementary contribution a bidirectional edge applies to its other
    // endpoint: the same computed value, sign-flipped, since what leaves one node enters the
    // other. False for every other contribution (source terms, directed edges, and a
    // bidirectional edge's own primary output).
    bool negateOutput = false;
};

// Contributions sharing the same (implementation, providerSource) run in the same worker
// process/library, so callers group tasks by this key before batching them into one
// evaluateBatch call rather than one round trip per contribution.
const std::string& providerProcessKey(const ContributionTask& task);

struct NodeProviderOutputBinding {
    std::string key;
    EntityId stateId = 0;
    std::size_t stateIndex = std::numeric_limits<std::size_t>::max();
    // Mirrors a source term's own setsValue (see NodeExecutionPlan::algebraicTasks and
    // docs/projectSchema.md's setsValue paragraph): by default an output's returned number is a
    // derivative, folded additively into its target state like any other contribution. When true,
    // the engine instead writes that same number directly into the target state every substep -- a
    // plain replacement, never integrated -- after the substep's contributions have been evaluated,
    // so they read the value from before it. The provider is evaluated once per substep, at its start
    // time t with step h, and a setsValue output is its value at t + h: a co-simulation step (advance
    // over [t, t + h] on inputs read at t, then report), as an imported FMU's fmi2DoStep is. The node
    // then records it beside its other states at t + h. Unlike a setsValue source term, it is not
    // recomputed after the step's last update or settled before the first step (either would call the
    // provider again for an interval it has already advanced over): a node's initial value for such a
    // state is its value at the start. This makes it a genuine algebraic state rather than the
    // Euler-specific pseudo-derivative trick FMI import used before this field existed (see
    // src/fmiResolver.mjs). No SDK change: NodeOutputCollector::addGradient's value is reinterpreted
    // exactly like a source term's addGradient value is.
    bool setsValue = false;
};

// Owns ALL the dynamics of one node, unlike ContributionTask which owns one scalar derivative
// into one state: evaluated once per substep, returns N named outputs (one per declared output),
// each either folded additively into its own target state as a derivative, or -- when that
// output's binding has setsValue set -- written directly into its target state as a genuine
// algebraic value. A node has at most one of these. Python-only for now (see providerRuntime.cpp);
// implementation is retained (rather than assumed) so a future C++ node-provider slice only has
// to add a branch here, not a new field.
struct NodeProviderTask {
    EntityId nodeId = 0;
    ContributionImplementation implementation = ContributionImplementation::pythonProvider;
    std::string providerSource;
    std::string providerProcessKeyCache; // "py:" + providerSource, same scheme as ContributionTask
    // This node's own states (read as the node advances, like a source term's), other nodes'
    // states (read from the step's synchronization snapshot, like an edge's), or project-level
    // shared parameters (a node has no parameters of its own), each one entry of `parameters`.
    std::vector<CompiledBinding> bindings;
    // The shared parameters the bindings read, one each however many bindings read it: live
    // values, stored schedules and recorded interventions reach them as they reach any parameter.
    std::vector<CompiledParameter> parameters;
    std::vector<NodeProviderOutputBinding> outputs; // N named outputs -> this node's own states
};

class ProviderEvaluator {
public:
    virtual ~ProviderEvaluator() = default;
    // Every task in a single call must share the same providerProcessKey(); the caller
    // (evaluateContributionTasks) is responsible for grouping them that way. Results are
    // returned in the same order as tasks/inputs.
    virtual std::vector<double> evaluateBatch(const std::vector<const ContributionTask*>& tasks,
                                              const std::vector<std::span<const double>>& inputs,
                                              double simulationTime,
                                              double stepSize) = 0;

    // Throwing defaults, not pure virtual: existing ProviderEvaluator doubles (tests, the
    // benchmark harness) that never exercise computational-node providers need not implement
    // these. A real caller only reaches them when a plan actually contains a NodeProviderTask.
    virtual std::vector<std::pair<std::string, double>> evaluateNode(
        const NodeProviderTask&, std::span<const double> inputs, double simulationTime, double stepSize) {
        static_cast<void>(inputs);
        static_cast<void>(simulationTime);
        static_cast<void>(stepSize);
        throw std::runtime_error("This provider evaluator does not support computational-node providers.");
    }
    virtual std::vector<std::byte> requestNodeCheckpoint(const NodeProviderTask&) {
        throw std::runtime_error("This provider evaluator does not support computational-node checkpointing.");
    }
    virtual void requestNodeRestore(const NodeProviderTask&, std::span<const std::byte>) {
        throw std::runtime_error("This provider evaluator does not support computational-node restore.");
    }
    // Whether the program behind a provider process key (providerProcessKey) can be evaluated at every stage of a whole-model method:
    // its outputs depend only on its inputs, parameters and time, and evaluating it again changes nothing. A version 1 program cannot say
    // so, and is held (docs/proposals/integrators.md, Programs); this is where a program written against a version 2 SDK, whose purity
    // follows from its shape, will answer yes (docs/proposals/programSdkV2.md). Only a whole-model method asks.
    virtual bool declaredPure(const std::string& processKey) const {
        static_cast<void>(processKey);
        return false;
    }
};

// A node whose integration is "verlet" but whose rates do not split into two parts, each read only by the other: what is
// wrong, in words, and the node it is on (the validator files it against the node's Numerics tab).
struct VerletStructureError : std::runtime_error {
    VerletStructureError(EntityId node, const std::string& message) : std::runtime_error(message), nodeId(node) {}
    EntityId nodeId;
};

struct NodeExecutionPlan {
    EntityId nodeId = 0;
    std::size_t substeps = 1;
    // numerics.integration "semiImplicit": within each substep the node's states are updated one
    // after another in the order the node lists them, each from contributions evaluated with the
    // states already updated before it (so a position listed after its speed moves with the new
    // speed: semi-implicit, or symplectic, Euler). Otherwise every state is updated together from
    // the substep's starting values (explicit Euler).
    bool semiImplicit = false;
    // numerics.integration "verlet": Störmer–Verlet, second order and symplectic (docs/proposals/integrators.md, Verlet,
    // node by node). The node's states, in the order it lists them, fall in two parts: those before the first state whose
    // rate reads a state listed before it, and the rest. Each substep moves the first part by half a step, the second by a
    // whole step from the first's new values, and the first by the other half from the second's new values: a speed
    // listed before the position it moves gives velocity Verlet, a position listed before its speed position Verlet. A
    // state's rate may read only states of the other part (compileExecutionPlan refuses a node whose rates do not, naming
    // the states). A term written as a program is held: evaluated once at the substep's start, as under Euler, and added
    // through the substep.
    bool verlet = false;
    // Per state, in the node's order (verlet only): true for the first part (two half steps a substep, its rates read at
    // the substep's start and end), false for the second part or a state with no rate (one whole step, read at the middle).
    std::vector<bool> verletKicked;
    std::vector<EntityId> stateIds;
    std::vector<std::size_t> stateIndexes;
    std::vector<ContributionTask> contributions;
    // The node's own terms into its Update states (docs/proposals/ratesAndUpdates.md): a source term that sets its
    // value (setsValue), or any source term into a state whose kind is "update". They are worked out after the step, in
    // the update phase (applyUpdates), never within the node's substeps: through a step an Update state holds its value
    // from the step's start. Several may set one state; they sum. Kept in dependency order within the node, every term
    // setting a state before any term reading it where the terms have no cycle (stability analysis reads them so).
    std::vector<ContributionTask> algebraicTasks;
    // Terms of relationships into this node's Update states (a relationship's single equation into a state whose kind is
    // "update"), worked out in the update phase too; bindings as for a contribution of this node.
    std::vector<ContributionTask> valueTerms;
    // How the node's Update states are worked out (`updates`): once per step, from the values at the step's start, or
    // settled within the step -- worked out in dependency order, rings swept until nothing changes or `settleLimit`
    // sweeps. A document that gives no state a kind settles every node, as values settled at the same instant before.
    bool settles = false;
    std::size_t settleLimit = 1000;
    std::optional<NodeProviderTask> nodeProvider;
    std::size_t estimatedOperationsPerSubstep = 0;
    // True when any parameter of this node's tasks follows a stored schedule, so its values are
    // re-resolved every substep (as they are while an intervention is recorded).
    bool hasParameterSchedules = false;
};

// An algebraic relationship: an edge whose equations set states of its two endpoints (rather than
// adding a rate to one), with named intermediate quantities (definitions) its equations may share.
// See docs/projectSchema.md. Every state is read from the plan's whole state vector: all algebraic
// relationships are evaluated together at each synchronization instant, in dependency order, so a
// chain of them across many nodes settles within the instant.
struct AlgebraicRelationship {
    EntityId edgeId = 0;
    // States (source synchronizationSnapshot, valueIndex the plan's index), parameters and time.
    std::vector<CompiledBinding> bindings;
    // Per binding: the state's index in the plan's states, read as it stands when an equation reads it; or none (the
    // largest size_t) for a parameter or the time, resolved once for the instant.
    std::vector<std::size_t> stateReads;
    std::vector<CompiledParameter> parameters;
    // Each reads the bindings (symbols 0 .. bindings.size() - 1) and earlier definitions (symbol
    // bindings.size() + k for definition k).
    std::vector<CompiledExpression> definitions;
    // Each definition's program, built once the plan is compiled.
    std::vector<ExpressionProgram> definitionPrograms;
    // The definitions each definition reads whatever its choices (Which) take: all but those read only in a choice's
    // values or later conditions. The others are worked out only if the branch reading them is taken.
    std::vector<std::vector<std::size_t>> unconditionalDefinitions;
};

// One equation of an algebraic relationship: its value is added to its state, which every
// algebraic relationship writing it sums (and nothing else writes).
struct AlgebraicOutput {
    std::size_t relationship = 0;
    EntityId outputStateId = 0;
    std::size_t outputStateIndex = std::numeric_limits<std::size_t>::max();
    CompiledExpression expression;
    // The expression's program, built once the plan is compiled.
    ExpressionProgram program;
    // The definitions it needs whatever its choices take, directly or through other definitions, in ascending order:
    // worked out before it. The rest are worked out when a branch taken reads them, and not at all otherwise.
    std::vector<std::size_t> eagerDefinitions;
};

// One term of the update phase: something that sets an Update state.
enum class UpdateStepKind {
    relationshipOutput, // plan.algebraicOutputs[index]
    ownTerm,            // plan.nodes[node].algebraicTasks[index]
    valueTerm           // plan.nodes[node].valueTerms[index]
};

struct UpdateStep {
    UpdateStepKind kind = UpdateStepKind::relationshipOutput;
    std::size_t node = 0;
    std::size_t index = 0;
    // The state it adds its value to, and the states it reads (those its equation uses; every one a program binds).
    std::size_t writes = 0;
    std::vector<std::size_t> reads;
};

// Steps that settle together: one step in no cycle, worked out once; or the steps of a ring (a strongly connected set),
// swept together -- every sweep reading only the previous sweep's values -- until nothing changes or `limit` sweeps.
struct SettleGroup {
    std::vector<std::size_t> steps;
    bool ring = false;
    std::size_t limit = 1000;
};

struct ExecutionPlan {
    std::vector<AlgebraicRelationship> algebraicRelationships;
    // A relationship's several equations, each setting an Update state; where they form no ring, in an order in which
    // every output setting a state comes before any output reading it.
    std::vector<AlgebraicOutput> algebraicOutputs;
    // Every state the update phase sets, each the sum of the steps setting it.
    std::vector<std::size_t> algebraicStateIndexes;
    // The update phase (docs/proposals/ratesAndUpdates.md, applyUpdates): every term setting an Update state; those of
    // nodes worked out once per step, from the values at the step's start; and those of settling nodes, in groups in
    // dependency order.
    std::vector<UpdateStep> updateSteps;
    std::vector<std::size_t> oncePerStepSteps;
    std::vector<SettleGroup> settleGroups;
    // The states the settling steps set.
    std::vector<std::size_t> settleStateIndexes;
    StateValues initialStates;
    std::unordered_map<EntityId, EntityId> stateNodes;
    std::unordered_map<EntityId, std::size_t> stateIndexes;
    std::vector<EntityId> stateIds;
    std::vector<NodeExecutionPlan> nodes;
    std::vector<std::size_t> taskSubmissionOrder;
};

struct EvaluatedContribution {
    std::size_t sequence = 0;
    std::size_t outputStateIndex = 0;
    double value = 0;
};

ExecutionPlan compileExecutionPlan(const boost::property_tree::ptree& document);

std::vector<std::size_t> planTaskSubmissionOrder(const std::vector<NodeExecutionPlan>& nodes);

// The parts recorded with each result sample (docs/proposals/unifiedEntityEditors.md, decision 11): what each term written as an
// equation -- a node's own source term, or a relationship's term at one end -- adds to a Rate state or gives an Update state.
// A relationship's term at the far end of a bidirectional relationship is its own part, negated. A term written as a program
// is not recorded: working it out again would run the program again, which may keep state of its own.
struct RecordedPart {
    EntityId sourceId = 0;
    EntityId stateId = 0;
    bool negated = false;
};

// Every recorded part, in the order evaluateRecordedParts gives their values: node by node, its Rate terms, then the
// relationship terms into its Update states, then its own Update terms.
std::vector<RecordedPart> recordedParts(const ExecutionPlan& plan);

// Each recorded part's value from the states of one sample (plan order) and the parameters as they stand at its time. Pure:
// it changes nothing the run reads, so recording never changes a run's numbers. A part that cannot be worked out is NaN.
std::vector<double> evaluateRecordedParts(const ExecutionPlan& plan, const StateValues& states, const EntityValues& liveParameterValues,
                                          const std::vector<ParameterSchedule>& activeSchedules, double simulationTime);

// localStates is only ever read here -- but a nodeProvider output with setsValue needs to write its
// target state directly (see NodeProviderOutputBinding::setsValue), exactly like
// applyAlgebraicTasks does. Rather than taking localStates by mutable reference (which would force
// every caller, including every existing test, to supply a named lvalue instead of a plain
// brace-init StateValues), such a write is appended to algebraicNodeProviderWrites instead -- a
// caller-supplied out-parameter, nullptr by default -- as a (stateIndex, value) pair for the caller
// to apply once this call returns, exactly how integrateNode already applies the derivatives it
// gets back from reduceContributions. A setsValue nodeProvider output encountered with a null
// algebraicNodeProviderWrites throws rather than silently discarding the write.
std::vector<EvaluatedContribution> evaluateContributionTasks(
    const NodeExecutionPlan& node,
    const StateValues& localStates,
    const StateValues& synchronizationSnapshot,
    const NodeParameterValues& parameterValues,
    double simulationTime = 0,
    double stepSize = 0,
    ProviderEvaluator* providerEvaluator = nullptr,
    std::vector<std::pair<std::size_t, double>>* algebraicNodeProviderWrites = nullptr,
    const std::vector<double>* nodeProviderParameterValues = nullptr,
    const std::vector<double>* latches = nullptr);

// An expression as a program (ExpressionProgram), its symbols already bound: as the plan compiles every equation's.
ExpressionProgram compileExpressionProgram(const CompiledExpression& expression);

// The values of a computational-node provider's parameters (NodeProviderTask::parameters) at
// simulationTime, resolved as every other parameter is: live overrides, recorded interventions and
// stored schedules first, else the shared parameter's value.
std::vector<double> resolveNodeProviderParameterValues(const NodeProviderTask& task, const EntityValues& liveParameterValues,
                                                       const std::vector<ParameterSchedule>& activeSchedules = {}, double simulationTime = 0);

// activeSchedules/simulationTime default to {}/0 so every existing call site (mostly tests
// exercising a single substep in isolation) keeps its previous flat-override-only behavior
// unchanged -- an empty schedule list can never match, so resolution falls through exactly as
// before. Only simulationRunner.cpp's main loop (via integrateNode) passes real schedules.
NodeParameterValues resolveParameterValues(const NodeExecutionPlan& node, const EntityValues& liveParameterValues,
                                            const std::vector<ParameterSchedule>& activeSchedules = {}, double simulationTime = 0);
// Shared by evaluateContributionTasks (indexed by position in node.contributions) and
// applyAlgebraicTasks (indexed by position in node.algebraicTasks) -- two structurally separate
// lists, so each needs its own resolved-values vector rather than sharing one keyed by a single
// shared index space.
NodeParameterValues resolveParameterValues(const std::vector<ContributionTask>& tasks, const EntityValues& liveParameterValues,
                                            const std::vector<ParameterSchedule>& activeSchedules = {}, double simulationTime = 0);

std::vector<std::pair<std::size_t, double>> reduceContributions(
    std::vector<EvaluatedContribution> contributions);

// A node's own value terms (NodeExecutionPlan::algebraicTasks) worked out from localStates alone, as stability analysis
// and settleAlgebraicStates use them: sets each state the tasks set to zero, then recomputes each task in the given
// order and adds its value -- several terms setting one state sum -- never divided by stepSize. The run itself works
// these out in the update phase (applyUpdates). Because each write lands in the same localStates array
// every later algebraic task and every ordinary (differential) contribution in this same substep
// reads from, this composes with any solver: there is no derivative or stepSize-dependent
// arithmetic here at all, unlike the Euler-specific pseudo-derivative trick this replaces. Always
// intra-node (see compileExecutionPlan's dependency-ordering comment) -- takes no
// synchronizationSnapshot because a source term's bindings are never cross-node. `evaluationTime` is
// the instant localStates represent: the value is g(x, t) at one instant, so it always agrees with
// the states it is stored beside. stepSize is only passed on to a programmable term's provider.
void applyAlgebraicTasks(const std::vector<ContributionTask>& algebraicTasks, StateValues& localStates,
                         const NodeParameterValues& parameterValues, double evaluationTime, double stepSize,
                         ProviderEvaluator* providerEvaluator);

struct NodeIntegrationResult {
    StateValues states;
    std::uint64_t computeNanoseconds = 0;
};

// Owns one node's full substep loop for one global step: seeds localStates from the frozen
// synchronizationSnapshot, then per substep applies algebraic tasks (recomputed fresh, see above)
// before evaluating and Euler-integrating the node's ordinary differential contributions. Shared
// verbatim by the serial/thread-pool backend (simulationRunner.cpp) and the partitioned backend
// (partitionRuntime.cpp, which wraps this with its own node index) so the two can never silently
// diverge on this logic.
// activeSchedules defaults to {} (no effect on callers that pass none). Every backend passes the
// run's active schedules: the partitioned one hands them to each partition worker
// (partitionRuntime.cpp), so an intervention applies whichever backend a run is given.
NodeIntegrationResult integrateNode(const NodeExecutionPlan& node,
                                    const StateValues& synchronizationSnapshot,
                                    const EntityValues& liveParameterValues,
                                    double simulationTime,
                                    double synchronizationStep,
                                    ProviderEvaluator* providerEvaluator = nullptr,
                                    const std::vector<ParameterSchedule>& activeSchedules = {},
                                    double synchronizationEndTime = std::numeric_limits<double>::quiet_NaN());

// What one run of the update phase did: how many relationship definitions it worked out (each at most once per
// sweep, and only if an equation needed it), and how many rings stopped at their limit without settling.
// A ring of settling Updates that reached its limit still changing: which of `settleGroups` it is, the state that changed
// most in its last sweep, and by how much.
struct UnsettledRing {
    std::size_t group = 0;
    std::size_t stateIndex = 0;
    double change = 0;
};

struct UpdateOutcome {
    std::size_t definitionsWorked = 0;
    std::size_t ringsUnsettled = 0;
    std::vector<UnsettledRing> unsettledRings;
};

// The update phase (docs/proposals/ratesAndUpdates.md). `states` holds every Rate state as the step left it and every
// Update state as it was at the step's start; on return every Update state holds its new value.
// - After a step (`afterStep`): every Update of a node worked out once per step reads `states` as given -- Rate states
//   at the step's end, Update states at its start, the time `simulationTime` (the step's end) -- and all are set at
//   once, so their order never matters. Then the settling nodes' Updates, in groups in dependency order, each reading
//   the latest values: a group of one step once, a ring swept until nothing changes or its limit.
// - Settling at an instant (`afterStep` false: a run's start, a resume, a parameter set): only the settling nodes'
//   Updates are worked out, from `states` as they stand; an Update worked out once per step keeps its value.
// stepSize and providerEvaluator are only passed on to programs.
UpdateOutcome applyUpdates(const ExecutionPlan& plan, StateValues& states, const EntityValues& liveParameterValues,
                           const std::vector<ParameterSchedule>& activeSchedules, double simulationTime, bool afterStep,
                           double stepSize = 0, ProviderEvaluator* providerEvaluator = nullptr);

// Settles the settling nodes' Updates at simulationTime, from `states` as they stand (applyUpdates, not after a step).
// Returns how many relationship definitions were worked out.
std::size_t evaluateAlgebraicRelationships(const ExecutionPlan& plan, StateValues& states, const EntityValues& liveParameterValues,
                                    const std::vector<ParameterSchedule>& activeSchedules, double simulationTime,
                                    double stepSize = 0, ProviderEvaluator* providerEvaluator = nullptr);

void settleAlgebraicStates(const ExecutionPlan& plan, StateValues& states, const EntityValues& liveParameterValues,
                           double time, double stepSize, ProviderEvaluator* providerEvaluator = nullptr,
                           const std::vector<ParameterSchedule>& activeSchedules = {});

}
