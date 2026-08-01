/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "modelValidator.hpp"
#include <cmath>
#include <regex>
#include <cstdlib>
#include <set>
#include <sstream>
#include <stdexcept>
#include <unordered_map>

namespace konjugate {
namespace {
const std::regex uuidPattern("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$");
const std::regex symbolPattern("^[a-z][A-Za-z0-9]*$");

void add(ValidationResult& result, std::string code, std::string severity, std::string message,
         std::string kind = "model", std::string entityId = {}, std::string field = {}) {
    result.issues.push_back({std::move(code), std::move(severity), std::move(message), {std::move(kind), std::move(entityId), std::move(field)}});
}

std::string value(const boost::property_tree::ptree& tree, const std::string& key) {
    return tree.get<std::string>(key, "");
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

void validateMathJson(const boost::property_tree::ptree& expression,
                      const std::set<std::string>& symbols,
                      std::vector<std::string>& errors) {
    if (expression.empty()) {
        const auto token = expression.data();
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
    const std::set<std::string> unary = {"Abs", "Cos", "Exp", "Ln", "Log", "Negate", "Sin", "Sqrt", "Tan"};
    const std::set<std::string> binary = {"Divide", "Max", "Min", "Power"};
    if ((!unary.contains(operation) && !binary.contains(operation) && operation != "Add" && operation != "Multiply") ||
        (unary.contains(operation) && items.size() != 2) || (binary.contains(operation) && items.size() != 3) ||
        ((operation == "Add" || operation == "Multiply") && items.size() < 3)) {
        errors.push_back("Unsupported or malformed executable operation: " + operation + ".");
        return;
    }
    for (std::size_t index = 1; index < items.size(); ++index) validateMathJson(*items[index], symbols, errors);
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
    if (latex.find('=') != std::string::npos) errors.push_back("Assignments are not supported in relationship expressions.");

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

    const std::set<std::string> supportedCommands = {
        "cdot", "cos", "exp", "frac", "left", "ln", "log", "max", "min", "mathrm", "right", "sin", "sqrt", "tan"
    };
    const std::regex commandExpression(R"(\\([A-Za-z]+))");
    for (auto match = std::sregex_iterator(latex.begin(), latex.end(), commandExpression); match != std::sregex_iterator(); ++match) {
        const auto command = (*match)[1].str();
        if (!supportedCommands.contains(command)) errors.push_back("Unsupported LaTeX command: \\" + command + ".");
    }

    // Remove command names before scanning identifiers. Their arguments remain,
    // so both plain symbols and symbols rendered as \mathrm{symbol} are checked.
    const auto expressionWithoutCommands = std::regex_replace(latex, commandExpression, " ");
    const std::regex identifierExpression(R"([A-Za-z][A-Za-z0-9]*)");
    std::set<std::string> unknownSymbols;
    for (auto match = std::sregex_iterator(expressionWithoutCommands.begin(), expressionWithoutCommands.end(), identifierExpression);
         match != std::sregex_iterator(); ++match) {
        const auto symbol = match->str();
        if (!knownSymbols.contains(symbol)) unknownSymbols.insert(symbol);
    }
    for (const auto& symbol : unknownSymbols) errors.push_back("Unknown symbol: " + symbol + ".");
    return errors;
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
        add(result, "invalidDocument", "error", "The project must contain node and edge arrays.");
        result.valid = false;
        return result;
    }

    std::set<std::string> allIds;
    std::unordered_map<std::string, std::set<std::string>> stateIds;
    std::unordered_map<std::string, std::set<std::string>> stateSymbols;
    std::unordered_map<std::string, const boost::property_tree::ptree*> nodesById;
    auto registerId = [&](const std::string& id, const std::string& kind, const std::string& entityId, const std::string& label) {
        if (!std::regex_match(id, uuidPattern)) add(result, "invalidUuid", "error", label + " does not have a valid UUID.", kind, entityId, "id");
        else if (!allIds.insert(id).second) add(result, "duplicateUuid", "error", label + " reuses an existing UUID.", kind, entityId, "id");
    };

    std::set<std::string> runConfigurationIds;
    if (const auto configurations = document.get_child_optional("runConfigurations")) {
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
            } catch (...) {
                add(result, "runConfigurationInvalid", "error", "Numerical configuration values must be finite and positive; output interval must be an integer multiple of the global timestep.", "runConfiguration", configurationId, "numerics");
            }
        }
        if (!configurations->empty() && !runConfigurationIds.contains(value(document, "activeRunConfigurationId"))) {
            add(result, "activeRunConfigurationMissing", "error", "Choose an existing active run configuration.", "model", {}, "runConfigurations");
        }
    }

