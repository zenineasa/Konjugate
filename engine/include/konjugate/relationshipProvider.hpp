/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace konjugate::sdk::v1 {

struct ScalarPort {
    std::string key;
    std::string name;
    std::string unit;
};

struct RelationshipDescription {
    std::string providerId;
    std::string name;
    std::vector<ScalarPort> inputs;
    ScalarPort output;
};

struct InitializationContext {
    std::uint64_t instanceId = 0;
};

class InputView {
public:
    InputView(std::span<const double> values, std::span<const std::string_view> keys) noexcept
        : values_(values), keys_(keys) {}

    [[nodiscard]] std::size_t size() const noexcept { return values_.size(); }
    [[nodiscard]] double at(std::size_t index) const {
        if (index >= values_.size()) throw std::out_of_range("Relationship-provider input index is out of range.");
        return values_[index];
    }
    [[nodiscard]] double at(std::string_view key) const {
        for (std::size_t index = 0; index < keys_.size(); ++index) {
            if (keys_[index] == key) return values_[index];
        }
        throw std::out_of_range("Unknown relationship-provider input key.");
    }

private:
    std::span<const double> values_;
    std::span<const std::string_view> keys_;
};

struct EvaluationContext {
    double simulationTime = 0;
    double stepSize = 0;
    InputView inputs;
};

class OutputCollector {
public:
    void addGradient(double value) noexcept { gradient_ += value; }
    [[nodiscard]] double gradient() const noexcept { return gradient_; }

private:
    double gradient_ = 0;
};

class RelationshipProvider {
public:
    virtual ~RelationshipProvider() = default;
    [[nodiscard]] virtual RelationshipDescription describe() const = 0;
    virtual void initialize(const InitializationContext&) {}
    virtual void evaluate(const EvaluationContext&, OutputCollector&) = 0;
    virtual void shutdown() noexcept {}
};

} // namespace konjugate::sdk::v1

std::unique_ptr<konjugate::sdk::v1::RelationshipProvider> createRelationshipProvider();
