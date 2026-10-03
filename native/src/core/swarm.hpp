#pragma once
// ---------------------------------------------------------------------------
// Swarm: the peer-to-peer engine behind `p2pshare send` and `p2pshare get`.
//
// Every peer in a room connects to every other peer over WebRTC (full mesh).
// Transfers are pull-based, like BitTorrent:
//   1. The sender publishes a manifest: file metadata + SHA-256 of each chunk.
//   2. Every peer keeps a bitfield of the chunks it has verified and tells the
//      others about new ones ("have").
//   3. A downloader requests missing chunks from every connected peer that has
//      them, so a third peer downloads different parts from the sender and
//      from the second peer simultaneously.
//   4. Each chunk is decrypted, checked against the manifest hash, written to
//      disk at its offset, and immediately offered to the rest of the swarm.
//
// Churn recovery: dropped links are retried with backoff, P2P links survive
// signaling outages, and a guest persists its verified bitfield (resume.hpp),
// so after a dropped connection or a restart the download resumes from the
// last verified chunk.
//
// All methods run on the EventLoop thread (see event_loop.hpp).
// ---------------------------------------------------------------------------

#include <rtc/rtc.hpp>

#include <nlohmann/json.hpp>

#include <chrono>
#include <deque>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "core/bitfield.hpp"
#include "core/crypto.hpp"
#include "core/event_loop.hpp"
#include "core/manifest.hpp"
#include "core/signaling.hpp"
#include "core/storage.hpp"

namespace p2p {

enum class Role { Host, Guest };

struct SwarmOptions {
  Role role = Role::Guest;
  std::string serverUrl;  // ws://host:port of p2pshare-signal
  std::string roomId;
  std::string peerId;  // this process's id in the room
  Key key;             // AES-256-GCM key from the link fragment
  std::vector<std::string> iceServers{"stun:stun.l.google.com:19302"};
  // Host only
  std::filesystem::path sourcePath;
  std::optional<Manifest> manifest;
  // Guest only
  std::filesystem::path outputDir = ".";
};

/** A guest's peer id for a room: reused from its resume state so a restarted
 * download rejoins as the same peer, otherwise freshly generated. */
std::string guestPeerId(const std::filesystem::path& outputDir, const std::string& roomId);

struct PeerSnapshot {
  std::string id;
  bool isHost = false;
  std::string state;  // connected | connecting | reconnecting | left | banned | bad-key
  double progress = 0;
  uint64_t downloaded = 0;  // bytes we received from this peer
  uint64_t uploaded = 0;    // bytes we sent to this peer
};

struct SwarmSnapshot {
  std::string status;  // connecting | waiting | connected | transferring | seeding | stalled | complete | error
  std::string message;
  std::optional<FileMeta> file;
  uint32_t verifiedChunks = 0;
  uint32_t totalChunks = 0;
  uint32_t resumedChunks = 0;
  uint64_t bytesVerified = 0;
  double downloadRate = 0;
  double uploadRate = 0;
  uint64_t uploadedTotal = 0;
  std::optional<std::filesystem::path> savedTo;
  std::vector<PeerSnapshot> peers;
};

/** Bytes per second over a sliding two-second window. */
class RateMeter {
 public:
  void add(uint64_t bytes);
  double rate();
  uint64_t total() const { return total_; }

 private:
  std::deque<std::pair<std::chrono::steady_clock::time_point, uint64_t>> samples_;
  uint64_t total_ = 0;
};

class Swarm {
 public:
  Swarm(EventLoop& loop, SwarmOptions options);
  ~Swarm();
  Swarm(const Swarm&) = delete;
  Swarm& operator=(const Swarm&) = delete;

  void start();
  /** Close every connection. Call on the loop thread before destroying. */
  void shutdown();
  SwarmSnapshot snapshot();

  std::function<void(const std::string&)> onEvent;                // notable events, for the log
  std::function<void(const std::filesystem::path&)> onComplete;  // guest: file verified and saved
  std::function<void(const std::string&)> onFatal;               // unrecoverable error

 private:
  using Clock = std::chrono::steady_clock;
  struct Link;
  struct Peer;

