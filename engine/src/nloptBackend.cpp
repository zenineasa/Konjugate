/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "nloptBackend.hpp"
#include "finiteDifferenceGradient.hpp"
#include <nlopt.hpp>
#include <stdexcept>

namespace konjugate {
namespace {

struct AlgorithmInfo {
    nlopt::algorithm algorithm;
};

// A vector, not a map -- order here is the declared, user-facing order (derivative-free first,
// then gradient-based; see nloptAlgorithmIds()'s doc comment), which a std::map's alphabetical
// key order would silently scramble.
//
// LD_LBFGS is deliberately excluded: in this vcpkg NLopt build it routes through the optional
// "luksan" feature (LGPL-licensed, off by default -- see vcpkg.json's nlopt entry), and fails at
// runtime ("attempting to use NLOPT_LD_LBFGS, but Luksan code disabled") without it. Enabling an
// LGPL component is a licensing decision, not a build-config one -- left out here rather than
// silently opted into. Every algorithm below is NLopt's own native implementation (not
// Luksan-derived), so none of them carry that tradeoff.
//
// ISRES (a global, population-based evolution strategy) stands in for CMA-ES: this vcpkg build
// of NLopt has no LN_CMAES entry in its algorithm enum at all (confirmed against the installed
// nlopt.hpp), so it isn't a build-config choice like LBFGS above -- it simply isn't offered by
// this library build. ISRES fills the same "global, derivative-free, good for messy/multi-modal
// loss surfaces" role and is present in every NLopt build.
const std::vector<std::pair<std::string, AlgorithmInfo>>& algorithmTable() {
    static const std::vector<std::pair<std::string, AlgorithmInfo>> table = {
        {"nlopt-bobyqa", {nlopt::LN_BOBYQA}},
        {"nlopt-cobyla", {nlopt::LN_COBYLA}},
        {"nlopt-neldermead", {nlopt::LN_NELDERMEAD}},
        {"nlopt-praxis", {nlopt::LN_PRAXIS}},
        {"nlopt-sbplx", {nlopt::LN_SBPLX}},
        {"nlopt-isres", {nlopt::GN_ISRES}},
        {"nlopt-slsqp", {nlopt::LD_SLSQP}},
        {"nlopt-mma", {nlopt::LD_MMA}},
        {"nlopt-ccsaq", {nlopt::LD_CCSAQ}},
    };
    return table;
}

const AlgorithmInfo* findAlgorithm(const std::string& algorithmId) {
    for (const auto& [id, info] : algorithmTable()) if (id == algorithmId) return &info;
    return nullptr;
}

// A small, explicit mapping rather than relying on a specific NLopt version's string-conversion
// helper -- keeps this file buildable against whatever NLopt release vcpkg happens to resolve.
std::string describeNloptResult(nlopt::result outcome) {
    switch (outcome) {
    case nlopt::SUCCESS: return "success";
    case nlopt::STOPVAL_REACHED: return "stopValueReached";
    case nlopt::FTOL_REACHED: return "functionToleranceReached";
    case nlopt::XTOL_REACHED: return "parameterToleranceReached";
    case nlopt::MAXEVAL_REACHED: return "maxIterationsReached";
    case nlopt::MAXTIME_REACHED: return "maxTimeReached";
    default: return "failed (" + std::to_string(static_cast<int>(outcome)) + ")";
    }
}

// The context nlopt's C-style callback carries through its opaque void* data pointer -- captures
// everything the objective wrapper needs without relying on any global/static state, so this
// backend is safe to use from multiple fit runs (even concurrently, though the fitting CLI never
// does that today).
struct NloptContext {
    const LossFunction* loss = nullptr;
    const FittingProgressCallback* onProgress = nullptr;
    std::size_t iteration = 0;
};

double nloptObjective(const std::vector<double>& point, std::vector<double>& gradient, void* data) {
    auto* context = static_cast<NloptContext*>(data);
    const double loss = (*context->loss)(point);
    if (!gradient.empty()) {
        const auto computed = finiteDifferenceGradient(*context->loss, point);
        gradient = computed;
    }
    context->iteration += 1;
    if (*context->onProgress) (*context->onProgress)({context->iteration, loss, point});
    return loss;
}

class NloptOptimizerBackend final : public OptimizerBackend {
public:
    explicit NloptOptimizerBackend(std::string algorithmId) : algorithmId_(std::move(algorithmId)) {}

    std::string id() const override { return algorithmId_; }

    OptimizationResult optimize(const LossFunction& loss, const std::vector<double>& initialValues,
        const std::vector<ParameterBounds>& bounds, const FittingOptions& options,
        const FittingProgressCallback& onProgress) const override {
        const auto* info = findAlgorithm(algorithmId_);
        if (!info) throw std::invalid_argument("Unrecognized NLopt algorithm id: " + algorithmId_);
        const auto dimension = initialValues.size();
        nlopt::opt solver(info->algorithm, static_cast<unsigned>(dimension));
        std::vector<double> lower(dimension), upper(dimension);
        for (std::size_t index = 0; index < dimension; ++index) {
            lower[index] = bounds[index].minimum;
            upper[index] = bounds[index].maximum;
        }
        solver.set_lower_bounds(lower);
        solver.set_upper_bounds(upper);
        solver.set_maxeval(static_cast<int>(options.maxIterations));
        solver.set_xtol_rel(options.tolerance);

        static const FittingProgressCallback noProgress = [](const FittingProgressUpdate&) {};
        NloptContext context{&loss, onProgress ? &onProgress : &noProgress, 0};
        solver.set_min_objective(nloptObjective, &context);

        OptimizationResult result;
        result.parameterValues = initialValues;
        try {
            const auto outcome = solver.optimize(result.parameterValues, result.loss);
            result.converged = outcome > 0;
            result.terminationReason = describeNloptResult(outcome);
        } catch (const std::exception& error) {
            result.converged = false;
            result.terminationReason = error.what();
        }
        result.iterations = context.iteration;
        return result;
    }

private:
    std::string algorithmId_;
};

}

std::vector<std::string> nloptAlgorithmIds() {
    std::vector<std::string> ids;
    ids.reserve(algorithmTable().size());
    for (const auto& [id, info] : algorithmTable()) ids.push_back(id);
    return ids;
}

std::unique_ptr<OptimizerBackend> createNloptBackend(const std::string& algorithmId) {
    if (!findAlgorithm(algorithmId)) throw std::invalid_argument("Unrecognized NLopt algorithm id: " + algorithmId);
    return std::make_unique<NloptOptimizerBackend>(algorithmId);
}

}
