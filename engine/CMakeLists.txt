# Copyright © 2026 Zenin Easa Panthakkalakath

cmake_minimum_required(VERSION 3.20)

if(APPLE AND NOT CMAKE_OSX_DEPLOYMENT_TARGET)
    set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "Minimum macOS deployment target" FORCE)
endif()

project(konjugateEngine VERSION 0.2.0 LANGUAGES CXX)

if(NOT CMAKE_CONFIGURATION_TYPES AND NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE RelWithDebInfo CACHE STRING "Build type" FORCE)
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(ZLIB REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(Protobuf REQUIRED)
find_package(Threads REQUIRED)
find_package(Eigen3 CONFIG REQUIRED)
find_package(NLopt CONFIG REQUIRED)
find_path(BOOST_INCLUDE_DIR boost/property_tree/json_parser.hpp REQUIRED)

protobuf_generate_cpp(PROTOCOL_SOURCES PROTOCOL_HEADERS "${CMAKE_CURRENT_SOURCE_DIR}/../protocol/engineProtocol.proto")
protobuf_generate_cpp(PROVIDER_PROTOCOL_SOURCES PROVIDER_PROTOCOL_HEADERS "${CMAKE_CURRENT_SOURCE_DIR}/../protocol/relationshipProvider.proto")

option(KONJUGATE_ENABLE_METIS "Enable METIS graph partitioning when the library is available" ON)
option(KONJUGATE_REQUIRE_METIS "Fail configuration when METIS is unavailable" OFF)
if(KONJUGATE_REQUIRE_METIS AND NOT KONJUGATE_ENABLE_METIS)
    message(FATAL_ERROR "KONJUGATE_REQUIRE_METIS cannot be enabled when KONJUGATE_ENABLE_METIS is disabled")
endif()
if(KONJUGATE_ENABLE_METIS)
    if(APPLE)
        # Prefer a system/Homebrew METIS on macOS: it is the long-verified configuration here
        # (see the dylib rpath-fixup below), whereas vcpkg's statically-linked metis+GKlib port
        # is only exercised on Windows/Linux, where there is no equivalent system package.
        find_path(METIS_INCLUDE_DIR metis.h PATHS /usr/local/include /opt/homebrew/include NO_DEFAULT_PATH)
        find_library(METIS_LIBRARY NAMES metis PATHS /usr/local/lib /opt/homebrew/lib NO_DEFAULT_PATH)
    endif()
    if(NOT METIS_INCLUDE_DIR OR NOT METIS_LIBRARY)
        find_path(METIS_INCLUDE_DIR metis.h)
        find_library(METIS_LIBRARY NAMES metis)
        find_library(GKLIB_LIBRARY NAMES GKlib gklib)
    endif()
endif()

if(METIS_INCLUDE_DIR AND METIS_LIBRARY)
    set(KONJUGATE_HAS_METIS 1)
    message(STATUS "METIS partitioning enabled: ${METIS_LIBRARY}")
    if(APPLE AND NOT METIS_LIBRARY MATCHES "\\.dylib$")
        message(FATAL_ERROR "METIS resolved to a static library (${METIS_LIBRARY}) on macOS instead of a "
            "Homebrew dylib. This exact combination previously corrupted the live simulation event stream at "
            "runtime (surfacing as 'The engine protocol frame is too large' on the Electron side) rather than "
            "failing at build time, so it is rejected here instead. Run 'brew install metis' so this build uses "
            "the verified dylib path, or delete METIS_INCLUDE_DIR/METIS_LIBRARY/GKLIB_LIBRARY from the CMake "
            "cache if you intentionally need to test the vcpkg static path on this platform.")
    endif()
else()
    set(KONJUGATE_HAS_METIS 0)
    if(KONJUGATE_REQUIRE_METIS)
        message(FATAL_ERROR "METIS is required by this build. Use the development-no-metis preset to test the fallback path.")
    endif()
    message(STATUS "METIS was not found; the built-in greedy partitioner remains available")
endif()

set(KONJUGATE_METIS_LINK_LIBRARY ${METIS_LIBRARY})
if(KONJUGATE_HAS_METIS AND APPLE AND METIS_LIBRARY MATCHES "\\.dylib$")
    file(REAL_PATH "${METIS_LIBRARY}" METIS_REAL_LIBRARY)
    set(METIS_BUNDLED_LIBRARY "${CMAKE_BINARY_DIR}/libmetis.dylib")
    set(METIS_PREPARED_LIBRARY "${CMAKE_BINARY_DIR}/libmetis.prepared.dylib")
    configure_file("${METIS_REAL_LIBRARY}" "${METIS_PREPARED_LIBRARY}" COPYONLY)
    file(CHMOD "${METIS_PREPARED_LIBRARY}" PERMISSIONS OWNER_READ OWNER_WRITE OWNER_EXECUTE GROUP_READ GROUP_EXECUTE WORLD_READ WORLD_EXECUTE)
    execute_process(
        COMMAND install_name_tool -id "@loader_path/libmetis.dylib" "${METIS_PREPARED_LIBRARY}"
        RESULT_VARIABLE METIS_INSTALL_NAME_RESULT
    )
    if(NOT METIS_INSTALL_NAME_RESULT EQUAL 0)
        message(FATAL_ERROR "Could not prepare the METIS runtime library for application packaging")
    endif()
    execute_process(
        COMMAND codesign --force --sign - "${METIS_PREPARED_LIBRARY}"
        RESULT_VARIABLE METIS_CODESIGN_RESULT
    )
    if(NOT METIS_CODESIGN_RESULT EQUAL 0)
        message(FATAL_ERROR "Could not re-sign the METIS runtime library after install_name_tool modification")
    endif()
    execute_process(COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${METIS_PREPARED_LIBRARY}" "${METIS_BUNDLED_LIBRARY}")
    file(REMOVE "${METIS_PREPARED_LIBRARY}")
    set(KONJUGATE_METIS_LINK_LIBRARY "${METIS_BUNDLED_LIBRARY}")
endif()
if(GKLIB_LIBRARY)
    list(APPEND KONJUGATE_METIS_LINK_LIBRARY ${GKLIB_LIBRARY})
endif()


# Every dependency documented here (boost-property-tree, eigen3, nlopt, openssl, protobuf, zlib,
# and their transitive deps) is a core, always-present dependency, not a METIS-conditional one --
# this used to be gated behind KONJUGATE_HAS_METIS back when METIS was the only documented
# dependency, which silently dropped thirdPartyNotices.md entirely from a --no-metis build.
file(MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/thirdPartyLicenses")
configure_file(
    "${CMAKE_CURRENT_SOURCE_DIR}/../thirdPartyNotices.md"
    "${CMAKE_BINARY_DIR}/thirdPartyNotices.md"
    COPYONLY
)
foreach(licenseFile apache2.txt metis.txt gklib.txt boostSoftwareLicense1.0.txt nlopt.txt protobuf.txt utf8Range.txt zlib.txt)
    configure_file(
        "${CMAKE_CURRENT_SOURCE_DIR}/../thirdPartyLicenses/${licenseFile}"
        "${CMAKE_BINARY_DIR}/thirdPartyLicenses/${licenseFile}"
        COPYONLY
    )
endforeach()

add_executable(konjugateEngine
    ${PROTOCOL_SOURCES}
    ${PROTOCOL_HEADERS}
    ${PROVIDER_PROTOCOL_SOURCES}
    ${PROVIDER_PROTOCOL_HEADERS}
    src/dependencyGraph.cpp
    src/executionBackend.cpp
    src/executionPlan.cpp
    src/causalInference.cpp
    src/causalInferenceReport.cpp
    src/finiteDifferenceGradient.cpp
    src/main.cpp
    src/modelValidator.cpp
    src/nloptBackend.cpp
    src/parameterFitting.cpp
    src/parameterFittingReport.cpp
    src/partitionPlan.cpp
    src/partitionRuntime.cpp
    src/projectContainer.cpp
    src/cppToolchain.cpp
    src/fmiImport.cpp
    src/providerRuntime.cpp
    src/simulationRunner.cpp
    src/taskExecutor.cpp
    src/validationReport.cpp
)
set_target_properties(konjugateEngine PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}"
    INSTALL_RPATH "$<IF:$<PLATFORM_ID:Darwin>,@loader_path,$ORIGIN>"
)
target_include_directories(konjugateEngine PRIVATE include ${BOOST_INCLUDE_DIR} "${CMAKE_CURRENT_BINARY_DIR}")
target_link_libraries(konjugateEngine PRIVATE ZLIB::ZLIB OpenSSL::Crypto protobuf::libprotobuf Threads::Threads Eigen3::Eigen NLopt::nlopt ${CMAKE_DL_LIBS})
target_compile_definitions(konjugateEngine PRIVATE KONJUGATE_HAS_METIS=${KONJUGATE_HAS_METIS})
if(KONJUGATE_HAS_METIS)
    target_include_directories(konjugateEngine PRIVATE ${METIS_INCLUDE_DIR})
    target_link_libraries(konjugateEngine PRIVATE ${KONJUGATE_METIS_LINK_LIBRARY})
endif()

add_library(konjugateProviderWorker STATIC
    src/providerWorker.cpp
)
target_include_directories(konjugateProviderWorker PUBLIC include)

# Compile-check only, same purpose as konjugateProviderWorker above: buildCppProvider() compiles
# and links this against a user's inline source at run time, outside of CMake entirely, but
# building it here as part of the ordinary CMake build catches a broken shim early.
add_library(konjugateProviderInProcessShim STATIC
    src/providerInProcessShim.cpp
)
target_include_directories(konjugateProviderInProcessShim PUBLIC include)

install(TARGETS konjugateEngine RUNTIME DESTINATION .)
# The C++/Python provider SDKs are source, not build output, but a packaged app still needs
# them on disk: buildCppProvider() compiles inline C++ providers against the public header and
# links them against providerWorker.cpp (or, for ProviderExecutionMode::inProcess,
# providerInProcessShim.cpp) at run time, and Python providers need the konjugate package on
# PYTHONPATH. See cppProviderSdkPath()/pythonProviderSdkPath() in engineAdapter.mjs, which
# expect exactly this layout under the packaged resources directory.
install(DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/include/konjugate" DESTINATION include)
# fmi2/ (the vendored FMI 2.0 headers) and fmiGlue.cpp are this same convention's FMU-export
# sibling: buildSharedLibrary (main.cpp) compiles a generated model's source against
# include/konjugate/simulationModel.hpp and links it against src/fmiGlue.cpp, exactly how
# buildCppProvider() already compiles/links relationship providers against this same include dir.
install(DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/include/fmi2" DESTINATION include)
install(FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/src/providerWorker.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/providerInProcessShim.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/fmiGlue.cpp"
    DESTINATION src
)
install(DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/sdk/python/konjugate" DESTINATION sdk/python
    PATTERN "__pycache__" EXCLUDE
)
if(KONJUGATE_HAS_METIS AND APPLE AND METIS_BUNDLED_LIBRARY)
    install(FILES "${METIS_BUNDLED_LIBRARY}" DESTINATION .)
elseif(KONJUGATE_HAS_METIS AND UNIX AND METIS_LIBRARY MATCHES "\\.so(\\.[0-9.]+)?$")
    install(FILES "${METIS_LIBRARY}" DESTINATION .)
endif()
if(WIN32)
    install(DIRECTORY "${CMAKE_BINARY_DIR}/" DESTINATION . FILES_MATCHING PATTERN "*.dll")
endif()
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/../thirdPartyNotices.md" DESTINATION .)
install(FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/../thirdPartyLicenses/apache2.txt"
    "${CMAKE_CURRENT_SOURCE_DIR}/../thirdPartyLicenses/metis.txt"
    "${CMAKE_CURRENT_SOURCE_DIR}/../thirdPartyLicenses/gklib.txt"
    "${CMAKE_CURRENT_SOURCE_DIR}/../thirdPartyLicenses/boostSoftwareLicense1.0.txt"
    "${CMAKE_CURRENT_SOURCE_DIR}/../thirdPartyLicenses/nlopt.txt"
    "${CMAKE_CURRENT_SOURCE_DIR}/../thirdPartyLicenses/protobuf.txt"
    "${CMAKE_CURRENT_SOURCE_DIR}/../thirdPartyLicenses/utf8Range.txt"
    "${CMAKE_CURRENT_SOURCE_DIR}/../thirdPartyLicenses/zlib.txt"
    DESTINATION thirdPartyLicenses
)

include(CTest)
if(BUILD_TESTING)
    find_package(Python3 COMPONENTS Interpreter)
    add_executable(executionPlanTests
        tests/executionPlanTests.cpp
        src/dependencyGraph.cpp
        src/executionBackend.cpp
        src/executionPlan.cpp
        src/partitionPlan.cpp
        src/partitionRuntime.cpp
        src/taskExecutor.cpp
    )
    set_target_properties(executionPlanTests PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
        RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}"
        RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}"
        RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}"
    )
    target_include_directories(executionPlanTests PRIVATE include ${BOOST_INCLUDE_DIR})
    target_link_libraries(executionPlanTests PRIVATE Threads::Threads)
    target_compile_definitions(executionPlanTests PRIVATE KONJUGATE_HAS_METIS=${KONJUGATE_HAS_METIS})
    if(KONJUGATE_HAS_METIS)
        target_include_directories(executionPlanTests PRIVATE ${METIS_INCLUDE_DIR})
        target_link_libraries(executionPlanTests PRIVATE ${KONJUGATE_METIS_LINK_LIBRARY})
    endif()
    add_test(NAME executionPlanTests COMMAND executionPlanTests)

    add_executable(relationshipProviderTests
        tests/relationshipProviderTests.cpp
        ${PROVIDER_PROTOCOL_SOURCES}
        ${PROVIDER_PROTOCOL_HEADERS}
        src/executionPlan.cpp
        src/modelValidator.cpp
        src/cppToolchain.cpp
        src/providerRuntime.cpp
    )
    target_include_directories(relationshipProviderTests PRIVATE include ${BOOST_INCLUDE_DIR} "${CMAKE_CURRENT_BINARY_DIR}")
    target_link_libraries(relationshipProviderTests PRIVATE protobuf::libprotobuf OpenSSL::Crypto Threads::Threads ${CMAKE_DL_LIBS})
    add_test(NAME relationshipProviderTests COMMAND relationshipProviderTests)
    # The test binary resolves provider sources/SDK paths (e.g. "../tests/...", cppSdkPath "..")
    # relative to engine/tests, and its Python-provider cases need the SDK on PYTHONPATH; ctest's
    # default working directory is the build directory, not the source tree, so both must be set
    # explicitly here (mirroring the pythonRelationshipProviderTest entry below).
    set_tests_properties(relationshipProviderTests PROPERTIES
        WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/tests"
        ENVIRONMENT "PYTHONPATH=${CMAKE_CURRENT_SOURCE_DIR}/sdk/python"
    )
    if(Python3_Interpreter_FOUND)
        add_test(
            NAME pythonRelationshipProviderTest
            COMMAND "${CMAKE_COMMAND}" -E env
                "PYTHONPATH=${CMAKE_CURRENT_SOURCE_DIR}/sdk/python"
                "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/pythonRelationshipProviderTest.py"
        )
            add_test(
                NAME nodeProviderWorkerTest
                COMMAND "${CMAKE_COMMAND}" -E env
                "PYTHONPATH=${CMAKE_CURRENT_SOURCE_DIR}/sdk/python"
                "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/nodeProviderWorkerTest.py"
            )
    endif()

    add_executable(nodeProviderRuntimeTests
        tests/nodeProviderRuntimeTests.cpp
        ${PROVIDER_PROTOCOL_SOURCES}
        ${PROVIDER_PROTOCOL_HEADERS}
        src/executionPlan.cpp
        src/modelValidator.cpp
        src/cppToolchain.cpp
        src/providerRuntime.cpp
    )
    target_include_directories(nodeProviderRuntimeTests PRIVATE include ${BOOST_INCLUDE_DIR} "${CMAKE_CURRENT_BINARY_DIR}")
    target_link_libraries(nodeProviderRuntimeTests PRIVATE protobuf::libprotobuf OpenSSL::Crypto Threads::Threads ${CMAKE_DL_LIBS})
    add_test(NAME nodeProviderRuntimeTests COMMAND nodeProviderRuntimeTests)
    # Same resolution reasoning as relationshipProviderTests above: this test's Python provider
    # case resolves PYTHONPATH relative to engine/tests, not ctest's default working directory.
    set_tests_properties(nodeProviderRuntimeTests PROPERTIES
        WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/tests"
        ENVIRONMENT "PYTHONPATH=${CMAKE_CURRENT_SOURCE_DIR}/sdk/python"
    )

    add_executable(fmiGlueTests
        tests/fmiGlueTests.cpp
        src/fmiGlue.cpp
    )
    set_target_properties(fmiGlueTests PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
        RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}"
        RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}"
        RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}"
    )
    target_include_directories(fmiGlueTests PRIVATE include)
    add_test(NAME fmiGlueTests COMMAND fmiGlueTests)

    add_executable(causalInferenceTests
        tests/causalInferenceTests.cpp
        src/causalInference.cpp
    )
    set_target_properties(causalInferenceTests PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
        RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}"
        RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}"
        RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}"
    )
    target_include_directories(causalInferenceTests PRIVATE include)
    target_link_libraries(causalInferenceTests PRIVATE Eigen3::Eigen)
    add_test(NAME causalInferenceTests COMMAND causalInferenceTests)

    # Round-trips writeInferenceReport()/writeValidationReport()/writeInspectionReport() through
    # real protobuf encode+decode -- these had no coverage of their own report-writing logic
    # before this target existed (writeFittingReport()'s equivalent lives in
    # parameterFittingTests.cpp instead). Only needs the report structs' header definitions, not
    # inferGraph()/validateModel()'s own implementations (causalInference.cpp/modelValidator.cpp),
    # since what's under test is serialization of a given struct, not how that struct gets built.
    add_executable(reportProtocolTests
        tests/reportProtocolTests.cpp
        src/causalInferenceReport.cpp
        src/validationReport.cpp
        ${PROTOCOL_SOURCES}
        ${PROTOCOL_HEADERS}
    )
    set_target_properties(reportProtocolTests PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
        RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}"
        RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}"
        RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}"
    )
    target_include_directories(reportProtocolTests PRIVATE include ${BOOST_INCLUDE_DIR} "${CMAKE_CURRENT_BINARY_DIR}")
    target_link_libraries(reportProtocolTests PRIVATE Eigen3::Eigen protobuf::libprotobuf)
    add_test(NAME reportProtocolTests COMMAND reportProtocolTests)

    # Needs the full simulation stack (runSimulation() and everything it depends on), not just
    # parameterFitting.cpp itself -- the recovery tests below drive real simulations end to end.
    add_executable(parameterFittingTests
        tests/parameterFittingTests.cpp
        src/causalInference.cpp
        src/dependencyGraph.cpp
        src/executionBackend.cpp
        src/executionPlan.cpp
        src/finiteDifferenceGradient.cpp
        src/modelValidator.cpp
        src/nloptBackend.cpp
        src/parameterFitting.cpp
        src/parameterFittingReport.cpp
        src/partitionPlan.cpp
        src/partitionRuntime.cpp
        src/cppToolchain.cpp
        src/providerRuntime.cpp
        src/simulationRunner.cpp
        src/taskExecutor.cpp
        ${PROTOCOL_SOURCES}
        ${PROTOCOL_HEADERS}
        ${PROVIDER_PROTOCOL_SOURCES}
        ${PROVIDER_PROTOCOL_HEADERS}
    )
    set_target_properties(parameterFittingTests PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
        RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}"
        RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}"
        RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}"
    )
    target_include_directories(parameterFittingTests PRIVATE include ${BOOST_INCLUDE_DIR} "${CMAKE_CURRENT_BINARY_DIR}")
    target_link_libraries(parameterFittingTests PRIVATE
        Eigen3::Eigen NLopt::nlopt protobuf::libprotobuf OpenSSL::Crypto Threads::Threads ${CMAKE_DL_LIBS})
    target_compile_definitions(parameterFittingTests PRIVATE KONJUGATE_HAS_METIS=${KONJUGATE_HAS_METIS})
    if(KONJUGATE_HAS_METIS)
        target_include_directories(parameterFittingTests PRIVATE ${METIS_INCLUDE_DIR})
        target_link_libraries(parameterFittingTests PRIVATE ${KONJUGATE_METIS_LINK_LIBRARY})
    endif()
    add_test(NAME parameterFittingTests COMMAND parameterFittingTests)

    # A manual perf tool, not a pass/fail test: intentionally left out of add_test/ctest.
    add_executable(providerBatchingBenchmark
        tests/providerBatchingBenchmark.cpp
        ${PROVIDER_PROTOCOL_SOURCES}
        ${PROVIDER_PROTOCOL_HEADERS}
        src/executionPlan.cpp
        src/cppToolchain.cpp
        src/providerRuntime.cpp
    )
    target_include_directories(providerBatchingBenchmark PRIVATE include ${BOOST_INCLUDE_DIR} "${CMAKE_CURRENT_BINARY_DIR}")
    target_link_libraries(providerBatchingBenchmark PRIVATE protobuf::libprotobuf OpenSSL::Crypto Threads::Threads ${CMAKE_DL_LIBS})
