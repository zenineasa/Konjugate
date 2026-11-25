/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// An imported FMU as a Konjugate node program: the driver src/fmiResolver.mjs's generated source hands one FMU's
// variable table to (makeImportedFmu2/makeImportedFmu3 below), written once here rather than generated as text for
// every FMU. It runs the FMU in Co-Simulation through the FMI 2.0 or 3.0 C API, as the standards order it:
//
//  - The FMU is instantiated with its resources directory (FMI 2.0: a file: URI; FMI 3.0: an absolute path ending in
//    a separator) and a logger, so whatever it says about a failure is in the error Konjugate reports.
//  - Initialization waits for the first step, when the run's start time and the node's input values are known:
//    every parameter and input is set inside initialization mode, the one place a fixed parameter may be set.
//  - Between steps each input is set before every step; a tunable parameter only when its value has changed; a fixed
//    parameter never again -- if the value it is bound to changes during the run, the run stops and says so, since
//    the FMU would otherwise go on with the old value unnoticed.
//  - Integer, Boolean and enumeration variables are read as numbers; set from a number, which an integer or
//    enumeration takes rounded to the nearest whole number (refused, naming the variable, when outside its type's
//    range) and a Boolean takes as true for anything other than 0.
//  - Events inside a step (a bouncing ball's bounce, a time event) are the FMU's own to handle in Co-Simulation; an
//    FMU that asks to end the simulation is terminated there and its outputs keep their last values from then on.

#include "fmiDynamicLoad.hpp"
#include "relationshipProvider.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace konjugate::fmi {

enum class ValueType { float64, float32, int8, uint8, int16, uint16, int32, uint32, int64, uint64, boolean, enumeration };
enum class Role { input, fixedParameter, tunableParameter, output };

struct ImportedVariable {
    std::string key;
    std::string name;
    std::uint32_t valueReference = 0;
    ValueType type = ValueType::float64;
    Role role = Role::input;
};

// An input or parameter the project gives a value of its own (`kind: "value"`): set once, in initialization mode, and never
// again. Inputs and parameters neither bound nor given a value are not in the spec at all, so the FMU keeps its start values.
struct ImportedValue {
    ImportedVariable variable;
    double value = 0.0;
};

struct ImportedFmuSpec {
    std::string providerId;
    std::string modelName;
    std::string instantiationToken;
    std::string binaryPath;
    // FMI 2.0: the resources directory's file: URI; FMI 3.0: its absolute path ending in a separator.
    std::string resourceLocation;
    std::vector<ImportedVariable> variables;
    std::vector<ImportedValue> values{};
};

inline const char* typeName(ValueType type) {
    switch (type) {
    case ValueType::float64: return "Float64";
    case ValueType::float32: return "Float32";
    case ValueType::int8: return "Int8";
    case ValueType::uint8: return "UInt8";
    case ValueType::int16: return "Int16";
    case ValueType::uint16: return "UInt16";
    case ValueType::int32: return "Int32";
    case ValueType::uint32: return "UInt32";
    case ValueType::int64: return "Int64";
    case ValueType::uint64: return "UInt64";
    case ValueType::boolean: return "Boolean";
    case ValueType::enumeration: return "Enumeration";
    }
    return "unknown";
}

// The shortest of 15 to 17 significant digits that reads back as the same number: 0.1, not 0.10000000000000001.
inline std::string numberText(double value) {
    char buffer[32];
    for (int digits = 15; digits <= 17; ++digits) {
        std::snprintf(buffer, sizeof buffer, "%.*g", digits, value);
        if (std::strtod(buffer, nullptr) == value) break;
    }
    return buffer;
}

// What an FMU said through its logger, kept for the next error: its warnings and errors, the latest last.
class FmuMessages {
public:
    void add(int status, const char* category, const char* message) {
        if (status < 1 || !message || !*message) return; // OK and Pending carry nothing worth reporting
        if (messages_.size() == 8) messages_.erase(messages_.begin());
        std::string line = message;
        if (category && *category && status >= 3) line = std::string(category) + ": " + line;
        messages_.push_back(std::move(line));
    }