    result.nodeCount = nodesOptional->size();
    if (!result.nodeCount) add(result, "emptyModel", "warning", "Add at least one node to begin building a model.");
    for (const auto& entry : *nodesOptional) {
        const auto& node = entry.second;
        const auto id = value(node, "id");
        const auto name = value(node, "name");
        registerId(id, "node", id, "Node \"" + (name.empty() ? std::string("Untitled") : name) + "\"");
        nodesById[id] = &node;
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
        const auto states = node.get_child_optional("states");
        if (!states || states->empty()) add(result, "nodeStatesEmpty", "warning", "This node has no state variables.", "node", id, "states");
        if (states) for (const auto& stateEntry : *states) {
            const auto& state = stateEntry.second;
            const auto stateId = value(state, "id");
            const auto symbol = value(state, "symbol");
            registerId(stateId, "node", id, "State \"" + value(state, "name") + "\"");
            stateIds[id].insert(stateId);
            if (!std::regex_match(symbol, symbolPattern)) add(result, "stateSymbolInvalid", "error", "State symbol must be lower camel case.", "node", id, "states");
            else if (!stateSymbols[id].insert(symbol).second) add(result, "stateSymbolDuplicate", "error", "State symbol \"" + symbol + "\" is duplicated in this node.", "node", id, "states");
        }
        if (const auto terms = node.get_child_optional("sourceTerms")) for (const auto& termEntry : *terms) {
            const auto& term = termEntry.second;
            registerId(value(term, "id"), "node", id, "Source term");
            const auto state = value(term, "state");
            if (!stateSymbols[id].contains(state)) add(result, "sourceStateMissing", "error", "Source term references a missing state.", "node", id, "sourceTerms");
            if (value(term, "expression").empty()) add(result, "sourceExpressionEmpty", "error", "Source term requires an expression.", "node", id, "sourceTerms");
            const auto mathJson = term.get_child_optional("expressionModel.mathJson");
            if (!mathJson) add(result, "sourceExpressionInvalid", "error", "Source term requires a valid executable expression.", "node", id, "sourceTerms");
            else {
                std::set<std::string> executableSymbols;
                if (const auto bindings = term.get_child_optional("expressionModel.bindings")) {
                    for (const auto& binding : *bindings) {
                        executableSymbols.insert(value(binding.second, "symbol"));
                        if (!stateIds[id].contains(value(binding.second, "stateId"))) {
                            add(result, "sourceBindingMissing", "error", "Source term binding references a missing local state.", "node", id, "sourceTerms");
                        }
                    }
                }
                std::vector<std::string> errors;
                validateMathJson(*mathJson, executableSymbols, errors);
                if (!errors.empty()) add(result, "sourceExpressionInvalid", "error", errors.front(), "node", id, "sourceTerms");
            }
            if (!stateIds[id].contains(value(term, "expressionModel.output.stateId"))) {
                add(result, "sourceOutputMissing", "error", "Source term requires an existing output state.", "node", id, "sourceTerms");
            }
        }
    }

    result.edgeCount = edgesOptional->size();
    for (const auto& entry : *edgesOptional) {
        const auto& edge = entry.second;
        const auto id = value(edge, "id");
        registerId(id, "edge", id, "Relationship \"" + value(edge, "name") + "\"");
        const auto sourceNode = value(edge, "source.nodeId");
        const auto targetNode = value(edge, "target.nodeId");
        if (!stateIds.contains(sourceNode)) add(result, "edgeSourceMissing", "error", "Relationship source node no longer exists.", "edge", id, "source");
        if (!stateIds.contains(targetNode)) add(result, "edgeTargetMissing", "error", "Relationship target node no longer exists.", "edge", id, "target");
        if (!sourceNode.empty() && sourceNode == targetNode) add(result, "edgeSelfConnection", "error", "A relationship must connect two different nodes.", "edge", id, "target");
        const auto sourceState = value(edge, "source.stateId");
        const auto targetState = value(edge, "target.stateId");
        if (!sourceState.empty() && !stateIds[sourceNode].contains(sourceState)) add(result, "edgeSourceStateMissing", "error", "Relationship source state no longer exists.", "edge", id, "source");
        if (!targetState.empty() && !stateIds[targetNode].contains(targetState)) add(result, "edgeTargetStateMissing", "error", "Relationship target state no longer exists.", "edge", id, "target");
        std::set<std::string> parameters;
        std::set<std::string> parameterIds;
        if (const auto parameterList = edge.get_child_optional("parameters")) for (const auto& parameterEntry : *parameterList) {
            const auto& parameter = parameterEntry.second;
            registerId(value(parameter, "id"), "edge", id, "Parameter \"" + value(parameter, "name") + "\"");
            const auto symbol = value(parameter, "symbol");
            parameterIds.insert(value(parameter, "id"));
            if (!std::regex_match(symbol, symbolPattern)) add(result, "parameterSymbolInvalid", "error", "Parameter symbol must be lower camel case.", "edge", id, "parameters");
            else if (!parameters.insert(symbol).second) add(result, "parameterSymbolDuplicate", "error", "Parameter symbol \"" + symbol + "\" is duplicated.", "edge", id, "parameters");
        }
        if (const auto bindings = edge.get_child_optional("equationModel.bindings")) for (const auto& bindingEntry : *bindings) {
            const auto& binding = bindingEntry.second;
            if (value(binding, "kind") == "parameter") {
                if (!parameterIds.contains(value(binding, "parameterId"))) add(result, "edgeBindingMissing", "error", "Equation binding references a missing parameter.", "edge", id, "equation");
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
        } else if (targetState.empty()) {
            add(result, "edgeOutputMissing", "error", "Choose the state updated by this equation.", "edge", id, "output");
        }
    }
    result.valid = std::none_of(result.issues.begin(), result.issues.end(), [](const auto& item) { return item.severity == "error"; });
    return result;
}

}
