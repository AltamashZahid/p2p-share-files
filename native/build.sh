#!/usr/bin/env bash
# Configure + build with the MSYS2 UCRT64 toolchain (GCC, CMake, Ninja).
set -euo pipefail
cd "$(dirname "$0")"
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel 4
