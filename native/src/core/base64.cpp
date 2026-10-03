#include "core/base64.hpp"

#include <stdexcept>

namespace p2p {

namespace {
constexpr char kAlphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

int decodeChar(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '-' || c == '+') return 62;  // accept standard base64 too
  if (c == '_' || c == '/') return 63;
  return -1;
}
}  // namespace

std::string base64urlEncode(const uint8_t* data, size_t size) {
  std::string out;
  out.reserve((size + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 2 < size; i += 3) {
    const uint32_t n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    out += kAlphabet[(n >> 18) & 63];
    out += kAlphabet[(n >> 12) & 63];
    out += kAlphabet[(n >> 6) & 63];
    out += kAlphabet[n & 63];
  }
  if (i + 1 == size) {
    const uint32_t n = data[i] << 16;
    out += kAlphabet[(n >> 18) & 63];
    out += kAlphabet[(n >> 12) & 63];
  } else if (i + 2 == size) {
    const uint32_t n = (data[i] << 16) | (data[i + 1] << 8);
    out += kAlphabet[(n >> 18) & 63];
    out += kAlphabet[(n >> 12) & 63];
    out += kAlphabet[(n >> 6) & 63];
  }
  return out;
}

Bytes base64urlDecode(std::string_view text) {
  while (!text.empty() && text.back() == '=') text.remove_suffix(1);
  if (text.size() % 4 == 1) throw std::invalid_argument("invalid base64 length");

  Bytes out;
  out.reserve(text.size() * 3 / 4);
  uint32_t buffer = 0;
  int bits = 0;
  for (char c : text) {
    const int value = decodeChar(c);
    if (value < 0) throw std::invalid_argument("invalid base64 character");
    buffer = (buffer << 6) | static_cast<uint32_t>(value);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<uint8_t>((buffer >> bits) & 0xFF));
    }
  }
  return out;
}

std::string toHex(const uint8_t* data, size_t size) {
  static constexpr char kDigits[] = "0123456789abcdef";
  std::string out(size * 2, '0');
  for (size_t i = 0; i < size; ++i) {
    out[2 * i] = kDigits[data[i] >> 4];
    out[2 * i + 1] = kDigits[data[i] & 15];
  }
  return out;
}

}  // namespace p2p
