/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <boost/property_tree/ptree.hpp>
#include <filesystem>
#include <istream>
#include <ostream>

namespace konjugate {

void runSimulation(const boost::property_tree::ptree& document,
                   const boost::property_tree::ptree& configuration,
                   const std::filesystem::path& outputPath,
                   std::istream* controlStream = nullptr,
                   std::ostream* eventStream = nullptr);

}
