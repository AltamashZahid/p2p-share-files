#pragma once
// The sender hashes every chunk up front. Peers verify each chunk against this
// list no matter which peer relayed it, so a relaying peer can't corrupt the
// file. `fileId` is a hash of all chunk hashes, which authenticates the list.

#include <nlohmann/json.hpp>

#include <filesystem>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace p2p {

constexpr uint32_t kChunkSize = 128 * 1024;

struct FileMeta {
  std::string name;
  uint64_t size = 0;
  uint32_t chunkSize = kChunkSize;
  uint32_t totalChunks = 0;
  std::string fileId;
};

struct Manifest {
  FileMeta meta;
  std::vector<std::string> hashes;  // hex SHA-256 of every plaintext chunk
};

Manifest buildManifest(const std::filesystem::path& path,
                       const std::function<void(double)>& onProgress = nullptr);
std::string computeFileId(const std::vector<std::string>& hashes);
uint32_t chunkLength(const FileMeta& meta, uint32_t index);
uint32_t chunkCountFor(uint64_t size, uint32_t chunkSize);

nlohmann::json metaToJson(const FileMeta& meta);
/** nullopt if fields are missing or inconsistent. */
std::optional<FileMeta> metaFromJson(const nlohmann::json& json);

/** Make a remote file name safe to create locally (no paths, no reserved characters). */
std::string sanitizeFileName(const std::string& name);

}  // namespace p2p
