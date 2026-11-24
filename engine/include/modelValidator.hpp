/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <boost/property_tree/ptree.hpp>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace konjugate {

struct IssueLocation {
    std::string kind = "model";
    std::string entityId;
    std::string field;
};

// A precise "click straight to this parameter" navigation target -- see
// protocol/engineProtocol.proto's IssueAttributedParameterReport, which this mirrors field for
// field, for why this is separate from (and additional to) ValidationIssue::location.
struct AttributedParameter {
    std::string kind;        // "edge" or "sourceTerm"
    std::string ownerId;     // the edge id or source-term id, as a string
    std::string parameterId;
};

struct ValidationIssue {
    std::string code;
    std::string severity;
    std::string message;
    IssueLocation location;
    std::optional<AttributedParameter> attributedParameter;
};

struct ExecutionPlan;

struct ValidationResult {
    bool valid = true;
    std::size_t nodeCount = 0;
    std::size_t edgeCount = 0;
    std::vector<ValidationIssue> issues;
    // The model's execution plan, when validation compiled it and found the model valid: a run of the same document
    // can take it rather than compile the model again, which for a large model takes seconds.
    std::shared_ptr<const ExecutionPlan> plan;
};

ValidationResult validateModel(const boost::property_tree::ptree& document);

// What a relationship equation's LaTeX text gives against the symbols it may name, in this order: each environment but cases
// ("Unsupported LaTeX environment: X."), each \operatorname{X} that names no supported function, each command not supported once
// \operatorname{...}, cases markup and \text{...} are taken out, and then, once commands are taken out too, each identifier (a letter,
// then letters and digits) not in `knownSymbols`, once each and sorted ("Unknown symbol: x."). A plain scan of the text, which
// std::regex made the larger part of validating a model with many relationships.
std::vector<std::string> latexTextErrors(const std::string& latex, const std::set<std::string>& knownSymbols);

// The validator's name rules, checked by hand for the same reason: an entity id is 1 to 16 digits not starting with 0; a symbol,
// and a provider's input or output key, is a lower-case letter then letters and digits; a definition's symbol is a letter then
// letters, digits and underscores.
bool isEntityId(const std::string& text);
bool isLowerCamelSymbol(const std::string& text);
bool isDefinitionSymbol(const std::string& text);

}
