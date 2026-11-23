/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "executionPlan.hpp"
#include "wholeModelIntegration.hpp"
#include <algorithm>
#include <cerrno>
#include <cstdlib>
#include <set>
#include <chrono>
#include <cmath>
#include <functional>
#include <numbers>
#include <numeric>
#include <span>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>

namespace konjugate {
namespace {

std::string value(const boost::property_tree::ptree& tree, const std::string& key) {
    return tree.get<std::string>(key, "");
}

EntityId idValue(const boost::property_tree::ptree& tree, const std::string& key) {
    const auto text = tree.get<std::string>(key, "");
    std::size_t consumed = 0;
    const auto result = std::stoull(text, &consumed);
    if (!result || result > 9007199254740991ULL || consumed != text.size()) {
        throw std::runtime_error("Model ids must be positive safe integers.");
    }
    return result;
}

// Whether a leaf of an expression is a finite number, read whole and in range, without
// throwing: a model has many symbols for every number, and an exception for each is slow to compile.
bool readsAsFiniteNumber(const std::string& input, double& result) {
    if (input.empty()) return false;
    const char* begin = input.c_str();
    char* end = nullptr;
    errno = 0;
    const auto value = std::strtod(begin, &end);
    if (end == begin || end != begin + input.size() || errno == ERANGE || !std::isfinite(value)) return false;
    result = value;
    return true;
}

ExpressionOperation operationFromName(const std::string& name) {
    if (name == "Add") return ExpressionOperation::add;
    if (name == "Multiply") return ExpressionOperation::multiply;
    if (name == "Negate") return ExpressionOperation::negate;
    if (name == "Divide") return ExpressionOperation::divide;
    if (name == "Power") return ExpressionOperation::power;
    if (name == "Sqrt") return ExpressionOperation::squareRoot;
    if (name == "Abs") return ExpressionOperation::absolute;
    if (name == "Exp") return ExpressionOperation::exponential;
    if (name == "Ln" || name == "Log") return ExpressionOperation::logarithm;
    if (name == "Sin") return ExpressionOperation::sine;
    if (name == "Cos") return ExpressionOperation::cosine;
    if (name == "Tan") return ExpressionOperation::tangent;
    if (name == "Arcsin") return ExpressionOperation::arcsine;
    if (name == "Arccos") return ExpressionOperation::arccosine;
    if (name == "Arctan") return ExpressionOperation::arctangent;
    if (name == "Arctan2") return ExpressionOperation::arctangent2;
    if (name == "Tanh") return ExpressionOperation::hyperbolicTangent;
    if (name == "Min") return ExpressionOperation::minimum;
    if (name == "Max") return ExpressionOperation::maximum;
    if (name == "Which") return ExpressionOperation::conditional;
    if (name == "Less") return ExpressionOperation::less;
    if (name == "LessEqual") return ExpressionOperation::lessEqual;
    if (name == "Greater") return ExpressionOperation::greater;
    if (name == "GreaterEqual") return ExpressionOperation::greaterEqual;
    if (name == "Equal") return ExpressionOperation::equal;
    if (name == "NotEqual") return ExpressionOperation::notEqual;
    if (name == "And") return ExpressionOperation::logicalAnd;
    if (name == "Or") return ExpressionOperation::logicalOr;
    if (name == "Not") return ExpressionOperation::logicalNot;
    throw std::runtime_error("Unsupported executable operation: " + name + ".");
}

CompiledExpression compileExpression(const boost::property_tree::ptree& tree) {
    if (tree.empty()) {
        CompiledExpression expression;
        // "True"/"False" appear as bare symbols in MathJSON -- "True" is the otherwise branch of
        // a cases expression.
        if (tree.data() == "True" || tree.data() == "False") {
            expression.operation = ExpressionOperation::literal;
            expression.literal = tree.data() == "True" ? 1.0 : 0.0;
            return expression;
        }
        double number = 0;
        if (readsAsFiniteNumber(tree.data(), number)) {
            expression.operation = ExpressionOperation::literal;
            expression.literal = number;
        } else {
            expression.operation = ExpressionOperation::symbol;
            expression.symbol = tree.data();
        }
        return expression;
    }
    auto item = tree.begin();
    if (item == tree.end()) throw std::runtime_error("Expression array is empty.");
    CompiledExpression expression;
    expression.operation = operationFromName(item->second.data());
    for (++item; item != tree.end(); ++item) expression.arguments.push_back(compileExpression(item->second));
    return expression;
}

std::vector<CompiledBinding> compileBindings(const boost::property_tree::ptree& bindings,
                                             EntityId outputNodeId,
                                             bool sourceTerm,
                                             const std::unordered_map<EntityId, std::size_t>& stateIndexes,
                                             const std::unordered_map<EntityId, std::size_t>& localStateIndexes,
                                             const std::string& identifierField = "symbol") {
    std::vector<CompiledBinding> result;
    for (const auto& bindingItem : bindings) {
        const auto& binding = bindingItem.second;
        CompiledBinding compiled;
        compiled.symbol = value(binding, identifierField);
        if (value(binding, "kind") == "parameter") {
            compiled.source = BindingSource::parameter;
            compiled.valueId = idValue(binding, "parameterId");
        } else if (value(binding, "kind") == "time") {
            compiled.source = BindingSource::simulationTime;
        } else {
            compiled.valueId = idValue(binding, "stateId");
            compiled.source = sourceTerm || idValue(binding, "nodeId") == outputNodeId
                ? BindingSource::localState : BindingSource::synchronizationSnapshot;
            compiled.valueIndex = compiled.source == BindingSource::localState
                ? localStateIndexes.at(compiled.valueId) : stateIndexes.at(compiled.valueId);
        }
        result.push_back(std::move(compiled));
    }
    return result;
}

// Project-level shared parameters (top-level "sharedParameters"), keyed by id. A relationship or
// source-term parameter carrying `sharedParameterId` takes its value and live/constant mode from
// the shared definition, and is controlled by the shared id, so one edit or one live control
// value drives every linked parameter. The linked parameter's own value and mode are left in the
// file only so an unlinked copy would still make sense; they are ignored here.
using SharedParameters = std::unordered_map<EntityId, const boost::property_tree::ptree*>;

SharedParameters collectSharedParameters(const boost::property_tree::ptree& document) {
    SharedParameters shared;
    if (const auto entries = document.get_child_optional("sharedParameters")) {
        for (const auto& entry : *entries) shared.emplace(idValue(entry.second, "id"), &entry.second);
    }
    return shared;
}

// A shared parameter's stored schedule ("schedule": { "interpolation": "linear" | "hold",
// "samples": [[time, value], ...] }), or null when it has none. Samples must be finite with strictly
// increasing times; modelValidator.cpp reports the same rules as validation errors.
std::shared_ptr<const ParameterSchedule> compileStoredSchedule(const boost::property_tree::ptree& definition) {
    const auto stored = definition.get_child_optional("schedule");
    if (!stored) return nullptr;
    auto schedule = std::make_shared<ParameterSchedule>();
    schedule->parameterId = idValue(definition, "id");
    schedule->mode = ParameterSchedule::Mode::piecewise;
    // Stored schedules govern from the very beginning, beneath every recorded intervention.
    schedule->startTime = -std::numeric_limits<double>::infinity();
    const auto interpolation = stored->get<std::string>("interpolation", "linear");
    if (interpolation != "linear" && interpolation != "hold") throw std::runtime_error("A parameter schedule's interpolation must be linear or hold.");
    schedule->hold = interpolation == "hold";
    if (const auto samples = stored->get_child_optional("samples")) {
        for (const auto& sampleItem : *samples) {
            std::vector<double> pair;
            for (const auto& component : sampleItem.second) pair.push_back(component.second.get_value<double>());
            if (pair.size() != 2 || !std::isfinite(pair[0]) || !std::isfinite(pair[1])) {
                throw std::runtime_error("A parameter schedule sample must be a pair of finite numbers [time, value].");
            }
            if (!schedule->samples.empty() && !(pair[0] > schedule->samples.back().first)) {
                throw std::runtime_error("A parameter schedule's sample times must be strictly increasing.");
            }
            schedule->samples.emplace_back(pair[0], pair[1]);
        }
    }
    if (schedule->samples.empty()) throw std::runtime_error("A parameter schedule needs at least one sample.");
    return schedule;
}

CompiledParameter compileParameter(const boost::property_tree::ptree& parameter, const SharedParameters& shared,
                                   std::unordered_map<EntityId, std::shared_ptr<const ParameterSchedule>>& schedules) {
    const auto id = idValue(parameter, "id");
    if (parameter.get_child_optional("sharedParameterId")) {
        const auto sharedId = idValue(parameter, "sharedParameterId");
        const auto found = shared.find(sharedId);
        if (found == shared.end()) throw std::runtime_error("A parameter links to a shared parameter that does not exist.");
        const auto& definition = *found->second;
        auto cached = schedules.find(sharedId);
        if (cached == schedules.end()) cached = schedules.emplace(sharedId, compileStoredSchedule(definition)).first;
        CompiledParameter compiled{id, definition.get<double>("value", 0), value(definition, "mode") == "live", sharedId};
        compiled.schedule = cached->second;
        return compiled;
    }
    return {id, parameter.get<double>("value", 0), value(parameter, "mode") == "live", id};
}

void bindExpressionSymbols(CompiledExpression& expression, const std::vector<CompiledBinding>& bindings) {
    if (expression.operation == ExpressionOperation::symbol) {
        const auto found = std::find_if(bindings.begin(), bindings.end(), [&](const auto& binding) {
            return binding.symbol == expression.symbol;
        });
        if (found == bindings.end()) throw std::runtime_error("Unknown executable symbol: " + expression.symbol + ".");
        expression.symbolIndex = static_cast<std::size_t>(std::distance(bindings.begin(), found));
    }
    for (auto& argument : expression.arguments) bindExpressionSymbols(argument, bindings);
}

// Binds an expression's symbols against the names seen so far (an algebraic relationship's bindings, then the
// definitions before it), each at its first place, by a hash, so a relationship with many definitions binds in linear
// time.
void bindExpressionNames(CompiledExpression& expression, const std::unordered_map<std::string, std::size_t>& names) {
    if (expression.operation == ExpressionOperation::symbol) {
        const auto found = names.find(expression.symbol);
        if (found == names.end()) throw std::runtime_error("Unknown executable symbol: " + expression.symbol + ".");
        expression.symbolIndex = found->second;
    }
    for (auto& argument : expression.arguments) bindExpressionNames(argument, names);
}

void collectSymbolIndexes(const CompiledExpression& expression, std::set<std::size_t>& indexes) {
    if (expression.operation == ExpressionOperation::symbol) indexes.insert(expression.symbolIndex);
    for (const auto& argument : expression.arguments) collectSymbolIndexes(argument, indexes);
}

// The symbols an expression reads whatever its choices take: a choice's (Which's) first condition is always worked
// out, its values and later conditions only when reached.
void collectUnconditionalSymbolIndexes(const CompiledExpression& expression, std::set<std::size_t>& indexes) {
    if (expression.operation == ExpressionOperation::symbol) indexes.insert(expression.symbolIndex);
    if (expression.operation == ExpressionOperation::conditional) {
        if (!expression.arguments.empty()) collectUnconditionalSymbolIndexes(expression.arguments.front(), indexes);
        return;
    }
    for (const auto& argument : expression.arguments) collectUnconditionalSymbolIndexes(argument, indexes);
}

bool expressionReadsSymbol(const CompiledExpression& expression, std::size_t symbolIndex) {
    if (expression.operation == ExpressionOperation::symbol && expression.symbolIndex == symbolIndex) return true;
    return std::any_of(expression.arguments.begin(), expression.arguments.end(), [&](const auto& argument) {
        return expressionReadsSymbol(argument, symbolIndex);
    });
}

// The local states a task reads: every one a provider binds, but only those an equation uses (the
// node editor binds all of a node's states to each source term, used or not).
std::vector<EntityId> localStatesRead(const ContributionTask& task) {
    std::vector<EntityId> stateIds;
    for (std::size_t index = 0; index < task.bindings.size(); ++index) {
        const auto& binding = task.bindings[index];
        if (binding.source != BindingSource::localState) continue;
        if (task.implementation == ContributionImplementation::equation && !expressionReadsSymbol(task.expression, index)) continue;
        stateIds.push_back(binding.valueId);
    }
    return stateIds;
}

std::string programProcessKeyPrefix(ContributionImplementation implementation, std::uint32_t version) {
    const bool python = implementation == ContributionImplementation::pythonProvider;
    if (version == 2) return python ? "py2:" : "cpp2:";
    return python ? "py:" : "cpp:";
}

void bindTask(ContributionTask& task) {
    for (auto& binding : task.bindings) {
        if (binding.source != BindingSource::parameter) continue;
        const auto found = std::find_if(task.parameters.begin(), task.parameters.end(), [&](const auto& parameter) {
            return parameter.id == binding.valueId;
        });
        if (found == task.parameters.end()) throw std::runtime_error("An executable parameter binding is unresolved.");
        binding.parameterIndex = static_cast<std::size_t>(std::distance(task.parameters.begin(), found));
    }
    if (task.implementation == ContributionImplementation::equation) bindExpressionSymbols(task.expression, task.bindings);
    else task.providerProcessKeyCache = programProcessKeyPrefix(task.implementation, task.programVersion) + task.providerSource;
}

// What the engine knows of a model to describe and check version 2 programs: every node's name, every state's unit and every
// parameter's (a shared parameter's for one linked to it).
struct ProgramContext {
    std::unordered_map<EntityId, std::string> nodeNames;
    std::unordered_map<EntityId, std::string> stateUnits;
    std::unordered_map<EntityId, std::string> parameterUnits;
    std::unordered_map<EntityId, std::string> stateLabels;
    std::unordered_map<EntityId, std::string> parameterLabels;
};

ProgramContext scanProgramContext(const boost::property_tree::ptree& document) {
    ProgramContext context;
    std::unordered_map<EntityId, std::string> sharedUnits;
    if (const auto shared = document.get_child_optional("sharedParameters")) {
        for (const auto& item : *shared) sharedUnits[idValue(item.second, "id")] = value(item.second, "unit");
    }
    const auto parameterUnit = [&](const boost::property_tree::ptree& parameter) {
        const auto linked = parameter.get_optional<EntityId>("sharedParameterId");
        if (linked && sharedUnits.contains(*linked)) return sharedUnits.at(*linked);
        return value(parameter, "unit");
    };
    for (const auto& [id, unit] : sharedUnits) context.parameterUnits[id] = unit;
    const auto parameterLabel = [](const boost::property_tree::ptree& parameter) {
        const auto name = value(parameter, "name");
        return "the parameter " + (name.empty() ? value(parameter, "symbol") : name);
    };
    if (const auto shared = document.get_child_optional("sharedParameters")) {
        for (const auto& item : *shared) context.parameterLabels[idValue(item.second, "id")] = parameterLabel(item.second);
    }
    if (const auto nodes = document.get_child_optional("nodes")) for (const auto& nodeItem : *nodes) {
        const auto& node = nodeItem.second;
        context.nodeNames[idValue(node, "id")] = value(node, "name");
        if (const auto states = node.get_child_optional("states")) for (const auto& state : *states) {
            const auto stateId = idValue(state.second, "id");
            context.stateUnits[stateId] = value(state.second, "unit");
            const auto symbol = value(state.second, "symbol");
            context.stateLabels[stateId] = value(node, "name") + "." + (symbol.empty() ? value(state.second, "name") : symbol);
        }
        if (const auto terms = node.get_child_optional("sourceTerms")) for (const auto& term : *terms) {
            if (const auto parameters = term.second.get_child_optional("parameters")) {
                for (const auto& parameter : *parameters) {
                    context.parameterUnits[idValue(parameter.second, "id")] = parameterUnit(parameter.second);
                    context.parameterLabels[idValue(parameter.second, "id")] = parameterLabel(parameter.second);
                }
            }
        }
    }
    if (const auto edges = document.get_child_optional("edges")) for (const auto& edgeItem : *edges) {
        if (const auto parameters = edgeItem.second.get_child_optional("parameters")) {
            for (const auto& parameter : *parameters) {
                context.parameterUnits[idValue(parameter.second, "id")] = parameterUnit(parameter.second);
                context.parameterLabels[idValue(parameter.second, "id")] = parameterLabel(parameter.second);
            }
        }
    }
    return context;
}

// A program's SDK version from its implementation: absent or 1 is version 1; 2 is version 2; any other is refused by name.
std::uint32_t programVersionOf(const boost::property_tree::ptree& implementation) {
    const auto text = value(implementation, "providerApiVersion");
    if (text.empty() || text == "1") return 1;
    if (text == "2") return 2;
    throw std::runtime_error("This program is written for version " + text + " of the program SDK, which this Konjugate does not have; update Konjugate.");
}

// The units a version 2 program's bindings are measured in.
void bindProgramUnits(std::vector<CompiledBinding>& bindings, const ProgramContext& context) {
    for (auto& binding : bindings) {
        const auto lookup = [&](const std::unordered_map<EntityId, std::string>& map) {
            const auto found = map.find(binding.valueId);
            return found != map.end() ? found->second : std::string();
        };
        if (binding.source == BindingSource::simulationTime) {
            binding.unit = "s";
            binding.label = "the time";
        } else if (binding.source == BindingSource::parameter) {
            binding.unit = lookup(context.parameterUnits);
            binding.label = lookup(context.parameterLabels);
        } else {
            binding.unit = lookup(context.stateUnits);
            binding.label = lookup(context.stateLabels);
        }
    }
}

// An expression's value, each symbol's from `read`: the symbols' values as they stand, or an algebraic relationship's
// with each definition worked out when first read.
template <typename Read>
double evaluateWith(const CompiledExpression& expression, Read& read) {
    const auto& arguments = expression.arguments;
    const auto argument = [&](std::size_t index) {
        if (index >= arguments.size()) throw std::runtime_error("Executable expression has too few arguments.");
        return evaluateWith(arguments[index], read);
    };
    switch (expression.operation) {
        case ExpressionOperation::literal: return expression.literal;
        case ExpressionOperation::symbol: return read(expression.symbolIndex);
        case ExpressionOperation::add: {
            double result = 0;
            for (const auto& item : arguments) result += evaluateWith(item, read);
            return result;
        }
        case ExpressionOperation::multiply: {
            double result = 1;
            for (const auto& item : arguments) result *= evaluateWith(item, read);
            return result;
        }
        case ExpressionOperation::negate: return -argument(0);
        case ExpressionOperation::divide: return argument(0) / argument(1);
        case ExpressionOperation::power: return std::pow(argument(0), argument(1));
        case ExpressionOperation::squareRoot: return std::sqrt(argument(0));
        case ExpressionOperation::absolute: return std::abs(argument(0));
        case ExpressionOperation::exponential: return std::exp(argument(0));
        case ExpressionOperation::logarithm: return std::log(argument(0));
        case ExpressionOperation::sine: return std::sin(argument(0));
        case ExpressionOperation::cosine: return std::cos(argument(0));
        case ExpressionOperation::tangent: return std::tan(argument(0));
        case ExpressionOperation::arcsine: return std::asin(argument(0));
        case ExpressionOperation::arccosine: return std::acos(argument(0));
        case ExpressionOperation::arctangent: return std::atan(argument(0));
        case ExpressionOperation::arctangent2: return std::atan2(argument(0), argument(1));
        case ExpressionOperation::hyperbolicTangent: return std::tanh(argument(0));
        case ExpressionOperation::minimum: return std::min(argument(0), argument(1));
        case ExpressionOperation::maximum: return std::max(argument(0), argument(1));
        case ExpressionOperation::conditional: {
            // (condition, value) pairs, first true condition wins; only the chosen value is
            // evaluated. The validator requires a final "True" (otherwise) branch.
            for (std::size_t index = 0; index + 1 < arguments.size(); index += 2) {
                if (evaluateWith(arguments[index], read) != 0.0) return evaluateWith(arguments[index + 1], read);
            }
            throw std::runtime_error("No branch of a cases expression matched.");
        }
        case ExpressionOperation::less:
        case ExpressionOperation::lessEqual:
        case ExpressionOperation::greater:
        case ExpressionOperation::greaterEqual:
        case ExpressionOperation::equal:
        case ExpressionOperation::notEqual: {
            // Chained, as MathJSON writes 0 < x < 1: every adjacent pair must hold.
            if (arguments.size() < 2) throw std::runtime_error("Executable expression has too few arguments.");
            double left = evaluateWith(arguments[0], read);
            for (std::size_t index = 1; index < arguments.size(); ++index) {
                const double right = evaluateWith(arguments[index], read);
                bool holds = false;
                switch (expression.operation) {
                    case ExpressionOperation::less: holds = left < right; break;
                    case ExpressionOperation::lessEqual: holds = left <= right; break;
                    case ExpressionOperation::greater: holds = left > right; break;
                    case ExpressionOperation::greaterEqual: holds = left >= right; break;
                    case ExpressionOperation::equal: holds = left == right; break;
                    default: holds = left != right; break;
                }
                if (!holds) return 0.0;
                left = right;
            }
            return 1.0;
        }
        case ExpressionOperation::logicalAnd: {
            for (const auto& item : arguments) if (evaluateWith(item, read) == 0.0) return 0.0;
            return 1.0;
        }
        case ExpressionOperation::logicalOr: {
            for (const auto& item : arguments) if (evaluateWith(item, read) != 0.0) return 1.0;
            return 0.0;
        }
        case ExpressionOperation::logicalNot: return argument(0) == 0.0 ? 1.0 : 0.0;
    }
    throw std::runtime_error("Executable expression operation is invalid.");
}

// Why a fail instruction throws: its index.
constexpr const char* programFailures[] = {
    "Executable expression has too few arguments.",
    "No branch of a cases expression matched.",
    "Executable expression operation is invalid.",
    "Executable symbol binding is invalid."
};

// Writes an expression's program: each operation after its arguments, in the order the tree walks them. A sum starts
// from 0 and a product from 1, adding or multiplying each argument in turn as the walk does, so even a sum of one
// negative zero comes out the same. An operation short of arguments fails only if reached, as in the tree.
struct ProgramWriter {
    ExpressionProgram& program;
    std::size_t depth = 0;

