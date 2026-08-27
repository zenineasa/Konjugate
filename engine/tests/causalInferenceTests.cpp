/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "causalInference.hpp"
#include <cmath>
#include <iostream>
#include <random>
#include <stdexcept>
#include <string>

namespace {

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

bool approxEqual(double a, double b, double tolerance = 1e-6) {
    return std::abs(a - b) <= tolerance;
}

const konjugate::InferredEdge* findEdge(const konjugate::InferenceResult& result,
    const std::string& source, const std::string& target) {
    for (const auto& edge : result.edges) {
        if (edge.sourceColumn == source && edge.targetColumn == target) return &edge;
    }
    return nullptr;
}

const konjugate::SelfTerm* findSelfTerm(const konjugate::InferenceResult& result, const std::string& targetColumn) {
    for (const auto& term : result.selfTerms) {
        if (term.targetColumn == targetColumn) return &term;
    }
    return nullptr;
}

// The degree-1 (linear) term's coefficient, or 0 if the edge has none -- every test in this file
// that predates the polynomial extension only ever produced a single linear term, so this is a
// drop-in stand-in for the old InferredEdge::coefficient scalar field.
double linearCoefficient(const konjugate::InferredEdge& edge) {
    for (const auto& term : edge.terms) if (term.degree == 1) return term.coefficient;
    return 0.0;
}

// A fixed-seed generator, used throughout instead of a smooth deterministic formula (e.g. a sum
// of sinusoids) for "noise" terms below. Reproducibility (same seed -> same sequence every run)
// is kept, but the earlier sinusoidal approach was tried first and failed: a smooth curve is
// strongly autocorrelated with itself, which let it leak information across lags in exactly the
// way a real noise term must not -- see the comment on makeLaggedPairSeries for the concrete
// failure this caused.
double noiseSample(std::mt19937& generator, double scale) {
    static std::normal_distribution<double> standardNormal(0.0, 1.0);
    return scale * standardNormal(generator);
}

konjugate::InferenceSeries makeChainSeries(std::size_t rowCount) {
    // x1 -> x2 -> x3, with x3 having no direct dependence on x1. A well-known property of this
    // chain is x1 _||_ x3 | x2, so the partial correlation between columns 0 and 2 should be
    // small while both adjacent pairs are large -- this checks that computePartialCorrelation()
    // actually removes the indirect/mediated correlation rather than reporting raw pairwise
    // correlation.
    std::mt19937 generator(1001);
    konjugate::InferenceSeries series;
    series.columnNames = {"x1", "x2", "x3"};
    for (std::size_t t = 0; t < rowCount; ++t) {
        const double x1 = static_cast<double>(t) * 0.2 + noiseSample(generator, 0.15);
        const double x2 = 1.5 * x1 + 0.5 + noiseSample(generator, 0.15);
        const double x3 = -0.8 * x2 + 1.0 + noiseSample(generator, 0.15);
        series.rows.push_back({x1, x2, x3});
    }
    return series;
}

konjugate::InferenceSeries makeLaggedPairSeries(std::size_t rowCount) {
    // a follows a genuine AR(1) process (a[t] = 0.5*a[t-1] + drivingNoise[t]) driven by i.i.d.
    // noise, so a single self-lag control term fully captures a's own dynamics: a[t] _||_ a[t-2]
    // | a[t-1] for a true first-order Markov process with independent innovations. This matters
    // here specifically: an earlier version of this test drove the AR(1) recursion with a smooth
    // deterministic sinusoid instead of independent noise, which is autocorrelated with itself
    // by construction -- that let b's lag, which embeds a[t-2] via b[t-1] = 3*a[t-2], spuriously
    // "predict" a[t] beyond what the self-lag term absorbs, purely because the "noise" injected
    // at each step wasn't actually independent of the noise baked into a[t-2]. True (independent)
    // noise removes that channel.
    // b[t] = 3*a[t-1] + noise, and a does not depend on b at all -- a clean one-directional
    // lagged relationship with a known approximate coefficient.
    std::mt19937 generator(2002);
    konjugate::InferenceSeries series;
    series.columnNames = {"a", "b"};
    std::vector<double> a(rowCount);
    a[0] = 0.2;
    for (std::size_t t = 1; t < rowCount; ++t) {
        a[t] = 0.5 * a[t - 1] + noiseSample(generator, 0.3);
    }
    for (std::size_t t = 0; t < rowCount; ++t) {
        const double previousA = t > 0 ? a[t - 1] : a[0];
        series.rows.push_back({a[t], 3.0 * previousA + noiseSample(generator, 0.05)});
    }
    return series;
}

konjugate::InferenceSeries makeQuadraticPairSeries(std::size_t rowCount) {
    // Same AR(1)-driven "a" as makeLaggedPairSeries above, but b[t] = 2*a[t-1] + 0.5*a[t-1]^2
    // *exactly* -- no noise term on b at all. This is the test that actually proves the
    // scale-only destandardization math for degree >= 2 terms (see causalInference.hpp's
    // InferenceConfig::candidateDegrees comment): with a known, exact relationship, the
    // recovered polynomial coefficients must land close to the true (2.0, 0.5), not just
    // "plausible."
    //
    // Needs more rows than makeLaggedPairSeries's 60: b's lag is a near-deterministic function of
    // a[t-2], and the degree-2 feature it contributes gives ridge's inevitable shrinkage of the
    // self-lag control extra room to leave a residual that a richer feature set can latch onto,
    // producing a spurious b -> a edge at smaller sample sizes even after inferGraph's
    // degrees-of-freedom-adjusted acceptance gate. 300 rows was confirmed clean across several
    // independent generator seeds at this construction; smaller counts were not.
    std::mt19937 generator(5005);
    konjugate::InferenceSeries series;
    series.columnNames = {"a", "b"};
    std::vector<double> a(rowCount);
    a[0] = 0.2;
    for (std::size_t t = 1; t < rowCount; ++t) a[t] = 0.5 * a[t - 1] + noiseSample(generator, 0.3);
    for (std::size_t t = 0; t < rowCount; ++t) {
        const double previousA = t > 0 ? a[t - 1] : a[0];
        series.rows.push_back({a[t], 2.0 * previousA + 0.5 * previousA * previousA});
    }
    return series;
}

konjugate::InferenceSeries makeMutualPairSeries(std::size_t rowCount) {
    // c[t] = 0.6*d[t-1] + noise and d[t] = 0.6*c[t-1] + noise, driven by independent noise: a
    // stable coupled recursion (eigenvalues of [[0,0.6],[0.6,0]] are ±0.6) where each variable
    // genuinely depends on the other's previous value, so both directions should survive stage 2.
    std::mt19937 generator(3003);
    konjugate::InferenceSeries series;
    series.columnNames = {"c", "d"};
    std::vector<double> c(rowCount), d(rowCount);
    c[0] = 1.0;
    d[0] = -1.0;
    for (std::size_t t = 1; t < rowCount; ++t) {
        const double noiseC = noiseSample(generator, 0.05);
        const double noiseD = noiseSample(generator, 0.05);
        c[t] = 0.6 * d[t - 1] + noiseC;
        d[t] = 0.6 * c[t - 1] + noiseD;
    }
    for (std::size_t t = 0; t < rowCount; ++t) series.rows.push_back({c[t], d[t]});
    return series;
}

// b has a genuinely nonzero self-lag (unlike makeLaggedPairSeries's b, whose true self-lag is
// exactly 0) so the continuous-time self-term transform has a real, known-nonzero value to
// recover: selfLagCoefficient ~= 0.4 -> selfRate = (0.4 - 1)/timeStep, crossCoefficient ~= 2.0 ->
// crossRate = 2.0/timeStep.
konjugate::InferenceSeries makeContinuousTimeSeries(std::size_t rowCount) {
    std::mt19937 generator(7007);
    konjugate::InferenceSeries series;
    series.columnNames = {"source", "target"};
    std::vector<double> source(rowCount), target(rowCount);
    source[0] = 0.2;
    target[0] = 0.1;
    for (std::size_t t = 1; t < rowCount; ++t) source[t] = 0.5 * source[t - 1] + noiseSample(generator, 0.3);
    for (std::size_t t = 1; t < rowCount; ++t) {
        target[t] = 0.4 * target[t - 1] + 2.0 * source[t - 1] + noiseSample(generator, 0.05);
    }
    for (std::size_t t = 0; t < rowCount; ++t) series.rows.push_back({source[t], target[t]});
    return series;
}

// Same AR(1)-driven "source" as makeContinuousTimeSeries, but target now also has a genuine
// bilinear (non-separable) term: target[t] = 0.4*target[t-1] + 2.0*source[t-1] +
// 0.8*source[t-1]*target[t-1] + noise. The 0.8 coefficient cannot be represented as
// g(source) + h(target) -- no combination of an edge (source-only) and the self-lag term
// (target-only) can reconstruct it -- so recovering it is exactly what
// InferenceConfig::includeInteractionTerms exists to test. The 2.0 linear term stays large
// enough that stage 1's linear-correlation skeleton still admits the pair regardless of the
// interaction term (a separate, known limitation -- see
// docs/proposals/causalInferenceInteractionTerms.md's "Stage-1 skeleton blind spot" -- not what
// this test is checking).
konjugate::InferenceSeries makeInteractionPairSeries(std::size_t rowCount) {
    std::mt19937 generator(9009);
    konjugate::InferenceSeries series;
    series.columnNames = {"source", "target"};
    std::vector<double> source(rowCount), target(rowCount);
    source[0] = 0.2;
    target[0] = 0.1;
    for (std::size_t t = 1; t < rowCount; ++t) source[t] = 0.5 * source[t - 1] + noiseSample(generator, 0.3);
    for (std::size_t t = 1; t < rowCount; ++t) {
        target[t] = 0.4 * target[t - 1] + 2.0 * source[t - 1] + 0.8 * source[t - 1] * target[t - 1]
            + noiseSample(generator, 0.05);
    }
    for (std::size_t t = 0; t < rowCount; ++t) series.rows.push_back({source[t], target[t]});
    return series;
}

void parseInferenceCsvParsesHeaderAndRows() {
    const std::string csv = "time,a,b\n0,1,10\n1,2,20\n2,3,30\n3,4,40\n4,5,50\n"
        "5,6,60\n6,7,70\n7,8,80\n8,9,90\n9,10,100\n";
    const auto series = konjugate::parseInferenceCsv(csv);
    require(series.columnNames.size() == 2, "Expected two variable columns.");
    require(series.columnNames[0] == "a" && series.columnNames[1] == "b", "Column names should exclude the time column.");
    require(series.rows.size() == 10, "Expected ten data rows.");
    require(approxEqual(series.rows[0][0], 1.0) && approxEqual(series.rows[0][1], 10.0), "First row values did not parse correctly.");
    require(approxEqual(series.rows[9][0], 10.0) && approxEqual(series.rows[9][1], 100.0), "Last row values did not parse correctly.");
}

void parseInferenceCsvCapturesTimeStep() {
    const std::string csv = "time,a\n0,1\n2.5,2\n5,3\n7.5,4\n10,5\n12.5,6\n15,7\n17.5,8\n20,9\n22.5,10\n";
    const auto series = konjugate::parseInferenceCsv(csv);
    require(approxEqual(series.timeStep, 2.5), "The parsed time step should match the CSV's own regular spacing.");
}

void parseInferenceCsvRejectsRaggedRow() {
    const std::string csv = "time,a,b\n0,1,10\n1,2\n2,3,30\n3,4,40\n4,5,50\n5,6,60\n6,7,70\n7,8,80\n8,9,90\n9,10,100\n";
    bool threw = false;
    try {
        konjugate::parseInferenceCsv(csv);
    } catch (const std::runtime_error&) {
        threw = true;
    }
    require(threw, "A ragged row should be rejected.");
}

void parseInferenceCsvRejectsNonNumericCell() {
    const std::string csv = "time,a,b\n0,1,10\n1,two,20\n2,3,30\n3,4,40\n4,5,50\n5,6,60\n6,7,70\n7,8,80\n8,9,90\n9,10,100\n";
    bool threw = false;
    try {
        konjugate::parseInferenceCsv(csv);
    } catch (const std::runtime_error&) {
        threw = true;
    }
    require(threw, "A non-numeric cell should be rejected.");
}

void parseInferenceCsvRejectsUnevenSpacing() {
    const std::string csv = "time,a,b\n0,1,10\n1,2,20\n2,3,30\n4,4,40\n5,5,50\n6,6,60\n7,7,70\n8,8,80\n9,9,90\n10,10,100\n";
    bool threw = false;
    try {
        konjugate::parseInferenceCsv(csv);
    } catch (const std::runtime_error&) {
        threw = true;
    }
    require(threw, "An unevenly spaced time column should be rejected.");
}

void parseInferenceCsvRejectsConstantColumn() {
    const std::string csv = "time,a,b\n0,1,10\n1,2,10\n2,3,10\n3,4,10\n4,5,10\n5,6,10\n6,7,10\n7,8,10\n8,9,10\n9,10,10\n";
    bool threw = false;
    try {
        konjugate::parseInferenceCsv(csv);
    } catch (const std::runtime_error&) {
        threw = true;
    }
    require(threw, "A constant column should be rejected.");
}

void parseInferenceCsvRejectsTooFewRows() {
    const std::string csv = "time,a\n0,1\n1,2\n2,3\n";
    bool threw = false;
    try {
        konjugate::parseInferenceCsv(csv);
    } catch (const std::runtime_error&) {
        threw = true;
    }
    require(threw, "Fewer than the minimum row count should be rejected.");
}

void standardizeSeriesMatchesHandComputedMoments() {
    konjugate::InferenceSeries series;
    series.columnNames = {"x"};
    for (double value : {1.0, 2.0, 3.0, 4.0, 5.0}) series.rows.push_back({value});
    const auto standardized = konjugate::standardizeSeries(series);
    require(approxEqual(standardized.mean(0), 3.0), "Mean should be 3.0.");
    require(approxEqual(standardized.stddev(0), std::sqrt(2.5)), "Sample standard deviation should be sqrt(2.5).");
    require(approxEqual(standardized.values(0, 0), (1.0 - 3.0) / std::sqrt(2.5)), "First standardized value is incorrect.");
    require(approxEqual(standardized.values(2, 0), 0.0), "The middle value should standardize to exactly zero.");
    require(approxEqual(standardized.values(4, 0), (5.0 - 3.0) / std::sqrt(2.5)), "Last standardized value is incorrect.");
}

void partialCorrelationRemovesIndirectChainDependence() {
    const auto series = makeChainSeries(60);
    const auto standardized = konjugate::standardizeSeries(series);
    const auto partial = konjugate::computePartialCorrelation(standardized.values);
    const double p12 = std::abs(partial(0, 1));
    const double p23 = std::abs(partial(1, 2));
    const double p13 = std::abs(partial(0, 2));
    require(p12 > 0.5, "x1-x2 should show a strong direct partial correlation.");
    require(p23 > 0.5, "x2-x3 should show a strong direct partial correlation.");
    require(p13 < 0.3, "x1-x3 should show a weak partial correlation once x2 is conditioned on.");
    require(p13 < p12 && p13 < p23, "The mediated pair's partial correlation should be smaller than either direct pair's.");
}

void fitRidgeRegressionMatchesClosedFormSolution() {
    Eigen::MatrixXd x(5, 1);
    x << 1, 2, 3, 4, 5;
    Eigen::VectorXd y(5);
    y << 5, 7, 9, 11, 13; // y = 2x + 3 exactly

    const auto unpenalized = konjugate::fitRidgeRegression(x, y, 0.0);
    require(approxEqual(unpenalized.coefficients(0), 2.0), "Unpenalized ridge should recover the exact slope of 2.0.");
    require(approxEqual(unpenalized.intercept, 3.0), "Unpenalized ridge should recover the exact intercept of 3.0.");

    // Hand-derived closed form for this centered 1-feature case: beta = Sum((x-xbar)(y-ybar)) /
    // (Sum((x-xbar)^2) + penalty) = 20 / (10 + 10) = 1.0, intercept = ybar - xbar*beta = 9 - 3 = 6.0.
    const auto penalized = konjugate::fitRidgeRegression(x, y, 10.0);
    require(approxEqual(penalized.coefficients(0), 1.0), "Penalized ridge did not match the hand-derived closed form.");
    require(approxEqual(penalized.intercept, 6.0), "Penalized ridge's intercept did not match the hand-derived closed form.");
}

void heldOutScoreIsOneForAPerfectFitAndZeroForTheNullModel() {
    konjugate::RidgeFit perfectFit;
    perfectFit.coefficients = Eigen::VectorXd(1);
    perfectFit.coefficients(0) = 2.0;
    perfectFit.intercept = 3.0;
    Eigen::MatrixXd xValidation(2, 1);
    xValidation << 6, 7;
    Eigen::VectorXd yValidation(2);
    yValidation << 15, 17; // exactly 2x + 3
    require(approxEqual(konjugate::heldOutScore(perfectFit, xValidation, yValidation), 1.0),
        "A perfectly matching fit should score exactly 1.0.");

    konjugate::RidgeFit nullFit;
    nullFit.coefficients = Eigen::VectorXd(1);
    nullFit.coefficients(0) = 0.0;
    nullFit.intercept = 20.0; // the mean of yValidationForNull below
    Eigen::MatrixXd xIrrelevant(3, 1);
    xIrrelevant << 1, 2, 3;
    Eigen::VectorXd yValidationForNull(3);
    yValidationForNull << 10, 20, 30;
    require(approxEqual(konjugate::heldOutScore(nullFit, xIrrelevant, yValidationForNull), 0.0),
        "Predicting the mean with no explanatory power should score exactly 0.0.");
}

void inferGraphFindsAOneDirectionalLaggedEdge() {
    const auto series = makeLaggedPairSeries(60);
    konjugate::InferenceConfig config;
    const auto result = konjugate::inferGraph(series, config);

    const auto* aToB = findEdge(result, "a", "b");
    require(aToB != nullptr, "Expected an edge from a to b.");
    require(aToB->provenance == "continuousLagged", "The a-to-b edge should be backed by lagged evidence.");
    require(aToB->lag >= 1, "The a-to-b edge should have a positive lag.");
    require(linearCoefficient(*aToB) > 1.5 && linearCoefficient(*aToB) < 4.5, "The a-to-b coefficient should be roughly 3.0.");
    require(aToB->score > 0.5, "The a-to-b fit should explain a majority of the held-out variance.");

    require(findEdge(result, "b", "a") == nullptr, "b should not Granger-cause a in this construction.");
}

void inferGraphFindsBothDirectionsForAMutualRelationship() {
    const auto series = makeMutualPairSeries(80);
    konjugate::InferenceConfig config;
    const auto result = konjugate::inferGraph(series, config);

    const auto* dToC = findEdge(result, "d", "c");
    const auto* cToD = findEdge(result, "c", "d");
    require(dToC != nullptr && cToD != nullptr, "Expected edges in both directions for a genuinely mutual relationship.");
    require(dToC->provenance == "continuousLagged" && cToD->provenance == "continuousLagged", "Both edges should be backed by lagged evidence.");
}

void inferGraphFallsBackToCorrelationOnlyEdgesWhenNoDirectionClearsTheThreshold() {
    const auto series = makeLaggedPairSeries(60);
    konjugate::InferenceConfig config;
    config.coefficientThreshold = 5.0; // higher than the ~3.0 true coefficient, so stage 2 accepts nothing
    const auto result = konjugate::inferGraph(series, config);

    const auto* aToB = findEdge(result, "a", "b");
    const auto* bToA = findEdge(result, "b", "a");
    require(aToB != nullptr && bToA != nullptr, "A correlated pair with no direction clearing the threshold should still produce two edges.");
    require(aToB->provenance == "correlationOnly" && bToA->provenance == "correlationOnly",
        "Both fallback edges should be tagged correlationOnly, not continuousLagged.");
    // Both coefficients are de-standardized from the same shared, symmetric partial-correlation
    // value (coefficient = partialCorrelation * sigmaTarget / sigmaSource), so they must agree
    // in sign even though the two sigma ratios differ.
    require((linearCoefficient(*aToB) > 0.0) == (linearCoefficient(*bToA) > 0.0),
        "Both fallback coefficients should share the sign of the underlying partial correlation.");
    require(std::abs(linearCoefficient(*aToB)) > 1e-6 && std::abs(linearCoefficient(*bToA)) > 1e-6,
        "Neither fallback coefficient should be degenerately zero.");
}

void inferGraphScalesCorrelationOnlyCoefficientsByTimeStep() {
    // Every other existing test builds its InferenceSeries directly (not via parseInferenceCsv),
    // so timeStep defaults to 1.0 and a missing timeStep scaling would be numerically invisible.
    // Fit the same series at two different timeSteps and confirm the coefficient scales exactly
    // as 1/timeStep -- this is the one thing that distinguishes "scaled" from "not scaled" here.
    auto series = makeLaggedPairSeries(60);
    konjugate::InferenceConfig config;
    config.coefficientThreshold = 5.0; // same as above -- forces the correlationOnly fallback

    series.timeStep = 1.0;
    const auto atOne = konjugate::inferGraph(series, config);
    const auto* aToBAtOne = findEdge(atOne, "a", "b");
    require(aToBAtOne != nullptr, "Expected a correlationOnly a -> b edge at timeStep 1.");

    series.timeStep = 2.0;
    const auto atTwo = konjugate::inferGraph(series, config);
    const auto* aToBAtTwo = findEdge(atTwo, "a", "b");
    require(aToBAtTwo != nullptr, "Expected a correlationOnly a -> b edge at timeStep 2.");

    require(approxEqual(linearCoefficient(*aToBAtTwo), linearCoefficient(*aToBAtOne) / 2.0, 1e-9),
        "Doubling timeStep should exactly halve the correlationOnly coefficient (rate = coefficient/timeStep).");
    require(approxEqual(aToBAtTwo->intercept, aToBAtOne->intercept / 2.0, 1e-9),
        "Doubling timeStep should exactly halve the correlationOnly intercept too.");
}

void inferGraphRecoversAnExactQuadraticRelationship() {
    const auto series = makeQuadraticPairSeries(300);
    konjugate::InferenceConfig config;
    config.candidateDegrees = {1, 2};
    const auto result = konjugate::inferGraph(series, config);

    const auto* aToB = findEdge(result, "a", "b");
    require(aToB != nullptr, "Expected an edge from a to b.");
    require(aToB->provenance == "continuousLagged", "The a-to-b edge should be backed by lagged evidence.");
    require(aToB->score > 0.9, "An exact (noise-free) relationship should fit almost perfectly.");
    require(findEdge(result, "b", "a") == nullptr, "b should not Granger-cause a in this construction.");

    double linear = 0.0;
    double quadratic = 0.0;
    for (const auto& term : aToB->terms) {
        if (term.degree == 1) linear = term.coefficient;
        else if (term.degree == 2) quadratic = term.coefficient;
    }
    require(approxEqual(linear, 2.0, 0.2), "The recovered linear coefficient should be close to the true value of 2.0.");
    require(approxEqual(quadratic, 0.5, 0.1), "The recovered quadratic coefficient should be close to the true value of 0.5.");
}

void inferGraphWithDefaultConfigStaysLinearOnly() {
    // candidateDegrees defaults to {1} -- even fit against a genuinely quadratic relationship,
    // the result must never contain a degree >= 2 term, since this is what keeps existing
    // callers (and every other test in this file, all written before this extension) getting
    // byte-identical behavior to the original linear-only implementation.
    const auto series = makeQuadraticPairSeries(300);
    konjugate::InferenceConfig config;
    const auto result = konjugate::inferGraph(series, config);
    const auto* aToB = findEdge(result, "a", "b");
    require(aToB != nullptr, "Expected an edge from a to b even under a linear-only fit.");
    for (const auto& term : aToB->terms) {
        require(term.degree == 1, "candidateDegrees defaulting to {1} should never produce a degree >= 2 term.");
    }
}

void inferGraphRejectsCandidateLagsOtherThanOne() {
    const auto series = makeContinuousTimeSeries(300);
    konjugate::InferenceConfig config;
    config.candidateLags = {1, 2, 3};
    bool threw = false;
    try {
        konjugate::inferGraph(series, config);
    } catch (const std::runtime_error&) {
        threw = true;
    }
    require(threw, "candidateLags other than exactly {1} should be rejected, not silently clamped -- see "
        "InferenceConfig::candidateLags's doc comment for why lag > 1 could never produce a usable equation anyway.");
}

void inferGraphTransformsCoefficientsAndSelfLagIntoContinuousRatesExactly() {
    // True discrete relationship: target[t] = 0.4*target[t-1] + 2.0*source[t-1] + noise, timeStep
    // == 1.0 (a hand-built series, not parsed from CSV). The exact-Euler-match transform predicts
    // crossRate == crossCoefficient/timeStep ~= 2.0, and selfRate == (selfLagCoefficient -
    // 1.0)/timeStep ~= (0.4 - 1.0)/1.0 == -0.6.
    const auto series = makeContinuousTimeSeries(300);
    konjugate::InferenceConfig config;
    const auto result = konjugate::inferGraph(series, config);

    const auto* sourceToTarget = findEdge(result, "source", "target");
    require(sourceToTarget != nullptr, "Expected a source -> target edge.");
    require(sourceToTarget->provenance == "continuousLagged",
        "A lagged edge should be tagged continuousLagged, so it can never be confused with a raw discrete "
        "coefficient in the same terms[].coefficient field.");
    require(approxEqual(linearCoefficient(*sourceToTarget), 2.0, 0.2),
        "The continuous-time cross rate should be close to the true value of 2.0 (coefficient/timeStep with timeStep == 1).");

    require(findEdge(result, "target", "source") == nullptr,
        "The self-lag rate must not be emitted as a target -> target (or any) edge -- self-loop edges are not valid "
        "in Konjugate's schema.");
    const auto* targetSelf = findSelfTerm(result, "target");
    require(targetSelf != nullptr, "Expected a self-term for target.");
    require(approxEqual(targetSelf->rate, -0.6, 0.2),
        "The continuous-time self rate should be close to (0.4 - 1)/1 == -0.6.");
}

void inferGraphAppliesTheRateTransformToPolynomialDegrees() {
    // Unlike a matrix-logarithm-based conversion (tried and rejected -- see
    // docs/proposals/continuousTimeConversion.md), the exact-Euler-match transform is exact for
    // any polynomial degree: rate = coefficient/timeStep applies per term, with no restriction on
    // candidateDegrees.
    const auto series = makeQuadraticPairSeries(300);
    konjugate::InferenceConfig config;
    config.candidateDegrees = {1, 2};
    const auto result = konjugate::inferGraph(series, config);

    const auto* aToB = findEdge(result, "a", "b");
    require(aToB != nullptr, "Expected an edge from a to b.");
    require(aToB->provenance == "continuousLagged", "The a-to-b edge should be tagged continuousLagged.");

    double linear = 0.0;
    double quadratic = 0.0;
    for (const auto& term : aToB->terms) {
        if (term.degree == 1) linear = term.coefficient;
        else if (term.degree == 2) quadratic = term.coefficient;
    }
    require(approxEqual(linear, 2.0, 0.2), "The continuous-time linear rate should be close to the true value of 2.0.");
    require(approxEqual(quadratic, 0.5, 0.1), "The continuous-time quadratic rate should be close to the true value of 0.5.");
}

void inferGraphOmitsInteractionTermsByDefault() {
    // includeInteractionTerms defaults to false -- even fit against a series with a genuine
    // bilinear term, no edge should carry one, and the fit should behave the same as if the
    // interaction feature didn't exist at all (existing linear/self-lag recovery still works,
    // just without the coefficient the bilinear term would otherwise explain).
    const auto series = makeInteractionPairSeries(400);
    konjugate::InferenceConfig config;
    const auto result = konjugate::inferGraph(series, config);
    const auto* sourceToTarget = findEdge(result, "source", "target");
    require(sourceToTarget != nullptr, "Expected a source -> target edge even without interaction terms enabled.");
    require(!sourceToTarget->interaction.has_value(),
        "No edge should carry an interaction term when includeInteractionTerms is left at its default of false.");
}

void inferGraphRecoversANonSeparableInteractionTerm() {
    // With includeInteractionTerms enabled, stage 2's grid search should select the
    // interaction-on fit for this target (it genuinely explains more held-out variance) and
    // recover a coefficient close to the true 0.8 -- something no PolynomialTerm/SelfTerm
    // decomposition could represent, since 0.8*source*target isn't separable into g(source) +
    // h(target). This is the primary regression test for
    // docs/proposals/causalInferenceInteractionTerms.md.
    const auto series = makeInteractionPairSeries(400);
    konjugate::InferenceConfig config;
    config.includeInteractionTerms = true;
    const auto result = konjugate::inferGraph(series, config);

    const auto* sourceToTarget = findEdge(result, "source", "target");
    require(sourceToTarget != nullptr, "Expected a source -> target edge.");
    require(sourceToTarget->provenance == "continuousLagged", "The edge should be backed by lagged evidence.");
    require(sourceToTarget->interaction.has_value(),
        "The winning fit for this target should have selected interaction terms via held-out score.");
    require(approxEqual(sourceToTarget->interaction->coefficient, 0.8, 0.3),
        "The recovered interaction rate should be reasonably close to the true value of 0.8.");
    require(approxEqual(linearCoefficient(*sourceToTarget), 2.0, 0.3),
        "The linear term should still be recovered close to its true value of 2.0 alongside the interaction term.");

    const auto* targetSelf = findSelfTerm(result, "target");
    require(targetSelf != nullptr, "Expected a self-term for target.");
    require(approxEqual(targetSelf->rate, -0.6, 0.3),
        "The self rate should still be close to (0.4 - 1)/1 == -0.6 with interaction terms enabled.");
}

}

