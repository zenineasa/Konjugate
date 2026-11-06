/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Starter programs for a tuning objective written as a program (docs/proposals/tuningEditorsAndPrograms.md, step 5): each reads the
// keys it is given, so it runs as soon as those keys are bound. The objective the search makes small (or large, when maximising)
// is what `objective` returns; `report` adds further numbers by name.

const templates = {
    squaredError: {
        label: 'Squared error against measured data',
        keys: [{ key: 'simulated', kind: 'state' }, { key: 'measured', kind: 'measured' }],
        python: `def objective(run):
    # The total squared difference between a state and its measurements, sample by sample.
    simulated = run.series("simulated")
    measured = run.series("measured")
    return sum((s - m) ** 2 for s, m in zip(simulated, measured))
`,
        cpp: `#include <konjugate/objectiveProgram.hpp>

// The total squared difference between a state and its measurements, sample by sample.
double objective(const konjugate::Run& run) {
    const auto& simulated = run.series("simulated");
    const auto& measured = run.series("measured");
    double total = 0;
    for (std::size_t index = 0; index < simulated.size() && index < measured.size(); ++index) {
        const double difference = simulated[index] - measured[index];
        total += difference * difference;
    }
    return total;
}
`
    },
    settlingTime: {
        label: 'Settling time to a target',
        keys: [{ key: 'response', kind: 'state' }],
        python: `TARGET = 340.0     # where the response should settle
BAND = 0.02        # within 2 % of the target counts as settled

def objective(run):
    # The time after which the response stays within the band around the target: the shorter the better.
    response = run.series("response")
    times = run.times
    settled_at = times[-1]
    for time, value in reversed(list(zip(times, response))):
        if abs(value - TARGET) > BAND * abs(TARGET):
            break
        settled_at = time
    run.report("final", response[-1])
    return settled_at
`,
        cpp: `#include <konjugate/objectiveProgram.hpp>
#include <cmath>

constexpr double target = 340.0;   // where the response should settle
constexpr double band = 0.02;      // within 2 % of the target counts as settled

// The time after which the response stays within the band around the target: the shorter the better.
double objective(const konjugate::Run& run) {
    const auto& response = run.series("response");
    const auto& times = run.times();
    double settledAt = times.back();
    for (std::size_t index = response.size(); index-- > 0;) {
        if (std::abs(response[index] - target) > band * std::abs(target)) break;
        settledAt = times[index];
    }
    run.report("final", response.back());
    return settledAt;
}
`
    },
    overshoot: {
        label: 'Overshoot past a target',
        keys: [{ key: 'response', kind: 'state' }],
        python: `TARGET = 340.0     # the value the response should reach without going past

def objective(run):
    # How far the response went past the target, at its furthest: none is best.
    response = run.series("response")
    peak = max(response)
    run.report("peak", peak)
    return max(0.0, peak - TARGET)
`,
        cpp: `#include <konjugate/objectiveProgram.hpp>
#include <algorithm>

constexpr double target = 340.0;   // the value the response should reach without going past

// How far the response went past the target, at its furthest: none is best.
double objective(const konjugate::Run& run) {
    const auto& response = run.series("response");
    const double peak = *std::max_element(response.begin(), response.end());
    run.report("peak", peak);
    return std::max(0.0, peak - target);
}
`
    }
};

export const objectiveTemplateIds = Object.keys(templates);

export function objectiveTemplate(id, language) {
    const template = templates[id];
    if (!template) throw new Error(`There is no objective template "${id}".`);
    return { label: template.label, keys: template.keys.map((key) => ({ ...key })), source: language === 'cpp' ? template.cpp : template.python };
}

// Whether a program's bindings can be run: every key named and different, each bound to something.
export function programBindingsProblem(bindings) {
    const keys = new Set();
    for (const [index, binding] of bindings.entries()) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.key ?? '')) return `Binding ${index + 1} needs a key: letters, digits and underscores.`;
        if (keys.has(binding.key)) return `The key "${binding.key}" is used twice.`;
        keys.add(binding.key);
        const bound = binding.kind === 'measured' ? Boolean(binding.column) : Number.isSafeInteger(binding.id) && binding.id > 0;
        if (!bound) return `"${binding.key}" is not bound to anything yet.`;
    }
    return '';
}
