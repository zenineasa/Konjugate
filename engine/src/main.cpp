/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "causalInference.hpp"
#include "causalInferenceReport.hpp"
#include "modelValidator.hpp"
#include "nloptBackend.hpp"
#include "parameterFitting.hpp"
#include "parameterFittingReport.hpp"
#include "partitionPlan.hpp"
#include "projectContainer.hpp"
#include "simulationRunner.hpp"
#include "validationReport.hpp"
#include "engineProtocol.pb.h"
#include <boost/property_tree/json_parser.hpp>
#include <filesystem>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sstream>
#include <algorithm>
#if defined(_WIN32) || defined(_MSC_VER)
#include <fcntl.h>
#include <io.h>
#endif

namespace {
void writeFramedMessage(std::ostream& output, const google::protobuf::MessageLite& message) {
    const auto size = message.ByteSizeLong();
    if (size > 0xffffffffu) throw std::runtime_error("The protocol message is too large.");
    const unsigned char header[4] = {
        static_cast<unsigned char>((size >> 24) & 0xff), static_cast<unsigned char>((size >> 16) & 0xff),
        static_cast<unsigned char>((size >> 8) & 0xff), static_cast<unsigned char>(size & 0xff)
    };
    output.write(reinterpret_cast<const char*>(header), sizeof(header));
    if (!message.SerializeToOstream(&output)) throw std::runtime_error("Could not serialize the protocol message.");
    output.flush();
}

std::filesystem::path optionPath(int argc, char** argv, const std::string& option) {
    for (int index = 3; index + 1 < argc; ++index) if (std::string(argv[index]) == option) return argv[index + 1];
    return {};
}

bool hasKjtExtension(const std::filesystem::path& path) {
    auto extension = path.extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    return extension == ".kjt";
}

std::string readTextFile(const std::filesystem::path& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) throw std::runtime_error("The input file could not be opened.");
    std::ostringstream buffer;
    buffer << stream.rdbuf();
    return buffer.str();
}

std::vector<int> parseIntList(const std::string& csv) {
    std::vector<int> values;
    std::istringstream stream(csv);
    std::string item;
    while (std::getline(stream, item, ',')) values.push_back(std::stoi(item));
    return values;
}

std::vector<double> parseDoubleList(const std::string& csv) {
    std::vector<double> values;
    std::istringstream stream(csv);
    std::string item;
    while (std::getline(stream, item, ',')) values.push_back(std::stod(item));
    return values;
}

konjugate::InferenceConfig inferenceConfigFromArgs(int argc, char** argv) {
    konjugate::InferenceConfig config;
    const auto skeletonThreshold = optionPath(argc, argv, "--skeleton-threshold").string();
    if (!skeletonThreshold.empty()) config.skeletonThreshold = std::stod(skeletonThreshold);
    const auto coefficientThreshold = optionPath(argc, argv, "--coefficient-threshold").string();
    if (!coefficientThreshold.empty()) config.coefficientThreshold = std::stod(coefficientThreshold);
    const auto validationFraction = optionPath(argc, argv, "--validation-fraction").string();
    if (!validationFraction.empty()) config.validationFraction = std::stod(validationFraction);
    const auto lags = optionPath(argc, argv, "--lags").string();
    if (!lags.empty()) config.candidateLags = parseIntList(lags);
    const auto ridgePenalties = optionPath(argc, argv, "--ridge-penalties").string();
    if (!ridgePenalties.empty()) config.ridgePenalties = parseDoubleList(ridgePenalties);
    const auto degrees = optionPath(argc, argv, "--degrees").string();
    if (!degrees.empty()) config.candidateDegrees = parseIntList(degrees);
    const auto includeInteractionTerms = optionPath(argc, argv, "--include-interaction-terms").string();
    if (!includeInteractionTerms.empty()) config.includeInteractionTerms = includeInteractionTerms == "true" || includeInteractionTerms == "1";
    return config;
}
}

