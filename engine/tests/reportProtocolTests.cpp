/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Round-trip tests for the report writers that had no coverage of their own report-writing logic
// before this file existed: writeInferenceReport() (causalInferenceReport.cpp) and
// writeValidationReport()/writeInspectionReport() (validationReport.cpp). writeFittingReport()'s
// equivalent coverage lives in parameterFittingTests.cpp instead, alongside the recovery tests
// that already exercise it end to end. These construct the report structs directly (not through
// inferGraph()/validateModel()) -- what's being tested here is specifically "does the writer
// serialize a given struct correctly", not the inference/validation logic itself, which already
// has its own dedicated test coverage elsewhere.

#include "causalInferenceReport.hpp"
#include "engineProtocol.pb.h"
#include "validationReport.hpp"
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>

namespace {

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

std::string readBytes(const std::filesystem::path& path) {
    std::ifstream stream(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

void writeInferenceReportRoundTripsEdgesWithAndWithoutInteractionTerms() {
    konjugate::InferenceResult result;

    konjugate::InferredEdge withInteraction;
    withInteraction.sourceColumn = "sourceTemperature";
    withInteraction.targetColumn = "targetTemperature";
    withInteraction.lag = 1;
    withInteraction.terms = {{1, 0.5}, {2, -0.25}};
    withInteraction.interaction = konjugate::InteractionTerm{0.125};
    withInteraction.intercept = 1.5;
    withInteraction.score = 0.875;
    withInteraction.provenance = "continuousLagged";
    result.edges.push_back(withInteraction);

    konjugate::InferredEdge withoutInteraction;
    withoutInteraction.sourceColumn = "pressure";
    withoutInteraction.targetColumn = "flow";
    withoutInteraction.lag = 0;
    withoutInteraction.terms = {{1, 2.0}};
    // .interaction left unset -- must not round-trip as a zero-valued interaction term.
    withoutInteraction.intercept = 0.0;
    withoutInteraction.score = -std::numeric_limits<double>::infinity(); // a real, reachable case: the held-out score of an unusably bad fit
    withoutInteraction.provenance = "correlationOnly";
    result.edges.push_back(withoutInteraction);

    result.selfTerms.push_back({"targetTemperature", 0.05});

    const auto scratchPath = std::filesystem::temp_directory_path() / "konjugateInferenceReportTest.bin";
    konjugate::writeInferenceReport(scratchPath, result);
    const auto bytes = readBytes(scratchPath);
    std::error_code removeError;
    std::filesystem::remove(scratchPath, removeError);

    konjugate::protocol::InferenceReport decoded;
    require(decoded.ParseFromString(bytes), "Expected the written report to parse as a valid InferenceReport protobuf message.");
    require(decoded.edges_size() == 2, "Expected both edges to round-trip.");

    const auto& first = decoded.edges(0);
    require(first.source_column() == "sourceTemperature" && first.target_column() == "targetTemperature", "Expected the first edge's columns to round-trip.");
    require(first.lag() == 1, "Expected the first edge's lag to round-trip.");
    require(first.terms_size() == 2 && first.terms(0).degree() == 1 && first.terms(0).coefficient() == 0.5,
        "Expected the first edge's polynomial terms to round-trip.");
    require(first.has_interaction() && first.interaction().coefficient() == 0.125, "Expected the first edge's interaction term to round-trip as present.");
    require(first.intercept() == 1.5 && first.score() == 0.875, "Expected the first edge's intercept/score to round-trip.");

    const auto& second = decoded.edges(1);
    require(!second.has_interaction(), "Expected the second edge (no interaction term set) to round-trip as absent, not a zero-valued interaction.");
    require(std::isinf(second.score()) && second.score() < 0, "Expected the second edge's -Infinity score to round-trip exactly, not as some finite sentinel.");

    require(decoded.self_terms_size() == 1 && decoded.self_terms(0).target_column() == "targetTemperature" && decoded.self_terms(0).rate() == 0.05,
        "Expected the self term to round-trip.");
}

void writeValidationReportRoundTripsIssuesAndSummary() {
    konjugate::ValidationResult result;
    result.valid = false;
    result.nodeCount = 3;
    result.edgeCount = 2;
    konjugate::ValidationIssue issue;
    issue.code = "stateSymbolInvalid";
    issue.severity = "error";
    issue.message = "The state symbol must be lower-camel-case.";
    issue.location = {"node", "42", "states"};
    result.issues.push_back(issue);

    const auto scratchPath = std::filesystem::temp_directory_path() / "konjugateValidationReportTest.bin";
    konjugate::writeValidationReport(scratchPath, result);
    const auto bytes = readBytes(scratchPath);
    std::error_code removeError;
    std::filesystem::remove(scratchPath, removeError);

    konjugate::protocol::ValidationReport decoded;
    require(decoded.ParseFromString(bytes), "Expected the written report to parse as a valid ValidationReport protobuf message.");
    require(decoded.valid() == false, "Expected valid to round-trip.");
    require(decoded.summary().nodes() == 3 && decoded.summary().edges() == 2, "Expected the summary counts to round-trip.");
    require(decoded.issues_size() == 1, "Expected the one issue to round-trip.");
    const auto& issueOut = decoded.issues(0);
    require(issueOut.code() == "stateSymbolInvalid" && issueOut.severity() == "error", "Expected the issue's code/severity to round-trip.");
    require(issueOut.location().kind() == "node" && issueOut.location().entity_id() == "42" && issueOut.location().field() == "states",
        "Expected the issue's location to round-trip.");
}

void writeInspectionReportRoundTripsFields() {
    const auto scratchPath = std::filesystem::temp_directory_path() / "konjugateInspectionReportTest.bin";
    konjugate::writeInspectionReport(scratchPath, "konjugate", 1, true);
    const auto bytes = readBytes(scratchPath);
    std::error_code removeError;
    std::filesystem::remove(scratchPath, removeError);

    konjugate::protocol::InspectionReport decoded;
    require(decoded.ParseFromString(bytes), "Expected the written report to parse as a valid InspectionReport protobuf message.");
    require(decoded.format() == "konjugate" && decoded.container_version() == 1 && decoded.encrypted() == true,
        "Expected format/containerVersion/encrypted to round-trip.");
}

}

int main() {
    try {
        writeInferenceReportRoundTripsEdgesWithAndWithoutInteractionTerms();
        writeValidationReportRoundTripsIssuesAndSummary();
        writeInspectionReportRoundTripsFields();
        std::cout << "Report protocol tests passed.\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
