#include "core/protocol.hpp"

#include <cstring>

namespace p2p {

namespace {
constexpr uint8_t kFrameControl = 1;
constexpr uint8_t kFrameChunk = 2;
constexpr char kControlAad[] = "control";
constexpr size_t kControlAadSize = sizeof kControlAad - 1;

void writeU32(uint8_t* out, uint32_t value) {
  out[0] = static_cast<uint8_t>(value >> 24);
  out[1] = static_cast<uint8_t>(value >> 16);
  out[2] = static_cast<uint8_t>(value >> 8);
  out[3] = static_cast<uint8_t>(value);
}

uint32_t readU32(const uint8_t* in) {
  return (uint32_t{in[0]} << 24) | (uint32_t{in[1]} << 16) | (uint32_t{in[2]} << 8) | in[3];
}
}  // namespace

Bytes encodeControl(const Key& key, const nlohmann::json& message) {
  const std::string text = message.dump();
  const Bytes body = encrypt(key, reinterpret_cast<const uint8_t*>(text.data()), text.size(),
                             reinterpret_cast<const uint8_t*>(kControlAad), kControlAadSize);
  Bytes frame(1 + body.size());
  frame[0] = kFrameControl;
  std::memcpy(frame.data() + 1, body.data(), body.size());
  return frame;
}

Bytes encodeChunk(const Key& key, uint32_t index, const uint8_t* data, size_t size) {
  uint8_t header[5];
  header[0] = kFrameChunk;
  writeU32(header + 1, index);
  // The index is authenticated, so a chunk can't be replayed as another one.
  const Bytes body = encrypt(key, data, size, header + 1, 4);
  Bytes frame(sizeof header + body.size());
  std::memcpy(frame.data(), header, sizeof header);
  std::memcpy(frame.data() + sizeof header, body.data(), body.size());
  return frame;
}

std::optional<Frame> decodeFrame(const Key& key, const uint8_t* data, size_t size) {
  if (size < 1) return std::nullopt;

  if (data[0] == kFrameControl) {
    auto plain = decrypt(key, data + 1, size - 1, reinterpret_cast<const uint8_t*>(kControlAad),
                         kControlAadSize);
    if (!plain) return std::nullopt;
    Frame frame;
    frame.type = Frame::Type::Control;
    frame.message = nlohmann::json::parse(plain->begin(), plain->end(), nullptr, false);
    if (frame.message.is_discarded() || !frame.message.is_object()) return std::nullopt;
    return frame;
  }

  if (data[0] == kFrameChunk && size >= 5) {
    auto plain = decrypt(key, data + 5, size - 5, data + 1, 4);
    if (!plain) return std::nullopt;
    Frame frame;
    frame.type = Frame::Type::Chunk;
    frame.index = readU32(data + 1);
    frame.data = std::move(*plain);
    return frame;
  }

  return std::nullopt;
}

}  // namespace p2p
