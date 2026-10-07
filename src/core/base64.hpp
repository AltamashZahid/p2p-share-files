#pragma once
// Byte buffers and text encodings shared by the whole project.

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace p2p {

using Bytes = std::vector<uint8_t>;

/** URL-safe base64 without padding (RFC 4648 §5), as used in share links. */
std::string base64urlEncode(const uint8_t* data, size_t size);
inline std::string base64urlEncode(const Bytes& bytes) { return base64urlEncode(bytes.data(), bytes.size()); }

/** Throws std::invalid_argument on malformed input. */
Bytes base64urlDecode(std::string_view text);

std::string toHex(const uint8_t* data, size_t size);

}  // namespace p2p
