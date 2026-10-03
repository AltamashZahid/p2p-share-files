// ---------------------------------------------------------------------------
// p2pshare-signal: the WebSocket signaling server.
//
// It only introduces peers: it keeps track of who is in which room and relays
// WebRTC offers, answers and ICE candidates between them. It never sees file
// data, file names or encryption keys; those travel over encrypted WebRTC data
// channels between peers. All it knows are opaque room and peer ids.
//
// Messages are JSON text frames:
//   client -> server  { type: "create-room" | "join-room", id, roomId, peerId, nonce }
//                     { type: "signal", to, data }
//   server -> client  { type: "response", id, ok, error?, hostPeerId, peers[] }
//                     { type: "peer-joined", peerId, nonce } | { type: "peer-left", peerId }
//                     { type: "signal", from, data }
// ---------------------------------------------------------------------------

#include <rtc/rtc.hpp>

#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>

#include "core/link.hpp"

using nlohmann::json;
using Clock = std::chrono::steady_clock;

namespace {

// A room is a full mesh (every peer connects to every other), so keep it small.
constexpr size_t kMaxPeersPerRoom = 8;
// Empty rooms survive this long so peers can reconnect and resume.
constexpr auto kEmptyRoomTtl = std::chrono::minutes(30);

std::atomic<bool> running{true};

std::string timestamp() {
  const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  char text[16];
  std::strftime(text, sizeof text, "%H:%M:%S", std::localtime(&now));
  return text;
}

void log(const std::string& message) { std::cout << "[" << timestamp() << "] " << message << std::endl; }

struct Room {
  std::string hostPeerId;
  std::map<std::string, std::shared_ptr<rtc::WebSocket>> peers;  // peerId -> socket
  std::optional<Clock::time_point> emptySince;
};

struct Session {
  std::string roomId;
  std::string peerId;
};

class SignalingServer {
 public:
  void addClient(const std::shared_ptr<rtc::WebSocket>& ws) {
    {
      std::lock_guard lock(mutex_);
      clients_.insert(ws);
    }
    std::weak_ptr<rtc::WebSocket> weak = ws;
    ws->onMessage([this, weak](rtc::message_variant data) {
      auto socket = weak.lock();
      if (!socket) return;
      if (const auto* text = std::get_if<std::string>(&data)) handleMessage(socket, *text);
    });
    ws->onClosed([this, weak] {
      if (auto socket = weak.lock()) handleClose(socket);
    });
    ws->onError([](const std::string& error) { log("socket error: " + error); });
  }

  /** Delete rooms that have been empty for longer than the TTL. */
  void purgeExpiredRooms() {
    std::lock_guard lock(mutex_);
    const auto now = Clock::now();
    for (auto it = rooms_.begin(); it != rooms_.end();) {
      if (it->second.peers.empty() && it->second.emptySince && now - *it->second.emptySince > kEmptyRoomTtl) {
        log("room " + it->first + " expired");
        it = rooms_.erase(it);
      } else {
        ++it;
      }
    }
  }

 private:
  static void sendJson(const std::shared_ptr<rtc::WebSocket>& ws, const json& message) {
    if (ws->isOpen()) ws->send(message.dump());
  }

  void handleMessage(const std::shared_ptr<rtc::WebSocket>& ws, const std::string& text) {
    const json message = json::parse(text, nullptr, false);
    if (message.is_discarded() || !message.is_object()) return;
    const std::string type = message.value("type", "");

    std::lock_guard lock(mutex_);
    if (type == "create-room" || type == "join-room") {
      json response = register_(ws, message, type == "create-room");
      response["type"] = "response";
      response["id"] = message.value("id", 0);
      sendJson(ws, response);
    } else if (type == "signal") {
      relaySignal(ws, message);
    }
  }

  json register_(const std::shared_ptr<rtc::WebSocket>& ws, const json& message, bool create) {
    const std::string roomId = message.value("roomId", "");
    const std::string peerId = message.value("peerId", "");
    const std::string nonce = message.value("nonce", "");
    if (!p2p::isValidId(roomId) || !p2p::isValidId(peerId) || !p2p::isValidId(nonce)) {
      return {{"ok", false}, {"error", "Invalid room or peer id."}};
    }

    auto existing = rooms_.find(roomId);
    if (create) {
      // The original sender coming back (reconnect or restart) takes its room
      // over again; anyone else is refused.
      if (existing != rooms_.end() && existing->second.hostPeerId != peerId) {
        return {{"ok", false}, {"error", "Room already exists."}};
      }
      if (existing == rooms_.end()) {
        existing = rooms_.emplace(roomId, Room{peerId, {}, std::nullopt}).first;
        log("room " + roomId + " created");
      }
    } else {
      if (existing == rooms_.end()) return {{"ok", false}, {"error", "Room not found or expired."}};
      Room& room = existing->second;
      if (!room.peers.count(peerId) && room.peers.size() >= kMaxPeersPerRoom) {
        return {{"ok", false}, {"error", "Room is full (max 8 peers)."}};
      }
    }

    Room& room = existing->second;
    json peers = json::array();
    for (const auto& [id, socket] : room.peers) {
      if (id != peerId) peers.push_back(id);
    }
    attach(ws, roomId, room, peerId, nonce);
    return {{"ok", true}, {"roomId", roomId}, {"hostPeerId", room.hostPeerId}, {"peers", peers}};
  }

