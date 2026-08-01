/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "modelValidator.hpp"
#include "projectContainer.hpp"
#include "validationReport.hpp"
#include <boost/property_tree/json_parser.hpp>
#include <filesystem>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <algorithm>

namespace {
std::filesystem::path reportPath(int argc, char** argv) {
    for (int index = 3; index + 1 < argc; ++index) if (std::string(argv[index]) == "--report") return argv[index + 1];
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
    if (argc < 3) {
        std::cerr << "Usage: konjugateEngine <inspect|validate> <project.kjt> --report <report.json>\n";
        return 64;
    }
    const std::string command = argv[1];
    const auto report = reportPath(argc, argv);
    if (report.empty() || (command != "inspect" && command != "validate")) {
        std::cerr << "A supported command and --report path are required.\n";
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
        konjugate::writeValidationReport(report, result);
        return result.valid ? 0 : 2;
    } catch (const konjugate::ContainerError& error) {
        std::cerr << error.code << ": " << error.what() << '\n';
        return error.code == "PASSWORD_REQUIRED" || error.code == "DECRYPTION_FAILED" || error.code == "UNSUPPORTED_ENCRYPTION" ? 4 : 3;
    } catch (const std::exception& error) {
        std::cerr << "ENGINE_FAILURE: " << error.what() << '\n';
        return 5;
    }
}
