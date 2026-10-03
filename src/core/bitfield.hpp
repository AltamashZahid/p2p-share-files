#pragma once
// Compact record of which chunks a peer holds: one bit per chunk, like
// BitTorrent's bitfield. A 1 GB file (8192 chunks of 128 KB) needs 1 KB.
// Bit i lives in byte i/8 under mask 1 << (i % 8).

#include <cstdint>
#include <string>
#include <string_view>

#include "core/base64.hpp"

namespace p2p {

class Bitfield {
 public:
  Bitfield() = default;
  explicit Bitfield(uint32_t size);

  static Bitfield full(uint32_t size);
  /** Throws std::invalid_argument if the text doesn't match `size`. */
  static Bitfield fromBase64(uint32_t size, std::string_view text);

  bool has(uint32_t index) const;
  /** Returns true if the bit was newly set. */
  bool set(uint32_t index);

  uint32_t size() const { return size_; }
  uint32_t count() const { return count_; }
  bool complete() const { return count_ == size_; }
  std::string toBase64() const { return base64urlEncode(bytes_); }

 private:
  uint32_t size_ = 0;
  uint32_t count_ = 0;
  Bytes bytes_;
};

}  // namespace p2p
