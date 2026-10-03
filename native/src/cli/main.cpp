// ---------------------------------------------------------------------------
// p2pshare: command-line peer.
//
//   p2pshare send <file> [--server ws://host:8000]     share a file, print the link
//   p2pshare get  <link> [--out <dir>] [--exit-when-done]
//
// Every peer that opens the link joins the swarm: it downloads from the sender
// and from every other peer, and seeds what it has to the rest.
// ---------------------------------------------------------------------------

#include <rtc/rtc.hpp>

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

#include "core/crypto.hpp"
#include "core/event_loop.hpp"
#include "core/link.hpp"
#include "core/manifest.hpp"
#include "core/swarm.hpp"

namespace fs = std::filesystem;
using namespace p2p;

namespace {

std::atomic<bool> interrupted{false};
size_t lastLineLength = 0;

std::string formatBytes(double bytes) {
  const char* units[] = {"B", "KB", "MB", "GB", "TB"};
  int unit = 0;
  while (bytes >= 1024 && unit < 4) {
    bytes /= 1024;
    ++unit;
  }
  char text[32];
  std::snprintf(text, sizeof text, unit == 0 ? "%.0f %s" : "%.1f %s", bytes, units[unit]);
  return text;
}

std::string timestamp() {
  const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  char text[16];
  std::strftime(text, sizeof text, "%H:%M:%S", std::localtime(&now));
  return text;
}

/** Overwrite the live status line. */
void printStatus(const std::string& line) {
  std::string padded = line;
  if (padded.size() < lastLineLength) padded.append(lastLineLength - padded.size(), ' ');
  lastLineLength = line.size();
  std::cout << '\r' << padded << std::flush;
}

/** Print a log line above the live status line. */
void printEvent(const std::string& message) {
  std::cout << '\r' << std::string(lastLineLength, ' ') << '\r' << "[" << timestamp() << "] " << message << std::endl;
  lastLineLength = 0;
}

std::string statusLine(const SwarmSnapshot& snap, Role role) {
  std::string line = "[" + snap.status + "] ";
  if (role == Role::Host) {
    line += "up " + formatBytes(snap.uploadRate) + "/s | sent " + formatBytes(double(snap.uploadedTotal));
    int shown = 0;
    for (const auto& peer : snap.peers) {
      if (peer.state != "connected" || shown++ == 4) continue;
      line += (shown == 1 ? " | peers: " : ", ") + peer.id.substr(0, 6) + " " +
              std::to_string(int(peer.progress * 100)) + "%";
    }
    return line;
  }

  if (!snap.file) return line + snap.message;
  char percent[16];
  std::snprintf(percent, sizeof percent, "%.1f%%",
                snap.totalChunks ? 100.0 * snap.verifiedChunks / snap.totalChunks : 0.0);
  line += std::string(percent) + " " + formatBytes(double(snap.bytesVerified)) + "/" +
          formatBytes(double(snap.file->size)) + " | down " + formatBytes(snap.downloadRate) + "/s";
  if (snap.uploadRate > 0) line += " up " + formatBytes(snap.uploadRate) + "/s";
  line += " | " + std::to_string(snap.verifiedChunks) + "/" + std::to_string(snap.totalChunks) + " chunks";
  int shown = 0;
  for (const auto& peer : snap.peers) {
    if (peer.downloaded == 0 || shown++ == 3) continue;
    line += (shown == 1 ? " | from " : ", ") + (peer.isHost ? std::string("sender") : peer.id.substr(0, 6)) + " " +
            formatBytes(double(peer.downloaded));
  }
  return line;
}

int usage() {
  std::cout << "p2pshare - encrypted peer-to-peer file sharing\n\n"
               "Usage:\n"
               "  p2pshare send <file> [--server ws://host:8000] [--resume <link>] [--ice <url>]...\n"
               "  p2pshare get <link> [--out <dir>] [--exit-when-done] [--ice <url>]...\n\n"
               "  --server          signaling server (default ws://127.0.0.1:8000)\n"
               "  --resume <link>   sender restarted: share the same file in the same room again\n"
               "  --out <dir>       where to save the download (default: current directory)\n"
               "  --exit-when-done  quit after the download instead of seeding to others\n"
               "  --ice <url>       extra STUN/TURN server, e.g. turn:user:pass@host:3478\n";
  return 1;
}

/** Run the swarm until Ctrl+C, a fatal error, or (optionally) completion. */
int runSwarm(EventLoop& loop, Swarm& swarm, Role role, bool exitWhenDone) {
  int exitCode = 0;
  std::string lastMessage;
  swarm.onEvent = printEvent;
  swarm.onFatal = [&](const std::string& message) {
    printEvent("ERROR: " + message);
    exitCode = 2;
    loop.stop();
  };
  swarm.onComplete = [&](const fs::path& path) {
    printEvent("Download complete, every chunk verified. Saved to " + path.string());
    if (exitWhenDone) loop.postDelayed(std::chrono::seconds(1), [&] { loop.stop(); });
  };

  std::function<void()> refresh = [&] {
    if (interrupted) {
      printEvent("Stopping...");
      loop.stop();
      return;
    }
    const SwarmSnapshot snap = swarm.snapshot();
    if (snap.message != lastMessage) {
      lastMessage = snap.message;
      printEvent(snap.message);
    }
    printStatus(statusLine(snap, role));
    loop.postDelayed(std::chrono::milliseconds(500), refresh);
  };

  swarm.start();
  loop.post(refresh);
  loop.run();
  swarm.shutdown();
  std::cout << std::endl;
  return exitCode;
}

int send(int argc, char** argv) {
  if (argc < 3) return usage();
  const fs::path path = argv[2];
  SwarmOptions options;
  options.role = Role::Host;
  options.serverUrl = "ws://127.0.0.1:8000";
  std::string resumeLink;
  for (int i = 3; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--server" && i + 1 < argc) options.serverUrl = argv[++i];
    else if (arg == "--resume" && i + 1 < argc) resumeLink = argv[++i];
    else if (arg == "--ice" && i + 1 < argc) options.iceServers.push_back(argv[++i]);
    else return usage();
  }
  if (!fs::is_regular_file(path)) {
    std::cerr << "Not a file: " << path.string() << std::endl;
    return 1;
  }

  std::cout << "Hashing " << path.filename().string() << " (" << formatBytes(double(fs::file_size(path)))
            << ") for verification..." << std::endl;
  options.manifest = buildManifest(path, [](double progress) {
    printStatus("  " + std::to_string(int(progress * 100)) + "%");
  });
  std::cout << std::endl;
  options.sourcePath = path;

  if (!resumeLink.empty()) {
    // Same room and key as before, so peers continue from what they verified.
    const auto link = parseShareLink(resumeLink);
    if (!link) {
      std::cerr << "Invalid link for --resume" << std::endl;
      return 1;
    }
    options.serverUrl = link->serverUrl;
    options.roomId = link->roomId;
    options.key = Key::fromString(link->keyString);
  } else {
    options.roomId = randomId(4);
    options.key = Key::generate();
  }
  // Derived from the key, so a restarted sender reclaims its room with --resume.
  options.peerId = sha256Hex("host:" + options.key.toString()).substr(0, 16);

  const std::string link = buildShareLink({options.serverUrl, options.roomId, options.key.toString()});
  std::cout << "\nShare this link:\n\n  " << link << "\n\n"
            << "The part after #key= is the AES-256 decryption key. It never reaches the server.\n"
            << "Keep this running while peers download. Press Ctrl+C to stop.\n\n";

  EventLoop loop;
  Swarm swarm(loop, options);
  return runSwarm(loop, swarm, Role::Host, false);
}

int get(int argc, char** argv) {
  if (argc < 3) return usage();
  const auto link = parseShareLink(argv[2]);
  if (!link) {
    std::cerr << "Invalid link. Expected p2pshare://host:port/<room>#key=<key>" << std::endl;
    return 1;
  }

  SwarmOptions options;
  options.role = Role::Guest;
  options.serverUrl = link->serverUrl;
  options.roomId = link->roomId;
  bool exitWhenDone = false;
  for (int i = 3; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--out" && i + 1 < argc) options.outputDir = argv[++i];
    else if (arg == "--exit-when-done") exitWhenDone = true;
    else if (arg == "--ice" && i + 1 < argc) options.iceServers.push_back(argv[++i]);
    else return usage();
  }
  try {
    options.key = Key::fromString(link->keyString);
  } catch (const std::exception&) {
    std::cerr << "The link's #key is malformed." << std::endl;
    return 1;
  }
  options.peerId = randomId(8);

  std::cout << "Joining room " << link->roomId << " via " << link->serverUrl << "\n"
            << "Saving to " << fs::absolute(options.outputDir).string() << "\n\n";
  EventLoop loop;
  Swarm swarm(loop, options);
  return runSwarm(loop, swarm, Role::Guest, exitWhenDone);
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) return usage();
  rtc::InitLogger(rtc::LogLevel::Error);
  std::signal(SIGINT, [](int) { interrupted = true; });
  std::signal(SIGTERM, [](int) { interrupted = true; });

  const std::string command = argv[1];
  int result;
  try {
    if (command == "send") result = send(argc, argv);
    else if (command == "get") result = get(argc, argv);
    else result = usage();
  } catch (const std::exception& e) {
    std::cerr << "\nError: " << e.what() << std::endl;
    result = 1;
  }
  rtc::Cleanup().wait_for(std::chrono::seconds(2));
  return result;
}
