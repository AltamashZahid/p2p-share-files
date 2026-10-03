#pragma once
// ---------------------------------------------------------------------------
// Chunk storage on disk.
//
// The sender reads chunks straight from the original file. A receiver writes
// each verified chunk at its final offset in a pre-sized `<name>.part` file,
// so memory use stays flat no matter how large the file is (>500 MB is no
// problem). When every chunk is verified the part file is renamed into place.
// ---------------------------------------------------------------------------

#include <filesystem>
#include <fstream>

#include "core/base64.hpp"
#include "core/manifest.hpp"

namespace p2p {

class ChunkSource {
 public:
  virtual ~ChunkSource() = default;
  virtual Bytes read(uint32_t index) = 0;
};

/** Read-only access to a complete file (the sender's original, or a finished download). */
class FileReader : public ChunkSource {
 public:
  FileReader(const std::filesystem::path& path, FileMeta meta);
  Bytes read(uint32_t index) override;

 private:
  std::ifstream in_;
  FileMeta meta_;
};

/** A download in progress: positional writes into `<dir>/<name>.part`. */
class PartFile : public ChunkSource {
 public:
  /** Opens (or creates and pre-sizes) the part file. Throws on I/O errors. */
  PartFile(const std::filesystem::path& directory, FileMeta meta);

  void write(uint32_t index, const Bytes& data);
  Bytes read(uint32_t index) override;
  /** Push buffered writes to the OS so they survive a crash. */
  void flush();
  /** Close and rename to the final name (adding " (1)" etc. if taken). */
  std::filesystem::path finalize();

  const std::filesystem::path& path() const { return partPath_; }
  static std::filesystem::path partPathFor(const std::filesystem::path& directory, const FileMeta& meta);

 private:
  std::filesystem::path directory_;
  std::filesystem::path partPath_;
  std::fstream file_;
  FileMeta meta_;
};

/** Bytes free on the drive holding `directory` (max value if unknown). */
uint64_t freeSpace(const std::filesystem::path& directory);

}  // namespace p2p
