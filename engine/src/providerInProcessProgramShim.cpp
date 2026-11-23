/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The glue compiled with every version 2 C++ program (konjugate/sdk/v2/program.hpp) into a library the engine loads in-process, serving
// KonjugateInProcessProgramV2 (providerInProcessAbi.hpp). As the version 1 shims: everything crossing the boundary is POD and no C++
// exception crosses it. Unlike them, each instance is its own object (decision 6 of docs/proposals/programSdkV2.md), the engine owns
// every instance's memory, and the engine passes inputs already in the program's declaration order, defaulted and converted to the
// program's units.

#include "konjugate/sdk/v2/program.hpp"
#include "konjugate/providerInProcessAbi.hpp"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <typeinfo>
#include <vector>

#if defined(__GNUG__) || defined(__clang__)
#include <cxxabi.h>
#include <cstdlib>
#endif

namespace {

namespace k = konjugate::sdk::v2;

thread_local std::string g_createError;

constexpr std::int32_t kDone = 0;
constexpr std::int32_t kFailed = 1;
constexpr std::int32_t kOutOfDomain = 2;
constexpr std::int32_t kNotProvided = 3;

struct Instance {
    std::unique_ptr<k::Program> program;
    std::vector<unsigned char> bound;
};

struct ShimState {
    std::unique_ptr<k::Program> probe;
    std::string description;
    std::size_t inputCount = 0;
    std::size_t outputCount = 0;
    bool node = false;
    std::map<std::uint64_t, Instance> instances;
    std::string lastError;
    std::uint32_t lastErrorLine = 0;
};

ShimState& state(void* self) { return *static_cast<ShimState*>(self); }

// The program's class name as written ("PidController"), for messages: demangled, without its namespaces.
std::string programName(const k::Program& program) {
    std::string name = typeid(program).name();
#if defined(__GNUG__) || defined(__clang__)
    int status = 0;
    char* demangled = abi::__cxa_demangle(name.c_str(), nullptr, nullptr, &status);
    if (status == 0 && demangled) name = demangled;
    std::free(demangled); // NOLINT(cppcoreguidelines-no-malloc)
#endif
    const auto colons = name.rfind("::");
    if (colons != std::string::npos) name = name.substr(colons + 2);
    if (name.rfind("class ", 0) == 0) name = name.substr(6);
    return name;
}

std::string jsonText(const std::string& text) {
    std::string out = "\"";
    for (const char character : text) {
        const auto byte = static_cast<unsigned char>(character);
        if (character == '"' || character == '\\') {
            out += '\\';
            out += character;
        } else if (byte < 0x20) {
            char escaped[8];
            std::snprintf(escaped, sizeof escaped, "\\u%04x", byte);
            out += escaped;
        } else {
            out += character;
        }
    }
    return out + "\"";
}

std::string jsonNumber(double value) {
    std::ostringstream stream;
    stream.precision(17);
    stream << value;
    return stream.str();
}

const char* portKindName(k::detail::PortKind kind) {
    switch (kind) {
    case k::detail::PortKind::parameter: return "parameter";
    case k::detail::PortKind::constant: return "constant";
    case k::detail::PortKind::output: return "output";
    default: return "input";
    }
}

const char* memoryTypeName(k::detail::MemoryType type) {
    switch (type) {
    case k::detail::MemoryType::integer: return "integer";
    case k::detail::MemoryType::flag: return "flag";
    case k::detail::MemoryType::reals: return "reals";
    case k::detail::MemoryType::random: return "random";
    default: return "real";
    }
}

std::string describe(const k::Program& program, bool node) {
    const auto& registry = program.registry();
    std::string json = "{\"name\":" + jsonText(programName(program)) + ",\"kind\":\"" + (node ? "node" : "relationship") + "\",\"inputs\":[";
    for (std::size_t index = 0; index < registry.inputs.size(); ++index) {
        const auto& port = registry.inputs[index];
        json += std::string(index ? "," : "") + "{\"key\":" + jsonText(port.key) + ",\"kind\":\"" + portKindName(port.kind) + "\",\"unit\":" + jsonText(port.unit);
        if (port.hasDefault) json += ",\"default\":" + jsonNumber(port.defaultValue);
        json += "}";
    }
    json += "],\"outputs\":[";
    for (std::size_t index = 0; index < registry.outputs.size(); ++index) {
        const auto& port = registry.outputs[index];
        json += std::string(index ? "," : "") + "{\"key\":" + jsonText(port.key) + ",\"unit\":" + jsonText(port.unit);
        if (port.declaresDependencies) {
            json += ",\"dependsOn\":[";
            for (std::size_t at = 0; at < port.dependsOn.size(); ++at) {
                json += std::string(at ? "," : "") + jsonText(registry.inputs.at(port.dependsOn[at]).key);
            }
            json += "]";
        }
        json += "}";
    }
    json += "],\"memory\":[";
    for (std::size_t index = 0; index < registry.memory.size(); ++index) {
        const auto& field = registry.memory[index];
        json += std::string(index ? "," : "") + "{\"name\":" + jsonText(field.name) + ",\"type\":\"" + memoryTypeName(field.type) +
            "\",\"count\":" + std::to_string(field.count) + ",\"offset\":" + std::to_string(field.offset) + ",\"unit\":" + jsonText(field.unit) + "}";
    }
    json += "],\"memorySize\":" + std::to_string(registry.memorySize) + ",\"clockPeriod\":" + jsonNumber(registry.clockPeriod);
    if (registry.clockConstant) json += ",\"clockConstant\":" + jsonText(registry.inputs.at(*registry.clockConstant).key);
    return json + "}";
}

// Runs one call, turning what the program threw into a status code and a message.
template <typename Call>
std::int32_t guarded(ShimState& shim, Call&& call) {
    try {
        return call();
    } catch (const k::OutOfDomain& error) {
        shim.lastError = error.what();
        shim.lastErrorLine = error.line();
        return kOutOfDomain;
    } catch (const k::Failure& error) {
        shim.lastError = error.what();
        shim.lastErrorLine = error.line();
        return kFailed;
    } catch (const std::exception& error) {
        shim.lastError = error.what();
        shim.lastErrorLine = 0;
        return kFailed;
    } catch (...) {
        shim.lastError = "it threw something that is not a std::exception";
        shim.lastErrorLine = 0;
        return kFailed;
    }
}

void* create() {
    try {
        auto shim = std::make_unique<ShimState>();
        shim->probe = createProgram();
        if (!shim->probe) {
            g_createError = "createProgram() returned null.";
            return nullptr;
        }
        const bool relationship = dynamic_cast<const k::Relationship*>(shim->probe.get()) != nullptr;
        shim->node = dynamic_cast<const k::Node*>(shim->probe.get()) != nullptr;
        if (!relationship && !shim->node) {
            g_createError = "createProgram() must return a program derived from konjugate::sdk::v2::Relationship or Node.";
            return nullptr;
        }
        shim->description = describe(*shim->probe, shim->node);
        shim->inputCount = shim->probe->registry().inputs.size();
        shim->outputCount = shim->probe->registry().outputs.size();
        return shim.release();
    } catch (const std::exception& error) {
        g_createError = error.what();
        return nullptr;
    } catch (...) {
        g_createError = "createProgram() threw something that is not a std::exception.";
        return nullptr;
    }
}

void destroy(void* self) { delete static_cast<ShimState*>(self); } // NOLINT(cppcoreguidelines-owning-memory)

const char* description(void* self) { return state(self).description.c_str(); }

Instance& instanceOf(ShimState& shim, std::uint64_t instanceId) {
    const auto found = shim.instances.find(instanceId);
    if (found == shim.instances.end()) throw std::runtime_error("the engine asked for an instance that was never created");
    return found->second;
}

std::int32_t createInstance(void* self, std::uint64_t instanceId, const char* owner, double startTime, const double* values,
                            const unsigned char* bound, std::uint32_t valueCount, std::uint64_t ownerId, std::uint64_t programSeed,
                            std::uint8_t* memory, double* clockPeriod) {
    auto& shim = state(self);
    return guarded(shim, [&] {
        if (valueCount != shim.inputCount) throw std::runtime_error("the engine passed the wrong number of inputs");
        Instance instance;
        instance.program = createProgram();
        if (!instance.program) throw std::runtime_error("createProgram() returned null");
        instance.bound.assign(bound, bound + valueCount);
        const auto& registry = instance.program->registry();
        auto* bytes = reinterpret_cast<std::byte*>(memory);
        for (const auto& field : registry.memory) {
            std::memcpy(bytes + field.offset, field.initial.data(), field.initial.size());
            if (field.type == k::detail::MemoryType::random) k::seedRandom(bytes, field.offset, k::randomSeed(ownerId, programSeed, field.name));
        }
        k::Setup setup{instanceId, owner ? owner : "", startTime, values};
        k::MemoryWriter writer(bytes);
        instance.program->initialize(setup, writer);
        *clockPeriod = registry.clockConstant ? values[*registry.clockConstant] : registry.clockPeriod;
        shim.instances[instanceId] = std::move(instance);
        return kDone;
    });
}

std::int32_t evaluate(void* self, std::uint64_t instanceId, double time, const double* values, std::uint32_t valueCount,
                      const std::uint8_t* memory, double* outputs, std::uint32_t outputCount) {
    auto& shim = state(self);
    return guarded(shim, [&] {
        auto& instance = instanceOf(shim, instanceId);
        if (valueCount != shim.inputCount || outputCount != shim.outputCount) throw std::runtime_error("the engine passed the wrong number of ports");
        const k::Inputs inputs(values, reinterpret_cast<const std::byte*>(memory), instance.bound.data());
        if (shim.node) {
            k::Outputs written(outputs);
            static_cast<const k::Node&>(*instance.program).evaluate(time, inputs, written);
        } else {
            outputs[0] = static_cast<const k::Relationship&>(*instance.program).evaluate(time, inputs);
        }
        return kDone;
    });
}

std::int32_t advance(void* self, std::uint64_t instanceId, double time, double size, std::int32_t first, const double* values,
                     std::uint32_t valueCount, std::uint8_t* memory) {
    auto& shim = state(self);
    return guarded(shim, [&] {
        auto& instance = instanceOf(shim, instanceId);
        if (valueCount != shim.inputCount) throw std::runtime_error("the engine passed the wrong number of inputs");
        auto* bytes = reinterpret_cast<std::byte*>(memory);
        const k::Inputs inputs(values, bytes, instance.bound.data());
        k::MemoryWriter writer(bytes);
        instance.program->advance(k::Step{time, size, first != 0}, inputs, writer);
        return kDone;
    });
}

std::int32_t jacobian(void* self, std::uint64_t instanceId, double time, const double* values, std::uint32_t valueCount,
                      const std::uint8_t* memory, double* entries, std::uint32_t entryCount) {
    auto& shim = state(self);
    return guarded(shim, [&] {
        auto& instance = instanceOf(shim, instanceId);
        if (valueCount != shim.inputCount || entryCount != shim.inputCount * shim.outputCount) throw std::runtime_error("the engine passed the wrong number of entries");
        std::fill(entries, entries + entryCount, 0.0);
        const k::Inputs inputs(values, reinterpret_cast<const std::byte*>(memory), instance.bound.data());
        k::Jacobian written(entries, shim.inputCount);
        instance.program->jacobian(time, inputs, written);
        return written.provided() ? kDone : kNotProvided;
    });
}

const char* lastError(void* self) {
    if (!self) return g_createError.c_str();
    return state(self).lastError.c_str();
}

std::uint32_t lastErrorLine(void* self) { return self ? state(self).lastErrorLine : 0; }

void shutdownProgram(void* self) {
    for (auto& [instanceId, instance] : state(self).instances) {
        try {
            instance.program->shutdown();
        } catch (...) {} // NOLINT(bugprone-empty-catch)
    }
}

constexpr KonjugateInProcessProgramV2 kTable{
    sizeof(KonjugateInProcessProgramV2),
    kKonjugateInProcessProgramAbiVersion,
    &create,
    &destroy,
    &description,
    &createInstance,
    &evaluate,
    &advance,
    &jacobian,
    &lastError,
    &lastErrorLine,
    &shutdownProgram,
};

} // anonymous namespace

extern "C" const KonjugateInProcessProgramV2* konjugate_in_process_program_v2() {
    return &kTable;
}