    std::string take() {
        std::string text;
        for (const auto& message : messages_) text += (text.empty() ? "" : " ") + message;
        messages_.clear();
        return text;
    }

private:
    std::vector<std::string> messages_;
};

class ImportedFmuBase : public konjugate::sdk::v1::NodeProvider {
public:
    explicit ImportedFmuBase(ImportedFmuSpec spec) : spec_(std::move(spec)) {
        for (std::size_t index = 0; index < spec_.variables.size(); ++index) {
            (spec_.variables[index].role == Role::output ? outputIndexes_ : inputIndexes_).push_back(index);
        }
        lastSet_.assign(inputIndexes_.size(), 0.0);
        known_.assign(inputIndexes_.size(), false);
        heldOutputs_.assign(spec_.variables.size(), 0.0);
    }

    konjugate::sdk::v1::NodeProviderDescription describe() const override {
        konjugate::sdk::v1::NodeProviderDescription description{spec_.providerId, spec_.modelName, {}, {}};
        for (const auto index : inputIndexes_) description.inputs.push_back({spec_.variables[index].key, spec_.variables[index].key, ""});
        for (const auto index : outputIndexes_) description.outputs.push_back({spec_.variables[index].key, spec_.variables[index].key, ""});
        return description;
    }

    void initialize(const konjugate::sdk::v1::InitializationContext&) override { instantiate(); }

    void evaluate(const konjugate::sdk::v1::EvaluationContext& context, konjugate::sdk::v1::NodeOutputCollector& outputs) override {
        if (!instantiated()) throw std::runtime_error(fmuName() + " was evaluated before it was instantiated.");
        if (!ended_) {
            if (!started_) {
                enterInitializationMode(context.simulationTime);
                for (std::size_t port = 0; port < inputIndexes_.size(); ++port) setInput(port, context.inputs.at(port), context.simulationTime);
                for (const auto& given : spec_.values) set(given.variable, given.value, context.simulationTime);
                exitInitializationMode(context.simulationTime);
                started_ = true;
            } else {
                for (std::size_t port = 0; port < inputIndexes_.size(); ++port) {
                    const auto& variable = spec_.variables[inputIndexes_[port]];
                    const double value = context.inputs.at(port);
                    if (variable.role == Role::input) setInput(port, value, context.simulationTime);
                    else if (!known_[port]) { lastSet_[port] = value; known_[port] = true; if (variable.role == Role::tunableParameter) setInput(port, value, context.simulationTime); }
                    else if (value != lastSet_[port]) {
                        if (variable.role == Role::fixedParameter) {
                            throw std::runtime_error("The parameter '" + variable.name + "' of the FMU '" + spec_.modelName + "' is fixed: it was set to " + numberText(lastSet_[port]) +
                                " when the run started and cannot change during the run, but what it is bound to is now " + numberText(value) +
                                " (at t = " + numberText(context.simulationTime) + "). Bind it to something that stays constant, or change it before the run.");
                        }
                        setInput(port, value, context.simulationTime);
                    }
                }
            }
            if (doStep(context.simulationTime, context.stepSize)) {
                ended_ = true;
                std::cerr << fmuName() << " asked to end the simulation at t = " << numberText(context.simulationTime + context.stepSize)
                          << "; its outputs keep their last values from then on.\n";
            }
            for (const auto index : outputIndexes_) heldOutputs_[index] = get(spec_.variables[index], context.simulationTime);
            if (ended_) terminate();
        }
        for (const auto index : outputIndexes_) outputs.addGradient(spec_.variables[index].key, heldOutputs_.at(index));
    }

    std::vector<std::byte> checkpoint() const override {
        if (!instantiated()) throw std::runtime_error(fmuName() + " was checkpointed before it was instantiated.");
        if (ended_) {
            // An FMU that has ended the simulation is only its held outputs.
            std::vector<std::byte> bytes(sizeof endedMarker + heldOutputs_.size() * sizeof(double));
            std::memcpy(bytes.data(), endedMarker, sizeof endedMarker);
            std::memcpy(bytes.data() + sizeof endedMarker, heldOutputs_.data(), heldOutputs_.size() * sizeof(double));
            return bytes;
        }
        return captureState();
    }