    std::size_t add(InstructionCode code, int effect, std::uint32_t index = 0, double value = 0) {
        program.instructions.push_back({code, index, value});
        depth = static_cast<std::size_t>(static_cast<std::ptrdiff_t>(depth) + effect);
        program.depth = std::max(program.depth, depth);
        return program.instructions.size() - 1;
    }
    // Points the jump at `jump` to the next instruction written.
    void land(std::size_t jump) {
        if (program.instructions.size() > std::numeric_limits<std::uint32_t>::max()) throw std::runtime_error("An expression is too long to compile.");
        program.instructions[jump].index = static_cast<std::uint32_t>(program.instructions.size());
    }
    bool has(const CompiledExpression& expression, std::size_t count) {
        if (expression.arguments.size() >= count) return true;
        add(InstructionCode::fail, 1, 0);
        return false;
    }
    void unary(const CompiledExpression& expression, InstructionCode code) {
        if (!has(expression, 1)) return;
        write(expression.arguments[0]);
        add(code, 0);
    }
    void binary(const CompiledExpression& expression, InstructionCode code) {
        if (!has(expression, 2)) return;
        write(expression.arguments[0]);
        write(expression.arguments[1]);
        add(code, -1);
    }

    void write(const CompiledExpression& expression) {
        const auto& arguments = expression.arguments;
        const auto base = depth;
        switch (expression.operation) {
            case ExpressionOperation::literal: add(InstructionCode::literal, 1, 0, expression.literal); return;
            case ExpressionOperation::symbol:
                if (expression.symbolIndex > std::numeric_limits<std::uint32_t>::max()) add(InstructionCode::fail, 1, 3);
                else add(InstructionCode::symbol, 1, static_cast<std::uint32_t>(expression.symbolIndex));
                return;
            case ExpressionOperation::add:
            case ExpressionOperation::multiply: {
                const bool sum = expression.operation == ExpressionOperation::add;
                add(InstructionCode::literal, 1, 0, sum ? 0.0 : 1.0);
                for (const auto& item : arguments) {
                    write(item);
                    add(sum ? InstructionCode::add : InstructionCode::multiply, -1);
                }
                return;
            }
            case ExpressionOperation::negate: unary(expression, InstructionCode::negate); return;
            case ExpressionOperation::divide: binary(expression, InstructionCode::divide); return;
            case ExpressionOperation::power: binary(expression, InstructionCode::power); return;
            case ExpressionOperation::squareRoot: unary(expression, InstructionCode::squareRoot); return;
            case ExpressionOperation::absolute: unary(expression, InstructionCode::absolute); return;
            case ExpressionOperation::exponential: unary(expression, InstructionCode::exponential); return;
            case ExpressionOperation::logarithm: unary(expression, InstructionCode::logarithm); return;
            case ExpressionOperation::sine: unary(expression, InstructionCode::sine); return;
            case ExpressionOperation::cosine: unary(expression, InstructionCode::cosine); return;
            case ExpressionOperation::tangent: unary(expression, InstructionCode::tangent); return;
            case ExpressionOperation::arcsine: unary(expression, InstructionCode::arcsine); return;
            case ExpressionOperation::arccosine: unary(expression, InstructionCode::arccosine); return;
            case ExpressionOperation::arctangent: unary(expression, InstructionCode::arctangent); return;
            case ExpressionOperation::arctangent2: binary(expression, InstructionCode::arctangent2); return;
            case ExpressionOperation::hyperbolicTangent: unary(expression, InstructionCode::hyperbolicTangent); return;
            case ExpressionOperation::minimum: binary(expression, InstructionCode::minimum); return;
            case ExpressionOperation::maximum: binary(expression, InstructionCode::maximum); return;
            case ExpressionOperation::conditional: {
                // Each condition, then its value if it holds; past the last pair, no branch matched.
                std::vector<std::size_t> ends;
                for (std::size_t index = 0; index + 1 < arguments.size(); index += 2) {
                    write(arguments[index]);
                    const auto skip = add(InstructionCode::jumpIfZero, -1);
                    write(arguments[index + 1]);
                    ends.push_back(add(InstructionCode::jump, 0));
                    depth = base;
                    land(skip);
                }
                add(InstructionCode::fail, 1, 1);
                for (const auto end : ends) land(end);
                depth = base + 1;
                return;
            }
            case ExpressionOperation::less:
            case ExpressionOperation::lessEqual:
            case ExpressionOperation::greater:
            case ExpressionOperation::greaterEqual:
            case ExpressionOperation::equal:
            case ExpressionOperation::notEqual: {
                if (!has(expression, 2)) return;
                // Each pair in turn, going on from its right; the first that fails settles the chain.
                const auto comparison = static_cast<std::uint32_t>(static_cast<int>(expression.operation) - static_cast<int>(ExpressionOperation::less));
                std::vector<std::size_t> fails;
                write(arguments[0]);
                for (std::size_t index = 1; index < arguments.size(); ++index) {
                    write(arguments[index]);
                    add(InstructionCode::compare, 0, comparison);
                    fails.push_back(add(InstructionCode::jumpIfZero, -1));
                }
                add(InstructionCode::pop, -1);
                add(InstructionCode::literal, 1, 0, 1.0);
                const auto end = add(InstructionCode::jump, 0);
                depth = base + 1;
                for (const auto fail : fails) land(fail);
                add(InstructionCode::pop, -1);
                add(InstructionCode::literal, 1, 0, 0.0);
                land(end);
                return;
            }
            case ExpressionOperation::logicalAnd:
            case ExpressionOperation::logicalOr: {
                // The first argument false (for And) or true (for Or) settles it.
                const bool all = expression.operation == ExpressionOperation::logicalAnd;
                std::vector<std::size_t> settled;
                for (const auto& item : arguments) {
                    write(item);
                    settled.push_back(add(all ? InstructionCode::jumpIfZero : InstructionCode::jumpIfNonzero, -1));
                }
                add(InstructionCode::literal, 1, 0, all ? 1.0 : 0.0);
                const auto end = add(InstructionCode::jump, 0);
                depth = base;
                for (const auto jump : settled) land(jump);
                add(InstructionCode::literal, 1, 0, all ? 0.0 : 1.0);
                land(end);
                return;
            }
            case ExpressionOperation::logicalNot: unary(expression, InstructionCode::logicalNot); return;
        }
        add(InstructionCode::fail, 1, 2);
    }
};

ExpressionProgram expressionProgram(const CompiledExpression& expression) {
    ExpressionProgram program;
    ProgramWriter writer{program};
    writer.write(expression);
    return program;
}

// An algebraic relationship's expression as a program reading each symbol as what it is: a state from the states as they
// stand, a parameter or the time as resolved for the instant, a definition worked out when first read.
ExpressionProgram relationshipProgram(const CompiledExpression& expression, const AlgebraicRelationship& relationship) {
    auto program = expressionProgram(expression);
    const auto bindingCount = relationship.bindings.size();
    for (auto& instruction : program.instructions) {
        if (instruction.code != InstructionCode::symbol) continue;
        const std::size_t index = instruction.index;
        if (index >= bindingCount + relationship.definitions.size()) {
            instruction = {InstructionCode::fail, 3, 0};
        } else if (index >= bindingCount) {
            instruction = {InstructionCode::definition, static_cast<std::uint32_t>(index - bindingCount), 0};
        } else if (relationship.stateReads[index] == std::numeric_limits<std::size_t>::max()) {
            instruction = {InstructionCode::resolved, instruction.index, 0};
        } else if (relationship.stateReads[index] <= std::numeric_limits<std::uint32_t>::max()) {
            instruction = {InstructionCode::state, static_cast<std::uint32_t>(relationship.stateReads[index]), 0};
        }
    }
    return program;
}

// Runs a program, each symbol's value from `read`. Reading a symbol may run other programs (an algebraic relationship's
// definitions, worked out when first read): each run keeps its own stack.
template <typename Read>
double runProgram(const ExpressionProgram& program, Read& read) {
    constexpr std::size_t onFrame = 64;
    double frame[onFrame];
    std::vector<double> large;
    double* stack = frame;
    if (program.depth > onFrame) {
        large.resize(program.depth);
        stack = large.data();
    }
    std::size_t top = 0;
    const auto* instructions = program.instructions.data();
    const auto count = program.instructions.size();
    for (std::size_t at = 0; at < count; ++at) {
        const auto& instruction = instructions[at];
        switch (instruction.code) {
            case InstructionCode::literal: stack[top++] = instruction.value; break;
            case InstructionCode::symbol: { const double value = read(instruction.index); stack[top++] = value; break; }
            case InstructionCode::state:
            case InstructionCode::resolved:
            case InstructionCode::definition:
                if constexpr (requires { read.definition(std::size_t{}); }) {
                    double value = 0;
                    if (instruction.code == InstructionCode::state) value = read.state(instruction.index);
                    else if (instruction.code == InstructionCode::resolved) value = read.resolved(instruction.index);
                    else value = read.definition(instruction.index);
                    stack[top++] = value;
                    break;
                } else {
                    throw std::runtime_error("Executable symbol binding is invalid.");
                }
            case InstructionCode::add: --top; stack[top - 1] += stack[top]; break;
            case InstructionCode::multiply: --top; stack[top - 1] *= stack[top]; break;
            case InstructionCode::negate: stack[top - 1] = -stack[top - 1]; break;
            case InstructionCode::divide: --top; stack[top - 1] = stack[top - 1] / stack[top]; break;
            case InstructionCode::power: --top; stack[top - 1] = std::pow(stack[top - 1], stack[top]); break;
            case InstructionCode::squareRoot: stack[top - 1] = std::sqrt(stack[top - 1]); break;
            case InstructionCode::absolute: stack[top - 1] = std::abs(stack[top - 1]); break;
            case InstructionCode::exponential: stack[top - 1] = std::exp(stack[top - 1]); break;
            case InstructionCode::logarithm: stack[top - 1] = std::log(stack[top - 1]); break;
            case InstructionCode::sine: stack[top - 1] = std::sin(stack[top - 1]); break;
            case InstructionCode::cosine: stack[top - 1] = std::cos(stack[top - 1]); break;
            case InstructionCode::tangent: stack[top - 1] = std::tan(stack[top - 1]); break;
            case InstructionCode::arcsine: stack[top - 1] = std::asin(stack[top - 1]); break;
            case InstructionCode::arccosine: stack[top - 1] = std::acos(stack[top - 1]); break;
            case InstructionCode::arctangent: stack[top - 1] = std::atan(stack[top - 1]); break;
            case InstructionCode::arctangent2: --top; stack[top - 1] = std::atan2(stack[top - 1], stack[top]); break;
            case InstructionCode::hyperbolicTangent: stack[top - 1] = std::tanh(stack[top - 1]); break;
            case InstructionCode::minimum: --top; stack[top - 1] = std::min(stack[top - 1], stack[top]); break;
            case InstructionCode::maximum: --top; stack[top - 1] = std::max(stack[top - 1], stack[top]); break;
            case InstructionCode::compare: {
                const double left = stack[top - 2];
                const double right = stack[top - 1];
                bool holds = false;
                switch (instruction.index) {
                    case 0: holds = left < right; break;
                    case 1: holds = left <= right; break;
                    case 2: holds = left > right; break;
                    case 3: holds = left >= right; break;
                    case 4: holds = left == right; break;
                    default: holds = left != right; break;
                }
                stack[top - 2] = right;
                stack[top - 1] = holds ? 1.0 : 0.0;
                break;
            }
            case InstructionCode::logicalNot: stack[top - 1] = stack[top - 1] == 0.0 ? 1.0 : 0.0; break;
            case InstructionCode::jump: at = instruction.index - 1; break;
            case InstructionCode::jumpIfZero: if (stack[--top] == 0.0) at = instruction.index - 1; break;
            case InstructionCode::jumpIfNonzero: if (stack[--top] != 0.0) at = instruction.index - 1; break;
            case InstructionCode::pop: --top; break;
            case InstructionCode::fail: throw std::runtime_error(programFailures[std::min<std::size_t>(instruction.index, 3)]);
        }
    }
    return stack[0];
}

// An expression's value: by its program when it has one, otherwise by walking its tree.
template <typename Read>
double evaluateCompiled(const CompiledExpression& expression, const ExpressionProgram& program, Read& read) {
    return program.instructions.empty() ? evaluateWith(expression, read) : runProgram(program, read);
}

// A task's equation's value from its symbols' values.
double evaluateTask(const ContributionTask& task, const std::vector<double>& symbols) {
    const auto read = [&](std::size_t index) {
        if (index >= symbols.size()) throw std::runtime_error("Executable symbol binding is invalid.");
        return symbols[index];
    };
    return evaluateCompiled(task.expression, task.program, read);
}

}

double CompiledExpression::evaluate(const std::vector<double>& symbols) const {
    const auto read = [&](std::size_t index) {
        if (index >= symbols.size()) throw std::runtime_error("Executable symbol binding is invalid.");
        return symbols[index];
    };
    return evaluateWith(*this, read);
}

std::size_t CompiledExpression::operationCount() const noexcept {
    std::size_t count = 1;
    for (const auto& argument : arguments) count += argument.operationCount();
    return count;
}

namespace {

void compileAlgebraicRelationship(ExecutionPlan& plan, const boost::property_tree::ptree& edge, const boost::property_tree::ptree& outputs,
                                  const SharedParameters& sharedParameters,
                                  std::unordered_map<EntityId, std::shared_ptr<const ParameterSchedule>>& storedSchedules) {
    if (value(edge, "directionality") == "bidirectional") throw std::runtime_error("A relationship with several equations is directed.");
    if (!value(edge, "implementation.kind").empty() && value(edge, "implementation.kind") != "equation") {
        throw std::runtime_error("A relationship with several equations is written as equations.");
    }
    AlgebraicRelationship relationship;
    relationship.edgeId = idValue(edge, "id");
    const std::unordered_map<EntityId, std::size_t> noLocalStates;
    if (const auto bindings = edge.get_child_optional("equationModel.bindings")) {
        // No node is the output's own: every state is read from the plan's whole state vector.
        relationship.bindings = compileBindings(*bindings, 0, false, plan.stateIndexes, noLocalStates);
    }
    if (const auto parameters = edge.get_child_optional("parameters")) {
        for (const auto& parameterItem : *parameters) relationship.parameters.push_back(compileParameter(parameterItem.second, sharedParameters, storedSchedules));
    }
    for (auto& binding : relationship.bindings) {
        if (binding.source != BindingSource::parameter) continue;
        const auto found = std::find_if(relationship.parameters.begin(), relationship.parameters.end(), [&](const auto& parameter) { return parameter.id == binding.valueId; });
        if (found == relationship.parameters.end()) throw std::runtime_error("An executable parameter binding is unresolved.");
        binding.parameterIndex = static_cast<std::size_t>(std::distance(relationship.parameters.begin(), found));
    }
    std::unordered_map<std::string, std::size_t> names;
    std::size_t nameCount = 0;
    for (const auto& binding : relationship.bindings) names.emplace(binding.symbol, nameCount++);
    if (const auto definitions = edge.get_child_optional("equationModel.definitions")) {
        for (const auto& definitionItem : *definitions) {
            auto expression = compileExpression(definitionItem.second.get_child("mathJson"));
            // A definition reads the bindings and the definitions before it.
            bindExpressionNames(expression, names);
            names.emplace(value(definitionItem.second, "symbol"), nameCount++);
            relationship.definitions.push_back(std::move(expression));
        }
    }
    const auto bindingCount = relationship.bindings.size();
    // Where each binding is read from: a state's place in the plan's states, or its symbol's value for the instant.
    for (const auto& binding : relationship.bindings) {
        const bool constant = binding.source == BindingSource::parameter || binding.source == BindingSource::simulationTime;
        relationship.stateReads.push_back(constant ? std::numeric_limits<std::size_t>::max() : binding.valueIndex);
    }
    // The definitions each definition reads whatever its choices (Which) take; the others only if the branch reading them
    // is taken. Each output's closure over them is found by a walk, so a long chain of definitions costs in proportion to
    // what each output needs rather than to its square.
    relationship.unconditionalDefinitions.resize(relationship.definitions.size());
    for (std::size_t index = 0; index < relationship.definitions.size(); ++index) {
        std::set<std::size_t> always;
        collectUnconditionalSymbolIndexes(relationship.definitions[index], always);
        for (const auto symbol : always) if (symbol >= bindingCount) relationship.unconditionalDefinitions[index].push_back(symbol - bindingCount);
    }
    // The definitions `roots` reach through `edges`, in ascending order; `seen` marks each with `stamp` once.
    std::vector<std::size_t> seen(relationship.definitions.size(), 0);
    std::size_t stamp = 0;
    const auto closure = [&](const std::set<std::size_t>& symbols, const std::vector<std::vector<std::size_t>>& edges) {
        ++stamp;
        std::vector<std::size_t> found;
        std::vector<std::size_t> pending;
        for (const auto symbol : symbols) {
            if (symbol < bindingCount || seen[symbol - bindingCount] == stamp) continue;
            seen[symbol - bindingCount] = stamp;
            pending.push_back(symbol - bindingCount);
        }
        while (!pending.empty()) {
            const auto at = pending.back();
            pending.pop_back();
            found.push_back(at);
            for (const auto next : edges[at]) {
                if (seen[next] == stamp) continue;
                seen[next] = stamp;
                pending.push_back(next);
            }
        }
        std::sort(found.begin(), found.end());
        return found;
    };
    const auto relationshipIndex = plan.algebraicRelationships.size();
    const auto sourceNodeId = idValue(edge, "source.nodeId");
    const auto targetNodeId = idValue(edge, "target.nodeId");
    for (const auto& outputItem : outputs) {
        const auto& output = outputItem.second;
        if (value(output, "setsValue") != "true") throw std::runtime_error("Each equation of a relationship with several equations sets its state's value.");
        AlgebraicOutput compiled;
        compiled.relationship = relationshipIndex;
        compiled.outputStateId = idValue(output, "stateId");
        const auto node = value(output, "role") == "source" ? sourceNodeId : targetNodeId;
        const auto found = plan.stateIndexes.find(compiled.outputStateId);
        if (found == plan.stateIndexes.end() || plan.stateNodes.at(compiled.outputStateId) != node) {
            throw std::runtime_error("A relationship's equation sets a state that is not its endpoint's.");
        }
        compiled.outputStateIndex = found->second;
        compiled.expression = compileExpression(output.get_child("mathJson"));
        bindExpressionNames(compiled.expression, names);
        std::set<std::size_t> alwaysSymbols;
        collectUnconditionalSymbolIndexes(compiled.expression, alwaysSymbols);
        compiled.eagerDefinitions = closure(alwaysSymbols, relationship.unconditionalDefinitions);
        plan.algebraicOutputs.push_back(std::move(compiled));
    }
    plan.algebraicRelationships.push_back(std::move(relationship));
}

// For each output, in plan.algebraicOutputs' order, the states in `written` it reads: those its equation and the
// definitions it needs use. Those are found for each definition once, in order, from the states it reads and those the
// earlier definitions it reads need (a relationship's outputs share most of their definitions, which may be thousands):
// only the states in `written`, which are few.
std::vector<std::vector<std::size_t>> algebraicOutputReads(const ExecutionPlan& plan, const std::unordered_set<std::size_t>& written) {
    // Per relationship, a bit for each binding reading a written state; per definition, the bits of those it
    // reads directly or through the definitions it reads. A definition reads only those before it, so each one's bits
    // are known when it is reached; most relationships read no written state and need none.
    struct Reads {
        std::vector<std::size_t> bitOfSymbol;
        std::vector<std::size_t> stateOfBit;
        std::size_t words = 0;
        std::vector<std::uint64_t> definitionBits;
    };
    constexpr auto none = std::numeric_limits<std::size_t>::max();
    std::vector<Reads> relationshipReads(plan.algebraicRelationships.size());
    // ORs into `bits` (`words` long) those of the symbols `expression` reads.
    const auto readBits = [&](const CompiledExpression& expression, const AlgebraicRelationship& relationship, const Reads& reads, std::uint64_t* bits) {
        std::set<std::size_t> symbols;
        collectSymbolIndexes(expression, symbols);
        for (const auto symbol : symbols) {
            if (symbol < relationship.bindings.size()) {
                const auto bit = reads.bitOfSymbol[symbol];
                if (bit != none) bits[bit / 64] |= std::uint64_t{1} << (bit % 64);
                continue;
            }
            const auto* through = reads.definitionBits.data() + (symbol - relationship.bindings.size()) * reads.words;
            for (std::size_t word = 0; word < reads.words; ++word) bits[word] |= through[word];
        }
    };
    for (std::size_t index = 0; index < plan.algebraicRelationships.size(); ++index) {
        const auto& relationship = plan.algebraicRelationships[index];
        auto& reads = relationshipReads[index];
        reads.bitOfSymbol.assign(relationship.bindings.size(), none);
        for (std::size_t symbol = 0; symbol < relationship.bindings.size(); ++symbol) {
            const auto& binding = relationship.bindings[symbol];
            if (binding.source != BindingSource::synchronizationSnapshot && binding.source != BindingSource::localState) continue;
            if (!written.contains(binding.valueIndex)) continue;
            reads.bitOfSymbol[symbol] = reads.stateOfBit.size();
            reads.stateOfBit.push_back(binding.valueIndex);
        }
        reads.words = (reads.stateOfBit.size() + 63) / 64;
        if (!reads.words) continue;
        reads.definitionBits.assign(relationship.definitions.size() * reads.words, 0);
        for (std::size_t definition = 0; definition < relationship.definitions.size(); ++definition) {
            readBits(relationship.definitions[definition], relationship, reads, reads.definitionBits.data() + definition * reads.words);
        }
    }
    std::vector<std::vector<std::size_t>> result(plan.algebraicOutputs.size());
    std::vector<std::uint64_t> bits;
    for (std::size_t index = 0; index < plan.algebraicOutputs.size(); ++index) {
        const auto& output = plan.algebraicOutputs[index];
        const auto& reads = relationshipReads[output.relationship];
        if (!reads.words) continue;
        bits.assign(reads.words, 0);
        readBits(output.expression, plan.algebraicRelationships[output.relationship], reads, bits.data());
        for (std::size_t bit = 0; bit < reads.stateOfBit.size(); ++bit) if (bits[bit / 64] >> (bit % 64) & 1) result[index].push_back(reads.stateOfBit[bit]);
    }
    return result;
}

// Orders the outputs so every output setting a state comes before any output reading it, where they form no ring (the
// order applyUpdates settles them in, and the order they were evaluated in before a ring was allowed). Outputs in or
// after a ring keep their document order; the update phase sweeps a ring rather than ordering it.
void orderAlgebraicOutputs(ExecutionPlan& plan) {
    if (plan.algebraicOutputs.empty()) return;
    std::unordered_map<std::size_t, std::vector<std::size_t>> writers;
    for (std::size_t index = 0; index < plan.algebraicOutputs.size(); ++index) writers[plan.algebraicOutputs[index].outputStateIndex].push_back(index);
    std::unordered_set<std::size_t> written;
    for (const auto& [state, writing] : writers) written.insert(state);
    const auto outputReads = algebraicOutputReads(plan, written);
    const auto count = plan.algebraicOutputs.size();
    std::vector<std::vector<std::size_t>> after(count);
    std::vector<std::size_t> waiting(count, 0);
    for (std::size_t index = 0; index < count; ++index) {
        const auto& statesRead = outputReads[index];
        if (statesRead.empty()) continue;
        std::set<std::size_t> dependencies;
        for (const auto read : statesRead) {
            const auto& writing = writers.at(read);
            dependencies.insert(writing.begin(), writing.end());
        }
        for (const auto dependency : dependencies) {
            after[dependency].push_back(index);
            ++waiting[index];
        }
    }
    std::vector<std::size_t> ready;
    for (std::size_t index = count; index-- > 0;) if (!waiting[index]) ready.push_back(index);
    std::vector<AlgebraicOutput> ordered;
    ordered.reserve(count);
    while (!ready.empty()) {
        const auto index = ready.back();
        ready.pop_back();
        ordered.push_back(std::move(plan.algebraicOutputs[index]));
        for (auto next = after[index].rbegin(); next != after[index].rend(); ++next) if (!--waiting[*next]) ready.push_back(*next);
    }
    // A ring leaves its outputs, and those after it, waiting: they follow in document order.
    if (ordered.size() != count) {
        std::vector<AlgebraicOutput> rest;
        for (std::size_t index = 0; index < count; ++index) if (waiting[index]) rest.push_back(std::move(plan.algebraicOutputs[index]));
        for (auto& output : rest) ordered.push_back(std::move(output));
    }
    plan.algebraicOutputs = std::move(ordered);
    std::set<std::size_t> states;
    for (const auto& output : plan.algebraicOutputs) states.insert(output.outputStateIndex);
    plan.algebraicStateIndexes.assign(states.begin(), states.end());
}

// Builds the update phase (docs/proposals/ratesAndUpdates.md): every term setting an Update state, as one step each,
// with the state it sets and the states it reads that the phase sets; the steps of nodes worked out once per step; and
// those of settling nodes in groups in dependency order -- each strongly connected set of steps one group, a ring if it
// has more than one step or a step reading what it sets, the groups ordered so every group setting a state comes before
// any group reading it, ties going to the lowest step. Relationship outputs come first, in the order orderAlgebraicOutputs
// gave them, so where they form no ring they are worked out in exactly that order.
void buildUpdatePhase(ExecutionPlan& plan) {
    plan.updateSteps.clear();
    plan.oncePerStepSteps.clear();
    plan.settleGroups.clear();
    plan.settleStateIndexes.clear();
    constexpr auto none = std::numeric_limits<std::size_t>::max();
    std::vector<std::size_t> nodeOfState(plan.initialStates.size(), none);
    for (std::size_t node = 0; node < plan.nodes.size(); ++node) for (const auto index : plan.nodes[node].stateIndexes) nodeOfState[index] = node;
    std::unordered_set<std::size_t> written;
    for (const auto& output : plan.algebraicOutputs) written.insert(output.outputStateIndex);
    for (const auto& node : plan.nodes) {
        for (const auto* tasks : {&node.algebraicTasks, &node.valueTerms}) for (const auto& task : *tasks) written.insert(node.stateIndexes.at(task.outputStateIndex));
    }
    // A term's reads among the states the phase sets: every state a program binds, only those an equation uses.
    const auto readsOf = [&](const NodeExecutionPlan& node, const ContributionTask& task) {
        std::vector<std::size_t> reads;
        for (std::size_t index = 0; index < task.bindings.size(); ++index) {
            const auto& binding = task.bindings[index];
            if (task.implementation == ContributionImplementation::equation && !expressionReadsSymbol(task.expression, index)) continue;
            std::size_t state = none;
            if (binding.source == BindingSource::localState) state = node.stateIndexes.at(binding.valueIndex);
            else if (binding.source == BindingSource::synchronizationSnapshot) state = binding.valueIndex;
            if (state != none && written.contains(state)) reads.push_back(state);
        }
        return reads;
    };
    const auto outputReads = algebraicOutputReads(plan, written);
    for (std::size_t index = 0; index < plan.algebraicOutputs.size(); ++index) {
        const auto state = plan.algebraicOutputs[index].outputStateIndex;
        plan.updateSteps.push_back({UpdateStepKind::relationshipOutput, nodeOfState.at(state), index, state, outputReads[index]});
    }
    for (std::size_t node = 0; node < plan.nodes.size(); ++node) {
        const auto& compiled = plan.nodes[node];
        for (std::size_t index = 0; index < compiled.algebraicTasks.size(); ++index) {
            const auto& task = compiled.algebraicTasks[index];
            plan.updateSteps.push_back({UpdateStepKind::ownTerm, node, index, compiled.stateIndexes.at(task.outputStateIndex), readsOf(compiled, task)});
        }
        for (std::size_t index = 0; index < compiled.valueTerms.size(); ++index) {
            const auto& task = compiled.valueTerms[index];
            plan.updateSteps.push_back({UpdateStepKind::valueTerm, node, index, compiled.stateIndexes.at(task.outputStateIndex), readsOf(compiled, task)});
        }
    }
    {
        std::set<std::size_t> states(written.begin(), written.end());
        plan.algebraicStateIndexes.assign(states.begin(), states.end());
    }
    // Once per step, or settled with the node's others.
    std::vector<std::size_t> settling;
    for (std::size_t index = 0; index < plan.updateSteps.size(); ++index) {
        if (plan.nodes.at(plan.updateSteps[index].node).settles) settling.push_back(index);
        else plan.oncePerStepSteps.push_back(index);
    }
    if (settling.empty()) return;
    {
        std::set<std::size_t> states;
        for (const auto index : settling) states.insert(plan.updateSteps[index].writes);
        plan.settleStateIndexes.assign(states.begin(), states.end());
    }
    // The settling steps as a graph: from each step to every settling step reading the state it sets.
    const auto count = settling.size();
    std::unordered_map<std::size_t, std::vector<std::size_t>> settlingWriters;
    for (std::size_t local = 0; local < count; ++local) settlingWriters[plan.updateSteps[settling[local]].writes].push_back(local);
    std::vector<std::vector<std::size_t>> after(count);
    std::vector<bool> readsItself(count, false);
    for (std::size_t local = 0; local < count; ++local) {
        std::set<std::size_t> from;
        for (const auto state : plan.updateSteps[settling[local]].reads) {
            const auto found = settlingWriters.find(state);
            if (found != settlingWriters.end()) from.insert(found->second.begin(), found->second.end());
        }
        for (const auto writer : from) {
            if (writer == local) readsItself[local] = true;
            else after[writer].push_back(local);
        }
    }
    // Strongly connected sets (Tarjan's algorithm, iterative: a robot's chains of thousands of steps must not run out of stack).
    std::vector<std::size_t> order(count, none);
    std::vector<std::size_t> low(count, 0);
    std::vector<std::size_t> component(count, none);
    std::vector<bool> onStack(count, false);
    std::vector<std::size_t> stack;
    std::vector<std::vector<std::size_t>> components;
    std::size_t visited = 0;
    for (std::size_t root = 0; root < count; ++root) {
        if (order[root] != none) continue;
        std::vector<std::pair<std::size_t, std::size_t>> calls{{root, 0}};
        order[root] = low[root] = visited++;
        stack.push_back(root);
        onStack[root] = true;
        while (!calls.empty()) {
            auto& [at, next] = calls.back();
            if (next < after[at].size()) {
                const auto to = after[at][next++];
                if (order[to] == none) {
                    order[to] = low[to] = visited++;
                    stack.push_back(to);
                    onStack[to] = true;
                    calls.emplace_back(to, 0);
                } else if (onStack[to]) {
                    low[at] = std::min(low[at], order[to]);
                }
                continue;
            }
            if (low[at] == order[at]) {
                components.emplace_back();
                std::size_t member = none;
                do {
                    member = stack.back();
                    stack.pop_back();
                    onStack[member] = false;
                    component[member] = components.size() - 1;
                    components.back().push_back(member);
                } while (member != at);
            }
            const auto finished = at;
            calls.pop_back();
            if (!calls.empty()) low[calls.back().first] = std::min(low[calls.back().first], low[finished]);
        }
    }
    // The sets in dependency order, the one with the lowest step first among those ready.
    const auto sets = components.size();
    std::vector<std::size_t> lowest(sets, none);
    for (std::size_t local = 0; local < count; ++local) lowest[component[local]] = std::min(lowest[component[local]], local);
    std::vector<std::set<std::size_t>> successors(sets);
    std::vector<std::size_t> waiting(sets, 0);
    for (std::size_t local = 0; local < count; ++local) {
        for (const auto to : after[local]) {
            if (component[to] != component[local] && successors[component[local]].insert(component[to]).second) ++waiting[component[to]];
        }
    }
    std::set<std::pair<std::size_t, std::size_t>> ready;
    for (std::size_t set = 0; set < sets; ++set) if (!waiting[set]) ready.emplace(lowest[set], set);
    while (!ready.empty()) {
        const auto set = ready.begin()->second;
        ready.erase(ready.begin());
        SettleGroup group;
        group.limit = 0;
        std::vector<std::size_t> members = components[set];
        std::sort(members.begin(), members.end());
        for (const auto local : members) {
            group.steps.push_back(settling[local]);
            group.limit = std::max(group.limit, plan.nodes.at(plan.updateSteps[settling[local]].node).settleLimit);
        }
        group.ring = members.size() > 1 || readsItself[members.front()];
        if (!group.ring) group.limit = 1;
        plan.settleGroups.push_back(std::move(group));
        for (const auto next : successors[set]) if (!--waiting[next]) ready.emplace(lowest[next], next);
    }
}

}

namespace {

// The state at the other end of a bidirectional relationship, which takes its value negated: the edge's own source or
// target stateId when it names one of that node's states, else the node's first state, so an older saved edge without
// one still resolves sensibly. otherNodeStateIds are that node's states, in order; zero when it has none.
EntityId bidirectionalOtherStateId(const boost::property_tree::ptree& edge, const std::string& outputRole, const std::vector<EntityId>& otherNodeStateIds) {
    if (otherNodeStateIds.empty()) return 0;
    const auto otherStateText = value(edge, outputRole == "target" ? "source.stateId" : "target.stateId");
    if (!otherStateText.empty()) {
        std::size_t consumed = 0;
        const auto parsed = std::stoull(otherStateText, &consumed);
        if (parsed && consumed == otherStateText.size() &&
            std::find(otherNodeStateIds.begin(), otherNodeStateIds.end(), parsed) != otherNodeStateIds.end()) {
            return parsed;
        }
    }
    return otherNodeStateIds.front();
}

// What a document says of its states' kinds (docs/proposals/ratesAndUpdates.md). explicitUpdates: the states whose
// `kind` is "update", into which every term is a value. legacy: no state says its kind -- a document written before
// kinds existed -- whose values set at the same instant are Updates every node settles, so it gives the numbers it gave.
struct StateKinds {
    std::unordered_set<EntityId> explicitUpdates;
    bool legacy = true;
};

StateKinds scanStateKinds(const boost::property_tree::ptree& document) {
    StateKinds kinds;
    for (const auto& nodeItem : document.get_child("nodes")) {
        for (const auto& stateItem : nodeItem.second.get_child("states")) {
            const auto kind = value(stateItem.second, "kind");
            if (kind.empty()) continue;
            kinds.legacy = false;
            if (kind == "update") kinds.explicitUpdates.insert(idValue(stateItem.second, "id"));
        }
    }
    return kinds;
}

}

namespace {

// A Verlet node's two parts (NodeExecutionPlan::verlet): the states before the first one whose rate reads a state listed
// before it, and the rest. Only states with a rate count, and only what equations read: an Update holds its value through
// the step, and a term written as a program is held through the substep, so neither ties one state to another within it.
// Each rate may read only states of the other part; the first that does not is refused, in words.
void assignVerletParts(NodeExecutionPlan& node, const std::unordered_map<EntityId, std::string>& names) {
    if (node.nodeProvider) throw VerletStructureError(node.nodeId, "A node with a computational-node provider is integrated explicitly.");
    const auto count = node.stateIds.size();
    std::unordered_map<EntityId, std::size_t> localIndexes;
    for (std::size_t index = 0; index < count; ++index) localIndexes[node.stateIds[index]] = index;
    std::vector<bool> hasRate(count, false);
    for (const auto& task : node.contributions) hasRate[task.outputStateIndex] = true;
    // Per state, the states with a rate its equations read, in the order the node lists them.
    std::vector<std::vector<std::size_t>> reads(count);
    for (const auto& task : node.contributions) {
        if (task.implementation != ContributionImplementation::equation) continue;
        for (const auto stateId : localStatesRead(task)) {
            const auto found = localIndexes.find(stateId);
            if (found == localIndexes.end() || !hasRate[found->second]) continue;
            auto& list = reads[task.outputStateIndex];
            if (std::find(list.begin(), list.end(), found->second) == list.end()) list.push_back(found->second);
        }
    }
    for (auto& list : reads) std::sort(list.begin(), list.end());
    std::size_t split = count;
    for (std::size_t index = 0; index < count && split == count; ++index) {
        if (!reads[index].empty() && reads[index].front() < index) split = index;
    }
    node.verletKicked.assign(count, false);
    for (std::size_t index = 0; index < split; ++index) node.verletKicked[index] = hasRate[index];
    const auto name = [&](EntityId id) {
        const auto found = names.find(id);
        return found == names.end() || found->second.empty() ? std::to_string(id) : found->second;
    };
    for (std::size_t index = 0; index < count; ++index) {
        for (const auto read : reads[index]) {
            if (read != index && node.verletKicked[read] != node.verletKicked[index]) continue;
            const auto splitText = split == count ? std::string("none of its states reads one listed before it, so they are all one part")
                : "the second part starts at " + name(node.stateIds[split]) + ", the first state whose rate reads one listed before it";
            const auto problem = read == index ? "the rate of " + name(node.stateIds[index]) + " reads " + name(node.stateIds[index]) + " itself"
                : "the rate of " + name(node.stateIds[index]) + " reads " + name(node.stateIds[read]) + ", in the same part";
            throw VerletStructureError(node.nodeId, "Node \"" + name(node.nodeId) + "\" cannot be integrated with Verlet: " + problem +
                ". Verlet splits a node's states, in their listed order, in two parts and moves each from the other, so a state's "
                "rate may read only states of the other part, as a position's reads its speed and a speed's reads positions (here " +
                splitText + "). Reorder the states, or choose semi-implicit Euler for this node, or Runge–Kutta 4 for the whole model "
                "in the Run settings.");
        }
    }
}

// How a subsystem asks its nodes' Updates to be worked out (docs/proposals/ratesAndUpdates.md, over a subsystem): whether it
// settles them, the sweeps it gives a ring if it says so, and the subsystem it is in.
struct SubsystemUpdates {
    bool settles = false;
    std::optional<std::size_t> limit;
    EntityId parent = 0;
    bool hasParent = false;
};

std::unordered_map<EntityId, SubsystemUpdates> readSubsystemUpdates(const boost::property_tree::ptree& document) {
    std::unordered_map<EntityId, SubsystemUpdates> subsystems;
    const auto records = document.get_child_optional("subsystems");
    if (!records) return subsystems;
    // A file in which no subsystem says how its Updates are worked out is read exactly as before, its subsystems unread.
    const auto saysUpdates = std::any_of(records->begin(), records->end(), [](const auto& item) {
        return static_cast<bool>(item.second.get_child_optional("updates")) || static_cast<bool>(item.second.get_child_optional("updatesLimit"));
    });
    if (!saysUpdates) return subsystems;
    for (const auto& item : *records) {
        const auto& record = item.second;
        SubsystemUpdates entry;
        const auto updates = value(record, "updates");
        if (!updates.empty() && updates != "oncePerStep" && updates != "settle") throw std::runtime_error("A subsystem's updates must be oncePerStep or settle.");
        entry.settles = updates == "settle";
        if (record.get_child_optional("updatesLimit")) {
            entry.limit = record.get<std::size_t>("updatesLimit");
            if (!*entry.limit) throw std::runtime_error("A subsystem's updatesLimit must be a positive whole number.");
        }
        const auto parent = value(record, "parentSubsystemId");
        if (!parent.empty() && parent != "null") {
            entry.parent = idValue(record, "parentSubsystemId");
            entry.hasParent = true;
        }
        subsystems[idValue(record, "id")] = entry;
    }
    return subsystems;
}

}

ExecutionPlan compileExecutionPlan(const boost::property_tree::ptree& document) {
    checkRequiredFeatures(document);
    const auto programContext = scanProgramContext(document);
    const auto sharedParameters = collectSharedParameters(document);
    const auto stateKinds = scanStateKinds(document);
    const auto subsystemUpdates = readSubsystemUpdates(document);
    std::unordered_map<EntityId, std::shared_ptr<const ParameterSchedule>> storedSchedules;
    ExecutionPlan plan;
    std::unordered_map<EntityId, std::size_t> nodeIndexes;
    // The names of Verlet nodes and their states, for saying in words why one cannot be integrated so.
    std::unordered_map<EntityId, std::string> verletNames;
    // A disabled node contributes no state and no contribution tasks -- exactly as if it, and
    // every edge touching it, had been deleted from the model. Tracked so the edge loop below
    // can skip edges into a disabled node too, since their endpoint's state was never allocated.
    std::unordered_set<EntityId> disabledNodeIds;
    for (const auto& nodeItem : document.get_child("nodes")) {
        const auto& node = nodeItem.second;
        if (value(node, "enabled") == "false") {
            disabledNodeIds.insert(idValue(node, "id"));
            continue;
        }
        NodeExecutionPlan compiledNode;
        compiledNode.nodeId = idValue(node, "id");
        compiledNode.substeps = node.get<std::size_t>("numerics.substepsPerGlobalStep", 1);
        const auto integration = node.get<std::string>("numerics.integration", "explicit");
        if (integration != "explicit" && integration != "semiImplicit" && integration != "verlet") {
            throw std::runtime_error("A node's numerics.integration must be explicit, semiImplicit or verlet.");
        }
        compiledNode.semiImplicit = integration == "semiImplicit";
        compiledNode.verlet = integration == "verlet";
        if (compiledNode.verlet) {
            verletNames[compiledNode.nodeId] = value(node, "name");
            for (const auto& stateItem : node.get_child("states")) verletNames[idValue(stateItem.second, "id")] = value(stateItem.second, "name");
        }
        // How its Updates are worked out: settled within the step, or once per step; a legacy document settles them all.
        const auto updates = value(node, "updates");
        if (!updates.empty() && updates != "oncePerStep" && updates != "settle") throw std::runtime_error("A node's updates must be oncePerStep or settle.");
        compiledNode.settles = stateKinds.legacy || updates == "settle";
        // A node also settles when a subsystem it is in, at any depth, says so; its limit is the largest the node or any such
        // subsystem gives, 1000 when none gives one. A node in no settling subsystem is as it says.
        std::optional<std::size_t> limit;
        if (node.get_child_optional("updatesLimit")) limit = node.get<std::size_t>("updatesLimit");
        if (limit && !*limit) throw std::runtime_error("A node's updatesLimit must be a positive whole number.");
        if (!subsystemUpdates.empty() && !value(node, "subsystemId").empty() && value(node, "subsystemId") != "null") {
            auto at = subsystemUpdates.find(idValue(node, "subsystemId"));
            for (std::size_t depth = 0; at != subsystemUpdates.end() && depth <= subsystemUpdates.size(); ++depth) {
                if (at->second.settles) {
                    compiledNode.settles = true;
                    if (at->second.limit) limit = std::max(limit.value_or(0), *at->second.limit);
                }
                if (!at->second.hasParent) break;
                at = subsystemUpdates.find(at->second.parent);
            }
        }
        compiledNode.settleLimit = limit.value_or(1000);
        if (!compiledNode.substeps || compiledNode.substeps > 10000) {
            throw std::runtime_error("Node substepsPerGlobalStep must be an integer from 1 through 10000.");
        }
        for (const auto& stateItem : node.get_child("states")) {
            const auto stateId = idValue(stateItem.second, "id");
            compiledNode.stateIds.push_back(stateId);
            compiledNode.stateIndexes.push_back(plan.initialStates.size());
            plan.stateIndexes[stateId] = plan.initialStates.size();
            plan.initialStates.push_back(stateItem.second.get<double>("initialValue", 0));
            plan.stateNodes[stateId] = compiledNode.nodeId;
            plan.stateIds.push_back(stateId);
        }
        std::unordered_map<EntityId, std::size_t> localStateIndexes;
        for (std::size_t index = 0; index < compiledNode.stateIds.size(); ++index) {
            localStateIndexes[compiledNode.stateIds[index]] = index;
        }
        std::size_t sequence = 0;
        std::vector<ContributionTask> algebraicCandidates;
        for (const auto& termItem : node.get_child("sourceTerms")) {
            const auto& term = termItem.second;
            const auto termImplementationKind = value(term, "implementation.kind");
            const auto termProgrammable = termImplementationKind == "cpp" || termImplementationKind == "python";
            const bool termSetsValue = value(term, "setsValue") == "true";
            ContributionTask task;
            task.sequence = sequence++;
            task.sourceId = idValue(term, "id");
            task.outputStateId = idValue(term, termProgrammable ? "implementation.output.stateId" : "expressionModel.output.stateId");
            task.outputStateIndex = localStateIndexes.at(task.outputStateId);
            task.bindings = compileBindings(term.get_child(termProgrammable ? "implementation.bindings" : "expressionModel.bindings"),
                compiledNode.nodeId, true, plan.stateIndexes, localStateIndexes, termProgrammable ? "key" : "symbol");
            if (const auto parameters = term.get_child_optional("parameters")) for (const auto& parameterItem : *parameters) {
                const auto& parameter = parameterItem.second;
                task.parameters.push_back(compileParameter(parameter, sharedParameters, storedSchedules));
            }
            if (termProgrammable) {
                task.implementation = termImplementationKind == "cpp"
                    ? ContributionImplementation::cppProvider : ContributionImplementation::pythonProvider;
                task.providerSource = value(term, "implementation.source");
                task.providerOutputKey = value(term, "implementation.output.key");
                task.programVersion = programVersionOf(term.get_child("implementation"));
                if (task.programVersion == 2) {
                    task.programOwner = "node " + value(node, "name") + "'s own part";
                    task.programSeed = term.get<std::uint64_t>("implementation.seed", 0);
                    task.outputUnit = programContext.stateUnits.contains(task.outputStateId) ? programContext.stateUnits.at(task.outputStateId) : "";
                    task.outputLabel = programContext.stateLabels.contains(task.outputStateId) ? programContext.stateLabels.at(task.outputStateId) : "";
                    task.programOwnerKind = 1;
                    bindProgramUnits(task.bindings, programContext);
                    compiledNode.hasVersion2Programs = true;
                }
            } else {
                task.expression = compileExpression(term.get_child("expressionModel.mathJson"));
            }
            bindTask(task);
            compiledNode.estimatedOperationsPerSubstep += termProgrammable ? task.bindings.size() + 1 : task.expression.operationCount();
            // A term is a value when it says it sets one, or when its state's kind is "update".
            if (termSetsValue || stateKinds.explicitUpdates.contains(task.outputStateId)) algebraicCandidates.push_back(std::move(task));
            else compiledNode.contributions.push_back(std::move(task));
        }
        // Algebraic ("sets the value") source terms are recomputed fresh every substep, never
        // integrated -- see NodeExecutionPlan::algebraicTasks. One may itself bind another
        // algebraic task's own output state (e.g. "y = 2x, z = y + 1"), so they must be stored in
        // dependency order for applyAlgebraicTasks() to evaluate correctly in one pass. Binding
        // one's own output state is rejected outright (not just left for the generic cycle
        // check below) -- that would readmit exactly the hidden-recurrence, solver-specific
        // feedback this mechanism exists to eliminate, not a legitimate algebraic dependency.
        if (!algebraicCandidates.empty()) {
            // Several terms may set one state (they sum): a term reading it comes after every one.
            std::unordered_map<EntityId, std::vector<std::size_t>> algebraicIndexesByStateId;
            for (std::size_t index = 0; index < algebraicCandidates.size(); ++index) {
                algebraicIndexesByStateId[algebraicCandidates[index].outputStateId].push_back(index);
            }
            std::vector<std::vector<EntityId>> statesRead;
            for (const auto& task : algebraicCandidates) {
                statesRead.push_back(localStatesRead(task));
                // An Update may read its own value from the step's start (a counter); a value set at the same instant,
                // as a document without kinds means it, may not.
                if (!stateKinds.explicitUpdates.contains(task.outputStateId) &&
                    std::find(statesRead.back().begin(), statesRead.back().end(), task.outputStateId) != statesRead.back().end()) {
                    throw std::runtime_error(
                        "A node's own part that sets its state directly may not read that state.");
                }
            }
            std::vector<int> visitState(algebraicCandidates.size(), 0); // 0=unvisited, 1=visiting, 2=done
            std::vector<std::size_t> algebraicOrder;
            algebraicOrder.reserve(algebraicCandidates.size());
            std::function<void(std::size_t)> visit = [&](std::size_t index) {
                if (visitState[index] == 2) return;
                // A ring of a node's own terms is no longer refused: the update phase sweeps it. Here it keeps the order
                // it is found in.
                if (visitState[index] == 1) return;
                visitState[index] = 1;
                for (const auto stateId : statesRead[index]) {
                    if (stateId == algebraicCandidates[index].outputStateId) continue;
                    const auto found = algebraicIndexesByStateId.find(stateId);
                    if (found != algebraicIndexesByStateId.end()) for (const auto writer : found->second) visit(writer);
                }
                visitState[index] = 2;
                algebraicOrder.push_back(index);
            };
            for (std::size_t index = 0; index < algebraicCandidates.size(); ++index) visit(index);
            compiledNode.algebraicTasks.reserve(algebraicOrder.size());
            for (const auto index : algebraicOrder) compiledNode.algebraicTasks.push_back(std::move(algebraicCandidates[index]));
        }
        if (const auto implementation = node.get_child_optional("implementation")) {
            const auto kind = value(*implementation, "kind");
            if (kind != "python" && kind != "cpp") {
                throw std::runtime_error("A computational-node provider implementation kind must be python or cpp.");
            }
            NodeProviderTask providerTask;
            providerTask.implementation = kind == "cpp"
                ? ContributionImplementation::cppProvider : ContributionImplementation::pythonProvider;
            providerTask.nodeId = compiledNode.nodeId;
            providerTask.providerSource = value(*implementation, "source");
            // A binding to one of this node's own states reads it as it advances, like a source term;
            // one to another node's state reads it from the step's synchronization snapshot, like an
            // edge does. That other node's states may not be indexed yet (nodes compile in document
            // order), so its index is resolved once every node is compiled, below.
            if (const auto bindingsNode = implementation->get_child_optional("bindings")) {
                for (const auto& bindingItem : *bindingsNode) {
                    const auto& binding = bindingItem.second;
                    CompiledBinding compiled;
                    compiled.symbol = value(binding, "key");
                    if (value(binding, "kind") == "parameter") {
                        // A shared parameter, compiled as a parameter linked to it is, so its
                        // schedule and live control apply; one entry however many bindings read it.
                        if (!binding.get_child_optional("sharedParameterId")) {
                            throw std::runtime_error("A computational-node provider binds only shared parameters, by sharedParameterId.");
                        }
                        compiled.source = BindingSource::parameter;
                        compiled.valueId = idValue(binding, "sharedParameterId");
                        auto existing = std::find_if(providerTask.parameters.begin(), providerTask.parameters.end(),
                            [&](const auto& parameter) { return parameter.controlId == compiled.valueId; });
                        if (existing == providerTask.parameters.end()) {
                            boost::property_tree::ptree link;
                            link.put("id", compiled.valueId);
                            link.put("sharedParameterId", compiled.valueId);
                            providerTask.parameters.push_back(compileParameter(link, sharedParameters, storedSchedules));
                            existing = std::prev(providerTask.parameters.end());
                        }
                        compiled.parameterIndex = static_cast<std::size_t>(std::distance(providerTask.parameters.begin(), existing));
                    } else if (value(binding, "kind") == "time") {
                        compiled.source = BindingSource::simulationTime;
                    } else {
                        compiled.valueId = idValue(binding, "stateId");
                        const auto local = localStateIndexes.find(compiled.valueId);
                        compiled.source = local != localStateIndexes.end() ? BindingSource::localState : BindingSource::synchronizationSnapshot;
                        if (local != localStateIndexes.end()) compiled.valueIndex = local->second;
                    }
                    providerTask.bindings.push_back(std::move(compiled));
                }
            }
            for (const auto& outputItem : implementation->get_child("outputs")) {
                const auto& outputEntry = outputItem.second;
                NodeProviderOutputBinding output;
                output.key = value(outputEntry, "key");
                output.stateId = idValue(outputEntry, "stateId");
                output.stateIndex = localStateIndexes.at(output.stateId);
                output.setsValue = value(outputEntry, "setsValue") == "true";
                providerTask.outputs.push_back(std::move(output));
            }
            // Same reasoning, and same defensive necessity (main.cpp's run command compiles
            // without validating), as the algebraic-source-term self-reference throw above: a
            // setsValue output reading its own target state back through one of this provider's
            // own (shared, not per-output) bindings would make it a hidden, substep-count-dependent
            // recurrence rather than a genuine algebraic value.
            for (const auto& output : providerTask.outputs) {
                if (!output.setsValue) continue;
                for (const auto& binding : providerTask.bindings) {
                    if (binding.source == BindingSource::localState && binding.valueId == output.stateId) {
                        throw std::runtime_error(
                            "A computational-node-provider output that sets its state's value directly may not also be one of that provider's own input bindings.");
                    }
                }
            }
            providerTask.programVersion = programVersionOf(*implementation);
            if (providerTask.programVersion == 2) {
                providerTask.programOwner = "node " + value(node, "name");
                providerTask.programSeed = implementation->get<std::uint64_t>("seed", 0);
                bindProgramUnits(providerTask.bindings, programContext);
                // A version 2 program's output into an Update state is a value, read at the update instant; into a Rate state, a rate.
                for (auto& output : providerTask.outputs) {
                    output.setsValue = output.setsValue || stateKinds.explicitUpdates.contains(output.stateId);
                    output.unit = programContext.stateUnits.contains(output.stateId) ? programContext.stateUnits.at(output.stateId) : "";
                    output.label = programContext.stateLabels.contains(output.stateId) ? programContext.stateLabels.at(output.stateId) : "";
                }
                compiledNode.hasVersion2Programs = true;
            }
            providerTask.providerProcessKeyCache = programProcessKeyPrefix(providerTask.implementation, providerTask.programVersion) + providerTask.providerSource;
            compiledNode.estimatedOperationsPerSubstep += providerTask.bindings.size() + providerTask.outputs.size() + 1;
            compiledNode.nodeProvider = std::move(providerTask);
        }
        nodeIndexes[compiledNode.nodeId] = plan.nodes.size();
        plan.nodes.push_back(std::move(compiledNode));
    }

    for (auto& compiledNode : plan.nodes) {
        if (!compiledNode.nodeProvider) continue;
        for (auto& binding : compiledNode.nodeProvider->bindings) {
            if (binding.source != BindingSource::synchronizationSnapshot) continue;
            const auto found = plan.stateIndexes.find(binding.valueId);
            if (found == plan.stateIndexes.end()) {
                throw std::runtime_error("A computational-node provider binding references a state of a missing or disabled node.");
            }
            binding.valueIndex = found->second;
        }
    }

    for (const auto& edgeItem : document.get_child("edges")) {
        const auto& edge = edgeItem.second;
        // Same rule as a disabled node: skip a disabled edge, or one whose endpoint is disabled
        // (that endpoint's state was never allocated above, so its output/binding lookups below
        // would otherwise throw).
        if (value(edge, "enabled") == "false" ||
            disabledNodeIds.contains(idValue(edge, "source.nodeId")) ||
            disabledNodeIds.contains(idValue(edge, "target.nodeId"))) {
            continue;
        }
        const auto implementationKind = value(edge, "implementation.kind");
        // An algebraic relationship (equationModel.outputs): compiled apart from the nodes' tasks, as it
        // is evaluated for the whole plan at each synchronization instant.
        if (const auto outputs = edge.get_child_optional("equationModel.outputs")) {
            compileAlgebraicRelationship(plan, edge, *outputs, sharedParameters, storedSchedules);
            continue;
        }
        const auto programmable = implementationKind == "cpp" || implementationKind == "python";
        const auto outputRole = value(edge, programmable ? "implementation.output.role" : "equationModel.output.role");
        const auto severalOutputs = programmable && edge.get_child_optional("implementation.outputs") && !edge.get_child("implementation.outputs").empty();
        const auto outputStateId = severalOutputs ? EntityId{0} : idValue(edge, programmable ? "implementation.output.stateId" : "equationModel.output.stateId");
        const auto outputNodeId = severalOutputs ? EntityId{0} : plan.stateNodes.at(outputStateId);

        auto buildContribution = [&](EntityId contributionNodeId, EntityId contributionStateId, bool negate, const std::string& outputKey) {
            auto& contributionNode = plan.nodes.at(nodeIndexes.at(contributionNodeId));
            std::unordered_map<EntityId, std::size_t> localStateIndexes;
            for (std::size_t index = 0; index < contributionNode.stateIds.size(); ++index) {
                localStateIndexes[contributionNode.stateIds[index]] = index;
            }
            ContributionTask task;
            task.sequence = contributionNode.contributions.size();
            task.sourceId = idValue(edge, "id");
            task.outputStateId = contributionStateId;
            task.outputStateIndex = localStateIndexes.at(contributionStateId);
            task.negateOutput = negate;
            task.bindings = compileBindings(edge.get_child(programmable ? "implementation.bindings" : "equationModel.bindings"),
                contributionNodeId, false, plan.stateIndexes, localStateIndexes, programmable ? "key" : "symbol");
            for (const auto& parameterItem : edge.get_child("parameters")) {
                const auto& parameter = parameterItem.second;
                task.parameters.push_back(compileParameter(parameter, sharedParameters, storedSchedules));
            }
            if (programmable) {
                task.implementation = implementationKind == "cpp"
                    ? ContributionImplementation::cppProvider : ContributionImplementation::pythonProvider;
                task.providerSource = value(edge, "implementation.source");
                task.providerOutputKey = outputKey;
                task.programVersion = programVersionOf(edge.get_child("implementation"));
                if (task.programVersion == 2) {
                    const auto nodeName = [&](const std::string& end) {
                        const auto found = programContext.nodeNames.find(idValue(edge, end + ".nodeId"));
                        return found != programContext.nodeNames.end() ? found->second : std::string("?");
                    };
                    task.programOwner = "relationship " + nodeName("source") + " → " + nodeName("target");
                    task.programSeed = edge.get<std::uint64_t>("implementation.seed", 0);
                    task.outputUnit = programContext.stateUnits.contains(contributionStateId) ? programContext.stateUnits.at(contributionStateId) : "";
                    task.outputLabel = programContext.stateLabels.contains(contributionStateId) ? programContext.stateLabels.at(contributionStateId) : "";
                    task.programOwnerKind = 2;
                    bindProgramUnits(task.bindings, programContext);
                    contributionNode.hasVersion2Programs = true;
                }
            } else {
                task.expression = compileExpression(edge.get_child("equationModel.mathJson"));
            }
            bindTask(task);
            // Into a state whose kind is "update", the term is a value, worked out after the step.
            if (stateKinds.explicitUpdates.contains(contributionStateId)) {
                contributionNode.valueTerms.push_back(std::move(task));
                return;
            }
            contributionNode.estimatedOperationsPerSubstep += programmable ? task.bindings.size() + 1 : task.expression.operationCount();
            contributionNode.contributions.push_back(std::move(task));
        };

        // A version 2 program with several outputs (implementation.outputs, docs/projectSchema.md): one term per output, each reaching its
        // state, all of them the one program's (a two-way relationship has one output, validated).
        if (const auto outputs = programmable ? edge.get_child_optional("implementation.outputs") : boost::none; outputs && !outputs->empty()) {
            for (const auto& outputItem : *outputs) {
                const auto stateId = idValue(outputItem.second, "stateId");
                const auto found = plan.stateNodes.find(stateId);
                if (found == plan.stateNodes.end()) throw std::runtime_error("A relationship program's output reaches a state that is not in the model.");
                buildContribution(found->second, stateId, false, value(outputItem.second, "key"));
            }
            continue;
        }
        buildContribution(outputNodeId, outputStateId, false, value(edge, "implementation.output.key"));

        if (value(edge, "directionality") == "bidirectional") {
            // A bidirectional edge applies the same computed value to both connected nodes, with the sign flipped for the
            // other side -- what leaves one enters the other (see bidirectionalOtherStateId for which state that is).
            const auto otherNodeId = outputRole == "target" ? idValue(edge, "source.nodeId") : idValue(edge, "target.nodeId");
            const auto& otherNode = plan.nodes.at(nodeIndexes.at(otherNodeId));
            if (otherNode.stateIds.empty()) {
                throw std::runtime_error("A two-way relationship's other end has no states.");
            }
            const auto otherStateId = bidirectionalOtherStateId(edge, outputRole, otherNode.stateIds);
            buildContribution(otherNodeId, otherStateId, true, value(edge, "implementation.output.key"));
        }
    }
    for (auto& node : plan.nodes) if (node.verlet) assignVerletParts(node, verletNames);
    orderAlgebraicOutputs(plan);
    buildUpdatePhase(plan);
    std::sort(plan.stateIds.begin(), plan.stateIds.end());
    plan.taskSubmissionOrder = planTaskSubmissionOrder(plan.nodes);
    const auto scheduled = [](const std::vector<ContributionTask>& tasks) {
        return std::any_of(tasks.begin(), tasks.end(), [](const auto& task) {
            return std::any_of(task.parameters.begin(), task.parameters.end(), [](const auto& parameter) { return parameter.schedule != nullptr; });
        });
    };
    // Each equation as a program, now that its symbols are bound and nothing changes them.
    for (auto& node : plan.nodes) {
        for (auto* tasks : {&node.contributions, &node.algebraicTasks, &node.valueTerms}) {
            for (auto& task : *tasks) if (task.implementation == ContributionImplementation::equation) task.program = expressionProgram(task.expression);
        }
    }
    for (auto& relationship : plan.algebraicRelationships) {
        relationship.definitionPrograms.clear();
        relationship.definitionPrograms.reserve(relationship.definitions.size());
        for (const auto& definition : relationship.definitions) relationship.definitionPrograms.push_back(relationshipProgram(definition, relationship));
    }
    for (auto& output : plan.algebraicOutputs) output.program = relationshipProgram(output.expression, plan.algebraicRelationships[output.relationship]);
    for (auto& node : plan.nodes) {
        node.hasParameterSchedules = scheduled(node.contributions) || scheduled(node.algebraicTasks) || (node.nodeProvider &&
            std::any_of(node.nodeProvider->parameters.begin(), node.nodeProvider->parameters.end(), [](const auto& parameter) { return parameter.schedule != nullptr; }));
    }
    return plan;
}

std::vector<std::size_t> planTaskSubmissionOrder(const std::vector<NodeExecutionPlan>& nodes) {
    std::vector<std::size_t> order(nodes.size());
    std::iota(order.begin(), order.end(), 0);
    std::stable_sort(order.begin(), order.end(), [&nodes](std::size_t left, std::size_t right) {
        const auto leftWork = nodes[left].estimatedOperationsPerSubstep * nodes[left].substeps;
        const auto rightWork = nodes[right].estimatedOperationsPerSubstep * nodes[right].substeps;
        return leftWork > rightWork;
    });
    return order;
}

const std::string& providerProcessKey(const ContributionTask& task) {
    return task.providerProcessKeyCache;
}

namespace {

double finalizeContribution(const ContributionTask& task, double contribution) {
    if (task.negateOutput) contribution = -contribution;
    if (!std::isfinite(contribution)) throw std::runtime_error("A contribution task produced a non-finite derivative.");
    return contribution;
}

}

std::vector<EvaluatedContribution> evaluateContributionTasks(
    const NodeExecutionPlan& node,
    const StateValues& localStates,
    const StateValues& synchronizationSnapshot,
    const NodeParameterValues& parameterValues,
    double simulationTime,
    double stepSize,
    ProviderEvaluator* providerEvaluator,
    std::vector<std::pair<std::size_t, double>>* algebraicNodeProviderWrites,
    const std::vector<double>* nodeProviderParameterValues,
    const std::vector<double>* latches) {
    std::vector<EvaluatedContribution> evaluated;
    evaluated.reserve(node.contributions.size());

    // Provider tasks are collected by process key rather than evaluated immediately, so every
    // instance of a shared provider in this node can go out in a single evaluateBatch call
    // instead of one round trip per contribution. A real node typically has only a handful of
    // provider tasks (often exactly one), so this groups by a linear scan over key pointers
    // rather than an unordered_map: providerProcessKey() returns a reference into each task's
    // own precomputed cache, so grouping this way never hashes or copies that (potentially
    // long, since it is derived from the provider's whole inline source) string at all.
    std::vector<std::pair<const std::string*, std::vector<std::size_t>>> providerGroups;
    std::vector<std::vector<double>> symbolsByTask(node.contributions.size());

    for (std::size_t taskIndex = 0; taskIndex < node.contributions.size(); ++taskIndex) {
        const auto& task = node.contributions[taskIndex];
        auto& symbols = symbolsByTask[taskIndex];
        symbols.resize(task.bindings.size());
        for (std::size_t index = 0; index < task.bindings.size(); ++index) {
            const auto& binding = task.bindings[index];
            if (binding.source == BindingSource::parameter) {
                symbols[index] = parameterValues.at(taskIndex).at(binding.parameterIndex);
            } else if (binding.source == BindingSource::localState) symbols[index] = localStates.at(binding.valueIndex);
            else if (binding.source == BindingSource::simulationTime) symbols[index] = simulationTime;
            else symbols[index] = synchronizationSnapshot.at(binding.valueIndex);
        }
        // A latched condition's comparisons read their latches (event location), after the bindings.
        if (!task.latchSlots.empty()) {
            if (!latches) throw std::runtime_error("A latched condition was evaluated without its latches.");
            for (const auto slot : task.latchSlots) symbols.push_back(latches->at(slot));
        }

        if (task.implementation == ContributionImplementation::equation) {
            const auto contribution = finalizeContribution(task, evaluateTask(task, symbols));
            evaluated.push_back({task.sequence, task.outputStateIndex, contribution});
        } else {
            const auto& key = providerProcessKey(task);
            const auto found = std::find_if(providerGroups.begin(), providerGroups.end(),
                [&](const auto& group) { return *group.first == key; });
            if (found != providerGroups.end()) found->second.push_back(taskIndex);
            else providerGroups.emplace_back(&key, std::vector<std::size_t>{taskIndex});
        }
    }

    for (const auto& [key, taskIndexes] : providerGroups) {
        if (!providerEvaluator) throw std::runtime_error("A programmable relationship requires an initialized provider runtime.");

        std::vector<const ContributionTask*> tasks;
        std::vector<std::span<const double>> inputs;
        tasks.reserve(taskIndexes.size());
        inputs.reserve(taskIndexes.size());
        for (const auto taskIndex : taskIndexes) {
            tasks.push_back(&node.contributions[taskIndex]);
            inputs.emplace_back(symbolsByTask[taskIndex]);
        }

        const auto results = providerEvaluator->evaluateBatch(tasks, inputs, simulationTime, stepSize);
        if (results.size() != tasks.size()) {
            throw std::runtime_error("A provider batch evaluation returned the wrong number of results.");
        }
        for (std::size_t index = 0; index < tasks.size(); ++index) {
            const auto& task = *tasks[index];
            const auto contribution = finalizeContribution(task, results[index]);
            evaluated.push_back({task.sequence, task.outputStateIndex, contribution});
        }
    }

    if (node.nodeProvider) {
        const auto& task = *node.nodeProvider;
        std::vector<double> inputs(task.bindings.size());
        for (std::size_t index = 0; index < task.bindings.size(); ++index) {
            const auto& binding = task.bindings[index];
            if (binding.source == BindingSource::parameter) {
                if (!nodeProviderParameterValues) throw std::runtime_error("A computational-node provider's parameter was evaluated without its values.");
                inputs[index] = nodeProviderParameterValues->at(binding.parameterIndex);
            } else if (binding.source == BindingSource::simulationTime) {
                inputs[index] = simulationTime;
            } else {
                inputs[index] = binding.source == BindingSource::localState
                    ? localStates.at(binding.valueIndex) : synchronizationSnapshot.at(binding.valueIndex);
            }
        }
        if (!providerEvaluator) throw std::runtime_error("A computational-node provider requires an initialized provider runtime.");
        const auto outputs = providerEvaluator->evaluateNode(task, inputs, simulationTime, stepSize);
        for (const auto& [outputKey, outputValue] : outputs) {
            const auto found = std::find_if(task.outputs.begin(), task.outputs.end(),
                [&](const auto& output) { return output.key == outputKey; });
            if (found == task.outputs.end()) {
                throw std::runtime_error("A computational-node provider returned an undeclared output key '" + outputKey + "'.");
            }
            // A version 2 program's output into an Update state is read at the update instant (applyProgramUpdates), not here.
            if (found->setsValue && task.programVersion == 2) continue;
            if (!std::isfinite(outputValue)) throw std::runtime_error("A computational-node provider produced a non-finite value.");
            if (found->setsValue) {
                // A plain replacement, exactly like applyAlgebraicTasks -- see
                // NodeProviderOutputBinding::setsValue and this function's declaration comment.
                if (!algebraicNodeProviderWrites) {
                    throw std::runtime_error("A setsValue computational-node-provider output requires the caller to accept algebraic writes.");
                }
                algebraicNodeProviderWrites->emplace_back(found->stateIndex, outputValue);
            } else {
                const auto sequence = node.contributions.size() + static_cast<std::size_t>(std::distance(task.outputs.begin(), found));
                evaluated.push_back({sequence, found->stateIndex, outputValue});
            }
        }
    }

    return evaluated;
}

namespace {
// splitmix64: a well-mixed 64-bit value from any 64-bit input, so noise needs no stored state.
std::uint64_t mixBits(std::uint64_t value) {
    value += 0x9E3779B97F4A7C15ULL;
    value = (value ^ (value >> 30U)) * 0xBF58476D1CE4E5B9ULL;
    value = (value ^ (value >> 27U)) * 0x94D049BB133111EBULL;
    return value ^ (value >> 31U);
}

// A waveform at a time inside its window, as a fraction of its amplitude in [-1, 1].
double waveformUnitValue(const ParameterSchedule& schedule, double elapsed) {
    if (schedule.shape == ParameterSchedule::Shape::noise) {
        // The nth value drawn since the start: the same seed and index always give the same number, so the signal is a
        // function of time alone -- the same at any step size, and unchanged by restoring a checkpoint.
        const auto index = static_cast<std::uint64_t>(std::floor(elapsed * schedule.frequency));
        const auto bits = mixBits(schedule.seed ^ mixBits(index)) >> 11U;
        return static_cast<double>(bits) * (2.0 / 9007199254740992.0) - 1.0;
    }
    const double cycles = elapsed * schedule.frequency + schedule.phaseDegrees / 360.0;
    const double fraction = cycles - std::floor(cycles);
    switch (schedule.shape) {
    case ParameterSchedule::Shape::sine:
        return std::sin(2.0 * std::numbers::pi * cycles);
    case ParameterSchedule::Shape::square:
        return fraction < (schedule.dutyCycle > 0 ? schedule.dutyCycle : 0.5) ? 1.0 : -1.0;
    case ParameterSchedule::Shape::triangle:
        if (fraction < 0.25) return 4.0 * fraction;
        return fraction < 0.75 ? 2.0 - 4.0 * fraction : 4.0 * fraction - 4.0;
    case ParameterSchedule::Shape::sawtooth: {
        const double shifted = fraction + 0.5 - std::floor(fraction + 0.5);
        return 2.0 * shifted - 1.0;
    }
    case ParameterSchedule::Shape::noise:
        break;
    }
    return 0;
}
}

double evaluateParameterSchedule(const ParameterSchedule& schedule, double simulationTime) {
    switch (schedule.mode) {
    case ParameterSchedule::Mode::waveform: {
        const double elapsed = simulationTime - schedule.startTime;
        if (elapsed < 0 || (schedule.duration > 0 && elapsed >= schedule.duration)) return schedule.baseValue;
        return schedule.baseValue + schedule.amplitude * waveformUnitValue(schedule, elapsed);
    }
    case ParameterSchedule::Mode::step:
        return schedule.targetValue;
    case ParameterSchedule::Mode::ramp: {
        const auto elapsed = simulationTime - schedule.startTime;
        if (schedule.duration <= 0 || elapsed >= schedule.duration) return schedule.targetValue;
        if (elapsed <= 0) return schedule.baseValue;
        const auto fraction = elapsed / schedule.duration;
        return schedule.baseValue + fraction * (schedule.targetValue - schedule.baseValue);
    }
    case ParameterSchedule::Mode::pulse: {
        const auto elapsed = simulationTime - schedule.startTime;
        return (elapsed >= 0 && elapsed < schedule.duration) ? schedule.targetValue : schedule.baseValue;
    }
    case ParameterSchedule::Mode::piecewise: {
        if (schedule.samples.empty()) return schedule.baseValue;
        if (simulationTime <= schedule.samples.front().first) return schedule.samples.front().second;
        if (simulationTime >= schedule.samples.back().first) return schedule.samples.back().second;
        // The first sample later than simulationTime (a binary search: a stored schedule may hold a
        // year of daily samples, resolved every substep). Its predecessor is at or before it.
        const auto upper = std::upper_bound(schedule.samples.begin(), schedule.samples.end(), simulationTime,
            [](double time, const auto& sample) { return time < sample.first; });
        const auto [lowerTime, lowerValue] = *(upper - 1);
        if (schedule.hold) return lowerValue;
        const auto [upperTime, upperValue] = *upper;
        const auto fraction = upperTime > lowerTime ? (simulationTime - lowerTime) / (upperTime - lowerTime) : 0.0;
        return lowerValue + fraction * (upperValue - lowerValue);
    }
    }
    return schedule.targetValue;
}

namespace {
// controlId defaults to 0 for a CompiledParameter built directly (tests, tools) rather than through
// compileParameter; those are controlled by their own id.
EntityId controlIdOf(const CompiledParameter& parameter) { return parameter.controlId ? parameter.controlId : parameter.id; }

// Among every schedule recorded for this parameter, the one whose startTime is the latest that
// has already arrived governs -- a later intervention layered onto an earlier one takes over the
// instant it begins, matching how a real operator's most recent decision supersedes an earlier
// one already in effect. Falls through to the flat live-override map, then the compiled constant,
// exactly as before schedules existed, when no schedule for this parameter has started yet.
double resolveParameterValue(const CompiledParameter& parameter, const EntityValues& liveParameterValues,
                              const std::vector<ParameterSchedule>& activeSchedules, double simulationTime) {
    // A stored schedule replaces the constant: the parameter's own value at this time.
    // What was really done comes first: an input stream that has begun gives the value, live or not.
    for (const auto& schedule : activeSchedules) {
        if (schedule.input && schedule.parameterId == controlIdOf(parameter) && schedule.startTime <= simulationTime) {
            return evaluateParameterSchedule(schedule, simulationTime);
        }
    }
    const double ownValue = parameter.schedule ? evaluateParameterSchedule(*parameter.schedule, simulationTime) : parameter.value;
    if (!parameter.live) return ownValue;
    const ParameterSchedule* active = nullptr;
    for (const auto& schedule : activeSchedules) {
        if (schedule.input || schedule.parameterId != controlIdOf(parameter) || schedule.startTime > simulationTime) continue;
        if (!active || schedule.startTime > active->startTime) active = &schedule;
    }
    if (active) return evaluateParameterSchedule(*active, simulationTime);
    const auto override = liveParameterValues.find(controlIdOf(parameter));
    return override != liveParameterValues.end() ? override->second : ownValue;
}
}

NodeParameterValues resolveParameterValues(const std::vector<ContributionTask>& tasks, const EntityValues& liveParameterValues,
                                            const std::vector<ParameterSchedule>& activeSchedules, double simulationTime) {
    NodeParameterValues resolved;
    resolved.reserve(tasks.size());
    for (const auto& task : tasks) {
        auto& values = resolved.emplace_back();
        values.reserve(task.parameters.size());
        for (const auto& parameter : task.parameters) {
            values.push_back(resolveParameterValue(parameter, liveParameterValues, activeSchedules, simulationTime));
        }
    }
    return resolved;
}

std::vector<double> resolveNodeProviderParameterValues(const NodeProviderTask& task, const EntityValues& liveParameterValues,
                                                       const std::vector<ParameterSchedule>& activeSchedules, double simulationTime) {
    std::vector<double> values;
    values.reserve(task.parameters.size());
    for (const auto& parameter : task.parameters) values.push_back(resolveParameterValue(parameter, liveParameterValues, activeSchedules, simulationTime));
    return values;
}

NodeParameterValues resolveParameterValues(const NodeExecutionPlan& node, const EntityValues& liveParameterValues,
                                            const std::vector<ParameterSchedule>& activeSchedules, double simulationTime) {
    return resolveParameterValues(node.contributions, liveParameterValues, activeSchedules, simulationTime);
}

ProgramCallContext& programCallContext() noexcept {
    static ProgramCallContext context;
    return context;
}

std::vector<double> programInputs(const std::vector<CompiledBinding>& bindings, const StateValues& localStates, const StateValues& snapshot,
                                  const std::vector<double>& parameterValues, double time) {
    std::vector<double> inputs(bindings.size());
    for (std::size_t index = 0; index < bindings.size(); ++index) {
        const auto& binding = bindings[index];
        if (binding.source == BindingSource::parameter) inputs[index] = parameterValues.at(binding.parameterIndex);
        else if (binding.source == BindingSource::simulationTime) inputs[index] = time;
        else if (binding.source == BindingSource::localState) inputs[index] = localStates.at(binding.valueIndex);
        else inputs[index] = snapshot.at(binding.valueIndex);
    }
    return inputs;
}

std::vector<double> resolveTaskParameterValues(const std::vector<CompiledParameter>& parameters, const EntityValues& liveParameterValues,
                                               const std::vector<ParameterSchedule>& activeSchedules, double time) {
    std::vector<double> values;
    values.reserve(parameters.size());
    for (const auto& parameter : parameters) values.push_back(resolveParameterValue(parameter, liveParameterValues, activeSchedules, time));
    return values;
}

namespace {

// Every version 2 program of a node, once each (a two-way relationship's far end is the same program), with what `want` asks of it.
template <typename Want, typename Visit>
void forEachNodeProgram(const NodeExecutionPlan& node, Want&& want, Visit&& visit) {
    for (const auto* tasks : {&node.contributions, &node.algebraicTasks, &node.valueTerms}) {
        for (const auto& task : *tasks) {
            if (task.programVersion != 2 || task.negateOutput || !want(task.sourceId)) continue;
            visit(task.sourceId, task.bindings, task.parameters);
        }
    }
    if (node.nodeProvider && node.nodeProvider->programVersion == 2 && want(node.nodeId)) {
        visit(node.nodeId, node.nodeProvider->bindings, node.nodeProvider->parameters);
    }
}

}

void advanceNodePrograms(const NodeExecutionPlan& node, const StateValues& localStates, const StateValues& snapshot,
                         const EntityValues& liveParameterValues, const std::vector<ParameterSchedule>& activeSchedules, double time,
                         double size, ProviderEvaluator* providerEvaluator) {
    if (!node.hasVersion2Programs || !providerEvaluator) return;
    std::vector<ProgramAdvanceCall> calls;
    forEachNodeProgram(node, [&](EntityId owner) { return providerEvaluator->programAdvancesEachStep(owner); },
        [&](EntityId owner, const std::vector<CompiledBinding>& bindings, const std::vector<CompiledParameter>& parameters) {
            calls.push_back({owner, programInputs(bindings, localStates, snapshot,
                resolveTaskParameterValues(parameters, liveParameterValues, activeSchedules, time), time)});
        });
    if (!calls.empty()) providerEvaluator->advancePrograms(calls, time, size);
}

bool clockTicksAt(double period, double time) noexcept {
    if (!(period > 0)) return false;
    const double ticks = time / period;
    const double whole = std::round(ticks);
    return std::abs(ticks - whole) <= 1e-9 * std::max(1.0, std::abs(whole));
}

void advancePlanPrograms(const ExecutionPlan& plan, const StateValues& states, const EntityValues& liveParameterValues,
                         const std::vector<ParameterSchedule>& activeSchedules, double time, double size, bool clocked,
                         ProviderEvaluator* providerEvaluator, const std::vector<unsigned char>& include) {
    if (!providerEvaluator) return;
    // Clocked programs grouped by period, so each batch is told its own period as the step.
    std::vector<std::pair<double, std::vector<ProgramAdvanceCall>>> batches;
    for (std::size_t nodeIndex = 0; nodeIndex < plan.nodes.size(); ++nodeIndex) {
        const auto& node = plan.nodes[nodeIndex];
        if (!node.hasVersion2Programs || (!include.empty() && !include[nodeIndex])) continue;
        StateValues localStates(node.stateIndexes.size());
        for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) localStates[index] = states.at(node.stateIndexes[index]);
        const auto want = [&](EntityId owner) {
            if (!clocked) return providerEvaluator->programAdvancesEachStep(owner);
            return clockTicksAt(providerEvaluator->programClockPeriod(owner), time);
        };
        forEachNodeProgram(node, want, [&](EntityId owner, const std::vector<CompiledBinding>& bindings, const std::vector<CompiledParameter>& parameters) {
            const double step = clocked ? providerEvaluator->programClockPeriod(owner) : size;
            auto found = std::find_if(batches.begin(), batches.end(), [&](const auto& batch) { return batch.first == step; });
            if (found == batches.end()) found = batches.insert(batches.end(), {step, {}});
            found->second.push_back({owner, programInputs(bindings, localStates, states,
                resolveTaskParameterValues(parameters, liveParameterValues, activeSchedules, time), time)});
        });
    }
    for (const auto& [step, calls] : batches) providerEvaluator->advancePrograms(calls, time, step);
}

