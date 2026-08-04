/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "modelValidator.hpp"
#include "partitionPlan.hpp"
#include "projectContainer.hpp"
#include "simulationRunner.hpp"
#include "validationReport.hpp"
#include "engineProtocol.pb.h"
#include <boost/property_tree/json_parser.hpp>
#include <filesystem>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <algorithm>

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
}

int main(int argc, char** argv) {
    if (argc == 3 && std::string(argv[1]) == "capabilities" && std::string(argv[2]) == "--protobuf") {
        konjugate::protocol::EngineEvent event;
        event.set_protocol_version(1);
        auto* capabilities = event.mutable_capabilities();
        capabilities->set_metis_available(konjugate::metisPartitionerAvailable());
        capabilities->set_metis_version(konjugate::metisPartitionerVersion());
        writeFramedMessage(std::cout, event);
        return 0;
    }
    if (argc == 2 && std::string(argv[1]) == "capabilities") {
        std::cout << "{\"metis\":{\"available\":"
                  << (konjugate::metisPartitionerAvailable() ? "true" : "false")
                  << ",\"version\":\"" << konjugate::metisPartitionerVersion() << "\"}}\n";
        return 0;
    }
    if (argc < 3) {
        std::cerr << "Usage: konjugateEngine capabilities | <inspect|validate|run> <project.kjt> [--report report.json] [--configuration run.json --output results.kjr --control-stream protobuf]\n";
        return 64;
    }
    const std::string command = argv[1];
    const auto report = optionPath(argc, argv, "--report");
    const auto configurationPath = optionPath(argc, argv, "--configuration");
    const auto outputPath = optionPath(argc, argv, "--output");
    if ((command != "inspect" && command != "validate" && command != "run") ||
        ((command == "inspect" || command == "validate") && report.empty()) ||
        (command == "run" && (configurationPath.empty() || outputPath.empty()))) {
        std::cerr << "The selected command requires its report, configuration, and output paths.\n";
        return 64;
    }
    if (!hasKjtExtension(argv[2])) {
        std::cerr << "UNSUPPORTED_FILE_FORMAT: Only .kjt project files are supported.\n";
        return 3;
    }
    try {
        if (command == "inspect") {
            const auto inspection = konjugate::inspectProject(argv[2]);
            konjugate::writeInspectionReport(report, inspection.format, inspection.version, inspection.encrypted);
            return 0;
        }
        const auto passwordValue = std::getenv("KONJUGATE_PASSWORD");
        const auto project = konjugate::readProject(argv[2], passwordValue ? passwordValue : "");
        boost::property_tree::ptree document;
        std::istringstream input(project.json);
        boost::property_tree::read_json(input, document);
        const auto result = konjugate::validateModel(document);
        if (command == "validate") {
            konjugate::writeValidationReport(report, result);
            return result.valid ? 0 : 2;
        }
        if (!result.valid) {
            std::cerr << "MODEL_INVALID: The model must pass validation before it can run.\n";
            return 2;
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
        return 0;
    } catch (const konjugate::ContainerError& error) {
        std::cerr << error.code << ": " << error.what() << '\n';
        return error.code == "PASSWORD_REQUIRED" || error.code == "DECRYPTION_FAILED" || error.code == "UNSUPPORTED_ENCRYPTION" ? 4 : 3;
    } catch (const std::exception& error) {
        std::cerr << "ENGINE_FAILURE: " << error.what() << '\n';
        return 5;
    }
}
