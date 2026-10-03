#include "core/storage.hpp"

#include <limits>
#include <stdexcept>

namespace p2p {

namespace fs = std::filesystem;

namespace {
std::streamoff offsetOf(const FileMeta& meta, uint32_t index) {
  return static_cast<std::streamoff>(uint64_t{index} * meta.chunkSize);
}
}  // namespace

FileReader::FileReader(const fs::path& path, FileMeta meta) : in_(path, std::ios::binary), meta_(std::move(meta)) {
  if (!in_) throw std::runtime_error("cannot open " + path.string());
}

Bytes FileReader::read(uint32_t index) {
  Bytes data(chunkLength(meta_, index));
  in_.clear();
  in_.seekg(offsetOf(meta_, index));
  in_.read(reinterpret_cast<char*>(data.data()), static_cast<std::streamsize>(data.size()));
  if (static_cast<size_t>(in_.gcount()) != data.size()) throw std::runtime_error("short read");
  return data;
}

fs::path PartFile::partPathFor(const fs::path& directory, const FileMeta& meta) {
  return directory / (sanitizeFileName(meta.name) + ".part");
}

PartFile::PartFile(const fs::path& directory, FileMeta meta)
    : directory_(directory), partPath_(partPathFor(directory, meta)), meta_(std::move(meta)) {
  fs::create_directories(directory_);
  if (!fs::exists(partPath_)) std::ofstream(partPath_, std::ios::binary);  // create empty
  // Pre-size so every chunk can be written at its final offset, in any order.
  if (fs::file_size(partPath_) != meta_.size) fs::resize_file(partPath_, meta_.size);
  file_.open(partPath_, std::ios::in | std::ios::out | std::ios::binary);
  if (!file_) throw std::runtime_error("cannot open " + partPath_.string());
}

void PartFile::write(uint32_t index, const Bytes& data) {
  file_.clear();
  file_.seekp(offsetOf(meta_, index));
  file_.write(reinterpret_cast<const char*>(data.data()), static_cast<std::streamsize>(data.size()));
  if (!file_) throw std::runtime_error("write failed (disk full?)");
}

Bytes PartFile::read(uint32_t index) {
  Bytes data(chunkLength(meta_, index));
  file_.clear();
  file_.seekg(offsetOf(meta_, index));
  file_.read(reinterpret_cast<char*>(data.data()), static_cast<std::streamsize>(data.size()));
  if (static_cast<size_t>(file_.gcount()) != data.size()) throw std::runtime_error("short read");
  return data;
}

void PartFile::flush() { file_.flush(); }

fs::path PartFile::finalize() {
  file_.flush();
  file_.close();

  const std::string name = sanitizeFileName(meta_.name);
  fs::path target = directory_ / name;
  const fs::path stem = fs::path(name).stem();
  const fs::path extension = fs::path(name).extension();
  for (int n = 1; fs::exists(target); ++n) {
    target = directory_ / (stem.string() + " (" + std::to_string(n) + ")" + extension.string());
  }
  fs::rename(partPath_, target);
  return target;
}

uint64_t freeSpace(const fs::path& directory) {
  std::error_code error;
  fs::create_directories(directory, error);
  const auto info = fs::space(directory, error);
  return error ? std::numeric_limits<uint64_t>::max() : info.available;
}

}  // namespace p2p
