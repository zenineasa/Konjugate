/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <boost/property_tree/ptree.hpp>
#include <filesystem>
#include <istream>
#include <ostream>

namespace konjugate {

// controlStream, when non-null, must outlive the entire process: it is read from a detached
// background thread (see startControlReader() in simulationRunner.cpp) that is never joined and
// keeps blocking on stream->read() until EOF or an error, including after runSimulation() itself
// returns. The only real caller (main.cpp) passes &std::cin, whose lifetime already spans the
// whole process -- this is not enforced by the type system, so a caller passing anything with a
// shorter lifetime (a stack-local std::istringstream, for instance) would leave the background
// thread holding a dangling pointer. eventStream carries no such requirement: runSimulation()
// only ever dereferences it synchronously within its own call, so the ordinary "valid for the
// duration of the call" contract is enough.
void runSimulation(const boost::property_tree::ptree& document,
                   const boost::property_tree::ptree& configuration,
                   const std::filesystem::path& outputPath,
                   std::istream* controlStream = nullptr,
                   std::ostream* eventStream = nullptr);

}