bool planHasProgramUpdates(const ExecutionPlan& plan) {
    return std::any_of(plan.nodes.begin(), plan.nodes.end(), [](const auto& node) {
        return node.nodeProvider && node.nodeProvider->programVersion == 2 &&
            std::any_of(node.nodeProvider->outputs.begin(), node.nodeProvider->outputs.end(), [](const auto& output) { return output.setsValue; });
    });
}

void applyProgramUpdates(const ExecutionPlan& plan, const StateValues& readStates, StateValues& states, const EntityValues& liveParameterValues,
                         const std::vector<ParameterSchedule>& activeSchedules, double time, ProviderEvaluator* providerEvaluator) {
    for (const auto& node : plan.nodes) {
        if (!node.nodeProvider || node.nodeProvider->programVersion != 2) continue;
        const auto& task = *node.nodeProvider;
        if (std::none_of(task.outputs.begin(), task.outputs.end(), [](const auto& output) { return output.setsValue; })) continue;
        if (!providerEvaluator) throw std::runtime_error("A node program requires an initialized provider runtime.");
        StateValues localStates(node.stateIndexes.size());
        for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) localStates[index] = readStates.at(node.stateIndexes[index]);
        const auto inputs = programInputs(task.bindings, localStates, readStates,
            resolveTaskParameterValues(task.parameters, liveParameterValues, activeSchedules, time), time);
        for (const auto& [key, value] : providerEvaluator->evaluateNode(task, inputs, time, 0)) {
            const auto output = std::find_if(task.outputs.begin(), task.outputs.end(), [&](const auto& candidate) { return candidate.key == key; });
            if (output == task.outputs.end() || !output->setsValue) continue;
            states.at(node.stateIndexes.at(output->stateIndex)) = value;
        }
    }
}

