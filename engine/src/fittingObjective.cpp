/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "fittingObjective.hpp"
#include <algorithm>
#include <cctype>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace konjugate {

struct ObjectiveNode {
    enum class Type { number, variable, negate, binary, call, summary };
    Type type = Type::number;
    double number = 0.0;
    std::size_t variableIndex = 0;
    char operation = '+';     // binary: + - * / ^
    std::string function;     // call or summary name
    std::vector<std::unique_ptr<ObjectiveNode>> arguments;
    bool series = false;      // whether this has a value at each sample time, rather than one value for the run
};

namespace {

using Node = std::unique_ptr<ObjectiveNode>;

[[noreturn]] void fail(const std::string& message) { throw std::invalid_argument(message); }

bool isSummary(const std::string& name) { return name == "final" || name == "max" || name == "min" || name == "mean" || name == "integral"; }
bool isFunction(const std::string& name) {
    return name == "abs" || name == "sqrt" || name == "exp" || name == "ln" || name == "sin" || name == "cos" || name == "tan";
}

class Parser {
public:
    Parser(const std::string& text, const std::vector<ObjectiveVariable>& variables) : text_(text), variables_(variables) {}

    Node parse() {
        auto root = parseSum(false);
        skipSpace();
        if (position_ < text_.size()) fail("Unexpected '" + std::string(1, text_[position_]) + "' in the objective.");
        if (root->series) {
            fail("The objective has to be a single number, but part of it changes over time. Wrap states and measured data in final(…), max(…), min(…), mean(…) or integral(…).");
        }
        return root;
    }

private:
    const std::string& text_;
    const std::vector<ObjectiveVariable>& variables_;
    std::size_t position_ = 0;

    void skipSpace() { while (position_ < text_.size() && std::isspace(static_cast<unsigned char>(text_[position_]))) ++position_; }
    bool consume(char character) {
        skipSpace();
        if (position_ < text_.size() && text_[position_] == character) { ++position_; return true; }
        return false;
    }
    char peekOperator() {
        skipSpace();
        if (position_ >= text_.size()) return 0;
        if (text_.compare(position_, 3, "\xE2\x88\x92") == 0) return '-'; // −
        if (text_.compare(position_, 2, "\xC2\xB7") == 0 || text_.compare(position_, 2, "\xC3\x97") == 0) return '*'; // · ×
        return text_[position_];
    }
    void consumeOperator() {
        if (text_.compare(position_, 3, "\xE2\x88\x92") == 0) position_ += 3;
        else if (text_.compare(position_, 2, "\xC2\xB7") == 0 || text_.compare(position_, 2, "\xC3\x97") == 0) position_ += 2;
        else position_ += 1;
    }

    static Node binary(char operation, Node left, Node right) {
        auto node = std::make_unique<ObjectiveNode>();
        node->type = ObjectiveNode::Type::binary;
        node->operation = operation;
        node->series = left->series || right->series;
        node->arguments.push_back(std::move(left));
        node->arguments.push_back(std::move(right));
        return node;
    }

    Node parseSum(bool insideSummary) {
        auto left = parseProduct(insideSummary);
        for (;;) {
            const char operation = peekOperator();
            if (operation != '+' && operation != '-') return left;
            consumeOperator();
            left = binary(operation, std::move(left), parseProduct(insideSummary));
        }
    }

    Node parseProduct(bool insideSummary) {
        auto left = parseUnary(insideSummary);
        for (;;) {
            const char operation = peekOperator();
            if (operation != '*' && operation != '/') return left;
            consumeOperator();
            left = binary(operation, std::move(left), parseUnary(insideSummary));
        }
    }

    Node parseUnary(bool insideSummary) {
        const char operation = peekOperator();
        if (operation == '-' || operation == '+') {
            consumeOperator();
            auto operand = parseUnary(insideSummary);
            if (operation == '+') return operand;
            auto node = std::make_unique<ObjectiveNode>();
            node->type = ObjectiveNode::Type::negate;
            node->series = operand->series;
            node->arguments.push_back(std::move(operand));
            return node;
        }
        return parsePower(insideSummary);
    }

