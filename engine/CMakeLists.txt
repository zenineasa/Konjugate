# Copyright © 2026 Zenin Easa Panthakkalakath

cmake_minimum_required(VERSION 3.20)
project(konjugateEngine VERSION 0.1.0 LANGUAGES CXX)

if(NOT CMAKE_CONFIGURATION_TYPES AND NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE RelWithDebInfo CACHE STRING "Build type" FORCE)
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(ZLIB REQUIRED)
set(OPENSSL_USE_STATIC_LIBS TRUE)
find_package(OpenSSL REQUIRED)
find_path(BOOST_INCLUDE_DIR boost/property_tree/json_parser.hpp REQUIRED)

add_executable(konjugateEngine
    src/main.cpp
    src/modelValidator.cpp
    src/projectContainer.cpp
    src/simulationRunner.cpp
    src/validationReport.cpp
)
target_include_directories(konjugateEngine PRIVATE include ${BOOST_INCLUDE_DIR})
target_link_libraries(konjugateEngine PRIVATE ZLIB::ZLIB OpenSSL::Crypto)

if(MSVC)
    target_compile_options(konjugateEngine PRIVATE /W4 /permissive-)
else()
    target_compile_options(konjugateEngine PRIVATE -Wall -Wextra -Wpedantic)
endif()
