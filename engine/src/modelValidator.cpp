/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "modelValidator.hpp"
#include "executionPlan.hpp"
#include "stabilityAnalysis.hpp"
#include "wholeModelIntegration.hpp"
#include <algorithm>
#include <cctype>
#include <cmath>
#include <functional>
#include <regex>
#include <cstdlib>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <unordered_map>

namespace konjugate {
namespace {
ValidationIssue& add(ValidationResult& result, std::string code, std::string severity, std::string message,
         std::string kind = "model", std::string entityId = {}, std::string field = {}) {
    result.issues.push_back({std::move(code), std::move(severity), std::move(message), {std::move(kind), std::move(entityId), std::move(field)}, std::nullopt});
    return result.issues.back();
}

std::string value(const boost::property_tree::ptree& tree, const std::string& key) {
    return tree.get<std::string>(key, "");
}

EntityId idValue(const boost::property_tree::ptree& tree, const std::string& key) {
    return tree.get<EntityId>(key, 0);
}

struct ResolvedAttribution {
    AttributedParameter location;
    std::string phrase;
};

// The document's states, relationships and source terms by id, gathered in one pass, for the stability pass's lookups below: it may
// resolve a finding for every node, and searching the document for each one made validating a model of n flagged nodes take n² id
// parses (35 s of a 10,000-node grid's 45 s run). Where an id appears twice, the first in document order is kept, as the search found.
struct DocumentEntities {
    std::unordered_map<EntityId, const boost::property_tree::ptree*> states, edges, sourceTerms;

    explicit DocumentEntities(const boost::property_tree::ptree& document) {
        if (const auto edgeList = document.get_child_optional("edges")) {
            for (const auto& edgeEntry : *edgeList) edges.emplace(idValue(edgeEntry.second, "id"), &edgeEntry.second);
        }
        if (const auto nodes = document.get_child_optional("nodes")) {
            for (const auto& nodeEntry : *nodes) {
                if (const auto stateList = nodeEntry.second.get_child_optional("states")) {
                    for (const auto& stateEntry : *stateList) states.emplace(idValue(stateEntry.second, "id"), &stateEntry.second);
                }
                if (const auto terms = nodeEntry.second.get_child_optional("sourceTerms")) {
                    for (const auto& termEntry : *terms) sourceTerms.emplace(idValue(termEntry.second, "id"), &termEntry.second);
                }
            }
        }
    }
};

// The parameter with this id among an entity's parameters, or null.
const boost::property_tree::ptree* findParameter(const boost::property_tree::ptree& entity, EntityId parameterId) {
    if (const auto parameters = entity.get_child_optional("parameters")) {
        for (const auto& parameterEntry : *parameters) {
            if (idValue(parameterEntry.second, "id") == parameterId) return &parameterEntry.second;
        }
    }
    return nullptr;
}

// Resolves a ParameterAttribution (an opaque sourceId/parameterId pair from the compiled plan --
// see stabilityAnalysis.hpp) back to both a human-facing phrase for the issue's own message text,
// and a structured AttributedParameter for precise click-to-focus navigation (see
// IssueAttributedParameterReport in protocol/engineProtocol.proto) -- one document search
// produces both, rather than searching twice. stabilityAnalysis.cpp never sees the document/ptree,
// so this disambiguation (an edge's parameter vs. a source term's) and name lookup can only happen
// here. Returns std::nullopt if the ids can't be resolved -- defensive only; should not happen for
// a ParameterAttribution produced from this same document's own compiled plan, but a warning
// message silently degrading is better than this pass throwing over it.
std::optional<ResolvedAttribution> resolveAttributedParameter(const DocumentEntities& entities, const ParameterAttribution& attribution) {
    if (const auto edge = entities.edges.find(attribution.sourceId); edge != entities.edges.end()) {
        const auto parameter = findParameter(*edge->second, attribution.parameterId);
        if (!parameter) return std::nullopt;
        const auto edgeName = value(*edge->second, "name");
        std::ostringstream description;
        description << "the relationship" << (edgeName.empty() ? "" : " \"" + edgeName + "\"") << "'s '" << value(*parameter, "name") << "' parameter";
        return ResolvedAttribution{
            {"edge", std::to_string(attribution.sourceId), std::to_string(attribution.parameterId)},
            description.str()
        };
    }
    if (const auto term = entities.sourceTerms.find(attribution.sourceId); term != entities.sourceTerms.end()) {
        const auto parameter = findParameter(*term->second, attribution.parameterId);
        if (!parameter) return std::nullopt;
        return ResolvedAttribution{
            {"sourceTerm", std::to_string(attribution.sourceId), std::to_string(attribution.parameterId)},
            "this node's own '" + value(*parameter, "name") + "' source-term parameter"
        };
    }
    return std::nullopt;
}

// Same defensive-empty-string convention as resolveAttributedParameter above, and the same
// reason: dominantStateId comes from the compiled plan, which never sees the document, so
// resolving it to a human-facing symbol can only happen here.
std::string stateSymbol(const DocumentEntities& entities, EntityId stateId) {
    const auto state = entities.states.find(stateId);
    return state == entities.states.end() ? std::string() : value(*state->second, "symbol");
}

// The stability pass under a whole-model method (assessWholeModelStability): one finding for the model, on its run settings, where
// the step is chosen -- a global timestep, or steps per global step, rather than a node's substeps.
// Which version of the program SDK a program's source is written against: 2 when it includes konjugate/sdk/v2 or imports konjugate.v2.
bool sourceIsVersion2(const std::string& kind, const std::string& source) {
    if (kind == "cpp") return source.find("konjugate/sdk/v2/") != std::string::npos;
    static const std::regex python(R"((^|\n)\s*(from\s+konjugate\.v2(\.\w+)*\s+import|import\s+konjugate\.v2\b))");
    return std::regex_search(source, python);
}

// A program's providerApiVersion: 1 or 2, and agreeing with its source; another version is one this Konjugate does not have
// (docs/proposals/programSdkV2.md, Versioning). The file is the engine's switch and the source the truth, so a disagreement says which to
// change.
void checkProgramVersion(ValidationResult& result, const boost::property_tree::ptree& implementation, const std::string& kind,
                         const std::string& entityType, const std::string& id, const std::string& field) {
    const auto version = value(implementation, "providerApiVersion");
    if (version != "1" && version != "2") {
        add(result, "providerApiVersionInvalid", "error", version.empty()
            ? "A program must say which version of the program SDK it is written for (providerApiVersion)."
            : "This program is written for version " + version + " of the program SDK, which this Konjugate does not have; update Konjugate.",
            entityType, id, field);
        return;
    }
    const auto source = value(implementation, "source");
    if (source.empty()) return;
    const bool newer = sourceIsVersion2(kind, source);
    if (version == "1" && newer) {
        add(result, "programVersionMismatch", "error", "This program's code is written in the newer program format, but the file says it is "
            "in the older one. Save the program again from its editor, or set its providerApiVersion to 2.", entityType, id, field);
    } else if (version == "2" && !newer) {
        add(result, "programVersionMismatch", "error", std::string("This program's code is written in the older program format, but the file says "
            "it is in the newer one. ") + (kind == "cpp" ? "Include <konjugate/sdk/v2/program.hpp>" : "Import from konjugate.v2") +
            ", or set its providerApiVersion to 1.", entityType, id, field);
    }
}

void addWholeModelStability(ValidationResult& result, const boost::property_tree::ptree& document, const ExecutionPlan& plan,
                            double globalTimeStep, const IntegrationSettings& integration) {
    const auto assessment = assessWholeModelStability(plan, plan.initialStates, globalTimeStep, integration.stepsPerGlobalStep, 400,
        integration.method);
    if (!assessment) return;
    const auto configurationId = document.get<std::string>("activeRunConfigurationId", "");
    const auto symbol = stateSymbol(DocumentEntities(document), assessment->dominantStateId);
    const auto judged = assessment->perNode
        ? " (Judged node by node, each node's neighbours held: the model has " + std::to_string(assessment->stateCount) +
          " integrated states, more than the whole-model check takes.)" : std::string();
    // The names the Run dialog gives the methods.
    const auto adaptive = isAdaptive(integration);
    const std::string methodName = integration.method == IntegrationMethod::dormandPrince54
        ? (adaptive ? "Adaptive" : "Dormand–Prince 5(4) at fixed steps")
        : integration.method == IntegrationMethod::tsit5 ? (adaptive ? "Adaptive" : "Tsit5 at fixed steps") : "Runge–Kutta 4";
    std::ostringstream message;
    if (isRosenbrock(integration.method) || integration.method == IntegrationMethod::bdf) {
        // Stiff is L-stable: no step is too large for a mode that decays, however fast, and a stiff model is what it is for. Only a
        // mode that grows whatever the step is worth saying.
        if (assessment->unconditionallyUnstable) {
            message << "The model has a mode that grows whatever the step" << (symbol.empty() ? "" : " ('" + symbol + "' moves fastest)")
                    << " -- this looks like a modeling or gain-tuning issue rather than a numerics one; check whether this dynamics is "
                    << "intentionally unstable.";
            add(result, "numericsPotentiallyUnstable", "warning", message.str() + judged, "runConfiguration", configurationId, "numerics");
        } else if (integration.method == IntegrationMethod::bdf && assessment->largestDecayingAngleDegrees > 51.0) {
            // BDF's orders 3 to 5 are stable only for modes within 80, 66 and 51 degrees of the negative real axis: a model that
            // oscillates as it decays holds it to lower orders, or to small steps.
            message << "The model oscillates as it decays (a mode " << std::lround(assessment->largestDecayingAngleDegrees) << " degrees from "
                    << "the negative real axis" << (symbol.empty() ? "" : ", '" + symbol + "' moving fastest") << "): BDF's higher orders are "
                    << "not stable for such modes, so it will keep to low orders or small steps there. The Rosenbrock solver (Rodas4) is "
                    << "stable for every mode that decays.";
            add(result, "numericsBdfOscillatoryModes", "warning", message.str() + judged, "runConfiguration", configurationId, "numerics");
        }
        return;
    }
    if (adaptive) {
        // Adaptive keeps itself stable by shrinking its steps; what matters is a mode no step can hold, or a stiff model whose
        // stability, not its accuracy, will set the steps.
        if (assessment->unconditionallyUnstable) {
            message << "The model has a mode that grows whatever the step" << (symbol.empty() ? "" : " ('" + symbol + "' moves fastest)")
                    << " -- this looks like a modeling or gain-tuning issue rather than a numerics one; check whether this dynamics is "
                    << "intentionally unstable.";
            add(result, "numericsPotentiallyUnstable", "warning", message.str() + judged, "runConfiguration", configurationId, "numerics");
        } else if (assessment->stiffnessRatio && *assessment->stiffnessRatio > 1000) {
            message << "The model is stiff (fastest/slowest rate ratio " << *assessment->stiffnessRatio << "): Adaptive stays stable only with "
                    << "steps of at most about ";
            if (assessment->largestStableStep) message << *assessment->largestStableStep;
            message << " s" << (symbol.empty() ? "" : " ('" + symbol + "' moves fastest)") << ", whatever its tolerance, so it will take "
                    << "many small steps where its slowest parts need few.";
            add(result, "numericsStiffModel", "warning", message.str() + judged, "runConfiguration", configurationId, "numerics");
        }
        return;
    }
    if (!assessment->stable) {
        message << "The model may be unstable with " << methodName << " at its step of " << assessment->stepSize << " s (amplification factor "
                << assessment->maxAmplificationFactor << " > 1 per step)";
        if (assessment->unconditionallyUnstable) {
            message << " -- " << (symbol.empty() ? "a state" : "'" + symbol + "'") << " has a mode that grows whatever the step, so no step "
                    << "can stabilize it -- this looks like a modeling or gain-tuning issue rather than a numerics one; check whether this "
                    << "dynamics is intentionally unstable before adjusting numerics.";
        } else if (assessment->requiredStepsPerGlobalStep && assessment->largestStableStep) {
            message << " -- take at least " << *assessment->requiredStepsPerGlobalStep << " steps per global step (Run settings, Steps per "
                    << "global step), or a global timestep of at most " << *assessment->largestStableStep * static_cast<double>(assessment->stepsPerGlobalStep)
                    << " s" << (symbol.empty() ? "" : " ('" + symbol + "' moves fastest)") << ".";
        }
        add(result, "numericsPotentiallyUnstable", "warning", message.str() + judged, "runConfiguration", configurationId, "numerics");
    } else if (assessment->stiffnessRatio && *assessment->stiffnessRatio > 1000) {
        message << "The model is stable with " << methodName << " but stiff (fastest/slowest rate ratio " << *assessment->stiffnessRatio
                << ") -- its fastest dynamics set the step, much smaller than its slowest need.";
        add(result, "numericsStiffModel", "warning", message.str() + judged, "runConfiguration", configurationId, "numerics");
    }
}

void validateProviderOutput(ValidationResult& result,
                            const boost::property_tree::ptree& implementation,
                            const std::unordered_map<std::string, std::set<std::string>>& stateIds,
                            const std::string& sourceNode,
                            const std::string& targetNode,
                            const std::string& edgeId) {
    const auto role = value(implementation, "output.role");
    const auto stateId = value(implementation, "output.stateId");
    const auto key = value(implementation, "output.key");
    if (key.empty() || !isLowerCamelSymbol(key)) {
        add(result, "providerOutputKeyInvalid", "error", "Provider output key must be lower camel case.", "edge", edgeId, "implementation");
    }
    if (role != "source" && role != "target") {
        add(result, "providerOutputMissing", "error", "Provider output role must be source or target.", "edge", edgeId, "implementation");
        return;
    }
    const auto nodeId = role == "source" ? sourceNode : targetNode;
    const auto states = stateIds.find(nodeId);
    if (stateId.empty() || states == stateIds.end() || !states->second.contains(stateId)) {
        add(result, "providerOutputMissing", "error", "Provider output must reference an existing endpoint state.", "edge", edgeId, "implementation");
    }
}

// Mirrors executionPlan.cpp's bidirectional-edge "other endpoint" defaulting exactly (a
// bidirectional edge's reciprocal contribution targets that node's own source/target.stateId when
// given, else its first state) -- needed so the setsValue "sole contributor" count below can see
// a bidirectional edge's implicit second target, not just its declared primary one.
std::string firstStateIdOf(const std::unordered_map<std::string, const boost::property_tree::ptree*>& nodesById, const std::string& nodeId) {
    const auto found = nodesById.find(nodeId);
    if (found == nodesById.end()) return {};
    const auto states = found->second->get_child_optional("states");
    if (!states || states->empty()) return {};
    return value(states->begin()->second, "id");
}

std::string upperFirst(std::string input) {
    if (!input.empty()) input[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(input[0])));
    return input;
}

bool numericToken(const std::string& token) {
    if (token.empty()) return false;
    char* end = nullptr;
    std::strtod(token.c_str(), &end);
    return end == token.c_str() + token.size();
}

// Expressions are typed: numeric everywhere except the conditions of a "Which" (LaTeX cases),
// which must be comparisons or logic over comparisons. Keeping the two apart means a comparison's
// 1/0 never silently becomes a number in a derivative.
void validateTypedMathJson(const boost::property_tree::ptree& expression,
                           const std::set<std::string>& symbols,
                           std::vector<std::string>& errors,
                           bool condition) {
    if (expression.empty()) {
        const auto token = expression.data();
        if (token == "True" || token == "False") {
            if (!condition) errors.push_back("True/False can only be used as a condition.");
            return;
        }
        if (condition) {
            errors.push_back("A condition must be a comparison such as x > 0.");
            return;
        }
        if (!numericToken(token) && !symbols.contains(token)) errors.push_back("Unknown executable symbol: " + token + ".");
        return;
    }
    std::vector<const boost::property_tree::ptree*> items;
    for (const auto& item : expression) items.push_back(&item.second);
    if (items.empty() || !items.front()->empty()) {
        errors.push_back("The executable expression is malformed.");
        return;
    }
    const auto operation = items.front()->data();
    const auto arguments = items.size() - 1;
    static const std::set<std::string> unary = {"Abs", "Arccos", "Arcsin", "Arctan", "Cos", "Exp", "Ln", "Log", "Negate", "Sin", "Sqrt", "Tan", "Tanh"};
    static const std::set<std::string> binary = {"Arctan2", "Divide", "Max", "Min", "Power"};
    static const std::set<std::string> comparisons = {"Less", "LessEqual", "Greater", "GreaterEqual", "Equal", "NotEqual"};
    const bool numericOperation = unary.contains(operation) || binary.contains(operation) || operation == "Add" || operation == "Multiply" || operation == "Which";
    const bool booleanOperation = comparisons.contains(operation) || operation == "And" || operation == "Or" || operation == "Not";
    if (!numericOperation && !booleanOperation) {
        errors.push_back("Unsupported or malformed executable operation: " + operation + ".");
        return;
    }
    if (booleanOperation && !condition) {
        errors.push_back("A comparison (" + operation + ") can only be used as the condition of a cases expression.");
        return;
    }
    if (numericOperation && condition) {
        errors.push_back("A condition must be a comparison such as x > 0.");
        return;
    }
    const bool malformed =
        (unary.contains(operation) && arguments != 1) || (binary.contains(operation) && arguments != 2) ||
        ((operation == "Add" || operation == "Multiply") && arguments < 2) ||
        (operation == "Which" && (arguments < 2 || arguments % 2 != 0)) ||
        (operation == "NotEqual" && arguments != 2) ||
        (comparisons.contains(operation) && arguments < 2) ||
        ((operation == "And" || operation == "Or") && arguments < 2) ||
        (operation == "Not" && arguments != 1);
    if (malformed) {
        errors.push_back("Unsupported or malformed executable operation: " + operation + ".");
        return;
    }
    if (operation == "Which") {
        for (std::size_t index = 1; index < items.size(); ++index) {
            validateTypedMathJson(*items[index], symbols, errors, index % 2 == 1);
        }
        const auto& lastCondition = *items[items.size() - 2];
        if (!lastCondition.empty() || lastCondition.data() != "True") {
            errors.push_back("A cases expression needs a final \\text{otherwise} branch.");
        }
        return;
    }
    const bool childCondition = operation == "And" || operation == "Or" || operation == "Not";
    for (std::size_t index = 1; index < items.size(); ++index) validateTypedMathJson(*items[index], symbols, errors, childCondition);
}

// The symbols an executable expression actually reads. A binding list can name more (the node
// editor binds every state of a node to each of its source terms), and only these are references.
void collectMathJsonSymbols(const boost::property_tree::ptree& expression, std::set<std::string>& symbols) {
    if (expression.empty()) {
        const auto token = expression.data();
        if (token != "True" && token != "False" && !numericToken(token)) symbols.insert(token);
        return;
    }
    bool operation = true;
    for (const auto& item : expression) {
        if (!operation) collectMathJsonSymbols(item.second, symbols);
        operation = false;
    }
}

void validateMathJson(const boost::property_tree::ptree& expression,
                      const std::set<std::string>& symbols,
                      std::vector<std::string>& errors) {
    validateTypedMathJson(expression, symbols, errors, false);
}

std::vector<std::string> equationErrors(const boost::property_tree::ptree& edge,
                                        const boost::property_tree::ptree& sourceNode,
                                        const boost::property_tree::ptree& targetNode) {
    const auto latex = value(edge, "equationModel.latex").empty() ? value(edge, "equation") : value(edge, "equationModel.latex");
    std::vector<std::string> errors;
    int braces = 0;
    for (const char character : latex) {
        if (character == '{') ++braces;
        else if (character == '}' && --braces < 0) break;
    }
    if (braces != 0) errors.push_back("The LaTeX expression has unbalanced braces.");
    // An equality condition inside cases is fine; top-level "a = b" is still caught here (and as a
    // misplaced comparison by the typed MathJSON check).
    const bool hasCases = latex.find("\\begin{cases}") != std::string::npos;
    if (!hasCases && latex.find('=') != std::string::npos) errors.push_back("Assignments are not supported in relationship expressions.");

    std::set<std::string> knownSymbols;
    const auto addStates = [&](const boost::property_tree::ptree& node, const std::string& role) {
        if (const auto states = node.get_child_optional("states")) for (const auto& item : *states) {
            knownSymbols.insert(role + upperFirst(value(item.second, "symbol")));
        }
    };
    addStates(sourceNode, "source");
    addStates(targetNode, "target");
    if (const auto parameters = edge.get_child_optional("parameters")) for (const auto& item : *parameters) knownSymbols.insert(value(item.second, "symbol"));
    if (const auto bindings = edge.get_child_optional("equationModel.bindings")) for (const auto& item : *bindings) knownSymbols.insert(value(item.second, "symbol"));

    const auto textErrors = latexTextErrors(latex, knownSymbols);
    errors.insert(errors.end(), textErrors.begin(), textErrors.end());
    return errors;
}
}