  /**
   * Put this socket in the room under `peerId` and tell the other peers.
   * `nonce` identifies the process run, so peers can tell a restart (new
   * nonce) from a signaling reconnect of the same run (same nonce).
   */
  void attach(const std::shared_ptr<rtc::WebSocket>& ws, const std::string& roomId, Room& room,
              const std::string& peerId, const std::string& nonce) {
    auto previous = room.peers.find(peerId);
    if (previous != room.peers.end() && previous->second != ws) previous->second->close();

    room.peers[peerId] = ws;
    room.emptySince.reset();
    sessions_[ws.get()] = {roomId, peerId};
    for (const auto& [id, socket] : room.peers) {
      if (id != peerId) sendJson(socket, {{"type", "peer-joined"}, {"peerId", peerId}, {"nonce", nonce}});
    }
    log("peer " + peerId.substr(0, 6) + " joined room " + roomId + " (" + std::to_string(room.peers.size()) +
        " online)");
  }

  void relaySignal(const std::shared_ptr<rtc::WebSocket>& ws, const json& message) {
    const auto session = sessions_.find(ws.get());
    if (session == sessions_.end()) return;
    const auto room = rooms_.find(session->second.roomId);
    if (room == rooms_.end()) return;
    const auto target = room->second.peers.find(message.value("to", ""));
    if (target == room->second.peers.end()) return;
    sendJson(target->second,
             {{"type", "signal"}, {"from", session->second.peerId}, {"data", message.value("data", json())}});
  }

  void handleClose(const std::shared_ptr<rtc::WebSocket>& ws) {
    std::lock_guard lock(mutex_);
    clients_.erase(ws);
    const auto session = sessions_.find(ws.get());
    if (session == sessions_.end()) return;
    const Session info = session->second;
    sessions_.erase(session);

    const auto room = rooms_.find(info.roomId);
    if (room == rooms_.end()) return;
    // Only remove the peer if a reconnect hasn't already replaced this socket.
    const auto peer = room->second.peers.find(info.peerId);
    if (peer != room->second.peers.end() && peer->second == ws) {
      room->second.peers.erase(peer);
      for (const auto& [id, socket] : room->second.peers) {
        sendJson(socket, {{"type", "peer-left"}, {"peerId", info.peerId}});
      }
      log("peer " + info.peerId.substr(0, 6) + " left room " + info.roomId);
    }
    if (room->second.peers.empty() && !room->second.emptySince) room->second.emptySince = Clock::now();
  }

  std::mutex mutex_;
  std::map<std::string, Room> rooms_;
  std::map<rtc::WebSocket*, Session> sessions_;
  std::set<std::shared_ptr<rtc::WebSocket>> clients_;  // keeps sockets alive until closed
};

void printUsage() {
  std::cout << "Usage: p2pshare-signal [--port 8000] [--bind 0.0.0.0] [--cert cert.pem --key key.pem]\n"
               "  --port   port to listen on (default: $PORT or 8000)\n"
               "  --bind   address to bind (default: all interfaces)\n"
               "  --cert / --key   PEM files to serve wss:// (TLS) instead of ws://\n";
}

}  // namespace

int main(int argc, char** argv) {
  rtc::WebSocketServerConfiguration config;
  config.port = 8000;
  if (const char* port = std::getenv("PORT")) config.port = static_cast<uint16_t>(std::atoi(port));

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    const bool hasValue = i + 1 < argc;
    if (arg == "--port" && hasValue) {
      config.port = static_cast<uint16_t>(std::atoi(argv[++i]));
    } else if (arg == "--bind" && hasValue) {
      config.bindAddress = argv[++i];
    } else if (arg == "--cert" && hasValue) {
      config.certificatePemFile = argv[++i];
      config.enableTls = true;
    } else if (arg == "--key" && hasValue) {
      config.keyPemFile = argv[++i];
    } else {
      printUsage();
      return arg == "--help" || arg == "-h" ? 0 : 1;
    }
  }

  rtc::InitLogger(rtc::LogLevel::Error);
  std::signal(SIGINT, [](int) { running = false; });
  std::signal(SIGTERM, [](int) { running = false; });

  SignalingServer server;
  std::unique_ptr<rtc::WebSocketServer> ws;
  try {
    ws = std::make_unique<rtc::WebSocketServer>(config);
  } catch (const std::exception& e) {
    std::cerr << "Could not start server: " << e.what() << std::endl;
    return 1;
  }
  ws->onClient([&server](std::shared_ptr<rtc::WebSocket> client) { server.addClient(client); });
  log(std::string("Signaling server listening on ") + (config.enableTls ? "wss" : "ws") + "://" +
      config.bindAddress.value_or("0.0.0.0") + ":" + std::to_string(ws->port()));

  while (running) {
    std::this_thread::sleep_for(std::chrono::seconds(1));
    server.purgeExpiredRooms();
  }
  log("shutting down");
  ws->stop();
  return 0;
}
