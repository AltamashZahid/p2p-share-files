#include "core/swarm.hpp"

#include <algorithm>
#include <cctype>

#include "core/protocol.hpp"
#include "core/resume.hpp"

namespace p2p {

using nlohmann::json;
using namespace std::chrono_literals;

namespace {

constexpr auto kTickInterval = 250ms;
constexpr uint32_t kRequestWindow = 16;  // max chunks requested from one peer at a time
constexpr auto kRequestTimeout = 20s;    // re-request elsewhere after this
constexpr auto kConnectTimeout = 20s;    // a link that never opens counts as failed
constexpr auto kDisconnectGrace = 5s;    // "disconnected" is often a transient blip
constexpr auto kLeftPeerSilence = 3s;    // peer left the room and went quiet: it's gone
constexpr size_t kManifestBatch = 1500;  // hashes per manifest message (~100 KB)
constexpr size_t kHighWaterMark = 4 * 1024 * 1024;
constexpr size_t kLowWaterMark = 1 * 1024 * 1024;
constexpr int kMaxCorruptChunks = 3;
constexpr auto kRetryBase = 1000ms;
constexpr auto kRetryMax = 10000ms;
constexpr size_t kMaxMessageSize = 256 * 1024;
constexpr auto kPersistInterval = 1s;

bool isValidPeerIdText(const std::string& text) {
  return text.size() >= 4 && text.size() <= 64 &&
         std::all_of(text.begin(), text.end(), [](char c) { return std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_'; });
}

bool isHashHex(const std::string& text) {
  return text.size() == 64 &&
         std::all_of(text.begin(), text.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}

std::string stringOrEmpty(const json& message, const char* key) {
  const auto it = message.find(key);
  return it != message.end() && it->is_string() ? it->get<std::string>() : std::string();
}

}  // namespace

// ------------------------------------------------------------------ helpers

std::string guestPeerId(const std::filesystem::path& outputDir, const std::string& roomId) {
  const auto state = loadResumeState(outputDir, roomId);
  return state && isValidPeerIdText(state->peerId) ? state->peerId : randomId(8);
}

void RateMeter::add(uint64_t bytes) {
  samples_.emplace_back(std::chrono::steady_clock::now(), bytes);
  total_ += bytes;
}

double RateMeter::rate() {
  const auto cutoff = std::chrono::steady_clock::now() - 2s;
  while (!samples_.empty() && samples_.front().first < cutoff) samples_.pop_front();
  uint64_t bytes = 0;
  for (const auto& [time, n] : samples_) bytes += n;
  return bytes / 2.0;
}

struct Swarm::Link {
  uint64_t id = 0;
  std::string remoteId;
  bool initiator = false;
  std::shared_ptr<rtc::PeerConnection> pc;
  std::shared_ptr<rtc::DataChannel> channel;
  bool open = false;
  bool closed = false;
  bool remoteDescriptionSet = false;
  std::vector<rtc::Candidate> pendingCandidates;  // ICE that arrived before the SDP
  std::string remoteNonce;
  Clock::time_point createdAt = Clock::now();
  Clock::time_point lastActivity = Clock::now();  // last frame received
  std::optional<Clock::time_point> disconnectedAt;
};

struct Swarm::Peer {
  std::string id;
  bool isHost = false;
  std::string state = "connecting";
  std::optional<Bitfield> have;                                        // their chunks, once we know the file
  std::optional<std::pair<std::string, std::string>> pendingBitfield;  // (fileId, have) received too early
  std::vector<uint32_t> earlyHaves;                                    // "have"s received too early
  bool hasMeta = false;                                                // do they already know the file?
  std::set<uint32_t> inflight;                                         // chunks we requested from them
  std::deque<uint32_t> uploadQueue;                                    // chunks they requested from us
  uint64_t downloaded = 0;
  uint64_t uploaded = 0;
  int corrupt = 0;
  int retries = 0;
  Clock::time_point retryAt{};
};

Swarm::Swarm(EventLoop& loop, SwarmOptions options)
    : loop_(loop), options_(std::move(options)), nonce_(randomId(4)) {}

Swarm::~Swarm() { shutdown(); }

// ---------------------------------------------------------------- lifecycle

void Swarm::start() {
  startedAt_ = Clock::now();
  if (options_.role == Role::Host) {
    meta_ = options_.manifest->meta;
    hashes_ = options_.manifest->hashes;
    source_ = std::make_unique<FileReader>(options_.sourcePath, *meta_);
    have_ = Bitfield::full(meta_->totalChunks);
    hostPeerId_ = options_.peerId;
    ready_ = true;
    completed_ = true;
  }

  SignalingClient::Handlers handlers;
  handlers.onConnected = [this] { registerInRoom(); };
  handlers.onDisconnected = [this] {
    registered_ = false;
    event("Lost the signaling server, reconnecting... (direct peer links keep transferring)");
  };
  handlers.onMessage = [this](const json& message) { onSignalingMessage(message); };
  signaling_ = std::make_unique<SignalingClient>(loop_, options_.serverUrl, handlers);
  signaling_->start();
  scheduleTick();
}

void Swarm::shutdown() {
  if (stopped_) return;
  stopped_ = true;
  if (signaling_) signaling_->stop();
  for (auto& [id, link] : links_) closeLink(*link);
  links_.clear();
  persist();  // save progress so the next run resumes
}

void Swarm::fail(const std::string& message) {
  if (!fatalError_.empty()) return;
  fatalError_ = message;
  if (onFatal) onFatal(message);
}

void Swarm::event(const std::string& message) {
  if (onEvent) onEvent(message);
}

// ---------------------------------------------------------------- signaling

void Swarm::registerInRoom() {
  const bool host = options_.role == Role::Host;
  const json message = {{"type", host ? "create-room" : "join-room"},
                        {"roomId", options_.roomId},
                        {"peerId", options_.peerId},
                        {"nonce", nonce_}};
  signaling_->request(message, [this](std::optional<json> response) {
    if (stopped_) return;
    if (!response) {
      // No answer: try again shortly (or after the socket reconnects).
      loop_.postDelayed(3s, [this] {
        if (!stopped_ && !registered_ && signaling_->connected()) registerInRoom();
      });
      return;
    }
    if (!response->value("ok", false)) {
      const std::string error = response->value("error", std::string("Could not join the room."));
      if (!everRegistered_) {
        fail(error);  // wrong or expired link
        return;
      }
      // We were in this room before, so the signaling server probably restarted
      // and lost it. Keep trying: the sender re-creates it when it reconnects.
      loop_.postDelayed(3s, [this] {
        if (!stopped_ && !registered_ && signaling_->connected()) registerInRoom();
      });
      return;
    }
    registered_ = true;
    everRegistered_ = true;
    hostPeerId_ = response->value("hostPeerId", hostPeerId_);
    members_.clear();
    for (const auto& id : response->value("peers", json::array())) {
      if (id.is_string()) members_.insert(id.get<std::string>());
    }
    for (const auto& id : std::vector<std::string>(members_.begin(), members_.end())) ensureLink(id);
  });
}

void Swarm::onSignalingMessage(const json& message) {
  const std::string type = stringOrEmpty(message, "type");
  const std::string peerId = stringOrEmpty(message, "peerId");
  if (type == "peer-joined" && !peerId.empty()) {
    members_.insert(peerId);
    onPeerJoined(peerId, stringOrEmpty(message, "nonce"));
  } else if (type == "peer-left" && !peerId.empty()) {
    members_.erase(peerId);
  } else if (type == "signal") {
    const std::string from = stringOrEmpty(message, "from");
    if (!from.empty() && message.contains("data")) onSignal(from, message["data"]);
  }
}

void Swarm::onPeerJoined(const std::string& peerId, const std::string& nonce) {
  const auto it = links_.find(peerId);
  // Same run re-registering after a signaling blip: our direct link is fine.
  if (it != links_.end() && it->second->open && it->second->remoteNonce == nonce) return;
  // Otherwise it's a new run (e.g. a restart): start over with a fresh link.
  if (it != links_.end()) dropLink(peerId);
  Peer& peer = peerState(peerId);
  peer.retries = 0;
  peer.retryAt = {};
  ensureLink(peerId);
}

void Swarm::sendSignal(const std::string& to, const json& data) {
  signaling_->send({{"type", "signal"}, {"to", to}, {"data", data}});
}

void Swarm::onSignal(const std::string& from, const json& data) {
  if (stopped_ || !data.is_object()) return;
  const std::string kind = stringOrEmpty(data, "kind");

  std::shared_ptr<Link> link;
  if (kind == "description" && data.contains("description") &&
      stringOrEmpty(data["description"], "type") == "offer") {
    link = createLink(from, false);  // an offer always (re)starts the connection
  } else {
    const auto it = links_.find(from);
    if (it == links_.end() || it->second->closed) return;
    link = it->second;
  }

  try {
    if (kind == "description") {
      const json& description = data.at("description");
      link->pc->setRemoteDescription(
          rtc::Description(description.at("sdp").get<std::string>(), description.at("type").get<std::string>()));
      link->remoteDescriptionSet = true;
      for (const auto& candidate : link->pendingCandidates) {
        try {
          link->pc->addRemoteCandidate(candidate);
        } catch (const std::exception&) {
          // Unusable candidate (e.g. an mDNS name); others will do.
        }
      }
      link->pendingCandidates.clear();
    } else if (kind == "ice") {
      const json& candidate = data.at("candidate");
      rtc::Candidate parsed(candidate.at("candidate").get<std::string>(), stringOrEmpty(candidate, "sdpMid"));
      if (link->remoteDescriptionSet) {
        try {
          link->pc->addRemoteCandidate(parsed);
        } catch (const std::exception&) {
        }
      } else {
        link->pendingCandidates.push_back(parsed);
      }
    }
  } catch (const std::exception&) {
    failLink(link, "invalid signal");
  }
}

// -------------------------------------------------------------------- links

Swarm::Peer& Swarm::peerState(const std::string& peerId) {
  auto it = peers_.find(peerId);
  if (it == peers_.end()) {
    Peer peer;
    peer.id = peerId;
    peer.isHost = peerId == hostPeerId_;
    it = peers_.emplace(peerId, std::move(peer)).first;
  }
  return it->second;
}

/** Make sure we have (or are getting) a direct connection to `remoteId`. */
void Swarm::ensureLink(const std::string& remoteId) {
  if (stopped_ || remoteId == options_.peerId || !members_.count(remoteId)) return;
  const auto it = links_.find(remoteId);
  if (it != links_.end() && !it->second->closed) return;
  Peer& peer = peerState(remoteId);
  if (peer.state == "banned" || peer.state == "bad-key") return;
  if (Clock::now() < peer.retryAt) return;  // backing off after a failure

  // The lower peer id makes the offer; the other side waits for it. This way
  // two peers never send each other offers at the same time.
  if (options_.peerId < remoteId) createLink(remoteId, true);
}

std::shared_ptr<Swarm::Link> Swarm::createLink(const std::string& remoteId, bool initiator) {
  dropLink(remoteId);

  auto link = std::make_shared<Link>();
  link->id = ++nextLinkId_;
  link->remoteId = remoteId;
  link->initiator = initiator;

  rtc::Configuration config;
  for (const auto& server : options_.iceServers) config.iceServers.emplace_back(server);
  config.maxMessageSize = kMaxMessageSize;
  link->pc = std::make_shared<rtc::PeerConnection>(config);
  links_[remoteId] = link;

  Peer& peer = peerState(remoteId);
  peer.state = "connecting";
  peer.have.reset();
  peer.pendingBitfield.reset();
  peer.earlyHaves.clear();
  peer.hasMeta = false;
  peer.uploadQueue.clear();

  // libdatachannel calls these from its own threads: hop onto the event loop
  // and ignore anything from a link that has since been replaced.
  EventLoop* loop = &loop_;
  const uint64_t linkId = link->id;
  link->pc->onLocalDescription([this, loop, remoteId, linkId](rtc::Description description) {
    loop->post([this, remoteId, linkId, type = description.typeString(), sdp = std::string(description)] {
      if (!currentLink(remoteId, linkId)) return;
      sendSignal(remoteId, {{"kind", "description"}, {"description", {{"type", type}, {"sdp", sdp}}}});
    });
  });
  link->pc->onLocalCandidate([this, loop, remoteId, linkId](rtc::Candidate candidate) {
    loop->post([this, remoteId, linkId, text = candidate.candidate(), mid = candidate.mid()] {
      if (!currentLink(remoteId, linkId)) return;
      sendSignal(remoteId, {{"kind", "ice"}, {"candidate", {{"candidate", text}, {"sdpMid", mid}}}});
    });
  });
  link->pc->onStateChange([this, loop, remoteId, linkId](rtc::PeerConnection::State state) {
    loop->post([this, remoteId, linkId, state] { onPeerConnectionState(remoteId, linkId, state); });
  });

  if (initiator) {
    // Creating the channel triggers negotiation: onLocalDescription fires with the offer.
    auto channel = link->pc->createDataChannel("swarm");
    link->channel = channel;
    watchChannel(remoteId, linkId, channel);
  } else {
    link->pc->onDataChannel([this, loop, remoteId, linkId](std::shared_ptr<rtc::DataChannel> channel) {
      watchChannel(remoteId, linkId, channel);
      loop->post([this, remoteId, linkId, channel] {
        if (!adoptChannel(remoteId, linkId, channel)) channel->close();
      });
    });
  }
  return link;
}

void Swarm::watchChannel(const std::string& remoteId, uint64_t linkId,
                         const std::shared_ptr<rtc::DataChannel>& channel) {
  EventLoop* loop = &loop_;
  std::weak_ptr<rtc::DataChannel> weak = channel;
  channel->setBufferedAmountLowThreshold(kLowWaterMark);

  channel->onOpen([this, loop, remoteId, linkId, weak] {
    if (auto strong = weak.lock()) loop->post([this, remoteId, linkId, strong] { adoptChannel(remoteId, linkId, strong); });
  });
  channel->onClosed([this, loop, remoteId, linkId] {
    loop->post([this, remoteId, linkId] {
      if (auto link = currentLink(remoteId, linkId)) failLink(link, "channel closed");
    });
  });
  channel->onMessage([this, loop, remoteId, linkId, weak](rtc::message_variant message) {
    const auto* binary = std::get_if<rtc::binary>(&message);
    if (!binary) return;
    auto data = std::make_shared<Bytes>(reinterpret_cast<const uint8_t*>(binary->data()),
                                        reinterpret_cast<const uint8_t*>(binary->data()) + binary->size());
    auto strong = weak.lock();
    loop->post([this, remoteId, linkId, strong, data] {
      if (auto link = adoptChannel(remoteId, linkId, strong)) onFrame(link, *data);
    });
  });
  channel->onBufferedAmountLow([this, loop, remoteId] { loop->post([this, remoteId] { pumpUploads(remoteId); }); });
}

std::shared_ptr<Swarm::Link> Swarm::currentLink(const std::string& remoteId, uint64_t linkId) {
  if (stopped_) return nullptr;
  const auto it = links_.find(remoteId);
  if (it == links_.end() || it->second->id != linkId || it->second->closed) return nullptr;
  return it->second;
}

/** Attach an incoming channel to its link (whichever callback arrives first) and open it. */
std::shared_ptr<Swarm::Link> Swarm::adoptChannel(const std::string& remoteId, uint64_t linkId,
                                                 const std::shared_ptr<rtc::DataChannel>& channel) {
  auto link = currentLink(remoteId, linkId);
  if (!link || !channel) return nullptr;
  if (!link->channel) link->channel = channel;
  if (!link->open && channel->isOpen()) onLinkOpen(link);
  return link;
}

void Swarm::onLinkOpen(const std::shared_ptr<Link>& link) {
  link->open = true;
  Peer& peer = peerState(link->remoteId);
  peer.state = "connected";
  peer.retries = 0;
  peer.retryAt = {};
  sendControl(link, {{"t", "hello"},
                     {"peerId", options_.peerId},
                     {"nonce", nonce_},
                     {"isHost", options_.role == Role::Host},
                     {"fileId", ready_ ? json(meta_->fileId) : json(nullptr)},
                     {"have", ready_ ? json(have_->toBase64()) : json(nullptr)}});
  event("Connected to peer " + link->remoteId.substr(0, 6));
}

void Swarm::onPeerConnectionState(const std::string& remoteId, uint64_t linkId, rtc::PeerConnection::State state) {
  auto link = currentLink(remoteId, linkId);
  if (!link) return;
  using State = rtc::PeerConnection::State;
  if (state == State::Failed || state == State::Closed) {
    failLink(link, "connection failed");
  } else if (state == State::Disconnected) {
    link->disconnectedAt = Clock::now();  // tick() gives it a moment to recover
  } else if (state == State::Connected) {
    link->disconnectedAt.reset();
  }
}

void Swarm::closeLink(Link& link) {
  if (link.closed) return;
  link.closed = true;
  if (link.channel) {
    link.channel->resetCallbacks();
    link.channel->close();
  }
  link.pc->resetCallbacks();
  link.pc->close();
}

/** The link broke: forget its requests and retry with exponential backoff. */
void Swarm::failLink(const std::shared_ptr<Link>& link, const std::string& /*reason*/) {
  if (link->closed) return;
  const bool wasOpen = link->open;
  closeLink(*link);
  const auto it = links_.find(link->remoteId);
  if (it != links_.end() && it->second == link) links_.erase(it);

  Peer& peer = peerState(link->remoteId);
  if (peer.state != "banned" && peer.state != "bad-key") {
    peer.state = "disconnected";
    const auto delay = std::min<std::chrono::milliseconds>(kRetryBase * (1 << std::min(peer.retries, 4)), kRetryMax);
    peer.retryAt = Clock::now() + delay;
    ++peer.retries;
  }
  releaseRequests(link->remoteId);
  if (wasOpen) event("Lost connection to peer " + link->remoteId.substr(0, 6));
  schedule();
}

/** Quietly close a link (replacing it, or the peer misbehaved). */
void Swarm::dropLink(const std::string& remoteId) {
  const auto it = links_.find(remoteId);
  if (it != links_.end()) {
    auto link = it->second;
    links_.erase(it);
    closeLink(*link);
  }
  releaseRequests(remoteId);
}

bool Swarm::sendControl(const std::shared_ptr<Link>& link, const json& message) {
  return sendBinary(link, encodeControl(options_.key, message));
}

bool Swarm::sendBinary(const std::shared_ptr<Link>& link, const Bytes& frame) {
  if (!link->channel || link->closed || !link->channel->isOpen()) return false;
  try {
    link->channel->send(reinterpret_cast<const rtc::byte*>(frame.data()), frame.size());
    return true;
  } catch (const std::exception&) {
    return false;
  }
}

// ----------------------------------------------------------------- protocol

void Swarm::onFrame(const std::shared_ptr<Link>& link, const Bytes& data) {
  link->lastActivity = Clock::now();
  Peer& peer = peerState(link->remoteId);
  auto frame = decodeFrame(options_.key, data.data(), data.size());
  if (!frame) {
    // Wrong key (or tampered data). If we have nothing yet, our link's key is the problem.
    peer.state = "bad-key";
    dropLink(link->remoteId);
    if (!ready_) fail("Could not decrypt data from the sender. The link is missing or has a wrong #key.");
    else event("Ignoring peer " + link->remoteId.substr(0, 6) + ": it uses a different key");
    return;
  }
  if (frame->type == Frame::Type::Chunk) {
    onChunk(link, peer, frame->index, frame->data);
  } else {
    try {
      onControl(link, peer, frame->message);
    } catch (const json::exception&) {
      // Malformed message from a peer: ignore it.
    }
  }
}

void Swarm::onControl(const std::shared_ptr<Link>& link, Peer& peer, const json& message) {
  const std::string type = stringOrEmpty(message, "t");

  if (type == "hello") {
    link->remoteNonce = stringOrEmpty(message, "nonce");
    peer.isHost = message.value("isHost", false);
    if (peer.isHost) hostPeerId_ = peer.id;
    const std::string fileId = stringOrEmpty(message, "fileId");
    peer.hasMeta = !fileId.empty();
    acceptBitfield(peer, fileId, stringOrEmpty(message, "have"));
    if (ready_ && !peer.hasMeta) sendMetadata(link, peer);
    schedule();
  } else if (type == "meta") {
    onMeta(message);
  } else if (type == "manifest") {
    onManifestPart(message);
  } else if (type == "bitfield") {
    peer.hasMeta = true;
    acceptBitfield(peer, stringOrEmpty(message, "fileId"), stringOrEmpty(message, "have"));
    schedule();
  } else if (type == "have") {
    for (const auto& index : message.value("indices", json::array())) {
      if (!index.is_number_unsigned()) continue;
      if (peer.have) peer.have->set(index.get<uint32_t>());
      else peer.earlyHaves.push_back(index.get<uint32_t>());
    }
    schedule();
  } else if (type == "request") {
    enqueueUploads(peer, message.value("indices", json::array()));
  }
}

void Swarm::acceptBitfield(Peer& peer, const std::string& fileId, const std::string& have) {
  if (!ready_) {
    if (!fileId.empty() && !have.empty()) peer.pendingBitfield = std::make_pair(fileId, have);
    return;
  }
  if (!fileId.empty() && !have.empty() && fileId == meta_->fileId) {
    try {
      peer.have = Bitfield::fromBase64(meta_->totalChunks, have);
      return;
    } catch (const std::exception&) {
      // malformed: treat as empty
    }
  }
  peer.have = Bitfield(meta_->totalChunks);
}

void Swarm::sendMetadata(const std::shared_ptr<Link>& link, Peer& peer) {
  peer.hasMeta = true;
  json meta = metaToJson(*meta_);
  meta["t"] = "meta";
  sendControl(link, meta);
  for (size_t start = 0; start < hashes_.size(); start += kManifestBatch) {
    const auto end = hashes_.begin() + static_cast<long>(std::min(hashes_.size(), start + kManifestBatch));
    sendControl(link, {{"t", "manifest"},
                       {"start", start},
                       {"hashes", std::vector<std::string>(hashes_.begin() + static_cast<long>(start), end)}});
  }
}

void Swarm::onMeta(const json& message) {
  if (meta_) return;  // another peer already told us
  auto meta = metaFromJson(message);
  if (!meta) return;
  meta_ = meta;
  hashes_.assign(meta_->totalChunks, std::string());
  hashesReceived_ = 0;
  event("Receiving file list for " + meta_->name);
}

void Swarm::onManifestPart(const json& message) {
  if (!meta_ || ready_ || preparing_) return;
  const uint64_t start = message.value("start", uint64_t{0});
  const json hashes = message.value("hashes", json::array());
  for (size_t offset = 0; offset < hashes.size(); ++offset) {
    const uint64_t index = start + offset;
    if (index >= meta_->totalChunks || !hashes[offset].is_string()) continue;
    const std::string hash = hashes[offset].get<std::string>();
    if (hashes_[index].empty() && isHashHex(hash)) {
      hashes_[index] = hash;
      ++hashesReceived_;
    }
  }
  if (hashesReceived_ < meta_->totalChunks) return;

  preparing_ = true;
  if (computeFileId(hashes_) != meta_->fileId) {
    fail("The file manifest failed verification.");
    return;
  }
  prepareStorage();
}

void Swarm::prepareStorage() {
  // Earlier run of this download (same room, same file)? Resume from it.
  const auto saved = loadResumeState(options_.outputDir, options_.roomId);
  const bool sameFile = saved && saved->fileId == meta_->fileId;

  if (sameFile && saved->complete && std::filesystem::exists(saved->savedTo)) {
    savedTo_ = std::filesystem::path(saved->savedTo);
    source_ = std::make_unique<FileReader>(*savedTo_, *meta_);
    have_ = Bitfield::full(meta_->totalChunks);
    resumedChunks_ = meta_->totalChunks;
    completed_ = true;
    event("Already downloaded earlier: " + savedTo_->string() + " (seeding it to other peers)");
    onReady();
    return;
  }

  const auto partPath = PartFile::partPathFor(options_.outputDir, *meta_);
  const bool resuming = sameFile && !saved->have.empty() && std::filesystem::exists(partPath) &&
                        std::filesystem::file_size(partPath) == meta_->size;

  if (!resuming && freeSpace(options_.outputDir) < meta_->size) {
    fail("Not enough free disk space in " + options_.outputDir.string() + " for this file.");
    return;
  }
  try {
    auto part = std::make_unique<PartFile>(options_.outputDir, *meta_);
    part_ = part.get();
    source_ = std::move(part);
  } catch (const std::exception& e) {
    fail(std::string("Cannot create the output file: ") + e.what());
    return;
  }
  have_ = Bitfield(meta_->totalChunks);
  if (resuming) {
    try {
      have_ = Bitfield::fromBase64(meta_->totalChunks, saved->have);
      resumedChunks_ = have_->count();
      event("Resuming: " + std::to_string(resumedChunks_) + " of " + std::to_string(meta_->totalChunks) +
            " verified chunks restored from the previous run");
    } catch (const std::exception&) {
      have_ = Bitfield(meta_->totalChunks);  // corrupt state file: start over
    }
  }
  onReady();
}

/** Manifest verified and storage open: start downloading. */
void Swarm::onReady() {
  ready_ = true;
  preparing_ = false;

  for (auto& [id, peer] : peers_) {
    const auto pending = peer.pendingBitfield;
    peer.pendingBitfield.reset();
    acceptBitfield(peer, pending ? pending->first : "", pending ? pending->second : "");
    for (uint32_t index : peer.earlyHaves) peer.have->set(index);
    peer.earlyHaves.clear();
  }

  // Tell everyone what we have, and pass the manifest on to anyone missing it.
  for (const auto& [id, link] : links_) {
    if (!link->open) continue;
    Peer& peer = peerState(id);
    sendControl(link, {{"t", "bitfield"}, {"fileId", meta_->fileId}, {"have", have_->toBase64()}});
    if (!peer.hasMeta) sendMetadata(link, peer);
  }

  if (completed_) return;  // already downloaded earlier: just seed
  if (have_->complete()) {
    finish();
    return;
  }
  schedule();
}

// ----------------------------------------------------------------- download

/** Ask connected peers for chunks we still need, spreading requests out. */
void Swarm::schedule() {
  if (!ready_ || completed_ || stopped_) return;
  const uint32_t total = meta_->totalChunks;
  while (cursor_ < total && have_->has(cursor_)) ++cursor_;

  for (auto& [id, peer] : peers_) {
    const auto linkIt = links_.find(id);
    if (linkIt == links_.end() || !linkIt->second->open || !peer.have || peer.have->count() == 0) continue;
    if (peer.inflight.size() >= kRequestWindow) continue;
    const size_t room = kRequestWindow - peer.inflight.size();

    std::vector<uint32_t> picked;
    for (uint32_t i = cursor_; i < total && picked.size() < room; ++i) {
      if (!have_->has(i) && !inflight_.count(i) && peer.have->has(i)) picked.push_back(i);
    }
    if (picked.empty()) continue;

    const auto now = Clock::now();
    for (uint32_t index : picked) {
      inflight_[index] = {id, now};
      peer.inflight.insert(index);
    }
    sendControl(linkIt->second, {{"t", "request"}, {"indices", picked}});
  }
}

/** Forget requests sent to a peer so another peer can serve them. */
void Swarm::releaseRequests(const std::string& peerId) {
  const auto it = peers_.find(peerId);
  if (it == peers_.end()) return;
  for (uint32_t index : it->second.inflight) {
    const auto request = inflight_.find(index);
    if (request != inflight_.end() && request->second.first == peerId) inflight_.erase(request);
  }
  it->second.inflight.clear();
  it->second.uploadQueue.clear();
}

void Swarm::onChunk(const std::shared_ptr<Link>& link, Peer& peer, uint32_t index, const Bytes& data) {
  peer.inflight.erase(index);
  const auto request = inflight_.find(index);
  if (request != inflight_.end() && request->second.first == peer.id) inflight_.erase(request);
  if (!ready_ || completed_ || index >= meta_->totalChunks || have_->has(index)) return;

  // Integrity: the chunk must match the sender's manifest, whoever relayed it.
  if (sha256Hex(data.data(), data.size()) != hashes_[index]) {
    if (++peer.corrupt >= kMaxCorruptChunks) {
      peer.state = "banned";
      dropLink(link->remoteId);
      event("Blocked peer " + peer.id.substr(0, 6) + " for sending corrupt data");
    }
    return;  // no longer in flight, so it will be requested again
  }

  try {
    part_->write(index, data);
  } catch (const std::exception& e) {
    fail(std::string("Writing to disk failed: ") + e.what());
    return;
  }
  have_->set(index);
  resumeDirty_ = true;
  peer.downloaded += data.size();
  downloadMeter_.add(data.size());
  pendingHaves_.push_back(index);

  if (have_->complete()) finish();
  else if (peer.inflight.size() <= kRequestWindow / 2) schedule();
}

void Swarm::finish() {
  completed_ = true;
  flushHaves();
  try {
    savedTo_ = part_->finalize();
    // Keep seeding from the finished file.
    source_ = std::make_unique<FileReader>(*savedTo_, *meta_);
    part_ = nullptr;
  } catch (const std::exception& e) {
    fail(std::string("Could not save the file: ") + e.what());
    return;
  }
  resumeDirty_ = true;
  persist();
  if (onComplete) onComplete(*savedTo_);
}

/**
 * Save the verified bitfield. The .part file is flushed first, so every chunk
 * the saved bitfield lists is already written.
 */
void Swarm::persist() {
  if (options_.role != Role::Guest || !ready_ || !have_ || !resumeDirty_) return;
  if (part_) part_->flush();
  ResumeState state;
  state.peerId = options_.peerId;
  state.fileId = meta_->fileId;
  state.have = have_->toBase64();
  state.complete = completed_ && savedTo_.has_value();
  state.savedTo = savedTo_ ? savedTo_->string() : "";
  if (saveResumeState(options_.outputDir, options_.roomId, state)) resumeDirty_ = false;
  lastPersist_ = Clock::now();
}

// ------------------------------------------------------------------- upload

void Swarm::enqueueUploads(Peer& peer, const json& indices) {
  if (!ready_) return;
  for (const auto& index : indices) {
    if (index.is_number_unsigned() && have_->has(index.get<uint32_t>())) peer.uploadQueue.push_back(index.get<uint32_t>());
  }
  pumpUploads(peer.id);
}

/** Send requested chunks while the channel's send buffer has room (backpressure). */
void Swarm::pumpUploads(const std::string& remoteId) {
  if (stopped_) return;
  const auto linkIt = links_.find(remoteId);
  if (linkIt == links_.end()) return;
  const auto link = linkIt->second;
  if (!link->open || link->closed || !link->channel) return;
  Peer& peer = peerState(remoteId);

  while (!peer.uploadQueue.empty() && link->channel->bufferedAmount() < kHighWaterMark) {
    const uint32_t index = peer.uploadQueue.front();
    peer.uploadQueue.pop_front();
    Bytes data;
    try {
      data = source_->read(index);
    } catch (const std::exception&) {
      continue;
    }
    if (!sendBinary(link, encodeChunk(options_.key, index, data.data(), data.size()))) break;
    peer.uploaded += data.size();
    uploadMeter_.add(data.size());
  }
}

/** Announce newly verified chunks to every peer, batched. */
void Swarm::flushHaves() {
  if (pendingHaves_.empty()) return;
  const json message = {{"t", "have"}, {"indices", pendingHaves_}};
  pendingHaves_.clear();
  for (const auto& [id, link] : links_) {
    if (link->open) sendControl(link, message);
  }
}

// ------------------------------------------------------------- housekeeping

void Swarm::scheduleTick() {
  loop_.postDelayed(std::chrono::duration_cast<std::chrono::milliseconds>(kTickInterval), [this] {
    if (stopped_) return;
    tick();
    scheduleTick();
  });
}

void Swarm::tick() {
  const auto now = Clock::now();

  // Reconnect to anyone in the room we have no working link to.
  for (const auto& id : std::vector<std::string>(members_.begin(), members_.end())) ensureLink(id);

  // Links that never opened, or stayed "disconnected" too long, have failed.
  // A crashed peer sends no goodbye over UDP, but the signaling server notices
  // its socket closing at once (peer-left): if it then also goes quiet, it's gone.
  std::vector<std::shared_ptr<Link>> stale;
  for (const auto& [id, link] : links_) {
    const bool leftAndQuiet = registered_ && link->open && !members_.count(id) &&
                              now - link->lastActivity > kLeftPeerSilence;
    if ((!link->open && now - link->createdAt > kConnectTimeout) ||
        (link->disconnectedAt && now - *link->disconnectedAt > kDisconnectGrace) || leftAndQuiet) {
      stale.push_back(link);
    }
  }
  for (const auto& link : stale) failLink(link, "timeout");

  if (ready_ && !completed_) {
    for (auto it = inflight_.begin(); it != inflight_.end();) {
      if (now - it->second.second > kRequestTimeout) {
        const auto peer = peers_.find(it->second.first);
        if (peer != peers_.end()) peer->second.inflight.erase(it->first);
        it = inflight_.erase(it);
      } else {
        ++it;
      }
    }
    schedule();
  }
  flushHaves();
  for (const auto& [id, peer] : peers_) {
    if (!peer.uploadQueue.empty()) pumpUploads(id);
  }
  if (resumeDirty_ && now - lastPersist_ > kPersistInterval) persist();
}

uint64_t Swarm::bytesVerified() const {
  if (!meta_ || !have_) return 0;
  uint64_t bytes = uint64_t{have_->count()} * meta_->chunkSize;
  const uint32_t last = meta_->totalChunks - 1;
  if (have_->has(last)) bytes -= meta_->chunkSize - chunkLength(*meta_, last);
  return bytes;
}

bool Swarm::canProgress() {
  for (const auto& [id, peer] : peers_) {
    const auto link = links_.find(id);
    if (link == links_.end() || !link->second->open || !peer.have) continue;
    for (uint32_t i = cursor_; i < meta_->totalChunks; ++i) {
      if (!have_->has(i) && peer.have->has(i)) return true;
    }
  }
  return false;
}

SwarmSnapshot Swarm::snapshot() {
  SwarmSnapshot snap;
  snap.file = meta_;
  snap.totalChunks = meta_ ? meta_->totalChunks : 0;
  snap.verifiedChunks = have_ ? have_->count() : 0;
  snap.resumedChunks = resumedChunks_;
  snap.bytesVerified = bytesVerified();
  snap.downloadRate = downloadMeter_.rate();
  snap.uploadRate = uploadMeter_.rate();
  snap.uploadedTotal = uploadMeter_.total();
  snap.savedTo = savedTo_;

  int openPeers = 0;
  for (const auto& [id, peer] : peers_) {
    const auto link = links_.find(id);
    const bool open = link != links_.end() && link->second->open;
    std::string state = peer.state;
    if (!open && state != "banned" && state != "bad-key") {
      if (!members_.count(id)) state = "left";
      else if (state != "connecting" || peer.retries > 0) state = "reconnecting";
    }
    if (state == "connected") ++openPeers;
    snap.peers.push_back({id, peer.isHost, state,
                          peer.have && snap.totalChunks ? double(peer.have->count()) / snap.totalChunks : 0.0,
                          peer.downloaded, peer.uploaded});
  }

  const bool signalingDown = signaling_ && !signaling_->connected() && Clock::now() - startedAt_ > 3s;
  const std::string signalNote = signalingDown ? " (signaling server unreachable, retrying)" : "";
  if (!fatalError_.empty()) {
    snap.status = "error";
    snap.message = fatalError_;
  } else if (options_.role == Role::Host) {
    snap.status = openPeers == 0 ? "waiting" : "seeding";
    snap.message = openPeers == 0 ? "Waiting for peers to open the link..." + signalNote
                                  : "Sharing with " + std::to_string(openPeers) + " peer(s)" + signalNote;
  } else if (completed_) {
    snap.status = "complete";
    snap.message = "All chunks verified. Seeding to other peers until you press Ctrl+C.";
  } else if (!ready_) {
    snap.status = openPeers == 0 ? "connecting" : "connected";
    snap.message = openPeers == 0 ? "Connecting to peers..." + signalNote : "Connected. Receiving file info...";
  } else if (canProgress()) {
    snap.status = "transferring";
    snap.message = "Downloading " + meta_->name + signalNote;
  } else {
    snap.status = "stalled";
    snap.message =
        "Connection lost: no connected peer has the remaining chunks. Progress is saved; the download resumes "
        "automatically from the last verified chunk when the sender (or a peer with the missing chunks) is back.";
  }
  return snap;
}

}  // namespace p2p