    void restore(std::span<const std::byte> payload) override {
        if (!instantiated()) throw std::runtime_error(fmuName() + " was restored before it was instantiated.");
        if (payload.size() == sizeof endedMarker + heldOutputs_.size() * sizeof(double) && std::memcmp(payload.data(), endedMarker, sizeof endedMarker) == 0) {
            std::memcpy(heldOutputs_.data(), payload.data() + sizeof endedMarker, heldOutputs_.size() * sizeof(double));
            ended_ = true;
            terminate();
            return;
        }
        if (!started_) {
            // The snapshot holds every value the FMU had, so it is initialized with its own start values and then set
            // to the snapshot. Parameters are taken as the snapshot has them: the first step after this records what they
            // are bound to rather than setting them again.
            enterInitializationMode(0.0);
            exitInitializationMode(0.0);
            started_ = true;
        }
        std::fill(known_.begin(), known_.end(), false);
        restoreState(payload);
    }

    void shutdown() noexcept override { release(); }

protected:
    std::string fmuName() const { return "The FMU '" + spec_.modelName + "'"; }

    [[noreturn]] void refused(const std::string& call, const std::string& what, double time, int status) {
        std::string reason = messages_.take();
        std::string text = fmuName() + (status >= 4 ? " failed fatally in " : " refused ") + call + (what.empty() ? "" : " (" + what + ")");
        if (time == time) text += " at t = " + numberText(time);
        text += reason.empty() ? ": it gave no reason." : ": " + reason;
        if (text.back() != '.') text += '.';
        throw std::runtime_error(text);
    }

    // A status from the FMU: OK and Warning go on; Discard, Error and Fatal are refusals.
    void check(int status, const std::string& call, const std::string& what, double time) {
        if (status <= 1) {
            if (status == 1) messages_.take();
            return;
        }
        refused(call, what, time, status);
    }

    std::string describeVariable(const ImportedVariable& variable, const char* verb) const {
        return std::string(verb) + " '" + variable.name + "'";
    }

    // An integer type's value from a Konjugate number: the nearest whole number, refused when outside the type.
    double wholeNumber(const ImportedVariable& variable, double value, double minimum, double maximumExclusive) const {
        const double rounded = std::round(value);
        if (!std::isfinite(value) || rounded < minimum || rounded >= maximumExclusive) {
            throw std::runtime_error(std::string("The ") + (variable.role == Role::input ? "input" : "parameter") + " '" + variable.name + "' of the FMU '" + spec_.modelName + "' is an " +
                typeName(variable.type) + ", a whole number from " + numberText(minimum) + " to " + numberText(maximumExclusive - 1) +
                ", but it was given " + numberText(value) + ".");
        }
        return rounded;
    }

    ImportedFmuSpec spec_;
    FmuMessages messages_;

    virtual bool instantiated() const = 0;
    virtual void instantiate() = 0;
    virtual void enterInitializationMode(double startTime) = 0;
    virtual void exitInitializationMode(double time) = 0;
    virtual void set(const ImportedVariable& variable, double value, double time) = 0;
    virtual double get(const ImportedVariable& variable, double time) = 0;
    // True when the FMU asks to end the simulation.
    virtual bool doStep(double time, double stepSize) = 0;
    virtual void terminate() noexcept = 0;
    virtual std::vector<std::byte> captureState() const = 0;
    virtual void restoreState(std::span<const std::byte> payload) = 0;
    virtual void release() noexcept = 0;

    bool started_ = false;
    bool ended_ = false;

private:
    void setInput(std::size_t port, double value, double time) {
        set(spec_.variables[inputIndexes_[port]], value, time);
        lastSet_[port] = value;
        known_[port] = true;
    }

    std::vector<std::size_t> inputIndexes_;
    std::vector<std::size_t> outputIndexes_;
    std::vector<double> lastSet_;
    std::vector<bool> known_;
    std::vector<double> heldOutputs_;
    static constexpr char endedMarker[16] = "konjugateFmuEnd";
};

