/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <boost/property_tree/ptree.hpp>
#include <optional>
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

struct ValidationResult {
    bool valid = true;
    std::size_t nodeCount = 0;
    std::size_t edgeCount = 0;
    std::vector<ValidationIssue> issues;
};

ValidationResult validateModel(const boost::property_tree::ptree& document);

}
