/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The validator's text checks, written by hand where std::regex made validating a large model slow, against the regular expressions
// they replace (kept here as the reference): the same errors, in the same order, for hand-picked equations and for many random ones
// made of the pieces those expressions look at.

#include "modelValidator.hpp"
#include <algorithm>
#include <boost/property_tree/json_parser.hpp>
#include <sstream>
#include <cctype>
#include <iostream>
#include <random>
#include <regex>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

// The scan as equationErrors did it with std::regex before latexTextErrors.
std::vector<std::string> referenceLatexTextErrors(const std::string& latex, const std::set<std::string>& knownSymbols) {
    std::vector<std::string> errors;
    const std::regex environmentExpression(R"(\\begin\{([A-Za-z*]+)\})");
    for (auto match = std::sregex_iterator(latex.begin(), latex.end(), environmentExpression); match != std::sregex_iterator(); ++match) {
        if ((*match)[1].str() != "cases") errors.push_back("Unsupported LaTeX environment: " + (*match)[1].str() + ".");
    }
    const std::set<std::string> operatorNames = {"abs", "cos", "exp", "ln", "log", "max", "min", "negate", "sin", "tan"};
    const std::regex operatornameExpression(R"(\\operatorname\{([A-Za-z]+)\})");
    for (auto match = std::sregex_iterator(latex.begin(), latex.end(), operatornameExpression); match != std::sregex_iterator(); ++match) {
        auto name = (*match)[1].str();
        std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        if (!operatorNames.contains(name)) errors.push_back("\\operatorname{} does not name a supported function: " + (*match)[1].str() + ".");
    }
    const std::regex casesMarkupExpression(R"(\\(?:begin|end)\{[A-Za-z*]+\}|\\text\{[^}]*\})");
    const auto latexWithoutOperatorname = std::regex_replace(std::regex_replace(latex, operatornameExpression, " "), casesMarkupExpression, " ");
    const std::set<std::string> supportedCommands = {
        "cdot", "cos", "exp", "frac", "left", "ln", "log", "max", "min", "mathrm", "right", "sin", "sqrt", "tan",
        "ge", "geq", "gt", "land", "le", "leq", "lnot", "lor", "lt", "ne", "neg", "neq", "vee", "wedge"
    };
    const std::regex commandExpression(R"(\\([A-Za-z]+))");
    for (auto match = std::sregex_iterator(latexWithoutOperatorname.begin(), latexWithoutOperatorname.end(), commandExpression); match != std::sregex_iterator(); ++match) {
        const auto command = (*match)[1].str();
        if (!supportedCommands.contains(command)) errors.push_back("Unsupported LaTeX command: \\" + command + ".");
    }
    const auto expressionWithoutCommands = std::regex_replace(latexWithoutOperatorname, commandExpression, " ");
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

void sameAsReference(const std::string& latex, const std::set<std::string>& known) {
    const auto expected = referenceLatexTextErrors(latex, known);
    const auto actual = konjugate::latexTextErrors(latex, known);
    if (actual != expected) {
        std::string detail = "latexTextErrors differs from the regular expressions for: " + latex + "\n  expected:";
        for (const auto& error : expected) detail += " [" + error + "]";
        detail += "\n  actual:";
        for (const auto& error : actual) detail += " [" + error + "]";
        throw std::runtime_error(detail);
    }
}

void latexScanMatchesTheRegularExpressions() {
    const std::set<std::string> known = {"targetTemperature", "sourceTemperature", "conductance", "x", "y2", "k"};
    const std::vector<std::string> cases = {
        "",
        "\\mathrm{conductance} \\cdot (\\mathrm{sourceTemperature} - \\mathrm{targetTemperature})",
        "\\begin{cases} x & \\text{if } x > 0 \\\\ -x & \\text{otherwise} \\end{cases}",
        "\\begin{matrix} x \\end{matrix}",
        "\\begin{} x", "\\begin{1} x", "\\begin{cases*} x \\end{cases*}", "\\begin{cases x", "\\begin{ca}ses}",
        "\\operatorname{Max}(x, k)", "\\operatorname{softplus}(x)", "\\operatorname{}(x)", "\\operatorname{abs2}(x)", "\\operatorname{ABS}(x)",
        "\\text{unclosed x", "\\text{} x", "\\text{a}b}c", "\\textx{y}", "\\texts", "\\\\x", "\\\\\\alpha", "\\", "x\\", "\\1x",
        "\\alpha + \\alpha + \\beta", "\\frac{x}{y2} + 2x + x2y + y2_3", "\\mathrm{unknownName} + q",
        "\\begin{cases}\\begin{cases}x\\end{cases}\\end{cases}", "\\end{cases} x \\end{matrix}", "\\begin{aligned*}",
        "\\operatorname{sin}\\operatorname{cos}(x)\\operatorname{bad}", "\\operatorname{\\text{x}}", "\\text{\\operatorname{max}} y",
        "x \xC3\xA9 y \xE2\x88\x92 k", "\\left(x\\right)\n+\tk", "\\begin{cases}\nx\n\\end{cases}"
    };
    for (const auto& latex : cases) sameAsReference(latex, known);

    // Random equations from the pieces the scan treats specially.
    const std::vector<std::string> pieces = {
        "\\", "{", "}", "*", " ", "\n", "x", "k", "y2", "q", "Z", "7", "0", "_", "+", "&", "begin", "end", "text", "cases", "matrix",
        "operatorname", "max", "Abs", "mathrm", "frac", "alpha", "\\begin{", "\\end{", "\\text{", "\\operatorname{", "\\mathrm{",
        "conductance", "\xC3\xA9", "\xFF"
    };
    std::mt19937 generator(20261125);
    std::uniform_int_distribution<std::size_t> length(0, 14), pick(0, pieces.size() - 1);
    for (int sample = 0; sample < 200000; ++sample) {
        std::string latex;
        for (std::size_t count = length(generator); count-- > 0;) latex += pieces[pick(generator)];
        sameAsReference(latex, known);
    }
}

void nameChecksMatchTheRegularExpressions() {
    const std::regex entityId("^[1-9][0-9]{0,15}$");
    const std::regex symbol("^[a-z][A-Za-z0-9]*$");
    const std::regex definition("^[A-Za-z][A-Za-z0-9_]*$");
    const std::string alphabet = "019aAzZ_ -\n\xC3";
    std::mt19937 generator(7);
    std::uniform_int_distribution<std::size_t> length(0, 18), pick(0, alphabet.size() - 1);
    std::vector<std::string> samples = {"", "0", "1", "10", "1234567890123456", "12345678901234567", "a", "aB3", "Ab", "a_b", "_a", "a-b", "x\n"};
    for (int sample = 0; sample < 100000; ++sample) {
        std::string text;
        for (std::size_t count = length(generator); count-- > 0;) text += alphabet[pick(generator)];
        samples.push_back(text);
    }
    for (const auto& text : samples) {
        require(konjugate::isEntityId(text) == std::regex_match(text, entityId), "isEntityId differs from its expression for \"" + text + "\".");
        require(konjugate::isLowerCamelSymbol(text) == std::regex_match(text, symbol), "isLowerCamelSymbol differs from its expression for \"" + text + "\".");
        require(konjugate::isDefinitionSymbol(text) == std::regex_match(text, definition), "isDefinitionSymbol differs from its expression for \"" + text + "\".");
    }
}

}