int main() {
    try {
        parseInferenceCsvParsesHeaderAndRows();
        parseInferenceCsvCapturesTimeStep();
        parseInferenceCsvRejectsRaggedRow();
        parseInferenceCsvRejectsNonNumericCell();
        parseInferenceCsvRejectsUnevenSpacing();
        parseInferenceCsvRejectsConstantColumn();
        parseInferenceCsvRejectsTooFewRows();
        standardizeSeriesMatchesHandComputedMoments();
        partialCorrelationRemovesIndirectChainDependence();
        fitRidgeRegressionMatchesClosedFormSolution();
        heldOutScoreIsOneForAPerfectFitAndZeroForTheNullModel();
        inferGraphFindsAOneDirectionalLaggedEdge();
        inferGraphFindsBothDirectionsForAMutualRelationship();
        inferGraphFallsBackToCorrelationOnlyEdgesWhenNoDirectionClearsTheThreshold();
        inferGraphRecoversAnExactQuadraticRelationship();
        inferGraphWithDefaultConfigStaysLinearOnly();
        inferGraphRejectsCandidateLagsOtherThanOne();
        inferGraphTransformsCoefficientsAndSelfLagIntoContinuousRatesExactly();
        inferGraphAppliesTheRateTransformToPolynomialDegrees();
        inferGraphScalesCorrelationOnlyCoefficientsByTimeStep();
        inferGraphOmitsInteractionTermsByDefault();
        inferGraphRecoversANonSeparableInteractionTerm();
        std::cout << "Graph inference tests passed.\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