void validateAlgebraicRelationship(ValidationResult& result, const boost::property_tree::ptree& edge, const boost::property_tree::ptree& outputs,
                                   std::unordered_map<std::string, std::set<std::string>>& stateIds, const std::set<std::string>& parameterIds,
                                   const std::string& sourceNode, const std::string& targetNode, const std::string& id,
                                   std::set<std::string>& relationshipStateIds) {
    const auto implementationKind = value(edge, "implementation.kind");
    if (!implementationKind.empty() && implementationKind != "equation") {
        add(result, "relationshipOutputsInvalid", "error", "A relationship with several equations is written as equations, not a program.", "edge", id, "implementation");
    }
    if (value(edge, "directionality") == "bidirectional") {
        add(result, "relationshipOutputsInvalid", "error", "A relationship with several equations is directed: each equation names the state it sets.", "edge", id, "output");
    }
    std::set<std::string> symbols;
    if (const auto bindings = edge.get_child_optional("equationModel.bindings")) for (const auto& bindingEntry : *bindings) {
        const auto& binding = bindingEntry.second;
        symbols.insert(value(binding, "symbol"));
        if (value(binding, "kind") == "parameter") {
            if (!parameterIds.contains(value(binding, "parameterId"))) add(result, "edgeBindingMissing", "error", "Equation binding references a missing parameter.", "edge", id, "equation");
        } else if (value(binding, "kind") != "time") {
            const auto bindingNode = value(binding, "nodeId");
            if ((bindingNode != sourceNode && bindingNode != targetNode) || !stateIds[bindingNode].contains(value(binding, "stateId"))) {
                add(result, "edgeBindingMissing", "error", "Equation binding references a missing endpoint state.", "edge", id, "equation");
            }
        }
    }
    if (const auto definitions = edge.get_child_optional("equationModel.definitions")) for (const auto& definitionEntry : *definitions) {
        const auto& definition = definitionEntry.second;
        const auto symbol = value(definition, "symbol");
        std::vector<std::string> errors;
        const auto mathJson = definition.get_child_optional("mathJson");
        if (!mathJson) errors.push_back("Its expression is missing.");
        else validateMathJson(*mathJson, symbols, errors);
        if (!isDefinitionSymbol(symbol) || !symbols.insert(symbol).second) {
            errors.push_back("A definition needs a name of its own (letters and digits).");
        }
        if (!errors.empty()) add(result, "relationshipDefinitionInvalid", "error", "Definition \"" + symbol + "\": " + errors.front(), "edge", id, "equation");
    }
    if (outputs.empty()) add(result, "edgeOutputMissing", "error", "A relationship with several equations needs at least one.", "edge", id, "output");
    std::set<std::string> outputStates;
    for (const auto& outputEntry : outputs) {
        const auto& output = outputEntry.second;
        const auto role = value(output, "role");
        const auto stateId = value(output, "stateId");
        const auto& candidates = role == "source" ? stateIds[sourceNode] : stateIds[targetNode];
        if ((role != "source" && role != "target") || !candidates.contains(stateId)) {
            add(result, "edgeOutputMissing", "error", "Each equation sets an existing state of one of the relationship's two nodes.", "edge", id, "output");
            continue;
        }
        if (value(output, "setsValue") != "true") {
            add(result, "relationshipOutputNotAlgebraic", "error", "Each equation of a relationship with several equations sets its state's value (setsValue).", "edge", id, "output");
        }
        if (!outputStates.insert(stateId).second) {
            add(result, "relationshipOutputDuplicate", "error", "A relationship sets each state with one equation.", "edge", id, "output");
        }
        std::vector<std::string> errors;
        const auto mathJson = output.get_child_optional("mathJson");
        if (!mathJson) errors.push_back("Equation requires a valid executable expression.");
        else validateMathJson(*mathJson, symbols, errors);
        if (!errors.empty()) add(result, "edgeEquationInvalid", "error", errors.front(), "edge", id, "equation");
        relationshipStateIds.insert(stateId);
    }
}

