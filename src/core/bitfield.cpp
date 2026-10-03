#include "core/bitfield.hpp"

#include <stdexcept>

namespace p2p {

Bitfield::Bitfield(uint32_t size) : size_(size), bytes_((size + 7) / 8, 0) {}

Bitfield Bitfield::full(uint32_t size) {
  Bitfield field(size);
  for (uint32_t i = 0; i < size; ++i) field.set(i);
  return field;
}

Bitfield Bitfield::fromBase64(uint32_t size, std::string_view text) {
  Bytes bytes = base64urlDecode(text);
  if (bytes.size() != (size + 7) / 8) throw std::invalid_argument("bitfield size mismatch");
  Bitfield field(size);
  for (uint32_t i = 0; i < size; ++i) {
    if (bytes[i >> 3] & (1u << (i & 7))) field.set(i);
  }
  return field;
}

bool Bitfield::has(uint32_t index) const {
  return index < size_ && (bytes_[index >> 3] & (1u << (index & 7))) != 0;
}

bool Bitfield::set(uint32_t index) {
  if (index >= size_ || has(index)) return false;
  bytes_[index >> 3] |= static_cast<uint8_t>(1u << (index & 7));
  ++count_;
  return true;
}

}  // namespace p2p