int main(int argc, char** argv) {
#if defined(_WIN32) || defined(_MSC_VER)
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    // Every exit below uses std::_Exit() instead of a normal return, deliberately skipping the
    // C++ runtime's atexit/stdio-flush machinery. A `run` invocation with --control-stream
    // protobuf leaves a detached background thread (startControlReader(), simulationRunner.cpp)
    // permanently blocked in a locked stream->read() on stdin if the caller never closes its
    // write end -- normal on a one-shot successful run. On glibc (Linux), the ordinary exit path
    // (a plain `return`/std::exit) tries to lock and flush every open stdio stream at process
    // exit, including stdin, and deadlocks forever against that thread's held lock; macOS's libc
    // does not do this, which is why this was invisible until the engine was first exercised on
    // Linux CI. std::_Exit() bypasses that machinery entirely and is safe here: nothing in this
    // program relies on exit-time flushing for correctness -- every real write already flushes or
    // closes explicitly (atomicWrite()'s std::ofstream::close(), writeFramedMessage()'s explicit
    // flush()).
    // Every optimizer backend runParameterFit() will accept in this build.
    const auto optimizerBackendIds = konjugate::nloptAlgorithmIds();

    if (argc == 3 && std::string(argv[1]) == "capabilities" && std::string(argv[2]) == "--protobuf") {
        konjugate::protocol::EngineEvent event;
        event.set_protocol_version(1);
        auto* capabilities = event.mutable_capabilities();
        capabilities->set_metis_available(konjugate::metisPartitionerAvailable());
        capabilities->set_metis_version(konjugate::metisPartitionerVersion());
        for (const auto& id : optimizerBackendIds) capabilities->add_optimizer_backend_ids(id);
        writeFramedMessage(std::cout, event);
        std::_Exit(0);
    }
    if (argc == 2 && std::string(argv[1]) == "capabilities") {
        // std::cout is fully buffered (not line-buffered) once stdout isn't a terminal -- e.g.
        // piped to a parent process, exactly this CLI's normal use -- so the trailing '\n' above
        // does not itself force a flush the way it would interactively. std::_Exit() below
        // skips the atexit flush that would otherwise cover this, so it must be explicit here
        // (writeFramedMessage()/writeFramedEvent() already flush themselves; this was the one
        // remaining stdout write in this file that didn't).
        std::ostringstream backendIdsJson;
        for (std::size_t index = 0; index < optimizerBackendIds.size(); ++index) {
            if (index > 0) backendIdsJson << ",";
            backendIdsJson << "\"" << optimizerBackendIds[index] << "\"";
        }
        std::cout << "{\"metis\":{\"available\":"
                  << (konjugate::metisPartitionerAvailable() ? "true" : "false")
                  << ",\"version\":\"" << konjugate::metisPartitionerVersion() << "\"}"
                  << ",\"optimizerBackendIds\":[" << backendIdsJson.str() << "]}\n";
        std::cout.flush();
        std::_Exit(0);
    }
    if (argc < 3) {
        std::cerr << "Usage: konjugateEngine capabilities | <inspect|validate|run> <project.kjt> [--report report.json] [--configuration run.json --output result.bin --control-stream protobuf]\n"
                      "       konjugateEngine infer <series.csv> --report report.json [--skeleton-threshold X] [--coefficient-threshold X] [--validation-fraction X] [--lags 1] [--ridge-penalties 0.01,0.1,1.0,10.0] [--degrees 1,3]\n"
                      "       konjugateEngine fit <project.kjt> <measured.csv> --report report.json [--backend nlopt-bobyqa] [--max-iterations 200]\n";
        std::_Exit(64);
    }
    const std::string command = argv[1];
    const auto report = optionPath(argc, argv, "--report");
    const auto configurationPath = optionPath(argc, argv, "--configuration");
    const auto outputPath = optionPath(argc, argv, "--output");
    if ((command != "inspect" && command != "validate" && command != "run" && command != "infer" && command != "fit") ||
        ((command == "inspect" || command == "validate" || command == "infer" || command == "fit") && report.empty()) ||
        (command == "run" && (configurationPath.empty() || outputPath.empty())) ||
        (command == "fit" && argc < 4)) {
        std::cerr << "The selected command requires its report, configuration, and output paths.\n";
        std::_Exit(64);
    }
    // infer takes a CSV, not a .kjt project -- every other command still requires the container
    // extension check below. fit takes both a .kjt project (argv[2]) and a measured CSV
    // (argv[3]) -- only the project half needs the extension check.
    if (command != "infer" && !hasKjtExtension(argv[2])) {
        std::cerr << "UNSUPPORTED_FILE_FORMAT: Only .kjt project files are supported.\n";
        std::_Exit(3);
    }
    try {
        if (command == "infer") {
            const auto series = konjugate::parseInferenceCsv(readTextFile(argv[2]));
            const auto config = inferenceConfigFromArgs(argc, argv);
            const auto inferenceResult = konjugate::inferGraph(series, config);
            konjugate::writeInferenceReport(report, inferenceResult);
            std::_Exit(0);
        }
        if (command == "inspect") {
            const auto inspection = konjugate::inspectProject(argv[2]);
            konjugate::writeInspectionReport(report, inspection.format, inspection.version, inspection.encrypted);
            std::_Exit(0);
        }
        const auto passwordValue = std::getenv("KONJUGATE_PASSWORD");
        const auto project = konjugate::readProject(argv[2], passwordValue ? passwordValue : "");
        boost::property_tree::ptree document;
        std::istringstream input(project.json);
        boost::property_tree::read_json(input, document);
        const auto result = konjugate::validateModel(document);
        if (command == "validate") {
            konjugate::writeValidationReport(report, result);
            std::_Exit(result.valid ? 0 : 2);
        }
        if (!result.valid) {
            std::cerr << "MODEL_INVALID: The model must pass validation before it can run.\n";
            std::_Exit(2);
        }
        if (command == "fit") {
            konjugate::FittingProblem problem;
            problem.baseDocument = document;
            problem.measured = konjugate::parseInferenceCsv(readTextFile(argv[3]));
            problem.mapping = konjugate::autoMapColumnsToStates(problem.measured.columnNames, document);
            problem.tunableParameters = konjugate::findTunableParameters(document);
            if (problem.tunableParameters.empty()) {
                throw std::runtime_error("The model has no parameters marked tunable (parameters[].tuning).");
            }
            if (problem.mapping.empty()) {
                throw std::runtime_error("None of the measured CSV's columns matched a state in the model.");
            }
            const auto backendOption = optionPath(argc, argv, "--backend").string();
            if (!backendOption.empty()) problem.optimizerBackendId = backendOption;
            const auto maxIterationsOption = optionPath(argc, argv, "--max-iterations").string();
            if (!maxIterationsOption.empty()) problem.options.maxIterations = static_cast<std::size_t>(std::stoul(maxIterationsOption));
            const auto fittingReport = konjugate::runParameterFit(problem);
            konjugate::writeFittingReport(report, fittingReport);
            std::_Exit(fittingReport.converged ? 0 : 1);
        }
        boost::property_tree::ptree configuration;
        boost::property_tree::read_json(configurationPath.string(), configuration);
        const auto protobufEvents = optionPath(argc, argv, "--event-stream").string() == "protobuf";
        const auto controlStream = optionPath(argc, argv, "--control-stream").string();
        if (!controlStream.empty() && controlStream != "protobuf") {
            throw std::runtime_error("The requested engine control protocol is unsupported.");
        }
        const auto protobufControls = controlStream == "protobuf";
        konjugate::runSimulation(document, configuration, outputPath, protobufControls ? &std::cin : nullptr,
            protobufEvents ? &std::cout : nullptr);
        std::_Exit(0);
    } catch (const konjugate::ContainerError& error) {
        std::cerr << error.code << ": " << error.what() << '\n';
        std::_Exit(error.code == "PASSWORD_REQUIRED" || error.code == "DECRYPTION_FAILED" || error.code == "UNSUPPORTED_ENCRYPTION" ? 4 : 3);
    } catch (const std::exception& error) {
        std::cerr << "ENGINE_FAILURE: " << error.what() << '\n';
        std::_Exit(5);
    }
}