    Node parsePower(bool insideSummary) {
        auto base = parseAtom(insideSummary);
        if (peekOperator() == '^') {
            consumeOperator();
            return binary('^', std::move(base), parseUnary(insideSummary)); // right-associative, and -x is allowed in the exponent
        }
        return base;
    }

    Node parseAtom(bool insideSummary) {
        skipSpace();
        if (position_ >= text_.size()) fail("The objective ends where a number, name or bracket was expected.");
        const char character = text_[position_];
        if (character == '(') {
            ++position_;
            auto inner = parseSum(insideSummary);
            if (!consume(')')) fail("A bracket in the objective is not closed.");
            return inner;
        }
        if (std::isdigit(static_cast<unsigned char>(character)) || character == '.') return parseNumber();
        if (std::isalpha(static_cast<unsigned char>(character)) || character == '_') return parseName(insideSummary);
        fail("Unexpected '" + std::string(1, character) + "' in the objective.");
    }

    Node parseNumber() {
        const auto start = position_;
        while (position_ < text_.size() && (std::isdigit(static_cast<unsigned char>(text_[position_])) || text_[position_] == '.')) ++position_;
        if (position_ < text_.size() && (text_[position_] == 'e' || text_[position_] == 'E')) {
            auto lookahead = position_ + 1;
            if (lookahead < text_.size() && (text_[lookahead] == '+' || text_[lookahead] == '-')) ++lookahead;
            if (lookahead < text_.size() && std::isdigit(static_cast<unsigned char>(text_[lookahead]))) {
                position_ = lookahead;
                while (position_ < text_.size() && std::isdigit(static_cast<unsigned char>(text_[position_]))) ++position_;
            }
        }
        auto node = std::make_unique<ObjectiveNode>();
        node->type = ObjectiveNode::Type::number;
        try { node->number = std::stod(text_.substr(start, position_ - start)); } catch (const std::exception&) { fail("'" + text_.substr(start, position_ - start) + "' is not a number."); }
        return node;
    }

    Node parseName(bool insideSummary) {
        const auto start = position_;
        while (position_ < text_.size() && (std::isalnum(static_cast<unsigned char>(text_[position_])) || text_[position_] == '_')) ++position_;
        const auto name = text_.substr(start, position_ - start);
        skipSpace();
        const bool called = position_ < text_.size() && text_[position_] == '(';
        if (called) {
            const bool summary = isSummary(name);
            if (!summary && !isFunction(name)) fail("'" + name + "' is not a function. The functions are abs, sqrt, exp, ln, sin, cos, tan, final, max, min, mean and integral.");
            if (summary && insideSummary) fail("A " + name + "(…) cannot be inside another summary such as final(…) or integral(…).");
            ++position_;
            auto argument = parseSum(insideSummary || summary);
            if (!consume(')')) fail("The bracket after " + name + " is not closed.");
            auto node = std::make_unique<ObjectiveNode>();
            node->type = summary ? ObjectiveNode::Type::summary : ObjectiveNode::Type::call;
            node->function = name;
            node->series = summary ? false : argument->series;
            node->arguments.push_back(std::move(argument));
            return node;
        }
        for (std::size_t index = 0; index < variables_.size(); ++index) {
            if (variables_[index].name != name) continue;
            auto node = std::make_unique<ObjectiveNode>();
            node->type = ObjectiveNode::Type::variable;
            node->variableIndex = index;
            node->series = variables_[index].kind != ObjectiveVariable::Kind::parameter;
            if (node->series && !insideSummary) {
                fail("'" + name + "' changes over the run, so it needs a summary around it: final(" + name + "), max(" + name + "), min(" + name + "), mean(" + name + ") or integral(" + name + ").");
            }
            return node;
        }
        fail("'" + name + "' is not a name the objective knows. Use the buttons to insert states and parameters.");
    }
};

// A value with one entry for a quantity of the whole run, or one per sample time; `broadcast` reads either as the sample at `index`.
using Values = std::vector<double>;
double at(const Values& values, std::size_t index) { return values.size() == 1 ? values[0] : values[index]; }

double summarize(const std::string& name, const Values& values, const std::vector<double>& times) {
    if (values.empty()) return std::numeric_limits<double>::quiet_NaN();
    if (name == "final") return values.back();
    if (name == "max") return *std::max_element(values.begin(), values.end());
    if (name == "min") return *std::min_element(values.begin(), values.end());
    if (name == "mean") {
        double total = 0.0;
        for (const auto value : values) total += value;
        return total / static_cast<double>(values.size());
    }
    double total = 0.0;
    for (std::size_t index = 1; index < values.size() && index < times.size(); ++index) {
        total += 0.5 * (values[index] + values[index - 1]) * (times[index] - times[index - 1]);
    }
    return total;
}

}