std::vector<std::pair<std::size_t, double>> reduceContributions(
    std::vector<EvaluatedContribution> contributions) {
    std::stable_sort(contributions.begin(), contributions.end(), [](const auto& left, const auto& right) {
        return left.sequence < right.sequence;
    });
    std::vector<std::pair<std::size_t, double>> derivatives;
    for (const auto& contribution : contributions) {
        const auto found = std::find_if(derivatives.begin(), derivatives.end(), [&](const auto& derivative) {
            return derivative.first == contribution.outputStateIndex;
        });
        if (found == derivatives.end()) {
            derivatives.emplace_back(contribution.outputStateIndex, contribution.value);
        } else {
            found->second += contribution.value;
        }
    }
    return derivatives;
}

namespace {

// A value term's value from its symbols' values at evaluationTime: its equation's, or its program's.
double algebraicTaskValue(const ContributionTask& task, const std::vector<double>& symbols, double evaluationTime, double stepSize,
                          ProviderEvaluator* providerEvaluator) {
    double value = 0;
    if (task.implementation == ContributionImplementation::equation) {
        value = evaluateTask(task, symbols);
    } else {
        if (!providerEvaluator) throw std::runtime_error("A node's own part written as a program requires an initialized provider runtime.");
        const std::vector<const ContributionTask*> batchTasks{&task};
        const std::vector<std::span<const double>> inputs{symbols};
        // The provider sees the same instant as the states it reads.
        const auto results = providerEvaluator->evaluateBatch(batchTasks, inputs, evaluationTime, stepSize);
        if (results.size() != 1) throw std::runtime_error("A provider batch evaluation returned the wrong number of results.");
        value = results.front();
    }
    if (!std::isfinite(value)) throw std::runtime_error("A node's own part produced a value that is not a finite number.");
    return value;
}

}

