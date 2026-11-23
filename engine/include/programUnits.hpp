/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// Units for version 2 programs' ports (docs/proposals/programSdkV2.md, Units and dimensions): the app's unit catalogue (src/units.mjs),
// read the same way, so a program's port is checked against what it is bound to with the same rules as equations and the twin's
// mappings. A compatible unit is converted at the port (value in the port's unit = value in the bound unit x scale + offset); an
// incompatible one is refused by name.

#include <array>
#include <optional>
#include <string>

namespace konjugate {

struct ParsedUnit {
    std::string text;
    // Exponents of m, kg, s, A, K, mol, cd and rad.
    std::array<double, 8> dimensions{};
    double scale = 1;
    double offset = 0;
};

// A unit as written, or nothing for text the catalogue does not know. "" is a pure number.
std::optional<ParsedUnit> parseUnit(const std::string& text);

struct UnitConversion {
    double scale = 1;
    double offset = 0;
    bool identity = true;
    // Empty when the conversion exists; otherwise why not, in words.
    std::string error;
};

// value in `to` = value in `from` x scale + offset; or an error saying why there is none. `rate` drops the offset (a difference of
// temperatures, or a rate, never takes one: 1 degC/s is 1 K/s).
UnitConversion unitConversion(const std::string& from, const std::string& to, bool rate = false);

// The unit of a rate of a quantity in `unit`: "K" gives "K/s".
std::string perSecond(const std::string& unit);

}