FittingObjective::~FittingObjective() = default;
FittingObjective::FittingObjective(FittingObjective&&) noexcept = default;
FittingObjective& FittingObjective::operator=(FittingObjective&&) noexcept = default;

FittingObjective::FittingObjective(const std::string& expression, const std::vector<ObjectiveVariable>& variables)
    : variables_(variables) {
    if (expression.find_first_not_of(" \t\r\n") == std::string::npos) throw std::invalid_argument("The objective is empty.");
    root_ = Parser(expression, variables_).parse();
}

namespace {
Values evaluateNode(const ObjectiveNode& node, const ObjectiveData& data, const std::vector<ObjectiveVariable>& variables) {
    switch (node.type) {
    case ObjectiveNode::Type::number:
        return {node.number};
    case ObjectiveNode::Type::variable: {
        const auto& variable = variables[node.variableIndex];
        if (variable.kind == ObjectiveVariable::Kind::parameter) {
            const auto found = data.parameters.find(variable.id);
            return {found != data.parameters.end() ? found->second : variable.value};
        }
        if (variable.kind == ObjectiveVariable::Kind::state) {
            const auto found = data.states.find(variable.id);
            if (found == data.states.end()) throw std::runtime_error("The state '" + variable.name + "' did not appear in the simulated result.");
            return found->second;
        }
        const auto found = data.measured.find(variable.column);
        if (found == data.measured.end()) throw std::runtime_error("The measured column '" + variable.column + "' was not found.");
        return found->second;
    }
    case ObjectiveNode::Type::negate: {
        auto values = evaluateNode(*node.arguments[0], data, variables);
        for (auto& value : values) value = -value;
        return values;
    }
    case ObjectiveNode::Type::binary: {
        const auto left = evaluateNode(*node.arguments[0], data, variables);
        const auto right = evaluateNode(*node.arguments[1], data, variables);
        const auto length = std::max(left.size(), right.size());
        // Measured data and simulated states are paired by sample, so they must be the same length; a shorter one would be a misalignment.
        if (left.size() > 1 && right.size() > 1 && left.size() != right.size()) {
            throw std::runtime_error("The measured data and the simulation have a different number of samples.");
        }
        Values values(length);
        for (std::size_t index = 0; index < length; ++index) {
            const double a = at(left, index);
            const double b = at(right, index);
            switch (node.operation) {
            case '+': values[index] = a + b; break;
            case '-': values[index] = a - b; break;
            case '*': values[index] = a * b; break;
            case '/': values[index] = a / b; break;
            default: values[index] = std::pow(a, b); break;
            }
        }
        return values;
    }
    case ObjectiveNode::Type::call: {
        auto values = evaluateNode(*node.arguments[0], data, variables);
        for (auto& value : values) {
            if (node.function == "abs") value = std::fabs(value);
            else if (node.function == "sqrt") value = std::sqrt(value);
            else if (node.function == "exp") value = std::exp(value);
            else if (node.function == "ln") value = std::log(value);
            else if (node.function == "sin") value = std::sin(value);
            else if (node.function == "cos") value = std::cos(value);
            else value = std::tan(value);
        }
        return values;
    }
    case ObjectiveNode::Type::summary: {
        auto values = evaluateNode(*node.arguments[0], data, variables);
        // A summary of a single number (a parameter alone) is that number, over any length of run.
        if (values.size() == 1 && data.times.size() > 1) values.assign(data.times.size(), values[0]);
        return {summarize(node.function, values, data.times)};
    }
    }
    return {std::numeric_limits<double>::quiet_NaN()};
}
}

double FittingObjective::evaluate(const ObjectiveData& data) const {
    return evaluateNode(*root_, data, variables_).front();
}

}
