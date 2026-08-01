/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <boost/property_tree/ptree.hpp>
#include <string>
#include <vector>

namespace konjugate {

struct IssueLocation {
    std::string kind = "model";
    std::string entityId;
    std::string field;
};

struct ValidationIssue {
    std::string code;
    std::string severity;
    std::string message;
    IssueLocation location;
};

struct ValidationResult {
    bool valid = true;
    std::size_t nodeCount = 0;
    std::size_t edgeCount = 0;
    std::vector<ValidationIssue> issues;
};

ValidationResult validateModel(const boost::property_tree::ptree& document);

}
