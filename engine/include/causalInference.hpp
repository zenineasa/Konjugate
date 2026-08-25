/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <Eigen/Dense>
#include <string>
#include <vector>

namespace konjugate {

// One column per variable, one row per timestamp, in chronological order. Column 0 of the
// parsed CSV (the time column) is consumed by parseInferenceCsv() to validate regular spacing
// and is not part of this struct -- inferGraph() operates purely on the variable columns.
struct InferenceSeries {
    std::vector<std::string> columnNames;
    std::vector<std::vector<double>> rows; // rows[t][column], rows.size() == T, each row.size() == columnNames.size()
};

struct InferenceConfig {
    // Only "partialCorrelation" is implemented in v1. Kept as a string (validated against a
    // fixed set, not a bare bool) so a second stage-1 skeleton method is a new case later, not a
    // schema change -- see docs/proposals/causalInference.md's scoping note.
    std::string skeletonMethod = "partialCorrelation";
    std::vector<int> candidateLags = {1, 2, 3};
    double skeletonThreshold = 0.1;      // |partial correlation| a pair must clear to survive stage 1
    double coefficientThreshold = 0.05;  // aggregate (L2-norm across degrees) |standardized coefficient| a source must clear
    double validationFraction = 0.2;     // chronological held-out split, applied per target fit
    std::vector<double> ridgePenalties = {0.01, 0.1, 1.0, 10.0};
    // The array *is* the UI mode: {1} = linear only (default, byte-identical to the original v1
    // behavior), {N} = force degree N (no linear comparison), {1, N} = auto -- fit both and keep
    // whichever scores better per target, reusing the same held-out-score selection already used
    // for lag/penalty rather than adding a second selection mechanism. See
    // docs/proposals/causalInference.md's "Planned next" section.
    std::vector<int> candidateDegrees = {1};
};

// One polynomial term of a fitted relationship: coefficient * sourceColumn^degree, in the
// original (unstandardized) units of the two columns. A purely linear edge has exactly one
// entry with degree == 1; a fitted curve has one entry per degree 1..selected.
struct PolynomialTerm {
    int degree = 1;
    double coefficient = 0.0;
};

struct InferredEdge {
    std::string sourceColumn;
    std::string targetColumn;
    int lag = 0;                // 0 for a correlationOnly edge, which has no lag concept
    std::vector<PolynomialTerm> terms; // always non-empty; see PolynomialTerm
    double intercept = 0.0;     // in the original units of the target column
    double score = 0.0;         // held-out variance-explained, roughly (-inf, 1]; higher is better
    std::string provenance;     // "lagged" | "correlationOnly"
};

struct InferenceResult {
    std::vector<InferredEdge> edges;
};

// Parses CSV text whose first column is a numeric, strictly increasing, evenly spaced time
// column and whose remaining columns are the numeric variable series. Throws std::runtime_error
// with a specific, user-facing message on a ragged row, a non-numeric cell, a non-increasing or
// unevenly spaced time column, or a constant (zero-variance) variable column -- v1 requires
// complete, regularly sampled input and rejects otherwise rather than imputing or resampling.
InferenceSeries parseInferenceCsv(const std::string& csvContent);

// A standardized (zero-mean / unit-variance per column) copy of a series' variable columns,
// plus the per-column mean/stddev needed to de-standardize a fitted coefficient back to the
// original units of its two columns.
struct StandardizedSeries {
    Eigen::MatrixXd values;    // T x N, each column zero-mean / unit-variance
    Eigen::RowVectorXd mean;   // N, in original units
    Eigen::RowVectorXd stddev; // N, in original units
};
StandardizedSeries standardizeSeries(const InferenceSeries& series);

// πᵢⱼ = -θᵢⱼ / sqrt(θᵢᵢθⱼⱼ), θ the inverse of the correlation matrix of already-standardized
// columns -- the Gaussian-graphical-model machinery behind stage 1's skeleton pass, exposed
// directly for unit testing against a hand-computed example (see causalInferenceTests.cpp and
// docs/causalInference.md). Throws std::runtime_error if there are fewer than
// (columns + 2) rows, since the correlation matrix is not reliably invertible below that.
Eigen::MatrixXd computePartialCorrelation(const Eigen::MatrixXd& standardizedValues);

struct RidgeFit {
    Eigen::VectorXd coefficients; // one per feature column, standardized units
    double intercept = 0.0;       // standardized units
};

// Ridge regression with an unpenalized intercept: centers x/y, solves the penalized normal
// equations on the centered system, then recovers the intercept separately so the penalty never
// shrinks the baseline term. Exposed directly for unit testing against a closed-form solution.
RidgeFit fitRidgeRegression(const Eigen::MatrixXd& x, const Eigen::VectorXd& y, double penalty);

// Held-out variance explained: 1 - (validation MSE / validation variance), roughly (-inf, 1]
// with higher meaning a better fit.
double heldOutScore(const RidgeFit& fit, const Eigen::MatrixXd& xValidation, const Eigen::VectorXd& yValidation);

// Runs the two-stage pipeline described in docs/proposals/causalInference.md: a cheap
// partial-correlation skeleton pass over all pairs, then per-surviving-pair lagged ridge
// regression (lag and penalty jointly chosen by held-out validation loss) to find direction. A
// pair that survives stage 1 with no stage-2 evidence in either direction still produces two
// directed edges built from the (symmetric) partial-correlation coefficient, tagged
// provenance == "correlationOnly" rather than "lagged", so the two cases stay visibly distinct
// downstream. Throws std::runtime_error if there are not enough observations relative to the
// number of variables for the correlation matrix to be invertible.
InferenceResult inferGraph(const InferenceSeries& series, const InferenceConfig& config);

}