class ImportedFmu2 final : public ImportedFmuBase {
public:
    explicit ImportedFmu2(ImportedFmuSpec spec)
        : ImportedFmuBase(std::move(spec)), library_(spec_.binaryPath), api_(library_),
          callbacks_{&ImportedFmu2::logger, &std::calloc, &std::free, nullptr, this} {}

    ~ImportedFmu2() override { release(); }

private:
    static void logger(fmi2ComponentEnvironment environment, fmi2String, fmi2Status status, fmi2String category, fmi2String message, ...) {
        if (!environment || !message) return;
        char buffer[2048];
        va_list arguments;
        va_start(arguments, message);
        std::vsnprintf(buffer, sizeof buffer, message, arguments);
        va_end(arguments);
        static_cast<ImportedFmu2*>(environment)->messages_.add(static_cast<int>(status), category, buffer);
    }

    bool instantiated() const override { return component_ != nullptr; }

    void instantiate() override {
        component_ = api_.instantiate("konjugateImportedFmu", fmi2CoSimulation, spec_.instantiationToken.c_str(),
            spec_.resourceLocation.c_str(), &callbacks_, fmi2False, fmi2False);
        if (!component_) refused("fmi2Instantiate", "", std::nan(""), 3);
    }

    void enterInitializationMode(double startTime) override {
        check(api_.setupExperiment(component_, fmi2False, 0.0, startTime, fmi2False, 0.0), "fmi2SetupExperiment", "", startTime);
        check(api_.enterInitializationMode(component_), "fmi2EnterInitializationMode", "", startTime);
        initialized_ = true;
    }

    void exitInitializationMode(double time) override {
        check(api_.exitInitializationMode(component_), "fmi2ExitInitializationMode", "", time);
    }

    template <typename Function>
    Function need(Function function, const char* name, const ImportedVariable& variable) {
        if (!function) throw std::runtime_error(fmuName() + " does not provide " + name + ", which its variable '" + variable.name + "' needs.");
        return function;
    }

    void set(const ImportedVariable& variable, double value, double time) override {
        const fmi2ValueReference reference = variable.valueReference;
        const auto what = describeVariable(variable, "setting");
        if (variable.type == ValueType::float64) {
            const fmi2Real real = value;
            check(api_.setReal(component_, &reference, 1, &real), "fmi2SetReal", what, time);
        } else if (variable.type == ValueType::boolean) {
            const fmi2Boolean flag = value != 0.0 ? fmi2True : fmi2False;
            check(need(api_.setBoolean, "fmi2SetBoolean", variable)(component_, &reference, 1, &flag), "fmi2SetBoolean", what, time);
        } else {
            const fmi2Integer integer = static_cast<fmi2Integer>(wholeNumber(variable, value, -2147483648.0, 2147483648.0));
            check(need(api_.setInteger, "fmi2SetInteger", variable)(component_, &reference, 1, &integer), "fmi2SetInteger", what, time);
        }
    }

    double get(const ImportedVariable& variable, double time) override {
        const fmi2ValueReference reference = variable.valueReference;
        const auto what = describeVariable(variable, "reading");
        if (variable.type == ValueType::float64) {
            fmi2Real real = 0;
            check(api_.getReal(component_, &reference, 1, &real), "fmi2GetReal", what, time);
            return real;
        }
        if (variable.type == ValueType::boolean) {
            fmi2Boolean flag = fmi2False;
            check(need(api_.getBoolean, "fmi2GetBoolean", variable)(component_, &reference, 1, &flag), "fmi2GetBoolean", what, time);
            return flag ? 1.0 : 0.0;
        }
        fmi2Integer integer = 0;
        check(need(api_.getInteger, "fmi2GetInteger", variable)(component_, &reference, 1, &integer), "fmi2GetInteger", what, time);
        return static_cast<double>(integer);
    }

    bool doStep(double time, double stepSize) override {
        const auto status = api_.doStep(component_, time, stepSize, fmi2False);
        if (status == fmi2Discard && api_.getBooleanStatus) {
            fmi2Boolean terminated = fmi2False;
            constexpr int fmi2Terminated = 3; // fmi2StatusKind
            if (api_.getBooleanStatus(component_, fmi2Terminated, &terminated) == fmi2OK && terminated) {
                messages_.take();
                return true;
            }
        }
        if (status == fmi2Pending) {
            throw std::runtime_error(fmuName() + " wants to finish fmi2DoStep later (asynchronously), which Konjugate does not support.");
        }
        check(status, "fmi2DoStep", "a step of " + numberText(stepSize), time);
        return false;
    }

