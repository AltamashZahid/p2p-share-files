cmake_minimum_required(VERSION 3.20)
project(p2pshare VERSION 1.0.0 LANGUAGES C CXX)

# ---------------------------------------------------------------------------
# p2pshare: decentralized, end-to-end encrypted P2P file sharing in C++17.
#   p2pshare-signal  WebSocket signaling server (introduces peers only)
#   p2pshare         CLI peer: `send <file>` / `get <link>`
#   p2pshare-tests   unit tests for the crypto/protocol core
# ---------------------------------------------------------------------------

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# Self-contained executables: no MinGW / OpenSSL DLLs needed next to them.
set(OPENSSL_USE_STATIC_LIBS ON)
find_package(OpenSSL REQUIRED)
find_package(nlohmann_json 3.11 REQUIRED)
find_package(Threads REQUIRED)

# libdatachannel: WebRTC data channels + WebSocket client/server (no media).
include(FetchContent)
set(NO_MEDIA ON CACHE BOOL "" FORCE)
set(NO_EXAMPLES ON CACHE BOOL "" FORCE)
set(NO_TESTS ON CACHE BOOL "" FORCE)
set(NO_WEBSOCKET OFF CACHE BOOL "" FORCE)
set(USE_GNUTLS OFF CACHE BOOL "" FORCE)
set(USE_MBEDTLS OFF CACHE BOOL "" FORCE)
set(USE_NICE OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
  libdatachannel
  GIT_REPOSITORY https://github.com/paullouisageneau/libdatachannel.git
  GIT_TAG v0.24.6
  GIT_SHALLOW TRUE
  GIT_SUBMODULES_RECURSE TRUE
)
FetchContent_MakeAvailable(libdatachannel)

if(MINGW)
  set(STATIC_RUNTIME -static)
endif()

# Core library shared by the CLI, the server and the tests.
add_library(p2pcore STATIC
  src/core/base64.cpp
  src/core/bitfield.cpp
  src/core/crypto.cpp
  src/core/link.cpp
  src/core/manifest.cpp
  src/core/protocol.cpp
  src/core/resume.cpp
  src/core/event_loop.cpp
  src/core/signaling.cpp
  src/core/storage.cpp
  src/core/swarm.cpp
)
target_include_directories(p2pcore PUBLIC src)
target_link_libraries(p2pcore PUBLIC
  LibDataChannel::LibDataChannelStatic
  OpenSSL::Crypto
  nlohmann_json::nlohmann_json
  Threads::Threads
)
if(WIN32)
  target_link_libraries(p2pcore PUBLIC ws2_32 crypt32)
endif()
if(MSVC)
  target_compile_options(p2pcore PRIVATE /W4)
else()
  target_compile_options(p2pcore PRIVATE -Wall -Wextra)
endif()

add_executable(p2pshare src/cli/main.cpp)
target_link_libraries(p2pshare PRIVATE p2pcore ${STATIC_RUNTIME})

add_executable(p2pshare-signal src/server/main.cpp)
target_link_libraries(p2pshare-signal PRIVATE p2pcore ${STATIC_RUNTIME})

enable_testing()
add_executable(p2pshare-tests tests/test_core.cpp)
target_link_libraries(p2pshare-tests PRIVATE p2pcore ${STATIC_RUNTIME})
add_test(NAME core COMMAND p2pshare-tests)