void applyAlgebraicTasks(const std::vector<ContributionTask>& algebraicTasks, StateValues& localStates,
                         const NodeParameterValues& parameterValues, double evaluationTime, double stepSize,
                         ProviderEvaluator* providerEvaluator) {
    // Each state the tasks set is their sum: nothing is carried over from before.
    for (const auto& task : algebraicTasks) localStates.at(task.outputStateIndex) = 0;
    for (std::size_t taskIndex = 0; taskIndex < algebraicTasks.size(); ++taskIndex) {
        const auto& task = algebraicTasks[taskIndex];
        std::vector<double> symbols(task.bindings.size());
        for (std::size_t index = 0; index < task.bindings.size(); ++index) {
            const auto& binding = task.bindings[index];
            if (binding.source == BindingSource::parameter) {
                symbols[index] = parameterValues.at(taskIndex).at(binding.parameterIndex);
            } else if (binding.source == BindingSource::localState) {
                symbols[index] = localStates.at(binding.valueIndex);
            } else if (binding.source == BindingSource::simulationTime) {
                symbols[index] = evaluationTime;
            } else {
                // Structurally unreachable: compileBindings() forces every source term's
                // bindings to BindingSource::localState unconditionally (an algebraic task is
                // always a source term), so this should never fire. Fail loudly rather than
                // silently reading a stale cross-node snapshot if that invariant is ever broken.
                throw std::runtime_error("An algebraic task unexpectedly referenced the cross-node synchronization snapshot.");
            }
        }

        localStates.at(task.outputStateIndex) += algebraicTaskValue(task, symbols, evaluationTime, stepSize, providerEvaluator);
    }
}

