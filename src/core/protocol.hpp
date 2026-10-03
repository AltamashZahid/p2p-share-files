#pragma once
// ---------------------------------------------------------------------------
// Wire format for the swarm data channels. Every frame is encrypted:
//
//   control frame: [0x01][iv + AES-GCM(JSON message) + tag]          aad = "control"
//   chunk frame:   [0x02][index u32 BE][iv + AES-GCM(chunk) + tag]    aad = index
//
// Control messages (JSON, "t" = type):
//   hello     { peerId, nonce, isHost, fileId, have }  first message on every link
//   meta      { name, size, chunkSize, totalChunks, fileId }
//   manifest  { start, hashes[] }       SHA-256 of each plaintext chunk
//   bitfield  { fileId, have }          full set of verified chunks
//   have      { indices[] }             newly verified chunks (batched)
//   request   { indices[] }             "please send me these chunks"
// ---------------------------------------------------------------------------

#include <nlohmann/json.hpp>

#include <optional>

#include "core/crypto.hpp"

namespace p2p {

struct Frame {
  enum class Type { Control, Chunk };
  Type type = Type::Control;
  nlohmann::json message;  // Control
  uint32_t index = 0;      // Chunk
  Bytes data;              // Chunk (plaintext)
};

Bytes encodeControl(const Key& key, const nlohmann::json& message);
Bytes encodeChunk(const Key& key, uint32_t index, const uint8_t* data, size_t size);

/** nullopt if the frame can't be decrypted (wrong key, tampering) or parsed. */
std::optional<Frame> decodeFrame(const Key& key, const uint8_t* data, size_t size);

}  // namespace p2p