    void terminate() noexcept override {
        if (component_ && initialized_) api_.terminate(component_);
        initialized_ = false;
    }

    std::vector<std::byte> captureState() const override {
        auto& self = const_cast<ImportedFmu2&>(*this);
        fmi2FMUstate state = nullptr;
        self.check(api_.getFMUstate(component_, &state), "fmi2GetFMUstate", "capturing its state for a checkpoint", std::nan(""));
        size_t size = 0;
        const auto sizeStatus = api_.serializedFMUstateSize(component_, state, &size);
        if (sizeStatus > fmi2Warning) {
            api_.freeFMUstate(component_, &state);
            self.check(sizeStatus, "fmi2SerializedFMUstateSize", "", std::nan(""));
        }
        std::vector<std::byte> bytes(size);
        const auto status = api_.serializeFMUstate(component_, state, reinterpret_cast<fmi2Byte*>(bytes.data()), size);
        api_.freeFMUstate(component_, &state);
        self.check(status, "fmi2SerializeFMUstate", "", std::nan(""));
        return bytes;
    }

    void restoreState(std::span<const std::byte> payload) override {
        fmi2FMUstate state = nullptr;
        check(api_.deSerializeFMUstate(component_, reinterpret_cast<const fmi2Byte*>(payload.data()), payload.size(), &state),
            "fmi2DeSerializeFMUstate", "restoring a checkpoint", std::nan(""));
        const auto status = api_.setFMUstate(component_, state);
        api_.freeFMUstate(component_, &state);
        check(status, "fmi2SetFMUstate", "restoring a checkpoint", std::nan(""));
    }

    void release() noexcept override {
        if (!component_) return;
        terminate();
        api_.freeInstance(component_);
        component_ = nullptr;
    }

    LoadedLibrary library_;
    Fmi2Api api_;
    const fmi2CallbackFunctions callbacks_;
    fmi2Component component_ = nullptr;
    bool initialized_ = false;
};

class ImportedFmu3 final : public ImportedFmuBase {
public:
    explicit ImportedFmu3(ImportedFmuSpec spec) : ImportedFmuBase(std::move(spec)), library_(spec_.binaryPath), api_(library_) {}

    ~ImportedFmu3() override { release(); }

private:
    static void logMessage(fmi3InstanceEnvironment environment, fmi3Status status, fmi3String category, fmi3String message) {
        if (environment) static_cast<ImportedFmu3*>(environment)->messages_.add(static_cast<int>(status), category, message);
    }

    bool instantiated() const override { return instance_ != nullptr; }

    void instantiate() override {
        instance_ = api_.instantiateCoSimulation("konjugateImportedFmu", spec_.instantiationToken.c_str(),
            spec_.resourceLocation.empty() ? nullptr : spec_.resourceLocation.c_str(),
            fmi3False, fmi3False, fmi3False, fmi3False, nullptr, 0, this, &ImportedFmu3::logMessage, nullptr);
        if (!instance_) refused("fmi3InstantiateCoSimulation", "", std::nan(""), 3);
    }

    void enterInitializationMode(double startTime) override {
        check(api_.enterInitializationMode(instance_, fmi3False, 0.0, startTime, fmi3False, 0.0), "fmi3EnterInitializationMode", "", startTime);
        initialized_ = true;
    }

    void exitInitializationMode(double time) override {
        check(api_.exitInitializationMode(instance_), "fmi3ExitInitializationMode", "", time);
    }

    template <typename Value, typename Setter>
    void setOne(Setter setter, const char* name, const ImportedVariable& variable, Value value, double time) {
        if (!setter) throw std::runtime_error(fmuName() + " does not provide " + name + ", which its variable '" + variable.name + "' needs.");
        const fmi3ValueReference reference = variable.valueReference;
        check(setter(instance_, &reference, 1, &value, 1), name, describeVariable(variable, "setting"), time);
    }

