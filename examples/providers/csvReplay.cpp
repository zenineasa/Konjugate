// Copyright © 2026 Zenin Easa Panthakkalakath

// A recorded signal replayed: a relationship program that is a function of time alone (docs/programs.md). It reads the recording when
// the run starts, in initialize(), from a CSV file (a time column, then the value; a heading row is skipped), interpolates linearly
// between readings and holds the first and the last past either end. With no file named it replays the readings written below, so it
// runs as it is.

#include <konjugate/sdk/v2/program.hpp>

#include <cstddef>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

namespace k = konjugate::sdk::v2;

namespace {

class CsvReplay final : public k::Relationship {
public:
    k::Output output{this, "output"};

    // The CSV to read, by its path; empty replays the readings below.
    std::string file;

    void initialize(const k::Setup&, k::MemoryWriter&) override {
        times_ = {0.0, 10.0, 20.0, 30.0};
        values_ = {290.0, 292.5, 291.0, 293.0};
        if (file.empty()) return;
        std::ifstream in(file);
        if (!in) k::fail("Cannot read the recording " + file + ".");
        times_.clear();
        values_.clear();
        std::string line;
        while (std::getline(in, line)) {
            std::stringstream row(line);
            std::string time;
            std::string value;
            if (!std::getline(row, time, ',') || !std::getline(row, value, ',')) continue;
            try {
                times_.push_back(std::stod(time));
                values_.push_back(std::stod(value));
            } catch (const std::exception&) {
                // A heading, or a row that is not two numbers.
            }
        }
        if (times_.size() < 2) k::fail("The recording " + file + " has fewer than two readings.");
    }

    double evaluate(double t, const k::Inputs&) const override {
        if (t <= times_.front()) return values_.front();
        if (t >= times_.back()) return values_.back();
        std::size_t index = 0;
        while (index + 2 < times_.size() && t > times_[index + 1]) ++index;
        const double fraction = (t - times_[index]) / (times_[index + 1] - times_[index]);
        return values_[index] + fraction * (values_[index + 1] - values_[index]);
    }

private:
    std::vector<double> times_;
    std::vector<double> values_;
};

}

std::unique_ptr<k::Program> createProgram() { return std::make_unique<CsvReplay>(); }
