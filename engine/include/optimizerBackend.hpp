/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace konjugate {

struct ParameterBounds {
    double minimum = 0.0;
    double maximum = 0.0;
};

// One call per solver iteration/evaluation the backend chooses to report -- not necessarily
// every loss evaluation (a gradient-based backend's finite-difference probes don't each get
// their own progress update, only the point the solver actually steps to).
struct FittingProgressUpdate {
    std::size_t iteration = 0;
    double loss = 0.0;
    std::vector<double> parameterValues;
};

// Runs a full simulation trial and scores it against measured data -- see
// engine/src/parameterFitting.cpp. A black box to every backend: no analytic gradient exists,
// so gradient-based backends must finite-difference this themselves (see
// finiteDifferenceGradient.hpp).
using LossFunction = std::function<double(const std::vector<double>&)>;
using FittingProgressCallback = std::function<void(const FittingProgressUpdate&)>;

struct FittingOptions {
    std::size_t maxIterations = 200;
    double tolerance = 1e-8;
};

struct OptimizationResult {
    std::vector<double> parameterValues;
    double loss = 0.0;
    std::size_t iterations = 0;
    bool converged = false;
    std::string terminationReason;
};

// One pluggable solver. Concrete backends (NLopt algorithms, IPOPT, ...) wrap a real optimization
// library behind this interface, so the fitting loop and the UI only ever depend on this, not on
// any specific library -- see engine/src/nloptBackend.cpp for the first concrete implementation.
class OptimizerBackend {
public:
    virtual ~OptimizerBackend() = default;
    virtual std::string id() const = 0;
    virtual OptimizationResult optimize(const LossFunction& loss, const std::vector<double>& initialValues,
        const std::vector<ParameterBounds>& bounds, const FittingOptions& options,
        const FittingProgressCallback& onProgress) const = 0;
};

}