    template <typename Value, typename Getter>
    double getOne(Getter getter, const char* name, const ImportedVariable& variable, double time) {
        if (!getter) throw std::runtime_error(fmuName() + " does not provide " + name + ", which its variable '" + variable.name + "' needs.");
        const fmi3ValueReference reference = variable.valueReference;
        Value value{};
        check(getter(instance_, &reference, 1, &value, 1), name, describeVariable(variable, "reading"), time);
        return static_cast<double>(value);
    }

    void set(const ImportedVariable& variable, double value, double time) override {
        switch (variable.type) {
        case ValueType::float64: return setOne<fmi3Float64>(api_.setFloat64, "fmi3SetFloat64", variable, value, time);
        case ValueType::float32: return setOne<fmi3Float32>(api_.setFloat32, "fmi3SetFloat32", variable, static_cast<fmi3Float32>(value), time);
        case ValueType::int8: return setOne<fmi3Int8>(api_.setInt8, "fmi3SetInt8", variable, static_cast<fmi3Int8>(wholeNumber(variable, value, -128.0, 128.0)), time);
        case ValueType::uint8: return setOne<fmi3UInt8>(api_.setUInt8, "fmi3SetUInt8", variable, static_cast<fmi3UInt8>(wholeNumber(variable, value, 0.0, 256.0)), time);
        case ValueType::int16: return setOne<fmi3Int16>(api_.setInt16, "fmi3SetInt16", variable, static_cast<fmi3Int16>(wholeNumber(variable, value, -32768.0, 32768.0)), time);
        case ValueType::uint16: return setOne<fmi3UInt16>(api_.setUInt16, "fmi3SetUInt16", variable, static_cast<fmi3UInt16>(wholeNumber(variable, value, 0.0, 65536.0)), time);
        case ValueType::int32: return setOne<fmi3Int32>(api_.setInt32, "fmi3SetInt32", variable, static_cast<fmi3Int32>(wholeNumber(variable, value, -2147483648.0, 2147483648.0)), time);
        case ValueType::uint32: return setOne<fmi3UInt32>(api_.setUInt32, "fmi3SetUInt32", variable, static_cast<fmi3UInt32>(wholeNumber(variable, value, 0.0, 4294967296.0)), time);
        case ValueType::int64: return setOne<fmi3Int64>(api_.setInt64, "fmi3SetInt64", variable, static_cast<fmi3Int64>(wholeNumber(variable, value, -9223372036854775808.0, 9223372036854775808.0)), time);
        case ValueType::uint64: return setOne<fmi3UInt64>(api_.setUInt64, "fmi3SetUInt64", variable, static_cast<fmi3UInt64>(wholeNumber(variable, value, 0.0, 18446744073709551616.0)), time);
        case ValueType::enumeration: return setOne<fmi3Int64>(api_.setInt64, "fmi3SetInt64", variable, static_cast<fmi3Int64>(wholeNumber(variable, value, -9223372036854775808.0, 9223372036854775808.0)), time);
        case ValueType::boolean: return setOne<fmi3Boolean>(api_.setBoolean, "fmi3SetBoolean", variable, value != 0.0 ? fmi3True : fmi3False, time);
        }
    }

    double get(const ImportedVariable& variable, double time) override {
        switch (variable.type) {
        case ValueType::float64: return getOne<fmi3Float64>(api_.getFloat64, "fmi3GetFloat64", variable, time);
        case ValueType::float32: return getOne<fmi3Float32>(api_.getFloat32, "fmi3GetFloat32", variable, time);
        case ValueType::int8: return getOne<fmi3Int8>(api_.getInt8, "fmi3GetInt8", variable, time);
        case ValueType::uint8: return getOne<fmi3UInt8>(api_.getUInt8, "fmi3GetUInt8", variable, time);
        case ValueType::int16: return getOne<fmi3Int16>(api_.getInt16, "fmi3GetInt16", variable, time);
        case ValueType::uint16: return getOne<fmi3UInt16>(api_.getUInt16, "fmi3GetUInt16", variable, time);
        case ValueType::int32: return getOne<fmi3Int32>(api_.getInt32, "fmi3GetInt32", variable, time);
        case ValueType::uint32: return getOne<fmi3UInt32>(api_.getUInt32, "fmi3GetUInt32", variable, time);
        case ValueType::int64: return getOne<fmi3Int64>(api_.getInt64, "fmi3GetInt64", variable, time);
        case ValueType::uint64: return getOne<fmi3UInt64>(api_.getUInt64, "fmi3GetUInt64", variable, time);
        case ValueType::enumeration: return getOne<fmi3Int64>(api_.getInt64, "fmi3GetInt64", variable, time);
        case ValueType::boolean: return getOne<fmi3Boolean>(api_.getBoolean, "fmi3GetBoolean", variable, time) != 0.0 ? 1.0 : 0.0;
        }
        return 0.0;
    }