  // signaling
  void registerInRoom();
  void onSignalingMessage(const nlohmann::json& message);
  void onPeerJoined(const std::string& peerId, const std::string& nonce);
  void onSignal(const std::string& from, const nlohmann::json& data);
  void sendSignal(const std::string& to, const nlohmann::json& data);

  // links
  void ensureLink(const std::string& remoteId);
  std::shared_ptr<Link> createLink(const std::string& remoteId, bool initiator);
  void watchChannel(const std::string& remoteId, uint64_t linkId, const std::shared_ptr<rtc::DataChannel>& channel);
  std::shared_ptr<Link> currentLink(const std::string& remoteId, uint64_t linkId);
  std::shared_ptr<Link> adoptChannel(const std::string& remoteId, uint64_t linkId,
                                     const std::shared_ptr<rtc::DataChannel>& channel);
  void onLinkOpen(const std::shared_ptr<Link>& link);
  void onPeerConnectionState(const std::string& remoteId, uint64_t linkId, rtc::PeerConnection::State state);
  void failLink(const std::shared_ptr<Link>& link, const std::string& reason);
  void dropLink(const std::string& remoteId);
  static void closeLink(Link& link);
  bool sendControl(const std::shared_ptr<Link>& link, const nlohmann::json& message);
  bool sendBinary(const std::shared_ptr<Link>& link, const Bytes& frame);
  Peer& peerState(const std::string& peerId);

  // protocol
  void onFrame(const std::shared_ptr<Link>& link, const Bytes& data);
  void onControl(const std::shared_ptr<Link>& link, Peer& peer, const nlohmann::json& message);
  void acceptBitfield(Peer& peer, const std::string& fileId, const std::string& have);
  void sendMetadata(const std::shared_ptr<Link>& link, Peer& peer);
  void onMeta(const nlohmann::json& message);
  void onManifestPart(const nlohmann::json& message);
  void prepareStorage();
  void onReady();

  // transfer
  void schedule();
  void releaseRequests(const std::string& peerId);
  void onChunk(const std::shared_ptr<Link>& link, Peer& peer, uint32_t index, const Bytes& data);
  void finish();
  void persist();
  void enqueueUploads(Peer& peer, const nlohmann::json& indices);
  void pumpUploads(const std::string& remoteId);
  void flushHaves();

  // housekeeping
  void scheduleTick();
  void tick();
  void fail(const std::string& message);
  void event(const std::string& message);
  uint64_t bytesVerified() const;
  bool canProgress();

  EventLoop& loop_;
  SwarmOptions options_;
  const std::string nonce_;  // distinguishes this run from an earlier one with the same peer id
  std::unique_ptr<SignalingClient> signaling_;
  bool registered_ = false;
  bool everRegistered_ = false;  // joined successfully at least once
  Clock::time_point startedAt_{};
  bool stopped_ = false;

  std::set<std::string> members_;  // peer ids the signaling server says are in the room
  std::map<std::string, std::shared_ptr<Link>> links_;
  std::map<std::string, Peer> peers_;
  std::string hostPeerId_;
  uint64_t nextLinkId_ = 0;

  std::optional<FileMeta> meta_;
  std::vector<std::string> hashes_;  // SHA-256 (hex) of every chunk
  uint32_t hashesReceived_ = 0;
  std::unique_ptr<ChunkSource> source_;  // where chunks are read from
  PartFile* part_ = nullptr;             // guest: same object as source_ while downloading
  std::optional<Bitfield> have_;         // chunks this peer has verified
  bool ready_ = false;                   // manifest verified, storage open
  bool preparing_ = false;
  bool completed_ = false;
  std::optional<std::filesystem::path> savedTo_;
  uint32_t resumedChunks_ = 0;
  bool resumeDirty_ = false;
  Clock::time_point lastPersist_{};

  std::map<uint32_t, std::pair<std::string, Clock::time_point>> inflight_;  // chunk -> (peer, requested at)
  uint32_t cursor_ = 0;  // every chunk below this index is verified
  std::vector<uint32_t> pendingHaves_;
  RateMeter downloadMeter_;
  RateMeter uploadMeter_;
  std::string fatalError_;
};

}  // namespace p2p
