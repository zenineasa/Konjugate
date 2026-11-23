/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "programUnits.hpp"

#include <cmath>
#include <cstddef>
#include <functional>
#include <map>
#include <numbers>
#include <regex>
#include <string>
#include <vector>

namespace konjugate {
namespace {

// The same catalogue as src/units.mjs, in the same order of SI base quantities: m, kg, s, A, K, mol, cd, rad.
using Dimensions = std::array<double, 8>;

struct UnitEntry {
    double scale = 1;
    Dimensions dimensions{};
    double absoluteOffset = 0;
};

Dimensions dims(double m = 0, double kg = 0, double s = 0, double a = 0, double k = 0, double mol = 0, double cd = 0, double rad = 0) {
    return {m, kg, s, a, k, mol, cd, rad};
}

const std::map<std::string, UnitEntry>& catalogue() {
    static const std::map<std::string, UnitEntry> units = [] {
        std::map<std::string, UnitEntry> table;
        const auto add = [&](std::initializer_list<const char*> symbols, double scale, Dimensions dimensions, double offset = 0) {
            for (const auto* symbol : symbols) table[symbol] = {scale, dimensions, offset};
        };
        const double pi = std::numbers::pi;
        add({"1", "-", ""}, 1, dims()); add({"%", "percent", "pct"}, 0.01, dims()); add({"ppm"}, 1e-6, dims()); add({"ppb"}, 1e-9, dims());
        add({"rad", "radian", "radians"}, 1, dims(0, 0, 0, 0, 0, 0, 0, 1)); add({"°", "deg", "degree", "degrees"}, pi / 180, dims(0, 0, 0, 0, 0, 0, 0, 1));
        add({"rev", "revolution", "revolutions", "turn"}, 2 * pi, dims(0, 0, 0, 0, 0, 0, 0, 1));
        add({"m", "metre", "meter", "metres", "meters"}, 1, dims(1)); add({"in", "inch", "inches", "\""}, 0.0254, dims(1));
        add({"ft", "foot", "feet", "'"}, 0.3048, dims(1)); add({"yd", "yard", "yards"}, 0.9144, dims(1)); add({"mi", "mile", "miles"}, 1609.344, dims(1));
        add({"nmi"}, 1852, dims(1));
        add({"g", "gram", "grams"}, 1e-3, dims(0, 1)); add({"t", "tonne", "tonnes"}, 1000, dims(0, 1));
        add({"lb", "lbs", "lbm", "pound", "pounds"}, 0.45359237, dims(0, 1)); add({"oz", "ounce", "ounces"}, 0.028349523125, dims(0, 1));
        add({"s", "sec", "second", "seconds"}, 1, dims(0, 0, 1)); add({"min", "minute", "minutes"}, 60, dims(0, 0, 1));
        add({"h", "hr", "hour", "hours"}, 3600, dims(0, 0, 1)); add({"d", "day", "days"}, 86400, dims(0, 0, 1));
        add({"K", "kelvin"}, 1, dims(0, 0, 0, 0, 1)); add({"°C", "degC", "deg C", "celsius", "℃"}, 1, dims(0, 0, 0, 0, 1), 273.15);
        add({"°F", "degF", "deg F", "fahrenheit", "℉"}, 5.0 / 9.0, dims(0, 0, 0, 0, 1), 459.67 * 5.0 / 9.0); add({"°R", "degR", "rankine"}, 5.0 / 9.0, dims(0, 0, 0, 0, 1));
        add({"A", "amp", "amps", "ampere"}, 1, dims(0, 0, 0, 1)); add({"V", "volt", "volts"}, 1, dims(2, 1, -3, -1)); add({"Ω", "ohm", "ohms"}, 1, dims(2, 1, -3, -2));
        add({"S", "siemens"}, 1, dims(-2, -1, 3, 2)); add({"F", "farad"}, 1, dims(-2, -1, 4, 2)); add({"Ah"}, 3600, dims(0, 0, 1, 1));
        add({"H", "henry"}, 1, dims(2, 1, -2, -2)); add({"Wb", "weber"}, 1, dims(2, 1, -2, -1)); add({"T", "tesla"}, 1, dims(0, 1, -2, -1));
        add({"mol", "mole", "moles"}, 1, dims(0, 0, 0, 0, 0, 1)); add({"cd", "candela"}, 1, dims(0, 0, 0, 0, 0, 0, 1)); add({"Hz", "hertz"}, 1, dims(0, 0, -1));
        add({"rpm", "RPM"}, 2 * pi / 60, dims(0, 0, -1, 0, 0, 0, 0, 1)); add({"rps"}, 2 * pi, dims(0, 0, -1, 0, 0, 0, 0, 1)); add({"cps"}, 1, dims(0, 0, -1));
        add({"N", "newton", "newtons"}, 1, dims(1, 1, -2)); add({"lbf"}, 4.4482216152605, dims(1, 1, -2)); add({"kgf"}, 9.80665, dims(1, 1, -2));
        add({"Pa", "pascal"}, 1, dims(-1, 1, -2)); add({"bar"}, 1e5, dims(-1, 1, -2)); add({"atm"}, 101325, dims(-1, 1, -2));
        add({"psi", "psia", "psig"}, 6894.757293168, dims(-1, 1, -2)); add({"mmHg"}, 133.322387415, dims(-1, 1, -2)); add({"torr", "Torr"}, 101325.0 / 760.0, dims(-1, 1, -2));
        add({"inHg"}, 3386.389, dims(-1, 1, -2)); add({"mmH2O", "mmWC"}, 9.80665, dims(-1, 1, -2)); add({"inH2O", "inWC"}, 249.08891, dims(-1, 1, -2));
        add({"J", "joule", "joules"}, 1, dims(2, 1, -2)); add({"Wh"}, 3600, dims(2, 1, -2)); add({"cal", "calorie"}, 4.184, dims(2, 1, -2));
        add({"BTU", "Btu", "btu"}, 1055.05585262, dims(2, 1, -2)); add({"eV"}, 1.602176634e-19, dims(2, 1, -2));
        add({"W", "watt", "watts"}, 1, dims(2, 1, -3)); add({"hp", "HP"}, 745.69987158227, dims(2, 1, -3)); add({"VA"}, 1, dims(2, 1, -3));
        add({"L", "l", "litre", "liter", "litres", "liters"}, 1e-3, dims(3)); add({"gal", "gallon", "gallons"}, 3.785411784e-3, dims(3));
        add({"impgal"}, 4.54609e-3, dims(3)); add({"bbl"}, 0.158987294928, dims(3));
        add({"gpm", "GPM"}, 3.785411784e-3 / 60, dims(3, 0, -1)); add({"cfm", "CFM"}, 0.3048 * 0.3048 * 0.3048 / 60, dims(3, 0, -1)); add({"lpm", "LPM"}, 1e-3 / 60, dims(3, 0, -1));
        add({"mph"}, 0.44704, dims(1, 0, -1)); add({"kn", "knot", "knots"}, 1852.0 / 3600.0, dims(1, 0, -1));
        return table;
    }();
    return units;
}

const std::vector<std::pair<std::string, double>>& prefixes() {
    static const std::vector<std::pair<std::string, double>> list = {
        {"da", 1e1}, {"Y", 1e24}, {"Z", 1e21}, {"E", 1e18}, {"P", 1e15}, {"T", 1e12}, {"G", 1e9}, {"M", 1e6}, {"k", 1e3}, {"h", 1e2}, {"d", 1e-1},
        {"c", 1e-2}, {"m", 1e-3}, {"µ", 1e-6}, {"μ", 1e-6}, {"u", 1e-6}, {"n", 1e-9}, {"p", 1e-12}, {"f", 1e-15}};
    return list;
}

bool prefixable(const std::string& symbol) {
    static const std::vector<std::string> list = {"m", "g", "s", "A", "K", "V", "Ω", "S", "F", "H", "Wb", "T", "mol", "cd", "Hz", "N", "Pa", "bar", "J",
                                                  "Wh", "W", "L", "l", "eV", "VA", "Ah", "cal", "t"};
    for (const auto& item : list) if (item == symbol) return true;
    return false;
}

std::optional<UnitEntry> symbolUnit(const std::string& symbol) {
    const auto& units = catalogue();
    if (const auto found = units.find(symbol); found != units.end()) return found->second;
    for (const auto& [prefix, factor] : prefixes()) {
        if (symbol.rfind(prefix, 0) != 0) continue;
        const auto rest = symbol.substr(prefix.size());
        if (prefixable(rest) && units.contains(rest)) {
            const auto& unit = units.at(rest);
            return UnitEntry{unit.scale * factor, unit.dimensions, 0};
        }
    }
    return std::nullopt;
}

std::optional<std::vector<UnitEntry>> splitSymbols(const std::string& name) {
    if (name.empty()) return std::vector<UnitEntry>{};
    for (std::size_t length = name.size(); length > 0; --length) {
        const auto unit = symbolUnit(name.substr(0, length));
        if (!unit) continue;
        if (auto rest = splitSymbols(name.substr(length))) {
            rest->insert(rest->begin(), *unit);
            return rest;
        }
    }
    return std::nullopt;
}

struct Token {
    char type = 'n'; // n name, * times, / divide, ( and )
    std::string name;
    double power = 1;
};

std::string replaceAll(std::string text, const std::string& from, const std::string& to) {
    for (std::size_t at = text.find(from); at != std::string::npos; at = text.find(from, at + to.size())) text.replace(at, from.size(), to);
    return text;
}

std::optional<std::vector<Token>> tokenize(std::string source) {
    const std::vector<std::pair<std::string, std::string>> superscripts = {
        {"⁰", "0"}, {"¹", "1"}, {"²", "2"}, {"³", "3"}, {"⁴", "4"}, {"⁵", "5"}, {"⁶", "6"}, {"⁷", "7"}, {"⁸", "8"}, {"⁹", "9"}, {"⁻", "-"}};
    for (const auto& [from, to] : superscripts) source = replaceAll(source, from, to);
    for (const auto* times : {"·", "×", "⋅"}) source = replaceAll(source, times, "*");
    std::vector<Token> tokens;
    static const std::regex name(R"(^(°[CFR]|(?:[A-Za-z%°"'_]|µ|μ|Ω|℃|℉)+)(\^?-?\d+(?:\.\d+)?)?)");
    std::size_t index = 0;
    while (index < source.size()) {
        const char character = source[index];
        if (character == ' ' || character == '\t') { ++index; continue; }
        if (character == '*' || character == '.') { tokens.push_back({'*'}); ++index; continue; }
        if (character == '/') { tokens.push_back({'/'}); ++index; continue; }
        if (character == '(' || character == ')') { tokens.push_back({character}); ++index; continue; }
        std::smatch match;
        const std::string rest = source.substr(index);
        if (!std::regex_search(rest, match, name)) return std::nullopt;
        Token token;
        token.name = match[1].str();
        if (match[2].matched) {
            auto power = match[2].str();
            if (!power.empty() && power[0] == '^') power = power.substr(1);
            token.power = std::stod(power);
        }
        tokens.push_back(token);
        index += static_cast<std::size_t>(match.length(0));
    }
    return tokens;
}

struct Product {
    double scale = 1;
    Dimensions dimensions{};
};

std::optional<Product> evaluateTokens(const std::vector<Token>& tokens) {
    std::size_t position = 0;
    std::function<std::optional<Product>()> product;
    const auto factor = [&]() -> std::optional<Product> {
        if (position >= tokens.size()) return std::nullopt;
        const auto& token = tokens[position];
        if (token.type == '(') {
            ++position;
            auto inner = product();
            if (!inner || position >= tokens.size() || tokens[position].type != ')') return std::nullopt;
            ++position;
            return inner;
        }
        if (token.type != 'n') return std::nullopt;
        ++position;
        std::vector<UnitEntry> parts;
        if (const auto single = symbolUnit(token.name)) parts = {*single};
        else if (auto split = splitSymbols(token.name)) parts = std::move(*split);
        else return std::nullopt;
        Product result;
        for (std::size_t index = 0; index < parts.size(); ++index) {
            const double power = index + 1 == parts.size() ? token.power : 1;
            result.scale *= std::pow(parts[index].scale, power);
            for (std::size_t at = 0; at < 8; ++at) result.dimensions[at] += parts[index].dimensions[at] * power;
        }
        return result;
    };
    product = [&]() -> std::optional<Product> {
        auto result = factor();
        if (!result) return std::nullopt;
        bool below = false;
        while (position < tokens.size() && tokens[position].type != ')') {
            const auto& token = tokens[position];
            if (token.type == '/') below = true;
            if (token.type == '*' || token.type == '/') ++position;
            const auto next = factor();
            if (!next) return std::nullopt;
            if (below) {
                result->scale /= next->scale;
                for (std::size_t at = 0; at < 8; ++at) result->dimensions[at] -= next->dimensions[at];
            } else {
                result->scale *= next->scale;
                for (std::size_t at = 0; at < 8; ++at) result->dimensions[at] += next->dimensions[at];
            }
        }
        return result;
    };
    auto result = product();
    if (!result || position != tokens.size()) return std::nullopt;
    return result;
}

std::string normalize(std::string text) {
    while (!text.empty() && (text.front() == ' ' || text.front() == '\t')) text.erase(text.begin());
    while (!text.empty() && (text.back() == ' ' || text.back() == '\t')) text.pop_back();
    if (text.size() >= 2 && text.front() == '[' && text.back() == ']') text = text.substr(1, text.size() - 2);
    text = std::regex_replace(text, std::regex(R"(\bdeg(?:rees?)?\s*([CFR])\b)"), "deg$1");
    return replaceAll(text, "º", "°");
}

double tidy(double value) {
    return std::abs(value - std::round(value)) < 1e-12 * std::max(1.0, std::abs(value)) ? std::round(value) : value;
}

}

std::optional<ParsedUnit> parseUnit(const std::string& text) {
    const auto written = normalize(text);
    if (written == "C") return ParsedUnit{written, dims(0, 0, 0, 0, 1), 1, 273.15};
    const auto& units = catalogue();
    if (const auto whole = units.find(written); whole != units.end()) {
        return ParsedUnit{written, whole->second.dimensions, whole->second.scale, whole->second.absoluteOffset};
    }
    const auto tokens = tokenize(written);
    if (!tokens || tokens->empty()) {
        if (written.empty()) return ParsedUnit{"", dims(), 1, 0};
        return std::nullopt;
    }
    const auto result = evaluateTokens(*tokens);
    if (!result || !std::isfinite(result->scale) || result->scale == 0) return std::nullopt;
    double offset = 0;
    if (tokens->size() == 1 && (*tokens)[0].type == 'n' && (*tokens)[0].power == 1) {
        if (const auto single = units.find((*tokens)[0].name); single != units.end()) offset = single->second.absoluteOffset;
    }
    return ParsedUnit{written, result->dimensions, result->scale, offset};
}

UnitConversion unitConversion(const std::string& from, const std::string& to, bool rate) {
    UnitConversion conversion;
    const auto source = parseUnit(from);
    const auto target = parseUnit(to);
    if (!source) { conversion.error = "\"" + from + "\" is not a unit Konjugate knows"; return conversion; }
    if (!target) { conversion.error = "\"" + to + "\" is not a unit Konjugate knows"; return conversion; }
    // An angular speed and a frequency, or an angle and a pure number, differ only by an angle: one revolution is one cycle, a pure
    // number is radians (as src/units.mjs).
    constexpr std::size_t angle = 7;
    constexpr std::size_t time = 2;
    bool onlyAngle = std::abs(std::abs(source->dimensions[angle] - target->dimensions[angle]) - 1) < 1e-12;
    for (std::size_t index = 0; index < 8 && onlyAngle; ++index) {
        if (index != angle && source->dimensions[index] != target->dimensions[index]) onlyAngle = false;
    }
    bool same = true;
    for (std::size_t index = 0; index < 8; ++index) if (source->dimensions[index] != target->dimensions[index]) same = false;
    if (!same && !onlyAngle) {
        conversion.error = (from.empty() ? std::string("a pure number") : from) + " and " + (to.empty() ? std::string("a pure number") : to) +
            " measure different kinds of quantity";
        return conversion;
    }
    const bool asCycles = onlyAngle && source->dimensions[time] < 0;
    const double cycle = asCycles ? (source->dimensions[angle] > target->dimensions[angle] ? 1 / (2 * std::numbers::pi) : 2 * std::numbers::pi) : 1;
    conversion.scale = tidy(source->scale * cycle / target->scale);
    conversion.offset = rate ? 0.0 : tidy((source->offset - target->offset) / target->scale);
    conversion.identity = conversion.scale == 1 && conversion.offset == 0;
    return conversion;
}

std::string perSecond(const std::string& unit) {
    if (unit.empty()) return "Hz";
    if (unit.find_first_of("/*· ") == std::string::npos) return unit + "/s";
    return "(" + unit + ")/s";
}

}