// A relationship to a node that is there but has no state is told apart from one to a node that is gone, and names the node.
void relationshipToANodeWithoutStatesNamesIt() {
    std::istringstream input(R"json({
        "format": "konjugate", "version": 1,
        "nodes": [
            {"id": 1, "name": "Shell Cell", "states": [{"id": 11, "name": "Temperature", "symbol": "temperature", "initialValue": 300}]},
            {"id": 2, "name": "Ambient", "states": []}
        ],
        "edges": [
            {"id": 5, "name": "Heat Loss", "source": {"nodeId": 1, "stateId": 11}, "target": {"nodeId": 2, "stateId": ""}, "parameters": []},
            {"id": 6, "name": "Dangling", "source": {"nodeId": 1, "stateId": 11}, "target": {"nodeId": 9, "stateId": ""}, "parameters": []}
        ]
    })json");
    boost::property_tree::ptree document;
    boost::property_tree::read_json(input, document);
    const auto result = konjugate::validateModel(document);
    const auto find = [&](const std::string& code, const std::string& edgeId) {
        return std::find_if(result.issues.begin(), result.issues.end(), [&](const auto& issue) { return issue.code == code && issue.location.entityId == edgeId; });
    };
    const auto stateless = find("edgeTargetStateless", "5");
    require(stateless != result.issues.end(), "A relationship to a node without states was not reported as such.");
    require(stateless->message.find("\"Ambient\"") != std::string::npos && stateless->message.find("no state variables") != std::string::npos,
        "The message does not name the node or say what is wrong: " + stateless->message);
    require(find("edgeTargetMissing", "5") == result.issues.end(), "A node that is there was reported as gone.");
    require(find("edgeTargetMissing", "6") != result.issues.end(), "A relationship to a node that is gone was not reported as such.");
    require(find("edgeTargetStateless", "6") == result.issues.end(), "A node that is gone was reported as having no states.");
}

int main() {
    try {
        latexScanMatchesTheRegularExpressions();
        nameChecksMatchTheRegularExpressions();
        relationshipToANodeWithoutStatesNamesIt();
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
    std::cout << "Model validator tests passed.\n";
    return 0;
}