endif()

if(MSVC)
    target_compile_options(konjugateEngine PRIVATE /W4 /permissive- /MP)
    if(BUILD_TESTING)
        target_compile_options(executionPlanTests PRIVATE /W4 /permissive- /MP)
        target_compile_options(relationshipProviderTests PRIVATE /W4 /permissive- /MP)
        target_compile_options(nodeProviderRuntimeTests PRIVATE /W4 /permissive- /MP)
        target_compile_options(causalInferenceTests PRIVATE /W4 /permissive- /MP)
        target_compile_options(parameterFittingTests PRIVATE /W4 /permissive- /MP)
    endif()
else()
    target_compile_options(konjugateEngine PRIVATE -Wall -Wextra -Wpedantic)
    if(BUILD_TESTING)
        target_compile_options(executionPlanTests PRIVATE -Wall -Wextra -Wpedantic)
        target_compile_options(relationshipProviderTests PRIVATE -Wall -Wextra -Wpedantic)
        target_compile_options(nodeProviderRuntimeTests PRIVATE -Wall -Wextra -Wpedantic)
        target_compile_options(causalInferenceTests PRIVATE -Wall -Wextra -Wpedantic)
        target_compile_options(parameterFittingTests PRIVATE -Wall -Wextra -Wpedantic)
    endif()
endif()

if(APPLE AND CMAKE_CXX_COMPILER_ID MATCHES "Clang")
    target_compile_options(konjugateEngine PRIVATE -Wno-nullability-extension -Wno-gcc-compat)
    target_compile_options(konjugateProviderWorker PRIVATE -Wno-nullability-extension -Wno-gcc-compat)
    if(BUILD_TESTING)
        target_compile_options(executionPlanTests PRIVATE -Wno-nullability-extension -Wno-gcc-compat)
        target_compile_options(relationshipProviderTests PRIVATE -Wno-nullability-extension -Wno-gcc-compat)
        target_compile_options(nodeProviderRuntimeTests PRIVATE -Wno-nullability-extension -Wno-gcc-compat)
        target_compile_options(causalInferenceTests PRIVATE -Wno-nullability-extension -Wno-gcc-compat)
        target_compile_options(parameterFittingTests PRIVATE -Wno-nullability-extension -Wno-gcc-compat)
    endif()
endif()