ValidationResult validateModel(const boost::property_tree::ptree& document) {
    ValidationResult result;
    if (value(document, "format") != "konjugate" || document.get<int>("version", 0) != 1) {
        add(result, "unsupportedProject", "error", "The project format or schema version is not supported.");
        result.valid = false;
        return result;
    }
    const auto nodesOptional = document.get_child_optional("nodes");
    const auto edgesOptional = document.get_child_optional("edges");
    if (!nodesOptional || !edgesOptional) {
        add(result, "invalidDocument", "error", "The project must contain node and relationship arrays.");
        result.valid = false;
        return result;
    }

    std::set<std::string> allIds;
    std::unordered_map<std::string, std::set<std::string>> stateIds;
    std::unordered_map<std::string, std::set<std::string>> stateSymbols;
    std::unordered_map<std::string, const boost::property_tree::ptree*> nodesById;
    // Populated while walking source terms and edges below, then checked once at the end: a
    // source term authored as "sets the value" (setsValue) must be the SOLE contribution to its
    // state -- no other source term, no edge -- since a directly-set value and an
    // additively-summed derivative from anything else would silently fight each other every
    // substep. stateContributorCounts counts every enabled contribution (source term or edge)
    // targeting a given stateId; setsValueStateIds names which states have a setsValue source
    // term at all (most states have none, and never need the count checked).
    std::unordered_map<std::string, int> stateContributorCounts;
    std::set<std::string> setsValueStateIds;
    auto registerId = [&](const std::string& id, const std::string& kind, const std::string& entityId, const std::string& label) {
        bool validId = isEntityId(id);
        if (validId) {
            try { validId = std::stoull(id) <= 9007199254740991ULL; } catch (...) { validId = false; }
        }
        if (!validId) add(result, "invalidId", "error", label + " does not have a valid positive integer id.", kind, entityId, "id");
        else if (!allIds.insert(id).second) add(result, "duplicateId", "error", label + " reuses an existing id.", kind, entityId, "id");
    };

    // Project-level shared parameters: one definition that any number of relationship or
    // source-term parameters link to (via sharedParameterId), so a single value or live control
    // drives all of them. Their ids share the project-wide id space.
    std::set<std::string> sharedParameterIds;
    std::set<std::string> sharedParameterSymbols;
    if (const auto sharedParameters = document.get_child_optional("sharedParameters")) for (const auto& entry : *sharedParameters) {
        const auto& shared = entry.second;
        const auto sharedId = value(shared, "id");
        registerId(sharedId, "sharedParameter", sharedId, "Shared parameter \"" + value(shared, "name") + "\"");
        sharedParameterIds.insert(sharedId);
        const auto symbol = value(shared, "symbol");
        if (!isLowerCamelSymbol(symbol)) add(result, "parameterSymbolInvalid", "error", "Shared parameter symbol must be lower camel case.", "sharedParameter", sharedId, "symbol");
        else if (!sharedParameterSymbols.insert(symbol).second) add(result, "parameterSymbolDuplicate", "error", "Shared parameter symbol \"" + symbol + "\" is duplicated.", "sharedParameter", sharedId, "symbol");
        const auto mode = value(shared, "mode");
        if (mode != "constant" && mode != "live") add(result, "parameterModeInvalid", "error", "Parameter mode must be constant or live.", "sharedParameter", sharedId, "mode");
        if (!shared.get_optional<double>("value") || !std::isfinite(*shared.get_optional<double>("value"))) {
            add(result, "parameterValueInvalid", "error", "A shared parameter needs a finite value.", "sharedParameter", sharedId, "value");
        }
        if (shared.get_child_optional("tuning")) {
            const auto tuningMinimum = shared.get_optional<double>("tuning.minimum");
            const auto tuningMaximum = shared.get_optional<double>("tuning.maximum");
            const auto tuningValue = shared.get_optional<double>("value");
            if (!tuningMinimum || !tuningMaximum || !tuningValue || !std::isfinite(*tuningMinimum) || !std::isfinite(*tuningMaximum) ||
                !(*tuningMinimum < *tuningMaximum) || *tuningValue < *tuningMinimum || *tuningValue > *tuningMaximum) {
                add(result, "parameterTuningInvalid", "error", "Tunable parameter fitting bounds require minimum < maximum and an initial value within the bounds.", "sharedParameter", sharedId, "tuning");
            }
        }
        // A stored schedule: the parameter follows these samples over simulation time.
        if (const auto schedule = shared.get_child_optional("schedule")) {
            const auto interpolation = schedule->get<std::string>("interpolation", "linear");
            if (interpolation != "linear" && interpolation != "hold") {
                add(result, "parameterScheduleInvalid", "error", "A parameter schedule's interpolation must be linear or hold.", "sharedParameter", sharedId, "schedule");
            }
            std::size_t count = 0;
            bool wellFormed = true;
            double previousTime = -std::numeric_limits<double>::infinity();
            if (const auto samples = schedule->get_child_optional("samples")) for (const auto& sampleItem : *samples) {
                std::vector<double> pair;
                try {
                    for (const auto& component : sampleItem.second) pair.push_back(component.second.get_value<double>());
                } catch (const boost::property_tree::ptree_error&) {
                    pair.clear();
                }
                if (pair.size() != 2 || !std::isfinite(pair[0]) || !std::isfinite(pair[1]) || !(pair[0] > previousTime)) wellFormed = false;
                else previousTime = pair[0];
                ++count;
            }
            if (!count || !wellFormed) {
                add(result, "parameterScheduleInvalid", "error", "A parameter schedule needs at least one [time, value] sample, every number finite and the times strictly increasing.", "sharedParameter", sharedId, "schedule");
            }
            if (shared.get_child_optional("tuning")) {
                add(result, "parameterScheduleTuned", "error", "A parameter that follows a schedule cannot also be a fitting target.", "sharedParameter", sharedId, "tuning");
            }
        }
        if (mode == "live" && shared.get_child_optional("control")) {
            const auto minimum = shared.get_optional<double>("control.minimum");
            const auto maximum = shared.get_optional<double>("control.maximum");
            const auto step = shared.get_optional<double>("control.step");
            const auto initialValue = shared.get_optional<double>("value");
            if (!minimum || !maximum || !step || !initialValue || !std::isfinite(*minimum) || !std::isfinite(*maximum) ||
                !std::isfinite(*step) || !std::isfinite(*initialValue) || !(*minimum < *maximum) || !(*step > 0) ||
                *initialValue < *minimum || *initialValue > *maximum) {
                add(result, "parameterControlInvalid", "error", "Live parameter slider settings require minimum < maximum, step > 0 and an initial value within the bounds.", "sharedParameter", sharedId, "control");
            }
        }
    }
    // A parameter linked to a shared one takes its value and mode from it, so the link must
    // resolve and the parameter cannot also carry its own fitting bounds (a shared parameter
    // carries them instead, and fitting it moves every parameter linked to it).
    auto validateSharedLink = [&](const boost::property_tree::ptree& parameter, const std::string& kind, const std::string& ownerId, const std::string& field) {
        if (!parameter.get_child_optional("sharedParameterId")) return;
        if (!sharedParameterIds.contains(value(parameter, "sharedParameterId"))) {
            add(result, "sharedParameterMissing", "error", "Parameter \"" + value(parameter, "name") + "\" links to a shared parameter that does not exist.", kind, ownerId, field);
        }
        if (parameter.get_child_optional("tuning")) {
            add(result, "sharedParameterTuningUnsupported", "error", "A parameter linked to a shared parameter cannot be marked as tunable.", kind, ownerId, field);
        }
    };

    std::set<std::string> runConfigurationIds;
    // Populated when the active run configuration parses cleanly, for the stability-diagnostic
    // pass near the end of this function -- the pre-run phase of
    // docs/proposals/numericalStabilityDiagnostics.md needs a concrete step size to check against,
    // and the active run configuration is the closest thing a static document has to "the step
    // size this model will actually run at." Left empty (no check performed) when the document has
    // no run configurations at all, or the active one fails to parse -- there is nothing honest to
    // check against in either case.
    std::optional<double> activeGlobalTimeStep;
    // The active run configuration's method (docs/proposals/integrators.md): the stability pass judges a whole-model method by the
    // whole model's Jacobian and the method's stability function, not node by node with Euler's.
    IntegrationSettings activeIntegration;
    if (const auto configurations = document.get_child_optional("runConfigurations")) {
        const auto activeId = value(document, "activeRunConfigurationId");
        for (const auto& configurationEntry : *configurations) {
            const auto& configuration = configurationEntry.second;
            const auto configurationId = value(configuration, "id");
            registerId(configurationId, "runConfiguration", configurationId, "Run configuration \"" + value(configuration, "name") + "\"");
            runConfigurationIds.insert(configurationId);
            try {
                const auto globalTimeStep = configuration.get<double>("globalTimeStep");
                const auto outputInterval = configuration.get<double>("outputInterval");
                if (!(globalTimeStep > 0) || !(outputInterval > 0) ||
                    !std::isfinite(globalTimeStep) || !std::isfinite(outputInterval)) throw std::out_of_range("configuration");
                const auto ratio = outputInterval / globalTimeStep;
                if (outputInterval < globalTimeStep || std::abs(ratio - std::round(ratio)) > 1e-9) throw std::out_of_range("configuration");
                if (configurationId == activeId) activeGlobalTimeStep = globalTimeStep;
            } catch (...) {
                add(result, "runConfigurationInvalid", "error", "Numerical configuration values must be finite and positive; output interval must be an integer multiple of the global timestep.", "runConfiguration", configurationId, "numerics");
            }
            // A method this version does not know, or steps per global step out of range, refused by name.
            try {
                const auto integration = integrationSettingsFromTree(configuration);
                if (configurationId == activeId) activeIntegration = integration;
            } catch (const std::exception& error) {
                add(result, "runConfigurationMethodInvalid", "error", error.what(), "runConfiguration", configurationId, "numerics");
            }
        }
        if (!configurations->empty() && !runConfigurationIds.contains(value(document, "activeRunConfigurationId"))) {
            add(result, "activeRunConfigurationMissing", "error", "Choose an existing active run configuration.", "model", {}, "runConfigurations");
        }
    }

    // An empty model is where every model starts, not a problem with it: the project window shows what to do on its empty canvas.
    result.nodeCount = nodesOptional->size();
    std::set<std::string> disabledNodeIds;
    // A computational-node provider's bindings to other nodes' states, as (node, state) pairs: checked
    // once every node's states are known, since a node may read one listed after it.
    std::vector<std::pair<std::string, std::string>> remoteNodeProviderBindings;
    // The states relationships' equations set (equationModel.outputs).
    std::set<std::string> relationshipStateIds;
    // What each state is (its `kind`, docs/proposals/ratesAndUpdates.md) against what reaches it: the kind a state says;
    // the states a setsValue source term or a program's setsValue output sets; and per state, how many terms add a rate to
    // it (a source term or relationship that does not say it sets a value, into a state that does not say it is an
    // Update) and how many of those are a program's. Each state's "Node · State" name and node, for the messages.
    std::unordered_map<std::string, std::string> declaredKinds;
    std::set<std::string> termValueStateIds;
    std::set<std::string> programValueStateIds;
    std::unordered_map<std::string, int> plainRateCounts;
    std::unordered_map<std::string, int> programRateCounts;
    std::unordered_map<std::string, std::string> stateLabels;
    std::unordered_map<std::string, std::string> stateOwners;
    // Per state, what adds a rate to it and what sets its value, named as a person finds them: a node's source term (by
    // what it says), a node's program, a relationship (by its name).
    std::unordered_map<std::string, std::vector<std::string>> rateSources;
    std::unordered_map<std::string, std::vector<std::string>> valueSources;
    const auto note = [](std::vector<std::string>& sources, const std::string& source) {
        if (std::find(sources.begin(), sources.end(), source) == sources.end()) sources.push_back(source);
    };
    const auto declaredKind = [&](const std::string& stateId) {
        const auto found = declaredKinds.find(stateId);
        return found == declaredKinds.end() ? std::string{} : found->second;
    };
    for (const auto& entry : *nodesOptional) {
        const auto& node = entry.second;
        const auto id = value(node, "id");
        const auto name = value(node, "name");
        registerId(id, "node", id, "Node \"" + (name.empty() ? std::string("Untitled") : name) + "\"");
        nodesById[id] = &node;
        // A disabled node is inert from the engine's perspective (compileExecutionPlan skips it
        // entirely, same as if it had been deleted), so its own content isn't validated -- only
        // its ids, which must stay globally unique even while off so nothing collides whenever it
        // (or something added later) gets re-enabled.
        const bool nodeEnabled = value(node, "enabled") != "false";
        if (nodeEnabled) {
            const auto substepsValue = value(node, "numerics.substepsPerGlobalStep");
            if (!substepsValue.empty()) {
                try {
                    std::size_t consumed = 0;
                    const auto substeps = std::stoull(substepsValue, &consumed);
                    if (consumed != substepsValue.size() || !substeps || substeps > 10000) throw std::out_of_range("substeps");
                } catch (...) {
                    add(result, "nodeSubstepsInvalid", "error", "Node substeps per global step must be an integer from 1 through 10000.", "node", id, "numerics");
                }
            }
            const auto integration = value(node, "numerics.integration");
            if (!integration.empty() && integration != "explicit" && integration != "semiImplicit" && integration != "verlet") {
                add(result, "nodeIntegrationInvalid", "error", "A node's integration must be explicit, semiImplicit or verlet.", "node", id, "numerics");
            } else if ((integration == "semiImplicit" || integration == "verlet") && node.get_child_optional("implementation")) {
                add(result, "nodeIntegrationInvalid", "error", "A node with a computational-node provider is integrated explicitly.", "node", id, "numerics");
            }
            // How its Updates are worked out: once per step, or settled within the step, up to a number of sweeps.
            const auto updates = value(node, "updates");
            if (!updates.empty() && updates != "oncePerStep" && updates != "settle") {
                add(result, "nodeUpdatesInvalid", "error", "A node's updates are oncePerStep or settle.", "node", id, "numerics");
            }
            if (const auto limit = node.get_optional<std::string>("updatesLimit")) {
                try {
                    std::size_t consumed = 0;
                    const auto sweeps = std::stoull(*limit, &consumed);
                    if (consumed != limit->size() || !sweeps) throw std::out_of_range("updatesLimit");
                } catch (...) {
                    add(result, "nodeUpdatesInvalid", "error", "A node's updatesLimit is a positive whole number of sweeps.", "node", id, "numerics");
                }
            }
        } else {
            disabledNodeIds.insert(id);
        }
        const auto states = node.get_child_optional("states");
        if (nodeEnabled && (!states || states->empty())) add(result, "nodeStatesEmpty", "warning", "This node has no state variables.", "node", id, "states");
        if (states) for (const auto& stateEntry : *states) {
            const auto& state = stateEntry.second;
            const auto stateId = value(state, "id");
            const auto symbol = value(state, "symbol");
            registerId(stateId, "node", id, "State \"" + value(state, "name") + "\"");
            stateIds[id].insert(stateId);
            if (!nodeEnabled) continue;
            if (!isLowerCamelSymbol(symbol)) add(result, "stateSymbolInvalid", "error", "State symbol must be lower camel case.", "node", id, "states");
            stateOwners[stateId] = id;
            stateLabels[stateId] = value(node, "name") + " · " + value(state, "name");
            if (const auto kind = state.get_optional<std::string>("kind")) {
                if (*kind == "rate" || *kind == "update") declaredKinds[stateId] = *kind;
                else add(result, "stateKindInvalid", "error", "State \"" + value(state, "name") + "\" has kind \"" + *kind +
                    "\": a state is a rate (it changes over time by what reaches it) or an update (what reaches it is its next value).", "node", id, "states");
            }
            // A state's own absolute tolerance for the adaptive method (docs/proposals/integrators.md): a finite positive number.
            if (const auto tolerance = state.get_optional<std::string>("numerics.absoluteTolerance")) {
                char* end = nullptr;
                const auto parsed = std::strtod(tolerance->c_str(), &end);
                if (tolerance->empty() || end != tolerance->c_str() + tolerance->size() || !std::isfinite(parsed) || !(parsed > 0)) {
                    add(result, "stateAbsoluteToleranceInvalid", "error", "State \"" + value(state, "name") + "\"'s absolute tolerance must be a "
                        "finite number greater than 0.", "node", id, "numerics");
                }
            }
            // A state's initial value can be a fitting target too, with the same bounds as a parameter.
            if (state.get_child_optional("tuning")) {
                const auto minimum = state.get_optional<double>("tuning.minimum");
                const auto maximum = state.get_optional<double>("tuning.maximum");
                const auto initialValue = state.get_optional<double>("initialValue");
                if (!minimum || !maximum || !initialValue || !std::isfinite(*minimum) || !std::isfinite(*maximum) ||
                    !(*minimum < *maximum) || *initialValue < *minimum || *initialValue > *maximum) {
                    add(result, "stateTuningInvalid", "error", "A tunable initial value needs minimum < maximum and the initial value within them.", "node", id, "states");
                }
            }
            else if (!stateSymbols[id].insert(symbol).second) add(result, "stateSymbolDuplicate", "error", "State symbol \"" + symbol + "\" is duplicated in this node.", "node", id, "states");
        }
        // Per-node: (outputStateId, [stateIds its bindings reference]) for this node's own
        // setsValue ("algebraic") source terms -- checked for a dependency cycle or self-reference
        // once the whole sourceTerms loop below finishes, mirroring compileExecutionPlan's own
        // dependency-ordering pass exactly (see executionPlan.cpp) so a user hits this validator's
        // clear error message before ever reaching that pass's defensive throw.
        std::vector<std::pair<std::string, std::vector<std::string>>> algebraicCandidates;
        if (const auto terms = node.get_child_optional("sourceTerms")) for (const auto& termEntry : *terms) {
            const auto& term = termEntry.second;
            registerId(value(term, "id"), "node", id, "Own equation");
            std::set<std::string> sourceParameterSymbols;
            std::set<std::string> sourceParameterIds;
            if (const auto parameters = term.get_child_optional("parameters")) for (const auto& parameterEntry : *parameters) {
                const auto& parameter = parameterEntry.second;
                registerId(value(parameter, "id"), "node", id, "Source-term parameter \"" + value(parameter, "name") + "\"");
                sourceParameterIds.insert(value(parameter, "id"));
                validateSharedLink(parameter, "node", id, "sourceTerms");
                if (!nodeEnabled) continue;
                const auto symbol = value(parameter, "symbol");
                if (!isLowerCamelSymbol(symbol)) add(result, "parameterSymbolInvalid", "error", "Parameter symbol must be lower camel case.", "node", id, "sourceTerms");
                else if (!sourceParameterSymbols.insert(symbol).second) add(result, "parameterSymbolDuplicate", "error", "Source-term parameter symbols must be unique.", "node", id, "sourceTerms");
                const auto mode = value(parameter, "mode");
                if (mode != "constant" && mode != "live") add(result, "parameterModeInvalid", "error", "Parameter mode must be constant or live.", "node", id, "sourceTerms");
                if (parameter.get_child_optional("tuning")) {
                    const auto minimum = parameter.get_optional<double>("tuning.minimum");
                    const auto maximum = parameter.get_optional<double>("tuning.maximum");
                    const auto initial = parameter.get_optional<double>("value");
                    if (!minimum || !maximum || !initial || !std::isfinite(*minimum) || !std::isfinite(*maximum) ||
                        !(*minimum < *maximum) || *initial < *minimum || *initial > *maximum) {
                        add(result, "parameterTuningInvalid", "error", "Tunable parameter fitting bounds require minimum < maximum and an initial value within the bounds.", "node", id, "sourceTerms");
                    }
                }
                if (mode == "live" && parameter.get_child_optional("control")) {
                    const auto minimum = parameter.get_optional<double>("control.minimum");
                    const auto maximum = parameter.get_optional<double>("control.maximum");
                    const auto step = parameter.get_optional<double>("control.step");
                    const auto initial = parameter.get_optional<double>("value");
                    if (!minimum || !maximum || !step || !initial || !std::isfinite(*minimum) || !std::isfinite(*maximum) ||
                        !std::isfinite(*step) || !(*minimum < *maximum) || !(*step > 0) || *initial < *minimum || *initial > *maximum) {
                        add(result, "parameterControlInvalid", "error", "Live parameter slider settings require minimum < maximum, step > 0 and an initial value within the bounds.", "node", id, "sourceTerms");
                    }
                }
            }
            if (!nodeEnabled) continue;
            const auto termImplementation = term.get_child_optional("implementation");
            const auto termImplementationKind = termImplementation ? value(*termImplementation, "kind") : "equation";
            {
                const bool termProgrammable = termImplementationKind == "cpp" || termImplementationKind == "python";
                const auto termOutputStateId = value(term, termProgrammable ? "implementation.output.stateId" : "expressionModel.output.stateId");
                if (!termOutputStateId.empty()) {
                    stateContributorCounts[termOutputStateId] += 1;
                    // A value when it says so or when its state says it is an Update; otherwise a rate.
                    const auto expression = value(term, "expression");
                    const auto termName = termProgrammable || expression.empty() ? value(node, "name") + "'s own part"
                        : value(node, "name") + "'s own part \"" + (expression.size() > 40 ? expression.substr(0, 37) + "..." : expression) + "\"";
                    if (value(term, "setsValue") == "true") termValueStateIds.insert(termOutputStateId);
                    else if (declaredKind(termOutputStateId) != "update") plainRateCounts[termOutputStateId] += 1;
                    if (value(term, "setsValue") == "true" || declaredKind(termOutputStateId) == "update") note(valueSources[termOutputStateId], termName);
                    else note(rateSources[termOutputStateId], termName);
                    if (value(term, "setsValue") == "true") {
                        setsValueStateIds.insert(termOutputStateId);
                        std::vector<std::string> referencedStateIds;
                        // A provider may read any state it binds; an equation only the ones it uses.
                        std::optional<std::set<std::string>> usedSymbols;
                        if (!termProgrammable) {
                            usedSymbols.emplace();
                            if (const auto mathJson = term.get_child_optional("expressionModel.mathJson")) collectMathJsonSymbols(*mathJson, *usedSymbols);
                        }
                        if (const auto bindings = term.get_child_optional(termProgrammable ? "implementation.bindings" : "expressionModel.bindings")) {
                            for (const auto& bindingEntry : *bindings) {
                                const auto& binding = bindingEntry.second;
                                if (value(binding, "kind") != "state") continue;
                                if (usedSymbols && !usedSymbols->contains(value(binding, "symbol"))) continue;
                                referencedStateIds.push_back(value(binding, "stateId"));
                            }
                        }
                        algebraicCandidates.emplace_back(termOutputStateId, std::move(referencedStateIds));
                    }
                }
            }
            if (termImplementationKind != "equation" && termImplementationKind != "cpp" && termImplementationKind != "python") {
                add(result, "sourceKindInvalid", "error", "A node's own part must be written as an equation, a C++ program or a Python program.", "node", id, "sourceTerms");
            }
            if (termImplementationKind == "cpp" || termImplementationKind == "python") {
                checkProgramVersion(result, *termImplementation, termImplementationKind, "node", id, "sourceTerms");
                if (value(*termImplementation, "source").empty()) {
                    add(result, "providerSourceEmpty", "error", "A node's own part written as a program needs its program's source.", "node", id, "sourceTerms");
                }
                // Unlike an edge, a source term has no other endpoint to read from, so zero
                // declared bindings is not itself an error (e.g. a constant contribution).
                // It only warrants a warning when the source still looks like the untouched,
                // generated template — a signal the author has not started implementing it —
                // and that warning clears as soon as real source is written, binding or not.
                std::set<std::string> providerKeys;
                const auto providerBindings = termImplementation->get_child_optional("bindings");
                const bool hasBindings = providerBindings && !providerBindings->empty();
                if (!hasBindings && value(*termImplementation, "source").find("TODO: read") != std::string::npos) {
                    add(result, "sourceTermImplementationIncomplete", "warning",
                        "This own part's program has no inputs and is still the generated template.",
                        "node", id, "sourceTerms");
                }
                if (providerBindings) for (const auto& bindingEntry : *providerBindings) {
                    const auto& binding = bindingEntry.second;
                    const auto key = value(binding, "key");
                    if (!isLowerCamelSymbol(key)) {
                        add(result, "providerBindingKeyInvalid", "error", "Provider input keys must be lower camel case.", "node", id, "sourceTerms");
                    } else if (!providerKeys.insert(key).second) {
                        add(result, "providerBindingKeyDuplicate", "error", "Provider input key \"" + key + "\" is duplicated.", "node", id, "sourceTerms");
                    }
                    if (value(binding, "kind") == "parameter") {
                        if (!sourceParameterIds.contains(value(binding, "parameterId"))) add(result, "providerBindingMissing", "error", "Provider binding references a missing source-term parameter.", "node", id, "sourceTerms");
                    } else if (value(binding, "kind") != "state" || !stateIds[id].contains(value(binding, "stateId"))) {
                        add(result, "providerBindingMissing", "error", "Provider binding references a missing local state.", "node", id, "sourceTerms");
                    }
                }
                const auto outputKey = value(*termImplementation, "output.key");
                const auto outputStateId = value(*termImplementation, "output.stateId");
                if (outputKey.empty() || !isLowerCamelSymbol(outputKey)) {
                    add(result, "providerOutputKeyInvalid", "error", "Provider output key must be lower camel case.", "node", id, "sourceTerms");
                }
                if (outputStateId.empty() || !stateIds[id].contains(outputStateId)) {
                    add(result, "providerOutputMissing", "error", "Provider output must reference an existing local state.", "node", id, "sourceTerms");
                }
                continue;
            }
            const auto state = value(term, "state");
            if (!stateSymbols[id].contains(state)) add(result, "sourceStateMissing", "error", "A node's own part lands on a state that no longer exists.", "node", id, "sourceTerms");
            if (value(term, "expression").empty()) add(result, "sourceExpressionEmpty", "error", "A node's own part needs an equation.", "node", id, "sourceTerms");
            const auto mathJson = term.get_child_optional("expressionModel.mathJson");
            if (!mathJson) add(result, "sourceExpressionInvalid", "error", "A node's own part needs an equation that can be worked out.", "node", id, "sourceTerms");
            else {
                std::set<std::string> executableSymbols;
                if (const auto bindings = term.get_child_optional("expressionModel.bindings")) {
                    for (const auto& binding : *bindings) {
                        executableSymbols.insert(value(binding.second, "symbol"));
                        if (value(binding.second, "kind") == "parameter") {
                            if (!sourceParameterIds.contains(value(binding.second, "parameterId"))) add(result, "sourceBindingMissing", "error", "A node's own part reads a parameter that no longer exists.", "node", id, "sourceTerms");
                        } else if (value(binding.second, "kind") == "time") {
                            // Simulation time -- always available, nothing to resolve.
                        } else if (!stateIds[id].contains(value(binding.second, "stateId"))) {
                            add(result, "sourceBindingMissing", "error", "A node's own part reads a state of the node that no longer exists.", "node", id, "sourceTerms");
                        }
                    }
                }
                std::vector<std::string> errors;
                validateMathJson(*mathJson, executableSymbols, errors);
                if (!errors.empty()) add(result, "sourceExpressionInvalid", "error", errors.front(), "node", id, "sourceTerms");
            }
            if (!stateIds[id].contains(value(term, "expressionModel.output.stateId"))) {
                add(result, "sourceOutputMissing", "error", "A node's own part needs a state to land on.", "node", id, "sourceTerms");
            }
        }
        // A value set at the same instant (a setsValue term into a state that does not say its kind) may not read itself; an
        // Update may (a counter reads its value from the step's start). Rings of them are no longer refused: an Update reads
        // others from the step's start, and a settling node sweeps a ring (docs/proposals/ratesAndUpdates.md).
        for (const auto& [outputStateId, referencedStateIds] : algebraicCandidates) {
            if (declaredKind(outputStateId) == "update") continue;
            if (std::find(referencedStateIds.begin(), referencedStateIds.end(), outputStateId) != referencedStateIds.end()) {
                add(result, "setsValueSelfReference", "error",
                    "A node's own part that sets its state directly may not read that state.", "node", id, "sourceTerms");
                break;
            }
        }
        if (nodeEnabled) {
            if (const auto implementation = node.get_child_optional("implementation")) {
                const auto kind = value(*implementation, "kind");
                if (kind != "python" && kind != "cpp") {
                    add(result, "nodeProviderKindInvalid", "error",
                        "Computational-node provider implementation kind must be python or cpp.",
                        "node", id, "implementation");
                }
                checkProgramVersion(result, *implementation, kind, "node", id, "implementation");
                if (value(*implementation, "source").empty()) {
                    add(result, "providerSourceEmpty", "error", "Programmable computational-node providers require inline source.", "node", id, "implementation");
                }
                // Same "zero bindings is legitimate, but warn if it also still looks untouched"
                // stance as edges/source terms: a computational-node provider may legitimately
                // compute purely from parameters or time -- except a node has no parameter
                // concept to bind against, so this is really "purely from time or constants".
                std::set<std::string> nodeProviderKeys;
                const auto providerBindings = implementation->get_child_optional("bindings");
                const bool hasBindings = providerBindings && !providerBindings->empty();
                if (!hasBindings && value(*implementation, "source").find("TODO: read") != std::string::npos) {
                    add(result, "nodeProviderImplementationIncomplete", "warning",
                        "This computational-node provider has no input bindings and still contains the generated template.",
                        "node", id, "implementation");
                }
                // Collected alongside the ordinary per-binding checks below so the setsValue
                // self-reference check after the outputs loop can tell whether any of this
                // provider's own (shared, not per-output) input bindings reads a state one of its
                // setsValue outputs also targets -- see that check for why this matters.
                std::set<std::string> nodeProviderBindingStateIds;
                if (providerBindings) for (const auto& bindingEntry : *providerBindings) {
                    const auto& binding = bindingEntry.second;
                    const auto key = value(binding, "key");
                    if (!isLowerCamelSymbol(key)) {
                        add(result, "providerBindingKeyInvalid", "error", "Provider input keys must be lower camel case.", "node", id, "implementation");
                    } else if (!nodeProviderKeys.insert(key).second) {
                        add(result, "providerBindingKeyDuplicate", "error", "Provider input key \"" + key + "\" is duplicated.", "node", id, "implementation");
                    }
                    if (value(binding, "kind") == "parameter") {
                        // A node has no parameters of its own: its provider reads project-level shared ones.
                        if (value(binding, "sharedParameterId").empty()) {
                            add(result, "providerBindingParameterNotShared", "error",
                                "A computational-node provider binds only shared parameters, by sharedParameterId: a node has no parameters of its own.", "node", id, "implementation");
                        } else if (!sharedParameterIds.contains(value(binding, "sharedParameterId"))) {
                            add(result, "sharedParameterMissing", "error", "Provider binding \"" + key + "\" links to a shared parameter that does not exist.", "node", id, "implementation");
                        }
                    } else if (value(binding, "kind") != "state" || value(binding, "stateId").empty()) {
                        add(result, "providerBindingMissing", "error", "Provider binding references a missing state.", "node", id, "implementation");
                    } else if (stateIds[id].contains(value(binding, "stateId"))) {
                        nodeProviderBindingStateIds.insert(value(binding, "stateId"));
                    } else {
                        remoteNodeProviderBindings.emplace_back(id, value(binding, "stateId"));
                    }
                }
                // Unlike an edge/source term's single output, a computational-node provider
                // declares N named outputs -- each needs its own key-uniqueness check, and at
                // least one is required since zero outputs would mean the provider contributes
                // nothing at all, defeating the point of owning a node's dynamics. An output may
                // additionally carry setsValue (see docs/projectSchema.md), mirroring a source
                // term's own setsValue flag: its state becomes a genuine algebraic one rather than
                // a derivative contribution, so it's folded into the same stateContributorCounts/
                // setsValueStateIds machinery the sourceTerms loop above already populates, and
                // gets the same sole-contributor check at the bottom of this function.
                std::set<std::string> outputKeys;
                bool nodeProviderSelfReference = false;
                const auto outputs = implementation->get_child_optional("outputs");
                if (!outputs || outputs->empty()) {
                    add(result, "nodeProviderOutputsEmpty", "error", "A computational-node provider must declare at least one named output.", "node", id, "implementation");
                } else for (const auto& outputEntry : *outputs) {
                    const auto& output = outputEntry.second;
                    const auto key = value(output, "key");
                    if (key.empty() || !isLowerCamelSymbol(key)) {
                        add(result, "nodeProviderOutputKeyInvalid", "error", "Provider output key must be lower camel case.", "node", id, "implementation");
                    } else if (!outputKeys.insert(key).second) {
                        add(result, "nodeProviderOutputKeyDuplicate", "error", "Provider output key \"" + key + "\" is duplicated.", "node", id, "implementation");
                    }
                    const auto outputStateId = value(output, "stateId");
                    if (!stateIds[id].contains(outputStateId)) {
                        add(result, "nodeProviderOutputMissing", "error", "Provider output must reference an existing local state.", "node", id, "implementation");
                    } else {
                        stateContributorCounts[outputStateId] += 1;
                        // A version 2 program's output means what its state's kind says (docs/proposals/programSdkV2.md): into an Update
                        // state it is the state's value, read at the update instant, setsValue or not.
                        const bool version2 = value(*implementation, "providerApiVersion") == "2";
                        const bool setsValue = value(output, "setsValue") == "true" || (version2 && declaredKind(outputStateId) == "update");
                        if (setsValue) programValueStateIds.insert(outputStateId);
                        else programRateCounts[outputStateId] += 1;
                        note(setsValue ? valueSources[outputStateId] : rateSources[outputStateId], value(node, "name") + "'s program");
                        if (setsValue && !version2) {
                            setsValueStateIds.insert(outputStateId);
                            // A setsValue output reading its own target state back through one of
                            // this provider's (shared, per-node not per-output) bindings would make
                            // it a hidden, substep-count-dependent recurrence rather than a genuine
                            // algebraic value -- exactly the same reasoning as an ordinary source
                            // term's own self-reference rejection above, just checked against a
                            // shared binding list instead of one expression's own bindings.
                            if (nodeProviderBindingStateIds.contains(outputStateId)) nodeProviderSelfReference = true;
                        }
                    }
                }
                if (nodeProviderSelfReference) {
                    add(result, "setsValueSelfReference", "error",
                        "A computational-node-provider output that sets its state's value directly may not also be one of that provider's own input bindings.",
                        "node", id, "implementation");
                }
            }
        }
    }

    // Another node's state, read through the step's synchronization snapshot as an edge reads it: it
    // must exist, on a node that is enabled (a disabled node's states are never allocated).
    for (const auto& [nodeId, stateId] : remoteNodeProviderBindings) {
        const auto owner = std::find_if(stateIds.begin(), stateIds.end(), [&](const auto& entry) { return entry.second.contains(stateId); });
        if (owner == stateIds.end()) {
            add(result, "providerBindingMissing", "error", "Provider binding references a missing state.", "node", nodeId, "implementation");
        } else if (disabledNodeIds.contains(owner->first)) {
            add(result, "providerBindingStateDisabled", "error", "Provider binding reads a state of a disabled node.", "node", nodeId, "implementation");
        }
    }

    result.edgeCount = edgesOptional->size();
    for (const auto& entry : *edgesOptional) {
        const auto& edge = entry.second;
        const auto id = value(edge, "id");
        registerId(id, "edge", id, "Relationship \"" + value(edge, "name") + "\"");
        const auto sourceNode = value(edge, "source.nodeId");
        const auto targetNode = value(edge, "target.nodeId");
        // Counts this edge's contribution(s) towards stateContributorCounts (see its declaration
        // above) for the setsValue "sole contributor" check -- a directed edge targets one state
        // (role/stateId); a bidirectional edge also reciprocates onto the other endpoint.
        const auto countEdgeContribution = [&](const std::string& role, const std::string& stateId) {
            if (stateId.empty()) return;
            // A single equation adds a rate, unless its state says it is an Update, when it is a value.
            stateContributorCounts[stateId] += 1;
            if (declaredKind(stateId) != "update") plainRateCounts[stateId] += 1;
            const auto edgeName = "relationship \"" + value(edge, "name") + "\"";
            note(declaredKind(stateId) == "update" ? valueSources[stateId] : rateSources[stateId], edgeName);
            if (value(edge, "directionality") != "bidirectional") return;
            const auto otherNodeId = role == "target" ? sourceNode : targetNode;
            const auto otherStateField = role == "target" ? "source.stateId" : "target.stateId";
            auto otherStateId = value(edge, otherStateField);
            if (otherStateId.empty()) otherStateId = firstStateIdOf(nodesById, otherNodeId);
            if (!otherStateId.empty()) {
                stateContributorCounts[otherStateId] += 1;
                if (declaredKind(otherStateId) != "update") plainRateCounts[otherStateId] += 1;
                note(declaredKind(otherStateId) == "update" ? valueSources[otherStateId] : rateSources[otherStateId], edgeName);
            }
        };
        // An edge is inert -- and its content unvalidated -- if it's disabled itself, or either
        // endpoint node is (an edge into a disabled node can't contribute to anything either,
        // exactly as if it had been deleted alongside that node).
        const bool edgeEnabled = value(edge, "enabled") != "false" &&
            !disabledNodeIds.contains(sourceNode) && !disabledNodeIds.contains(targetNode);
        if (edgeEnabled) {
            if (!stateIds.contains(sourceNode)) add(result, "edgeSourceMissing", "error", "Relationship source node no longer exists.", "edge", id, "source");
            if (!stateIds.contains(targetNode)) add(result, "edgeTargetMissing", "error", "Relationship target node no longer exists.", "edge", id, "target");
            if (!sourceNode.empty() && sourceNode == targetNode) add(result, "edgeSelfConnection", "error", "A relationship must connect two different nodes.", "edge", id, "target");
        }
        const auto sourceState = value(edge, "source.stateId");
        const auto targetState = value(edge, "target.stateId");
        if (edgeEnabled) {
            if (!sourceState.empty() && !stateIds[sourceNode].contains(sourceState)) add(result, "edgeSourceStateMissing", "error", "Relationship source state no longer exists.", "edge", id, "source");
            if (!targetState.empty() && !stateIds[targetNode].contains(targetState)) add(result, "edgeTargetStateMissing", "error", "Relationship target state no longer exists.", "edge", id, "target");
        }
        std::set<std::string> parameters;
        std::set<std::string> parameterIds;
        if (const auto parameterList = edge.get_child_optional("parameters")) for (const auto& parameterEntry : *parameterList) {
            const auto& parameter = parameterEntry.second;
            registerId(value(parameter, "id"), "edge", id, "Parameter \"" + value(parameter, "name") + "\"");
            parameterIds.insert(value(parameter, "id"));
            validateSharedLink(parameter, "edge", id, "parameters");
            if (!edgeEnabled) continue;
            const auto symbol = value(parameter, "symbol");
            if (!isLowerCamelSymbol(symbol)) add(result, "parameterSymbolInvalid", "error", "Parameter symbol must be lower camel case.", "edge", id, "parameters");
            else if (!parameters.insert(symbol).second) add(result, "parameterSymbolDuplicate", "error", "Parameter symbol \"" + symbol + "\" is duplicated.", "edge", id, "parameters");
            const auto mode = value(parameter, "mode");
            if (mode != "constant" && mode != "live") add(result, "parameterModeInvalid", "error", "Parameter mode must be constant or live.", "edge", id, "parameters");
            // Orthogonal to mode -- a parameter can be marked as a digital-twin fitting target
            // (its value is a candidate the optimizer varies) independent of whether it's also a
            // live-adjustable slider during a run. Presence of "tuning" is what marks it tunable.
            if (parameter.get_child_optional("tuning")) {
                const auto tuningMinimum = parameter.get_optional<double>("tuning.minimum");
                const auto tuningMaximum = parameter.get_optional<double>("tuning.maximum");
                const auto tuningInitialValue = parameter.get_optional<double>("value");
                if (!tuningMinimum || !tuningMaximum || !tuningInitialValue || !std::isfinite(*tuningMinimum) || !std::isfinite(*tuningMaximum) ||
                    !(*tuningMinimum < *tuningMaximum) || *tuningInitialValue < *tuningMinimum || *tuningInitialValue > *tuningMaximum) {
                    add(result, "parameterTuningInvalid", "error", "Tunable parameter fitting bounds require minimum < maximum and an initial value within the bounds.", "edge", id, "parameters");
                }
            }
            if (mode == "live" && parameter.get_child_optional("control")) {
                const auto minimum = parameter.get_optional<double>("control.minimum");
                const auto maximum = parameter.get_optional<double>("control.maximum");
                const auto step = parameter.get_optional<double>("control.step");
                const auto initialValue = parameter.get_optional<double>("value");
                if (!minimum || !maximum || !step || !initialValue || !std::isfinite(*minimum) || !std::isfinite(*maximum) ||
                    !std::isfinite(*step) || !std::isfinite(*initialValue) || !(*minimum < *maximum) || !(*step > 0) ||
                    *initialValue < *minimum || *initialValue > *maximum) {
                    add(result, "parameterControlInvalid", "error", "Live parameter slider settings require minimum < maximum, step > 0 and an initial value within the bounds.", "edge", id, "parameters");
                }
            }
        }
        if (!edgeEnabled) continue;
        // A relationship with several equations, each setting a state of one of its endpoints from
        // the bindings and the definitions (named intermediate quantities) before it.
        if (const auto outputs = edge.get_child_optional("equationModel.outputs")) {
            validateAlgebraicRelationship(result, edge, *outputs, stateIds, parameterIds, sourceNode, targetNode, id, relationshipStateIds);
            for (const auto& output : *outputs) {
                const auto stateId = value(output.second, "stateId");
                if (!stateId.empty()) note(valueSources[stateId], "relationship \"" + value(edge, "name") + "\"");
            }
            continue;
        }
        const auto implementation = edge.get_child_optional("implementation");
        const auto implementationKind = implementation ? value(*implementation, "kind") : "equation";
        if (implementationKind != "equation" && implementationKind != "cpp" && implementationKind != "python") {
            add(result, "providerKindInvalid", "error", "Relationship implementation kind must be equation, cpp or python.", "edge", id, "implementation");
        }
        if (implementationKind == "cpp" || implementationKind == "python") {
            checkProgramVersion(result, *implementation, implementationKind, "edge", id, "implementation");
            if (value(*implementation, "source").empty()) {
                add(result, "providerSourceEmpty", "error", "Programmable relationships require inline source.", "edge", id, "implementation");
            }
            // A relationship's provider need not read any bound value either (e.g. a constant
            // or purely time-based contribution), so zero bindings is not itself an error. It
            // only warrants a warning when the source still looks like the untouched, generated
            // template — a signal the author has not started implementing it — and that warning
            // clears as soon as real source is written, binding or not.
            std::set<std::string> providerKeys;
            const auto providerBindings = implementation->get_child_optional("bindings");
            const bool hasBindings = providerBindings && !providerBindings->empty();
            if (!hasBindings && value(*implementation, "source").find("TODO: read") != std::string::npos) {
                add(result, "providerImplementationIncomplete", "warning",
                    "This programmable relationship has no input bindings and still contains the generated template.",
                    "edge", id, "implementation");
            }
            if (providerBindings) for (const auto& bindingEntry : *providerBindings) {
                const auto& binding = bindingEntry.second;
                const auto key = value(binding, "key");
                if (!isLowerCamelSymbol(key)) {
                    add(result, "providerBindingKeyInvalid", "error", "Provider input keys must be lower camel case.", "edge", id, "implementation");
                } else if (!providerKeys.insert(key).second) {
                    add(result, "providerBindingKeyDuplicate", "error", "Provider input key \"" + key + "\" is duplicated.", "edge", id, "implementation");
                }
                if (value(binding, "kind") == "parameter") {
                    if (!parameterIds.contains(value(binding, "parameterId"))) {
                        add(result, "providerBindingMissing", "error", "Provider binding references a missing parameter.", "edge", id, "implementation");
                    }
                } else if (value(binding, "kind") == "state") {
                    const auto bindingNode = value(binding, "nodeId");
                    const auto states = stateIds.find(bindingNode);
                    if ((bindingNode != sourceNode && bindingNode != targetNode) || states == stateIds.end() ||
                        !states->second.contains(value(binding, "stateId"))) {
                        add(result, "providerBindingMissing", "error", "Provider binding references a missing endpoint state.", "edge", id, "implementation");
                    }
                } else {
                    add(result, "providerBindingKindInvalid", "error", "Provider binding kind must be state or parameter.", "edge", id, "implementation");
                }
            }
            // A program with several outputs (implementation.outputs): each checked as the one output is, for a version 2 program on a
            // one-way relationship.
            if (const auto outputs = implementation->get_child_optional("outputs"); outputs && !outputs->empty()) {
                if (value(*implementation, "providerApiVersion") != "2") {
                    add(result, "programOutputsUnsupported", "error", "Only a program in the current program format can give a relationship several outputs.", "edge", id, "implementation");
                }
                if (value(edge, "directionality") == "bidirectional") {
                    add(result, "programOutputsUnsupported", "error", "A two-way relationship gives one output, which reaches both ends; give a program with several outputs a one-way relationship.", "edge", id, "implementation");
                }
                std::set<std::string> outputKeys;
                for (const auto& outputItem : *outputs) {
                    boost::property_tree::ptree single;
                    single.add_child("output", outputItem.second);
                    validateProviderOutput(result, single, stateIds, sourceNode, targetNode, id);
                    if (!outputKeys.insert(value(outputItem.second, "key")).second) {
                        add(result, "providerOutputKeyDuplicate", "error", "Provider output key \"" + value(outputItem.second, "key") + "\" is duplicated.", "edge", id, "implementation");
                    }
                    countEdgeContribution(value(outputItem.second, "role"), value(outputItem.second, "stateId"));
                }
                continue;
            }
            validateProviderOutput(result, *implementation, stateIds, sourceNode, targetNode, id);
            countEdgeContribution(value(*implementation, "output.role"), value(*implementation, "output.stateId"));
            continue;
        }
        if (const auto bindings = edge.get_child_optional("equationModel.bindings")) for (const auto& bindingEntry : *bindings) {
            const auto& binding = bindingEntry.second;
            if (value(binding, "kind") == "parameter") {
                if (!parameterIds.contains(value(binding, "parameterId"))) add(result, "edgeBindingMissing", "error", "Equation binding references a missing parameter.", "edge", id, "equation");
            } else if (value(binding, "kind") == "time") {
                // Simulation time -- always available, nothing to resolve.
            } else {
                const auto bindingNode = value(binding, "nodeId");
                if ((bindingNode != sourceNode && bindingNode != targetNode) || !stateIds[bindingNode].contains(value(binding, "stateId"))) {
                    add(result, "edgeBindingMissing", "error", "Equation binding references a missing endpoint state.", "edge", id, "equation");
                }
            }
        }
        const auto latex = value(edge, "equationModel.latex").empty() ? value(edge, "equation") : value(edge, "equationModel.latex");
        if (latex.empty()) add(result, "edgeEquationEmpty", "error", "Relationship requires an equation.", "edge", id, "equation");
        else if (nodesById.contains(sourceNode) && nodesById.contains(targetNode)) {
            auto errors = equationErrors(edge, *nodesById[sourceNode], *nodesById[targetNode]);
            const auto mathJson = edge.get_child_optional("equationModel.mathJson");
            if (!mathJson) errors.push_back("Equation requires a valid executable expression.");
            else {
                std::set<std::string> executableSymbols;
                if (const auto bindings = edge.get_child_optional("equationModel.bindings")) {
                    for (const auto& binding : *bindings) executableSymbols.insert(value(binding.second, "symbol"));
                }
                validateMathJson(*mathJson, executableSymbols, errors);
            }
            if (!errors.empty()) {
                std::ostringstream message;
                for (std::size_t index = 0; index < errors.size(); ++index) message << (index ? " " : "") << errors[index];
                add(result, "edgeEquationInvalid", "error", message.str(), "edge", id, "equation");
            }
        }
        const auto outputState = value(edge, "equationModel.output.stateId");
        if (!outputState.empty()) {
            const auto role = value(edge, "equationModel.output.role");
            if (role != "source" && role != "target") add(result, "edgeOutputMissing", "error", "Equation output role must be source or target.", "edge", id, "output");
            const auto& candidates = role == "source" ? stateIds[sourceNode] : stateIds[targetNode];
            if (!candidates.contains(outputState)) add(result, "edgeOutputMissing", "error", "Choose an existing state updated by this equation.", "edge", id, "output");
            countEdgeContribution(role, outputState);
        } else if (targetState.empty()) {
            add(result, "edgeOutputMissing", "error", "Choose the state updated by this equation.", "edge", id, "output");
        }
    }
    // What a state is against what reaches it (docs/proposals/ratesAndUpdates.md). A state is an Update when it says so,
    // or, saying nothing, when a setsValue source term or a relationship's several equations set it; what sets an Update
    // is summed. A program's setsValue output is the program's alone: it reports where the program got to.
    const auto label = [&](const std::string& stateId) { return stateLabels.contains(stateId) ? stateLabels.at(stateId) : stateId; };
    const auto owner = [&](const std::string& stateId) { return stateOwners.contains(stateId) ? stateOwners.at(stateId) : std::string{}; };
    // "A", "A and B", "A, B and C", "A, B, C and 2 others".
    const auto list = [](const std::vector<std::string>& names) {
        std::string text;
        const std::size_t shown = std::min<std::size_t>(names.size(), 3);
        for (std::size_t index = 0; index < shown; ++index) {
            if (index) text += index + 1 == shown && shown == names.size() ? " and " : ", ";
            text += names[index];
        }
        if (shown < names.size()) text += " and " + std::to_string(names.size() - shown) + (names.size() - shown == 1 ? " other" : " others");
        return text;
    };
    std::set<std::string> checked;
    for (const auto* setters : {&termValueStateIds, &relationshipStateIds, &programValueStateIds}) {
        for (const auto& stateId : *setters) {
            if (declaredKind(stateId) != "rate" || !checked.insert(stateId).second) continue;
            const auto& setBy = valueSources[stateId];
            const auto who = setBy.empty() ? std::string("something") : list(setBy);
            add(result, "valueIntoRateState", "error", label(stateId) + " is a rate: it changes by what is added to it over each step. "
                "But " + who + (setBy.size() == 1 ? " sets" : " set") + " its value. Make it an update, so its value is set after "
                "each step, or make " + (setBy.size() == 1 ? "that" : "those") + " add a rate instead.", "node", owner(stateId), "states");
        }
    }
    std::set<std::string> updates(termValueStateIds.begin(), termValueStateIds.end());
    updates.insert(relationshipStateIds.begin(), relationshipStateIds.end());
    for (const auto& [stateId, kind] : declaredKinds) if (kind == "update") updates.insert(stateId);
    for (const auto& stateId : updates) {
        if (declaredKind(stateId) == "rate") continue;
        // Into a state that says it is an Update only a program's rate is a rate; into one that is an Update only because
        // something sets it, any term that does not say it sets a value is.
        const auto rates = declaredKind(stateId) == "update" ? programRateCounts[stateId] : plainRateCounts[stateId] + programRateCounts[stateId];
        if (rates > 0) {
            const auto& addedBy = rateSources[stateId];
            const auto& setBy = valueSources[stateId];
            const auto why = declaredKind(stateId) == "update" || setBy.empty() ? std::string(": its value is set after each step")
                : std::string(", because ") + list(setBy) + (setBy.size() == 1 ? " sets" : " set") + " its value after each step";
            const auto who = addedBy.empty() ? std::string("something") : list(addedBy);
            add(result, "rateIntoUpdateState", "error", label(stateId) + " is an update" + why + ". But " + who +
                (addedBy.size() == 1 ? " adds" : " add") + " a rate to it, and an update has no rate to add to. Make " +
                (addedBy.size() == 1 ? "that" : "those") + " set a value too, or give the rate to a state that is a rate.",
                "node", owner(stateId), "states");
        }
    }
    // The plan compiled here, if any, serves the stability pass below too: compiling a large model takes seconds.
    std::shared_ptr<const ExecutionPlan> compiledPlan;
    // Whether a Verlet node's rates split into its two parts is known once its terms and relationships are compiled.
    bool hasVerletNode = false;
    if (const auto nodes = document.get_child_optional("nodes")) for (const auto& nodeItem : *nodes) {
        if (value(nodeItem.second, "enabled") != "false" && value(nodeItem.second, "numerics.integration") == "verlet") hasVerletNode = true;
    }
    if ((!relationshipStateIds.empty() || hasVerletNode) && std::none_of(result.issues.begin(), result.issues.end(), [](const auto& item) { return item.severity == "error"; })) {
        try {
            compiledPlan = std::make_shared<const ExecutionPlan>(compileExecutionPlan(document));
        } catch (const VerletStructureError& error) {
            add(result, "nodeIntegrationInvalid", "error", error.what(), "node", std::to_string(error.nodeId), "numerics");
        } catch (const std::exception& error) {
            add(result, "modelCompileFailed", "error", error.what(), "model", "");
        }
    }
    // A program's setsValue output is where the program got to: nothing else can set or add to that state.
    for (const auto& stateId : programValueStateIds) {
        if (stateContributorCounts[stateId] <= 1 && !relationshipStateIds.contains(stateId)) continue;
        add(result, "setsValueNotSoleContributor", "error",
            label(stateId) + " is set by its node's program after each step, so nothing else can reach it.", "node", owner(stateId), "states");
    }
    // Pre-run phase of docs/proposals/numericalStabilityDiagnostics.md: a local, linearized
    // Explicit Euler stability check per node, against the active run configuration's step size.
    // Only attempted once every structural check above has already run, and only when there is a
    // concrete step size to check against (see activeGlobalTimeStep's own comment). It needs a
    // compiled ExecutionPlan, the one the relationship check above compiled if it did: assessNodeStability needs the
    // same resolved bindings, parameters and dependency ordering compileExecutionPlan produces, and reproducing that
    // logic against the ptree directly would duplicate it rather than reuse it. The plan goes back with a valid result
    // so the run can take it too. A document that fails to compile for any
    // reason (most already reported above as a distinct error, a few not) is caught and simply
    // skipped here -- this pass is a heuristic addition, never the reason a document is invalid.
    const auto validSoFar = std::none_of(result.issues.begin(), result.issues.end(), [](const auto& item) { return item.severity == "error"; });
    if (activeGlobalTimeStep && validSoFar) {
        try {
            if (!compiledPlan) compiledPlan = std::make_shared<const ExecutionPlan>(compileExecutionPlan(document));
            const auto& plan = *compiledPlan;
            if (activeIntegration.method != IntegrationMethod::nodeByNode) {
                addWholeModelStability(result, document, plan, *activeGlobalTimeStep, activeIntegration);
            }
            std::optional<DocumentEntities> entities;
            if (activeIntegration.method == IntegrationMethod::nodeByNode) for (const auto& node : plan.nodes) {
                const auto assessment = assessNodeStability(node, plan.initialStates, *activeGlobalTimeStep, plan.algebraicStateIndexes);
                if (!assessment) continue;
                const auto nodeId = std::to_string(assessment->nodeId);
                if (!entities) entities.emplace(document);
                if (!assessment->stable) {
                    const auto resolved = assessment->dominantParameter
                        ? resolveAttributedParameter(*entities, *assessment->dominantParameter) : std::nullopt;
                    std::ostringstream message;
                    message << "This node's dynamics may be unstable at its current substep count (amplification factor "
                            << assessment->maxAmplificationFactor << " > 1 per global step)";
                    if (resolved) message << " -- driven mainly by " << resolved->phrase;
                    const auto symbol = stateSymbol(*entities, assessment->dominantStateId);
                    if (assessment->undampedOscillation) {
                        // An undamped oscillation, not a growing mode (docs/proposals/integrators.md, decision 1): a fix is one click
                        // away, on this warning and on the node's Numerics tab. Its own code, so the app can offer it.
                        std::ostringstream plain;
                        plain << "This node oscillates without damping"
                              << (symbol.empty() ? "" : " ('" + symbol + "' swings back and forth)")
                              << ", and Explicit Euler makes an undamped oscillation grow at every step size, however many substeps "
                              << "it has: in the oscillator benchmark its energy grows about nine million-fold over 1024 s. Semi-implicit "
                              << "Euler keeps that energy within 1 %: use semi-implicit for this node (Numerics tab, Integration).";
                        add(result, "numericsUndampedOscillation", "warning", plain.str(), "node", nodeId, "numerics");
                        continue;
                    }
                    if (assessment->unconditionallyUnstable) {
                        message << " -- no substep count can stabilize this with " << (node.verlet ? "Verlet" : "Explicit Euler") << " ("
                                << (symbol.empty() ? "its dominant state" : "'" + symbol + "'") << " has a genuinely growing mode) "
                                << "-- this looks like a modeling or gain-tuning issue rather than a numerics one; check whether "
                                << "this dynamics is intentionally unstable before adjusting numerics.";
                    } else {
                        // In the words of the node's card: its Numerics tab's "Substeps per global step", and a state whose equation sets its
                        // value (an Update) rather than how fast it changes.
                        message << " -- give it at least " << *assessment->requiredSubsteps
                                << " substeps (Numerics tab, Substeps per global step)";
                        if (!symbol.empty()) message << " ('" << symbol << "' needs that many to stabilize)";
                        message << ", make " << (symbol.empty() ? "a fast state" : "'" + symbol + "'") << " an Update, or move "
                                << (symbol.empty() ? "fast dynamics" : "its dynamics") << " onto a node of their own.";
                    }
                    auto& issue = add(result, "numericsPotentiallyUnstable", "warning", message.str(), "node", nodeId, "numerics");
                    if (resolved) issue.attributedParameter = resolved->location;
                } else if (assessment->stiffnessRatio && *assessment->stiffnessRatio > 1000) {
                    std::ostringstream message;
                    message << "This node is stable but stiff (fastest/slowest rate ratio " << *assessment->stiffnessRatio
                            << ") -- one state's dynamics are much faster than another's on the same node, forcing a smaller "
                            << "step than the slower dynamics alone would need.";
                    add(result, "numericsStiffModel", "warning", message.str(), "node", nodeId, "numerics");
                }
            }
        } catch (const std::exception&) {
            // Some other, already-reported structural problem (or a genuinely uncompilable
            // document this pass has no business diagnosing) -- nothing to add here.
        }
    }
    // A ring of Updates in settling nodes is valid, and swept each step until it settles or reaches its limit: said here, once
    // per ring, so its cost, and a ring that never settles, are no surprise when the run warns.
    const bool hasUpdates = !termValueStateIds.empty() || !relationshipStateIds.empty() ||
        std::any_of(declaredKinds.begin(), declaredKinds.end(), [](const auto& entry) { return entry.second == "update"; });
    if (hasUpdates && std::none_of(result.issues.begin(), result.issues.end(), [](const auto& item) { return item.severity == "error"; })) {
        try {
            if (!compiledPlan) compiledPlan = std::make_shared<const ExecutionPlan>(compileExecutionPlan(document));
            for (const auto& group : compiledPlan->settleGroups) {
                if (!group.ring) continue;
                std::vector<std::string> names;
                std::string firstState;
                for (const auto stepIndex : group.steps) {
                    const auto stateId = std::to_string(compiledPlan->stateIds.at(compiledPlan->updateSteps.at(stepIndex).writes));
                    if (firstState.empty()) firstState = stateId;
                    const auto name = label(stateId);
                    if (std::find(names.begin(), names.end(), name) == names.end()) names.push_back(name);
                }
                add(result, "updatesRing", "warning", "These values are set from each other in a ring: " + list(names) + ". Their nodes "
                    "settle within the step, so each step the ring is worked out again and again until it settles, up to " +
                    std::to_string(group.limit) + " times. If it has no settled value the run carries on and says so. To have the ring "
                    "go round once a step instead, let its nodes update once per step.", "node", owner(firstState), "numerics");
            }
        } catch (const std::exception&) {
            // Reported above, or not this check's to report.
        }
    }
    result.valid = std::none_of(result.issues.begin(), result.issues.end(), [](const auto& item) { return item.severity == "error"; });
    if (result.valid) result.plan = std::move(compiledPlan);
    return result;
}