    bool doStep(double time, double stepSize) override {
        fmi3Boolean eventHandlingNeeded = fmi3False;
        fmi3Boolean terminateSimulation = fmi3False;
        fmi3Boolean earlyReturn = fmi3False;
        fmi3Float64 lastSuccessfulTime = 0.0;
        // eventHandlingNeeded is only ever set with eventModeUsed, which this importer does not ask for: the FMU then
        // handles its own events inside the step (see this file's header comment).
        const auto status = api_.doStep(instance_, time, stepSize, fmi3False,
            &eventHandlingNeeded, &terminateSimulation, &earlyReturn, &lastSuccessfulTime);
        if (terminateSimulation && status <= fmi3Discard) {
            messages_.take();
            return true;
        }
        check(status, "fmi3DoStep", "a step of " + numberText(stepSize), time);
        if (earlyReturn) {
            throw std::runtime_error(fmuName() + " returned early from fmi3DoStep at t = " + numberText(lastSuccessfulTime) +
                ", which it was not allowed to.");
        }
        return false;
    }

    void terminate() noexcept override {
        if (instance_ && initialized_) api_.terminate(instance_);
        initialized_ = false;
    }

    std::vector<std::byte> captureState() const override {
        auto& self = const_cast<ImportedFmu3&>(*this);
        fmi3FMUState state = nullptr;
        self.check(api_.getFMUState(instance_, &state), "fmi3GetFMUState", "capturing its state for a checkpoint", std::nan(""));
        size_t size = 0;
        const auto sizeStatus = api_.serializedFMUStateSize(instance_, state, &size);
        if (sizeStatus > fmi3Warning) {
            api_.freeFMUState(instance_, &state);
            self.check(sizeStatus, "fmi3SerializedFMUStateSize", "", std::nan(""));
        }
        std::vector<std::byte> bytes(size);
        const auto status = api_.serializeFMUState(instance_, state, reinterpret_cast<fmi3Byte*>(bytes.data()), size);
        api_.freeFMUState(instance_, &state);
        self.check(status, "fmi3SerializeFMUState", "", std::nan(""));
        return bytes;
    }

    void restoreState(std::span<const std::byte> payload) override {
        fmi3FMUState state = nullptr;
        check(api_.deserializeFMUState(instance_, reinterpret_cast<const fmi3Byte*>(payload.data()), payload.size(), &state),
            "fmi3DeserializeFMUState", "restoring a checkpoint", std::nan(""));
        const auto status = api_.setFMUState(instance_, state);
        api_.freeFMUState(instance_, &state);
        check(status, "fmi3SetFMUState", "restoring a checkpoint", std::nan(""));
    }

    void release() noexcept override {
        if (!instance_) return;
        terminate();
        api_.freeInstance(instance_);
        instance_ = nullptr;
    }

    LoadedLibrary library_;
    Fmi3Api api_;
    fmi3Instance instance_ = nullptr;
    bool initialized_ = false;
};

inline std::unique_ptr<konjugate::sdk::v1::NodeProvider> makeImportedFmu2(ImportedFmuSpec spec) {
    return std::make_unique<ImportedFmu2>(std::move(spec));
}

inline std::unique_ptr<konjugate::sdk::v1::NodeProvider> makeImportedFmu3(ImportedFmuSpec spec) {
    return std::make_unique<ImportedFmu3>(std::move(spec));
}

} // namespace konjugate::fmi
