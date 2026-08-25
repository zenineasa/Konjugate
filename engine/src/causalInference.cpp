/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "causalInference.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace konjugate {
namespace {

constexpr double kEpsilon = 1e-9;
constexpr std::size_t kMinimumRows = 10;

std::vector<std::string> splitCsvLine(const std::string& line) {
    std::vector<std::string> fields;
    std::string field;
    std::istringstream stream(line);
    while (std::getline(stream, field, ',')) fields.push_back(field);
    return fields;
}

double parseNumericField(const std::string& field, std::size_t rowNumber, std::size_t columnNumber) {
    try {
        std::size_t consumed = 0;
        const double value = std::stod(field, &consumed);
        if (consumed != field.size()) throw std::invalid_argument("trailing characters");
        return value;
    } catch (const std::exception&) {
        std::ostringstream message;
        message << "Row " << rowNumber << ", column " << columnNumber << " (\"" << field << "\") is not a valid number.";
        throw std::runtime_error(message.str());
    }
}

}

InferenceSeries parseInferenceCsv(const std::string& csvContent) {
    std::vector<std::string> lines;
    std::istringstream stream(csvContent);
    std::string line;
    while (std::getline(stream, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (!line.empty()) lines.push_back(line);
    }
    if (lines.size() < 2) throw std::runtime_error("The CSV must contain a header row and at least one data row.");

    const auto header = splitCsvLine(lines.front());
    if (header.size() < 2) throw std::runtime_error("The CSV must contain a time column and at least one variable column.");
    const std::size_t columnCount = header.size();

    InferenceSeries series;
    series.columnNames.assign(header.begin() + 1, header.end());

    std::vector<double> time;
    for (std::size_t rowIndex = 1; rowIndex < lines.size(); ++rowIndex) {
        const auto fields = splitCsvLine(lines[rowIndex]);
        if (fields.size() != columnCount) {
            std::ostringstream message;
            message << "Row " << rowIndex + 1 << " has " << fields.size() << " fields, expected " << columnCount << ".";
            throw std::runtime_error(message.str());
        }
        time.push_back(parseNumericField(fields[0], rowIndex + 1, 1));
        std::vector<double> row(columnCount - 1);
        for (std::size_t column = 1; column < columnCount; ++column) {
            row[column - 1] = parseNumericField(fields[column], rowIndex + 1, column + 1);
        }
        series.rows.push_back(std::move(row));
    }

    if (series.rows.size() < kMinimumRows) {
        std::ostringstream message;
        message << "The CSV must contain at least " << kMinimumRows << " data rows; found " << series.rows.size() << ".";
        throw std::runtime_error(message.str());
    }

    // Regular-spacing validation: v1 requires complete, evenly sampled input and rejects
    // otherwise rather than imputing or resampling (docs/proposals/causalInference.md,
    // "Decided for v1").
    const double step = time[1] - time[0];
    if (!(step > kEpsilon)) throw std::runtime_error("The time column must be strictly increasing.");
    for (std::size_t index = 1; index < time.size(); ++index) {
        const double delta = time[index] - time[index - 1];
        if (delta <= 0) throw std::runtime_error("The time column must be strictly increasing.");
        if (std::abs(delta - step) > 1e-6 * step) {
            std::ostringstream message;
            message << "The time column is not evenly spaced at row " << index + 2
                    << " (expected a step of " << step << ", found " << delta << "). "
                    << "Import requires regularly sampled data; there is no gap-filling in this version.";
            throw std::runtime_error(message.str());
        }
    }

    // Reject a constant (zero-variance) variable column outright: it cannot meaningfully
    // participate in correlation or regression, and silently dropping it would leave the
    // caller's column bookkeeping out of sync with the report.
    const std::size_t variableCount = series.columnNames.size();
    const std::size_t rowCount = series.rows.size();
    for (std::size_t column = 0; column < variableCount; ++column) {
        double mean = 0.0;
        for (const auto& row : series.rows) mean += row[column];
        mean /= static_cast<double>(rowCount);
        double variance = 0.0;
        for (const auto& row : series.rows) variance += (row[column] - mean) * (row[column] - mean);
        variance /= static_cast<double>(rowCount - 1);
        if (variance < kEpsilon) {
            throw std::runtime_error("Column \"" + series.columnNames[column] + "\" is constant and cannot be analyzed.");
        }
    }

    return series;
}

StandardizedSeries standardizeSeries(const InferenceSeries& series) {
    const auto rowCount = static_cast<Eigen::Index>(series.rows.size());
    const auto columnCount = static_cast<Eigen::Index>(series.columnNames.size());
    Eigen::MatrixXd raw(rowCount, columnCount);
    for (Eigen::Index row = 0; row < rowCount; ++row) {
        for (Eigen::Index column = 0; column < columnCount; ++column) {
            raw(row, column) = series.rows[static_cast<std::size_t>(row)][static_cast<std::size_t>(column)];
        }
    }
    StandardizedSeries result;
    result.mean = raw.colwise().mean();
    const Eigen::MatrixXd centered = raw.rowwise() - result.mean;
    const Eigen::RowVectorXd variance =
        (centered.array().square().colwise().sum().matrix() / static_cast<double>(rowCount - 1));
    result.stddev = variance.array().sqrt().matrix();
    result.values = (centered.array().rowwise() / result.stddev.array()).matrix();
    return result;
}

Eigen::MatrixXd computePartialCorrelation(const Eigen::MatrixXd& standardizedValues) {
    const auto rowCount = standardizedValues.rows();
    const auto columnCount = standardizedValues.cols();
    if (rowCount <= columnCount + 1) {
        throw std::runtime_error("Not enough observations relative to the number of variables for a "
            "partial-correlation skeleton pass; at least (variable count + 2) rows are required.");
    }
    const Eigen::MatrixXd correlation = (standardizedValues.transpose() * standardizedValues) / static_cast<double>(rowCount - 1);
    const Eigen::MatrixXd precision = correlation.inverse();
    Eigen::MatrixXd partial(columnCount, columnCount);
    for (Eigen::Index i = 0; i < columnCount; ++i) {
        for (Eigen::Index j = 0; j < columnCount; ++j) {
            partial(i, j) = -precision(i, j) / std::sqrt(precision(i, i) * precision(j, j));
        }
    }
    return partial;
}

RidgeFit fitRidgeRegression(const Eigen::MatrixXd& x, const Eigen::VectorXd& y, double penalty) {
    const Eigen::RowVectorXd xMean = x.colwise().mean();
    const double yMean = y.mean();
    const Eigen::MatrixXd xCentered = x.rowwise() - xMean;
    const Eigen::VectorXd yCentered = (y.array() - yMean).matrix();
    const auto featureCount = x.cols();
    Eigen::MatrixXd gram = xCentered.transpose() * xCentered;
    gram += penalty * Eigen::MatrixXd::Identity(featureCount, featureCount);
    RidgeFit fit;
    fit.coefficients = gram.ldlt().solve(xCentered.transpose() * yCentered);
    fit.intercept = yMean - (xMean * fit.coefficients)(0, 0);
    return fit;
}

double heldOutScore(const RidgeFit& fit, const Eigen::MatrixXd& xValidation, const Eigen::VectorXd& yValidation) {
    const Eigen::VectorXd predictions = ((xValidation * fit.coefficients).array() + fit.intercept).matrix();
    const Eigen::VectorXd residuals = yValidation - predictions;
    const double meanSquaredError = residuals.array().square().mean();
    const double yMean = yValidation.mean();
    const double variance = (yValidation.array() - yMean).square().mean();
    if (variance < kEpsilon) return meanSquaredError < kEpsilon ? 1.0 : -1.0;
    return 1.0 - meanSquaredError / variance;
}

// Degrees-of-freedom correction (the classical adjusted-R^2 formula) applied to heldOutScore's
// raw value, used only to *select* between candidate (lag, degree, penalty) fits and to *gate*
// whether a target's best fit is accepted at all -- never as the score reported on the resulting
// edge (callers keep using the raw, more readable heldOutScore for that). This matters
// specifically for degree >= 2: a richer feature set (more columns per source) has more room to
// fit a validation split's own sampling noise, so an unrelated source can clear a plain
// bestScore <= 0.0 gate purely from finite-sample overfitting even though it beats the null
// model by less than its extra parameters would predict by chance alone. The correction shrinks
// toward the raw score as the validation split grows relative to the feature count, and toward
// -infinity as the feature count approaches the validation split size, so a degree-1 fit (few
// parameters) is barely affected while a degree >= 2 fit on a modest sample is held to a
// meaningfully higher bar. Returns -infinity where the split is too small to support the
// adjustment (fewer validation rows than parameters).
double adjustedHeldOutScore(double rawScore, std::size_t validationRows, std::size_t featureCount) {
    const double n = static_cast<double>(validationRows);
    const double p = static_cast<double>(featureCount);
    const double denominator = n - p - 1.0;
    if (denominator <= 0.0) return -std::numeric_limits<double>::infinity();
    return 1.0 - (1.0 - rawScore) * (n - 1.0) / denominator;
}

InferenceResult inferGraph(const InferenceSeries& series, const InferenceConfig& config) {
    if (config.skeletonMethod != "partialCorrelation") {
        throw std::runtime_error("Unsupported skeleton method \"" + config.skeletonMethod + "\".");
    }
    const StandardizedSeries standardized = standardizeSeries(series);
    const Eigen::MatrixXd partial = computePartialCorrelation(standardized.values);
    const std::size_t variableCount = series.columnNames.size();
    const std::size_t rowCount = series.rows.size();

    // Stage 1: which unordered pairs are related at all.
    std::vector<std::vector<bool>> survivedSkeleton(variableCount, std::vector<bool>(variableCount, false));
    for (std::size_t i = 0; i < variableCount; ++i) {
        for (std::size_t j = i + 1; j < variableCount; ++j) {
            if (std::abs(partial(static_cast<Eigen::Index>(i), static_cast<Eigen::Index>(j))) >= config.skeletonThreshold) {
                survivedSkeleton[i][j] = survivedSkeleton[j][i] = true;
            }
        }
    }

    // Polynomial feature expansion, precomputed once per source column, independent of which
    // target/lag is later fit against it. Degree 1 reuses the existing mean+scale standardized
    // column unchanged -- this is what keeps candidateDegrees == {1} byte-identical to the
    // original linear-only behavior. Degree >= 2 uses *scale-only* normalization (v = x/sigma,
    // no mean subtraction) so that destandardizing a fitted coefficient back to original units
    // is a single division, never binomial expansion -- see docs/proposals/causalInference.md's
    // "Planned next" section for the full reasoning.
    const int maxDegree = config.candidateDegrees.empty()
        ? 1 : std::max(1, *std::max_element(config.candidateDegrees.begin(), config.candidateDegrees.end()));
    const auto columnCount = static_cast<Eigen::Index>(variableCount);
    Eigen::MatrixXd expandedFeatures(static_cast<Eigen::Index>(rowCount), columnCount * maxDegree);
    std::vector<double> degreeScale(static_cast<std::size_t>(columnCount) * static_cast<std::size_t>(maxDegree), 1.0);
    for (Eigen::Index source = 0; source < columnCount; ++source) {
        expandedFeatures.col(source * maxDegree) = standardized.values.col(source);
    }
    if (maxDegree >= 2) {
        const Eigen::MatrixXd scaleOnly = (standardized.values.array().rowwise()
            + (standardized.mean.array() / standardized.stddev.array())).matrix();
        for (Eigen::Index source = 0; source < columnCount; ++source) {
            for (int power = 2; power <= maxDegree; ++power) {
                const Eigen::VectorXd raised = scaleOnly.col(source).array().pow(static_cast<double>(power)).matrix();
                const double scale = std::sqrt(raised.array().square().mean());
                const double safeScale = scale > kEpsilon ? scale : 1.0;
                expandedFeatures.col(source * maxDegree + (power - 1)) = raised / safeScale;
                degreeScale[static_cast<std::size_t>(source) * static_cast<std::size_t>(maxDegree)
                    + static_cast<std::size_t>(power - 1)] = safeScale;
            }
        }
    }

    InferenceResult result;
    std::vector<std::vector<bool>> laggedSurvived(variableCount, std::vector<bool>(variableCount, false));

    // Stage 2: for each target, jointly fit all of its stage-1-retained sources (plus the
    // target's own lagged value as a linear-only control, so a source's correlation with the
    // target's own persistence is not mistaken for its effect) at a single lag and polynomial
    // degree chosen, together with the ridge penalty, by held-out validation loss.
    for (std::size_t target = 0; target < variableCount; ++target) {
        std::vector<std::size_t> sources;
        for (std::size_t source = 0; source < variableCount; ++source) {
            if (source != target && survivedSkeleton[target][source]) sources.push_back(source);
        }
        if (sources.empty()) continue;

        double bestScore = -std::numeric_limits<double>::infinity();
        double bestRawScore = -std::numeric_limits<double>::infinity();
        int bestLag = 0;
        int bestDegree = 1;
        RidgeFit bestFit;
        bool found = false;

        for (const int lag : config.candidateLags) {
            if (lag <= 0 || static_cast<std::size_t>(lag) >= rowCount) continue;
            const std::size_t usableRows = rowCount - static_cast<std::size_t>(lag);
            const std::size_t validationRows = static_cast<std::size_t>(
                static_cast<double>(usableRows) * config.validationFraction);
            if (validationRows >= usableRows) continue;
            const std::size_t trainRows = usableRows - validationRows;

            for (const int degree : config.candidateDegrees) {
                const int clampedDegree = std::max(1, degree);
                const std::size_t featureCount = sources.size() * static_cast<std::size_t>(clampedDegree) + 1;
                if (trainRows <= featureCount + 1 || validationRows < 1) continue;

                Eigen::MatrixXd x(static_cast<Eigen::Index>(usableRows), static_cast<Eigen::Index>(featureCount));
                Eigen::VectorXd y(static_cast<Eigen::Index>(usableRows));
                for (std::size_t row = 0; row < usableRows; ++row) {
                    const auto eigenRow = static_cast<Eigen::Index>(row);
                    const auto t = static_cast<Eigen::Index>(row + static_cast<std::size_t>(lag));
                    for (std::size_t column = 0; column < sources.size(); ++column) {
                        const auto sourceIndex = static_cast<Eigen::Index>(sources[column]);
                        for (int power = 1; power <= clampedDegree; ++power) {
                            const auto featureColumn = static_cast<Eigen::Index>(
                                column * static_cast<std::size_t>(clampedDegree) + static_cast<std::size_t>(power - 1));
                            x(eigenRow, featureColumn) = expandedFeatures(eigenRow, sourceIndex * maxDegree + (power - 1));
                        }
                    }
                    x(eigenRow, static_cast<Eigen::Index>(sources.size() * static_cast<std::size_t>(clampedDegree))) =
                        standardized.values(eigenRow, static_cast<Eigen::Index>(target));
                    y(eigenRow) = standardized.values(t, static_cast<Eigen::Index>(target));
                }

                const Eigen::MatrixXd xTrain = x.topRows(static_cast<Eigen::Index>(trainRows));
                const Eigen::VectorXd yTrain = y.topRows(static_cast<Eigen::Index>(trainRows));
                const Eigen::MatrixXd xValidation = x.bottomRows(static_cast<Eigen::Index>(validationRows));
                const Eigen::VectorXd yValidation = y.bottomRows(static_cast<Eigen::Index>(validationRows));

                for (const double penalty : config.ridgePenalties) {
                    const RidgeFit fit = fitRidgeRegression(xTrain, yTrain, penalty);
                    const double rawScore = heldOutScore(fit, xValidation, yValidation);
                    const double score = adjustedHeldOutScore(rawScore, validationRows, featureCount);
                    if (score > bestScore) {
                        bestScore = score;
                        bestRawScore = rawScore;
                        bestLag = lag;
                        bestDegree = clampedDegree;
                        bestFit = fit;
                        found = true;
                    }
                }
            }
        }

        // A non-positive *adjusted* score means this target's joint fit does not beat predicting
        // its own held-out mean by more than its parameter count would explain by chance alone --
        // every one of its coefficients is fitted to noise at that point, no matter how large any
        // individual one looks, so nothing is extracted from it. Without this gate, a target
        // whose own dynamics are already well explained by its self-lag term can still show a
        // small but nonzero *standardized* coefficient on an unrelated source purely from
        // finite-sample overfitting under a weak ridge penalty, even though the joint fit is
        // clearly worse than the null model once judged against its own complexity -- richer
        // (degree >= 2) feature sets are the most exposed to this, since they add parameters
        // without necessarily adding genuine signal. See adjustedHeldOutScore's comment.
        if (!found || bestScore <= 0.0) continue;

        const double sigmaTarget = standardized.stddev(static_cast<Eigen::Index>(target));
        const double muTarget = standardized.mean(static_cast<Eigen::Index>(target));

        // The joint intercept, de-standardized, covers every accepted source's degree-1 term
        // (only degree 1 was mean-centered -- see the per-source loop below, where degree >= 2
        // terms contribute no intercept correction at all) and the discarded self-lag control
        // term together; split evenly across this target's accepted edges so their sum
        // reconstructs it exactly, matching how Konjugate sums every edge's contribution into
        // the same derivative (projectSchema.md: "Multiple relationships targeting the same
        // state contribute additively").
        double jointInterceptOriginal = muTarget + sigmaTarget * bestFit.intercept;
        for (std::size_t column = 0; column < sources.size(); ++column) {
            const double linearCoefficient = bestFit.coefficients(
                static_cast<Eigen::Index>(column * static_cast<std::size_t>(bestDegree)));
            const double sourceSigma = standardized.stddev(static_cast<Eigen::Index>(sources[column]));
            const double sourceMu = standardized.mean(static_cast<Eigen::Index>(sources[column]));
            jointInterceptOriginal -= (linearCoefficient * sigmaTarget / sourceSigma) * sourceMu;
        }
        const double selfLagCoefficient = bestFit.coefficients(
            static_cast<Eigen::Index>(sources.size() * static_cast<std::size_t>(bestDegree)));
        jointInterceptOriginal -= selfLagCoefficient * muTarget;

        for (std::size_t column = 0; column < sources.size(); ++column) {
            const std::size_t source = sources[column];
            const double sigmaSource = standardized.stddev(static_cast<Eigen::Index>(source));

            // Accept or reject the whole source based on the *aggregate* (L2-norm across
            // degrees) standardized coefficient, not each degree term individually -- a curved
            // relationship is one edge with a multi-term equation, not independent per-degree
            // decisions (mirrors the reference prototype's own edge_scores()).
            std::vector<PolynomialTerm> terms;
            double aggregateSquared = 0.0;
            for (int power = 1; power <= bestDegree; ++power) {
                const double standardizedCoefficient = bestFit.coefficients(static_cast<Eigen::Index>(
                    column * static_cast<std::size_t>(bestDegree) + static_cast<std::size_t>(power - 1)));
                aggregateSquared += standardizedCoefficient * standardizedCoefficient;
                double coefficientOriginal;
                if (power == 1) {
                    coefficientOriginal = standardizedCoefficient * sigmaTarget / sigmaSource;
                } else {
                    const double scale = degreeScale[static_cast<std::size_t>(source) * static_cast<std::size_t>(maxDegree)
                        + static_cast<std::size_t>(power - 1)];
                    coefficientOriginal = standardizedCoefficient * sigmaTarget / (std::pow(sigmaSource, power) * scale);
                }
                terms.push_back({power, coefficientOriginal});
            }
            if (std::sqrt(aggregateSquared) < config.coefficientThreshold) continue;
            laggedSurvived[target][source] = true;

            InferredEdge edge;
            edge.sourceColumn = series.columnNames[source];
            edge.targetColumn = series.columnNames[target];
            edge.lag = bestLag;
            edge.terms = std::move(terms);
            edge.intercept = jointInterceptOriginal / static_cast<double>(sources.size());
            edge.score = bestRawScore;
            edge.provenance = "lagged";
            result.edges.push_back(std::move(edge));
        }
    }

    // Fallback tier: a stage-1 survivor with no stage-2 evidence in either direction still
    // produces two directed edges, built from the symmetric partial-correlation coefficient
    // rather than a lagged one, tagged provenance == "correlationOnly" so they never read as an
    // ordinary lagged/dynamical edge downstream. Always linear (degree 1) -- partial correlation
    // is an inherently linear measure, so there is no natural nonlinear counterpart to it here.
    for (std::size_t i = 0; i < variableCount; ++i) {
        for (std::size_t j = i + 1; j < variableCount; ++j) {
            if (!survivedSkeleton[i][j] || laggedSurvived[i][j] || laggedSurvived[j][i]) continue;

            const double coefficientValue = partial(static_cast<Eigen::Index>(i), static_cast<Eigen::Index>(j));
            for (const auto& [target, source] : std::vector<std::pair<std::size_t, std::size_t>>{{i, j}, {j, i}}) {
                const double sigmaTarget = standardized.stddev(static_cast<Eigen::Index>(target));
                const double sigmaSource = standardized.stddev(static_cast<Eigen::Index>(source));
                const double muTarget = standardized.mean(static_cast<Eigen::Index>(target));
                const double muSource = standardized.mean(static_cast<Eigen::Index>(source));
                const double coefficientOriginal = coefficientValue * sigmaTarget / sigmaSource;

                InferredEdge edge;
                edge.sourceColumn = series.columnNames[source];
                edge.targetColumn = series.columnNames[target];
                edge.lag = 0;
                edge.terms = {{1, coefficientOriginal}};
                edge.intercept = muTarget - coefficientOriginal * muSource;
                edge.score = std::abs(coefficientValue);
                edge.provenance = "correlationOnly";
                result.edges.push_back(std::move(edge));
            }
        }
    }

    return result;
}

}
