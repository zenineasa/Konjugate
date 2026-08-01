/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <boost/property_tree/ptree.hpp>
#include <filesystem>

namespace konjugate {

void runSimulation(const boost::property_tree::ptree& document,
                   const boost::property_tree::ptree& configuration,
                   const std::filesystem::path& outputPath,
                   const std::filesystem::path& pacingControlPath = {});

}
