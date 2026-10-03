#include "core/resume.hpp"

#include <nlohmann/json.hpp>

#include <chrono>
#include <fstream>

namespace p2p {

namespace fs = std::filesystem;

fs::path resumeStatePath(const fs::path& directory, const std::string& roomId) {
  return directory / (".p2pshare-" + roomId + ".json");
}

std::optional<ResumeState> loadResumeState(const fs::path& directory, const std::string& roomId) {
  std::ifstream in(resumeStatePath(directory, roomId));
  if (!in) return std::nullopt;
  const nlohmann::json json = nlohmann::json::parse(in, nullptr, false);
  if (json.is_discarded() || !json.is_object()) return std::nullopt;
  try {
    ResumeState state;
    state.peerId = json.at("peerId").get<std::string>();
    state.fileId = json.value("fileId", "");
    state.have = json.value("have", "");
    state.complete = json.value("complete", false);
    state.savedTo = json.value("savedTo", "");
    return state;
  } catch (const nlohmann::json::exception&) {
    return std::nullopt;
  }
}

bool saveResumeState(const fs::path& directory, const std::string& roomId, const ResumeState& state) {
  const nlohmann::json json = {
      {"peerId", state.peerId},
      {"fileId", state.fileId},
      {"have", state.have},
      {"complete", state.complete},
      {"savedTo", state.savedTo},
      {"updatedAt", std::chrono::duration_cast<std::chrono::seconds>(
                        std::chrono::system_clock::now().time_since_epoch())
                        .count()},
  };
  const fs::path target = resumeStatePath(directory, roomId);
  const fs::path temp = target.string() + ".tmp";
  {
    std::ofstream out(temp, std::ios::trunc);
    if (!out) return false;
    out << json.dump();
    if (!out) return false;
  }
  std::error_code error;
  fs::remove(target, error);
  fs::rename(temp, target, error);
  return !error;
}

}  // namespace p2p