void settleAlgebraicStates(const ExecutionPlan& plan, StateValues& states, const EntityValues& liveParameterValues,
                           double time, double stepSize, ProviderEvaluator* providerEvaluator,
                           const std::vector<ParameterSchedule>& activeSchedules) {
    for (const auto& node : plan.nodes) {
        if (node.algebraicTasks.empty()) continue;
        StateValues localStates(node.stateIndexes.size());
        for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) localStates[index] = states.at(node.stateIndexes[index]);
        const auto parameterValues = resolveParameterValues(node.algebraicTasks, liveParameterValues, activeSchedules, time);
        applyAlgebraicTasks(node.algebraicTasks, localStates, parameterValues, time, stepSize / static_cast<double>(node.substeps), providerEvaluator);
        for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) states.at(node.stateIndexes[index]) = localStates[index];
    }
}

namespace {

// Störmer–Verlet over one global step's substeps (NodeExecutionPlan::verlet). Each substep of size h from t: the first part
// moves by h/2 with its rates read at t, the second by h with its rates read at t + h/2 from the first part's new values,
// and the first by h/2 again with its rates read at t + h from the second part's new values. Within the global step
// nothing a rate reads changes between one substep's end and the next one's start, so the rates read at a substep's end
// are the next substep's rates at its start, evaluated once. Other nodes are read from the snapshot throughout, as under
// Euler: across nodes the step stays first order. A term written as a program is held: evaluated once at the substep's
// start, with the states then, and added to its state's rate through the substep.
StateValues integrateVerletNode(const NodeExecutionPlan& node, StateValues localStates, const StateValues& synchronizationSnapshot,
                                const EntityValues& liveParameterValues, double simulationTime, double nodeTimeStep,
                                ProviderEvaluator* providerEvaluator, const std::vector<ParameterSchedule>& activeSchedules,
                                bool hasSchedules) {
    NodeExecutionPlan kickTasks;
    NodeExecutionPlan driftTasks;
    NodeExecutionPlan heldTasks;
    std::vector<std::size_t> kicked;
    std::vector<std::size_t> drifted;
    for (const auto& task : node.contributions) {
        const bool first = node.verletKicked.at(task.outputStateIndex);
        auto& indexes = first ? kicked : drifted;
        if (std::find(indexes.begin(), indexes.end(), task.outputStateIndex) == indexes.end()) indexes.push_back(task.outputStateIndex);
        (task.implementation != ContributionImplementation::equation ? heldTasks : first ? kickTasks : driftTasks).contributions.push_back(task);
    }
    const auto resolve = [&](const NodeExecutionPlan& group, double time) {
        return resolveParameterValues(group.contributions, liveParameterValues, activeSchedules, time);
    };
    const auto rates = [&](const NodeExecutionPlan& group, const NodeParameterValues& parameters, double time) {
        std::vector<double> result(localStates.size(), 0.0);
        if (group.contributions.empty()) return result;
        const auto evaluated = evaluateContributionTasks(group, localStates, synchronizationSnapshot, parameters, time, nodeTimeStep, providerEvaluator);
        for (const auto& [index, rate] : reduceContributions(evaluated)) result.at(index) = rate;
        return result;
    };
    auto kickParameters = resolve(kickTasks, simulationTime);
    auto driftParameters = resolve(driftTasks, simulationTime + 0.5 * nodeTimeStep);
    auto heldParameters = resolve(heldTasks, simulationTime);
    const auto half = 0.5 * nodeTimeStep;
    std::vector<double> kick;
    for (std::size_t substep = 0; substep < node.substeps; ++substep) {
        const double start = simulationTime + static_cast<double>(substep) * nodeTimeStep;
        const double middle = start + half;
        const double end = simulationTime + static_cast<double>(substep + 1) * nodeTimeStep;
        if (hasSchedules && substep > 0) heldParameters = resolve(heldTasks, start);
        const auto held = rates(heldTasks, heldParameters, start);
        if (substep == 0) kick = rates(kickTasks, kickParameters, start);
        for (const auto index : kicked) localStates[index] += half * (kick[index] + held[index]);
        if (hasSchedules && substep > 0) driftParameters = resolve(driftTasks, middle);
        const auto drift = rates(driftTasks, driftParameters, middle);
        for (const auto index : drifted) localStates[index] += nodeTimeStep * (drift[index] + held[index]);
        if (hasSchedules) kickParameters = resolve(kickTasks, end);
        kick = rates(kickTasks, kickParameters, end);
        for (const auto index : kicked) localStates[index] += half * (kick[index] + held[index]);
        advanceNodePrograms(node, localStates, synchronizationSnapshot, liveParameterValues, activeSchedules, end, nodeTimeStep, providerEvaluator);
    }
    return localStates;
}

}

