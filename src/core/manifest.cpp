#include "core/manifest.hpp"

#include <fstream>
#include <stdexcept>

#include "core/crypto.hpp"

namespace p2p {

namespace {
constexpr uint32_t kReadBlockChunks = 64;  // hash 8 MB per disk read
}

uint32_t chunkCountFor(uint64_t size, uint32_t chunkSize) {
  const uint64_t count = (size + chunkSize - 1) / chunkSize;
  return static_cast<uint32_t>(count == 0 ? 1 : count);
}

uint32_t chunkLength(const FileMeta& meta, uint32_t index) {
  const uint64_t start = uint64_t{index} * meta.chunkSize;
  if (start >= meta.size) return 0;
  const uint64_t remaining = meta.size - start;
  return static_cast<uint32_t>(remaining < meta.chunkSize ? remaining : meta.chunkSize);
}

std::string computeFileId(const std::vector<std::string>& hashes) {
  std::string joined;
  joined.reserve(hashes.size() * 64);
  for (const auto& hash : hashes) joined += hash;
  return sha256Hex(joined).substr(0, 32);
}

Manifest buildManifest(const std::filesystem::path& path, const std::function<void(double)>& onProgress) {
  std::ifstream in(path, std::ios::binary);
  if (!in) throw std::runtime_error("cannot open " + path.string());

  Manifest manifest;
  manifest.meta.name = path.filename().string();
  manifest.meta.size = std::filesystem::file_size(path);
  manifest.meta.chunkSize = kChunkSize;
  manifest.meta.totalChunks = chunkCountFor(manifest.meta.size, kChunkSize);
  manifest.hashes.resize(manifest.meta.totalChunks);

  Bytes block(size_t{kChunkSize} * kReadBlockChunks);
  for (uint32_t first = 0; first < manifest.meta.totalChunks; first += kReadBlockChunks) {
    in.read(reinterpret_cast<char*>(block.data()), static_cast<std::streamsize>(block.size()));
    const size_t got = static_cast<size_t>(in.gcount());
    const uint32_t last = std::min(first + kReadBlockChunks, manifest.meta.totalChunks);
    for (uint32_t i = first; i < last; ++i) {
      const size_t offset = size_t{i - first} * kChunkSize;
      const size_t length = offset < got ? std::min<size_t>(kChunkSize, got - offset) : 0;
      manifest.hashes[i] = sha256Hex(block.data() + offset, length);
    }
    if (onProgress) onProgress(double(last) / manifest.meta.totalChunks);
  }

  manifest.meta.fileId = computeFileId(manifest.hashes);
  return manifest;
}

nlohmann::json metaToJson(const FileMeta& meta) {
  return {{"name", meta.name},
          {"size", meta.size},
          {"mimeType", "application/octet-stream"},
          {"chunkSize", meta.chunkSize},
          {"totalChunks", meta.totalChunks},
          {"fileId", meta.fileId}};
}

std::optional<FileMeta> metaFromJson(const nlohmann::json& json) {
  try {
    FileMeta meta;
    meta.name = json.at("name").get<std::string>();
    meta.size = json.at("size").get<uint64_t>();
    meta.chunkSize = json.at("chunkSize").get<uint32_t>();
    meta.totalChunks = json.at("totalChunks").get<uint32_t>();
    meta.fileId = json.at("fileId").get<std::string>();
    if (meta.chunkSize == 0 || meta.chunkSize > 1024 * 1024) return std::nullopt;
    if (meta.totalChunks != chunkCountFor(meta.size, meta.chunkSize)) return std::nullopt;
    if (meta.fileId.empty()) return std::nullopt;
    return meta;
  } catch (const nlohmann::json::exception&) {
    return std::nullopt;
  }
}

std::string sanitizeFileName(const std::string& name) {
  // Keep only the last path component, then replace characters Windows rejects.
  std::string base = name;
  const size_t slash = base.find_last_of("/\\");
  if (slash != std::string::npos) base = base.substr(slash + 1);

  std::string out;
  for (unsigned char c : base) {
    const bool bad = c < 32 || c == '<' || c == '>' || c == ':' || c == '"' || c == '|' || c == '?' ||
                     c == '*';
    out += bad ? '_' : static_cast<char>(c);
  }
  while (!out.empty() && (out.back() == '.' || out.back() == ' ')) out.pop_back();
  if (out.empty() || out == "." || out == "..") out = "download.bin";
  if (out.size() > 200) out = out.substr(out.size() - 200);
  return out;
}

}  // namespace p2p
