#pragma once
// ---------------------------------------------------------------------------
// Auto-resume state for a download, stored next to it as
// `<out dir>/.p2pshare-<roomId>.json`:
//
//   { peerId, fileId, have (base64 bitfield), complete, savedTo, updatedAt }
//
// The bitfield is only saved after the .part file has been flushed, so every
// chunk it lists is really on disk. A restarted `p2pshare get` with the same
// link reloads it and requests only the missing chunks: the download resumes
// from the last verified chunk instead of 0%.
// ---------------------------------------------------------------------------

#include <filesystem>
#include <optional>
#include <string>

namespace p2p {

struct ResumeState {
  std::string peerId;  // reused so the swarm recognises a returning peer
  std::string fileId;
  std::string have;  // base64url bitfield of verified chunks
  bool complete = false;
  std::string savedTo;  // final path once complete
};

std::filesystem::path resumeStatePath(const std::filesystem::path& directory, const std::string& roomId);
std::optional<ResumeState> loadResumeState(const std::filesystem::path& directory, const std::string& roomId);
/** Write atomically (temp file + rename). Returns false on I/O errors. */
bool saveResumeState(const std::filesystem::path& directory, const std::string& roomId, const ResumeState& state);

}  // namespace p2p