NodeIntegrationResult integrateNode(const NodeExecutionPlan& node,
                                    const StateValues& synchronizationSnapshot,
                                    const EntityValues& liveParameterValues,
                                    double simulationTime,
                                    double synchronizationStep,
                                    ProviderEvaluator* providerEvaluator,
                                    const std::vector<ParameterSchedule>& activeSchedules,
                                    double synchronizationEndTime) {
    // The node's Update states are not worked out here: through the step they hold their values from its start, and the
    // update phase (applyUpdates) sets them after it, from the Rate states this leaves (docs/proposals/ratesAndUpdates.md).
    static_cast<void>(synchronizationEndTime);
    const auto startedAt = std::chrono::steady_clock::now();
    StateValues localStates(node.stateIndexes.size());
    for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) {
        localStates[index] = synchronizationSnapshot.at(node.stateIndexes[index]);
    }
    const auto nodeTimeStep = synchronizationStep / static_cast<double>(node.substeps);
    // Re-resolving every substep only matters for a ramp/pulse mid-transition (ordinary live
    // overrides and step schedules are already constant across one global step, same as before
    // schedules existed) -- gated on activeSchedules being non-empty so a node with no pending
    // intervention pays zero extra allocation cost even at node.substeps in the hundreds/thousands
    // (multi-rate models like HFT order routing per docs/proposals/fintechToolbox.md).
    const auto hasSchedules = !activeSchedules.empty() || node.hasParameterSchedules;
    if (node.verlet) {
        auto result = integrateVerletNode(node, std::move(localStates), synchronizationSnapshot, liveParameterValues, simulationTime,
            nodeTimeStep, providerEvaluator, activeSchedules, hasSchedules);
        const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - startedAt).count();
        return {std::move(result), static_cast<std::uint64_t>(std::max<std::int64_t>(0, elapsed))};
    }
    auto parameterValues = resolveParameterValues(node.contributions, liveParameterValues, activeSchedules, simulationTime);
    // Semi-implicit: the node's contributions, one group per state it updates, in the node's order.
    std::vector<NodeExecutionPlan> semiImplicitTasks;
    if (node.semiImplicit) {
        if (node.nodeProvider) throw std::runtime_error("A node with a computational-node provider is integrated explicitly.");
        semiImplicitTasks.resize(node.stateIndexes.size());
        for (const auto& task : node.contributions) semiImplicitTasks.at(task.outputStateIndex).contributions.push_back(task);
    }
    for (std::size_t substep = 0; substep < node.substeps; ++substep) {
        const double substepTime = simulationTime + static_cast<double>(substep) * nodeTimeStep;
        if (hasSchedules && substep > 0) {
            parameterValues = resolveParameterValues(node.contributions, liveParameterValues, activeSchedules, substepTime);
        }
        std::vector<std::pair<std::size_t, double>> algebraicNodeProviderWrites;
        // The provider's parameters at this substep's start, as its other inputs are read then.
        const auto providerParameterValues = node.nodeProvider && !node.nodeProvider->parameters.empty()
            ? resolveNodeProviderParameterValues(*node.nodeProvider, liveParameterValues, activeSchedules, substepTime) : std::vector<double>{};
        if (node.semiImplicit) {
            // Each state in the node's order, from contributions evaluated with the states updated before it.
            for (std::size_t stateIndex = 0; stateIndex < node.stateIndexes.size(); ++stateIndex) {
                const auto& stateTasks = semiImplicitTasks[stateIndex];
                if (stateTasks.contributions.empty()) continue;
                const auto stateParameters = resolveParameterValues(stateTasks.contributions, liveParameterValues, activeSchedules, substepTime);
                const auto stateEvaluated = evaluateContributionTasks(stateTasks, localStates, synchronizationSnapshot, stateParameters, substepTime, nodeTimeStep, providerEvaluator);
                for (const auto& derivative : reduceContributions(stateEvaluated)) localStates.at(derivative.first) += nodeTimeStep * derivative.second;
            }
            advanceNodePrograms(node, localStates, synchronizationSnapshot, liveParameterValues, activeSchedules,
                simulationTime + static_cast<double>(substep + 1) * nodeTimeStep, nodeTimeStep, providerEvaluator);
            continue;
        }
        const auto evaluated = evaluateContributionTasks(
            node, localStates, synchronizationSnapshot, parameterValues,
            substepTime, nodeTimeStep, providerEvaluator, &algebraicNodeProviderWrites, &providerParameterValues);
        // Same plain-replacement treatment as applyAlgebraicTasks, applied here rather than inside
        // evaluateContributionTasks itself -- see that function's declaration comment. Order versus
        // the Euler integration below never matters: a setsValue nodeProvider output's state index
        // can never also appear in `derivatives` (validated as its state's sole contributor), so the
        // two loops always touch disjoint state indices.
        for (const auto& [stateIndex, algebraicValue] : algebraicNodeProviderWrites) localStates.at(stateIndex) = algebraicValue;
        const auto derivatives = reduceContributions(evaluated);
        for (const auto& derivative : derivatives) localStates.at(derivative.first) += nodeTimeStep * derivative.second;
        // advance() for the node's version 2 programs with memory, once per substep, with its end and size.
        advanceNodePrograms(node, localStates, synchronizationSnapshot, liveParameterValues, activeSchedules,
            simulationTime + static_cast<double>(substep + 1) * nodeTimeStep, nodeTimeStep, providerEvaluator);
    }
    const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - startedAt).count();
    return {std::move(localStates), static_cast<std::uint64_t>(std::max<std::int64_t>(0, elapsed))};
}