namespace {
bool isAsciiLetter(char character) { return (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z'); }
bool isAsciiDigit(char character) { return character >= '0' && character <= '9'; }

// At `at`, `opening` (as "\\begin{") then one or more name characters (letters, and '*' when `star`) then '}': where the name
// starts and ends (the '}' is at its end), or nothing.
std::optional<std::pair<std::size_t, std::size_t>> bracedName(const std::string& text, std::size_t at, std::string_view opening, bool star) {
    if (text.compare(at, opening.size(), opening) != 0) return std::nullopt;
    const auto start = at + opening.size();
    auto end = start;
    while (end < text.size() && (isAsciiLetter(text[end]) || (star && text[end] == '*'))) ++end;
    if (end == start || end >= text.size() || text[end] != '}') return std::nullopt;
    return std::pair{start, end};
}
}

std::vector<std::string> latexTextErrors(const std::string& latex, const std::set<std::string>& knownSymbols) {
    std::vector<std::string> errors;
    // Environments: \begin{name}, each one but cases.
    for (std::size_t at = 0; at < latex.size();) {
        if (const auto name = bracedName(latex, at, "\\begin{", true)) {
            const auto environment = latex.substr(name->first, name->second - name->first);
            if (environment != "cases") errors.push_back("Unsupported LaTeX environment: " + environment + ".");
            at = name->second + 1;
        } else {
            ++at;
        }
    }

    // \operatorname{Word} is standard LaTeX for an unfamiliar function name -- a common shape for AI-generated equations even when
    // the prompt is steered toward the shorter \max/\min form. Accept it when Word names a real operator (case-insensitively) and take
    // the whole construct out before the general command and identifier scans below, so neither "operatorname" nor the operator word
    // itself is flagged again by those broader, name-agnostic checks.
    static const std::set<std::string> operatorNames = {"abs", "cos", "exp", "ln", "log", "max", "min", "negate", "sin", "tan"};
    std::string withoutOperatorname;
    withoutOperatorname.reserve(latex.size());
    for (std::size_t at = 0; at < latex.size();) {
        if (const auto name = bracedName(latex, at, "\\operatorname{", false)) {
            const auto word = latex.substr(name->first, name->second - name->first);
            auto lower = word;
            std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            if (!operatorNames.contains(lower)) errors.push_back("\\operatorname{} does not name a supported function: " + word + ".");
            withoutOperatorname += ' ';
            at = name->second + 1;
        } else {
            withoutOperatorname += latex[at++];
        }
    }
    // Take out the cases environment's markers and \text{...} labels ("if", "otherwise") so their words are not scanned as commands or
    // symbols below.
    std::string withoutMarkup;
    withoutMarkup.reserve(withoutOperatorname.size());
    for (std::size_t at = 0; at < withoutOperatorname.size();) {
        auto marker = bracedName(withoutOperatorname, at, "\\begin{", true);
        if (!marker) marker = bracedName(withoutOperatorname, at, "\\end{", true);
        if (marker) {
            withoutMarkup += ' ';
            at = marker->second + 1;
            continue;
        }
        if (withoutOperatorname.compare(at, 6, "\\text{") == 0) {
            const auto close = withoutOperatorname.find('}', at + 6);
            if (close != std::string::npos) {
                withoutMarkup += ' ';
                at = close + 1;
                continue;
            }
        }
        withoutMarkup += withoutOperatorname[at++];
    }

    // Commands: a backslash and the letters after it. Each unsupported one is named, as often as it appears; then each is taken out,
    // its arguments left, so both plain symbols and symbols written \mathrm{symbol} are checked.
    static const std::set<std::string> supportedCommands = {
        "cdot", "cos", "exp", "frac", "left", "ln", "log", "max", "min", "mathrm", "right", "sin", "sqrt", "tan",
        // cases conditions
        "ge", "geq", "gt", "land", "le", "leq", "lnot", "lor", "lt", "ne", "neg", "neq", "vee", "wedge"
    };
    std::string withoutCommands;
    withoutCommands.reserve(withoutMarkup.size());
    for (std::size_t at = 0; at < withoutMarkup.size();) {
        if (withoutMarkup[at] == '\\' && at + 1 < withoutMarkup.size() && isAsciiLetter(withoutMarkup[at + 1])) {
            auto end = at + 1;
            while (end < withoutMarkup.size() && isAsciiLetter(withoutMarkup[end])) ++end;
            const auto command = withoutMarkup.substr(at + 1, end - at - 1);
            if (!supportedCommands.contains(command)) errors.push_back("Unsupported LaTeX command: \\" + command + ".");
            withoutCommands += ' ';
            at = end;
        } else {
            withoutCommands += withoutMarkup[at++];
        }
    }

    // Identifiers: a letter, then letters and digits.
    std::set<std::string> unknownSymbols;
    for (std::size_t at = 0; at < withoutCommands.size();) {
        if (!isAsciiLetter(withoutCommands[at])) {
            ++at;
            continue;
        }
        auto end = at + 1;
        while (end < withoutCommands.size() && (isAsciiLetter(withoutCommands[end]) || isAsciiDigit(withoutCommands[end]))) ++end;
        auto symbol = withoutCommands.substr(at, end - at);
        if (!knownSymbols.contains(symbol)) unknownSymbols.insert(std::move(symbol));
        at = end;
    }
    for (const auto& symbol : unknownSymbols) errors.push_back("Unknown symbol: " + symbol + ".");
    return errors;
}

bool isEntityId(const std::string& text) {
    if (text.empty() || text.size() > 16 || text[0] < '1' || text[0] > '9') return false;
    return std::all_of(text.begin(), text.end(), isAsciiDigit);
}

bool isLowerCamelSymbol(const std::string& text) {
    if (text.empty() || text[0] < 'a' || text[0] > 'z') return false;
    return std::all_of(text.begin(), text.end(), [](char c) { return isAsciiLetter(c) || isAsciiDigit(c); });
}

bool isDefinitionSymbol(const std::string& text) {
    if (text.empty() || !isAsciiLetter(text[0])) return false;
    return std::all_of(text.begin(), text.end(), [](char c) { return isAsciiLetter(c) || isAsciiDigit(c) || c == '_'; });
}

}