namespace {

// Reads an algebraic relationship's symbols for the instant: a state binding from the states as they stand (an equation
// reached later may read one settled since an earlier one), a parameter or the time as resolved for the instant, and a
// definition as worked out when first read: with the definitions it reads whatever its choices take, in ascending
// order, so working one out recurses only as deep as its choices are nested, never down a long chain of definitions.
const ExpressionProgram noProgram;

struct DefinitionReader {
    const AlgebraicRelationship& relationship;
    const StateValues& states;
    std::vector<double>& symbols;
    // Per definition: 0 not worked out, 1 worked out, 2 waiting its turn.
    std::vector<char>& done;
    std::size_t& worked;
    // Lists kept for the instant: those found waiting (each read's at its end), and those still to look through.
    std::vector<std::size_t>& found;
    std::vector<std::size_t>& pending;

    double operator()(std::size_t index) {
        if (index >= symbols.size()) throw std::runtime_error("Executable symbol binding is invalid.");
        const auto bindingCount = relationship.bindings.size();
        if (index < bindingCount) {
            const auto state = relationship.stateReads[index];
            return state == noState ? symbols[index] : states[state];
        }
        if (done[index - bindingCount] != 1) workOut(index - bindingCount);
        return symbols[index];
    }
    // As a relationship's program reads them (see relationshipProgram).
    double state(std::size_t index) const { return states[index]; }
    double resolved(std::size_t index) const { return symbols[index]; }
    double definition(std::size_t definition) {
        if (done[definition] != 1) workOut(definition);
        return symbols[relationship.bindings.size() + definition];
    }

    void workOutOne(std::size_t definition) {
        symbols[relationship.bindings.size() + definition] =
            evaluateCompiled(relationship.definitions[definition], relationship.definitionPrograms.empty() ? noProgram : relationship.definitionPrograms[definition], *this);
        done[definition] = 1;
        ++worked;
    }

    void workOut(std::size_t definition) {
        // Every definition read here is below this one, and every one waiting from a read further out is above it:
        // this read's list (at the end of `found`) never meets that one's. `pending` is empty between reads.
        const auto start = found.size();
        pending.push_back(definition);
        done[definition] = 2;
        while (!pending.empty()) {
            const auto at = pending.back();
            pending.pop_back();
            found.push_back(at);
            for (const auto next : relationship.unconditionalDefinitions[at]) {
                if (done[next] != 0) continue;
                done[next] = 2;
                pending.push_back(next);
            }
        }
        std::sort(found.begin() + static_cast<std::ptrdiff_t>(start), found.end());
        const auto end = found.size();
        for (auto at = start; at < end; ++at) workOutOne(found[at]);
        found.resize(start);
    }

    static constexpr std::size_t noState = std::numeric_limits<std::size_t>::max();
};

}

UpdateOutcome applyUpdates(const ExecutionPlan& plan, StateValues& states, const EntityValues& liveParameterValues,
                           const std::vector<ParameterSchedule>& activeSchedules, double simulationTime, bool afterStep,
                           double stepSize, ProviderEvaluator* providerEvaluator) {
    UpdateOutcome outcome;
    if (plan.updateSteps.empty()) return outcome;
    // Each relationship's parameters, resolved for the instant, and its definitions, kept while the values read do not
    // change (an epoch): worked out once however many of its equations need them. Within a pass that is sound because
    // the steps are in dependency order -- when an equation needing a definition is reached, every state the definition
    // reads is already set -- and a new epoch begins wherever the values read change (a new pass, a ring's next sweep).
    std::vector<std::vector<double>> symbolValues(plan.algebraicRelationships.size());
    std::vector<std::vector<char>> worked(plan.algebraicRelationships.size());
    std::vector<std::size_t> resolvedIn(plan.algebraicRelationships.size(), 0);
    std::size_t epoch = 0;
    std::vector<std::size_t> found;
    std::vector<std::size_t> pending;
    const auto evaluate = [&](const UpdateStep& step, const StateValues& read) -> double {
        if (step.kind == UpdateStepKind::relationshipOutput) {
            const auto& output = plan.algebraicOutputs[step.index];
            const auto& relationship = plan.algebraicRelationships[output.relationship];
            auto& symbols = symbolValues[output.relationship];
            auto& done = worked[output.relationship];
            if (resolvedIn[output.relationship] != epoch) {
                symbols.assign(relationship.bindings.size() + relationship.definitions.size(), 0.0);
                done.assign(relationship.definitions.size(), 0);
                for (std::size_t index = 0; index < relationship.bindings.size(); ++index) {
                    const auto& binding = relationship.bindings[index];
                    if (binding.source == BindingSource::parameter) {
                        symbols[index] = resolveParameterValue(relationship.parameters.at(binding.parameterIndex), liveParameterValues, activeSchedules, simulationTime);
                    } else if (binding.source == BindingSource::simulationTime) {
                        symbols[index] = simulationTime;
                    }
                }
                resolvedIn[output.relationship] = epoch;
            }
            // The definitions it reads whatever its choices take, in ascending order; any other when a branch taken reads it.
            DefinitionReader reader{relationship, read, symbols, done, outcome.definitionsWorked, found, pending};
            for (const auto definition : output.eagerDefinitions) if (done[definition] != 1) reader.workOutOne(definition);
            const auto result = evaluateCompiled(output.expression, output.program, reader);
            if (!std::isfinite(result)) {
                throw std::runtime_error("The relationship " + std::to_string(relationship.edgeId) + " produced a non-finite value for state " +
                    std::to_string(output.outputStateId) + " at " + std::to_string(simulationTime) + " s.");
            }
            return result;
        }
        const auto& node = plan.nodes[step.node];
        const auto& task = step.kind == UpdateStepKind::ownTerm ? node.algebraicTasks[step.index] : node.valueTerms[step.index];
        std::vector<double> symbols(task.bindings.size());
        for (std::size_t index = 0; index < task.bindings.size(); ++index) {
            const auto& binding = task.bindings[index];
            if (binding.source == BindingSource::parameter) {
                symbols[index] = resolveParameterValue(task.parameters.at(binding.parameterIndex), liveParameterValues, activeSchedules, simulationTime);
            } else if (binding.source == BindingSource::simulationTime) {
                symbols[index] = simulationTime;
            } else if (binding.source == BindingSource::localState) {
                symbols[index] = read.at(node.stateIndexes.at(binding.valueIndex));
            } else {
                symbols[index] = read.at(binding.valueIndex);
            }
        }
        const auto value = algebraicTaskValue(task, symbols, simulationTime, stepSize / static_cast<double>(node.substeps), providerEvaluator);
        // A relationship's term at the far end of a bidirectional relationship is negated, as a rate there would be.
        return step.kind == UpdateStepKind::valueTerm ? finalizeContribution(task, value) : value;
    };
    // Once per step: every Update reads the same values -- Rate states at the step's end, Update states at its start --
    // and all are set at once, so their order never matters.
    if (afterStep && !plan.oncePerStepSteps.empty()) {
        const StateValues read = states;
        ++epoch;
        for (const auto index : plan.oncePerStepSteps) states.at(plan.updateSteps[index].writes) = 0;
        for (const auto index : plan.oncePerStepSteps) {
            const auto& step = plan.updateSteps[index];
            states.at(step.writes) += evaluate(step, read);
        }
    }
    if (plan.settleGroups.empty()) return outcome;
    // Settling: each state the settling steps set is the sum of its steps, worked out group by group in dependency order,
    // each reading the latest values. A ring's states start from their values as they stood.
    const StateValues prior = states;
    for (const auto index : plan.settleStateIndexes) states.at(index) = 0;
    ++epoch;
    for (std::size_t groupIndex = 0; groupIndex < plan.settleGroups.size(); ++groupIndex) {
        const auto& group = plan.settleGroups[groupIndex];
        if (!group.ring) {
            const auto& step = plan.updateSteps[group.steps.front()];
            states.at(step.writes) += evaluate(step, states);
            continue;
        }
        // A ring: swept, every sweep reading only the previous sweep's values, until nothing changes or its limit. What
        // steps outside the ring have already added to its states (`base`) is kept; the ring's own part is swept.
        std::vector<std::size_t> ringStates;
        for (const auto index : group.steps) ringStates.push_back(plan.updateSteps[index].writes);
        std::sort(ringStates.begin(), ringStates.end());
        ringStates.erase(std::unique(ringStates.begin(), ringStates.end()), ringStates.end());
        std::unordered_map<std::size_t, double> base;
        std::unordered_map<std::size_t, double> part;
        for (const auto state : ringStates) {
            base[state] = states.at(state);
            part[state] = prior.at(state) - states.at(state);
        }
        bool settled = false;
        UnsettledRing largest{groupIndex, ringStates.front(), 0};
        for (std::size_t sweep = 0; sweep < group.limit && !settled; ++sweep) {
            for (const auto state : ringStates) states.at(state) = base[state] + part[state];
            const StateValues read = states;
            ++epoch;
            std::unordered_map<std::size_t, double> next;
            for (const auto state : ringStates) next[state] = 0;
            for (const auto index : group.steps) {
                const auto& step = plan.updateSteps[index];
                next[step.writes] += evaluate(step, read);
            }
            settled = true;
            largest.change = 0;
            for (const auto state : ringStates) {
                const auto change = std::abs(next[state] - part[state]);
                if (!(change <= 1e-12 * std::max(1.0, std::abs(base[state] + next[state])))) settled = false;
                if (!(change <= largest.change)) largest = {groupIndex, state, change};
            }
            part = std::move(next);
        }
        for (const auto state : ringStates) states.at(state) = base[state] + part[state];
        if (!settled) {
            ++outcome.ringsUnsettled;
            outcome.unsettledRings.push_back(largest);
        }
    }
    return outcome;
}

std::size_t evaluateAlgebraicRelationships(const ExecutionPlan& plan, StateValues& states, const EntityValues& liveParameterValues,
                                           const std::vector<ParameterSchedule>& activeSchedules, double simulationTime,
                                           double stepSize, ProviderEvaluator* providerEvaluator) {
    return applyUpdates(plan, states, liveParameterValues, activeSchedules, simulationTime, false, stepSize, providerEvaluator).definitionsWorked;
}


namespace {

// The tasks recorded, in their order: node by node, its Rate terms, its relationships' terms into its Update states, its own
// Update terms; each only when written as an equation.
template <typename Visit>
void forEachRecordedTask(const ExecutionPlan& plan, Visit&& visit) {
    for (const auto& node : plan.nodes) {
        for (const auto* tasks : {&node.contributions, &node.valueTerms, &node.algebraicTasks}) {
            for (const auto& task : *tasks) {
                if (task.implementation == ContributionImplementation::equation) visit(node, task);
            }
        }
    }
}

}

std::vector<RecordedPart> recordedParts(const ExecutionPlan& plan) {
    std::vector<RecordedPart> parts;
    forEachRecordedTask(plan, [&](const NodeExecutionPlan& node, const ContributionTask& task) {
        const auto stateId = task.outputStateId ? task.outputStateId : node.stateIds.at(task.outputStateIndex);
        parts.push_back({task.sourceId, stateId, task.negateOutput});
    });
    return parts;
}

std::vector<double> evaluateRecordedParts(const ExecutionPlan& plan, const StateValues& states, const EntityValues& liveParameterValues,
                                          const std::vector<ParameterSchedule>& activeSchedules, double simulationTime) {
    std::vector<double> values;
    std::vector<double> symbols;
    forEachRecordedTask(plan, [&](const NodeExecutionPlan& node, const ContributionTask& task) {
        try {
            symbols.assign(task.bindings.size(), 0);
            for (std::size_t index = 0; index < task.bindings.size(); ++index) {
                const auto& binding = task.bindings[index];
                if (binding.source == BindingSource::parameter) {
                    symbols[index] = resolveParameterValue(task.parameters.at(binding.parameterIndex), liveParameterValues, activeSchedules, simulationTime);
                } else if (binding.source == BindingSource::simulationTime) {
                    symbols[index] = simulationTime;
                } else if (binding.source == BindingSource::localState) {
                    symbols[index] = states.at(node.stateIndexes.at(binding.valueIndex));
                } else {
                    symbols[index] = states.at(binding.valueIndex);
                }
            }
            const auto value = evaluateTask(task, symbols);
            values.push_back(task.negateOutput ? -value : value);
        } catch (const std::exception&) {
            values.push_back(std::numeric_limits<double>::quiet_NaN());
        }
    });
    return values;
}


ExpressionProgram compileExpressionProgram(const CompiledExpression& expression) {
    return expressionProgram(expression);
}

}
