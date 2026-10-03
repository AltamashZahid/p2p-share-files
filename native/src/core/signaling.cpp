#include "core/signaling.hpp"

#include <algorithm>

namespace p2p {

using nlohmann::json;

SignalingClient::SignalingClient(EventLoop& loop, std::string url, Handlers handlers)
    : loop_(loop), url_(std::move(url)), handlers_(std::move(handlers)) {}

SignalingClient::~SignalingClient() { stop(); }

void SignalingClient::start() {
  stopped_ = false;
  connect();
}

void SignalingClient::stop() {
  stopped_ = true;
  ++generation_;
  connected_ = false;
  if (socket_) {
    socket_->resetCallbacks();
    socket_->close();
    socket_.reset();
  }
  failPending();
}

void SignalingClient::connect() {
  if (stopped_) return;
  const uint64_t generation = ++generation_;
  rtc::WebSocketConfiguration config;
  config.pingInterval = std::chrono::seconds(10);
  config.connectionTimeout = std::chrono::seconds(10);
  auto socket = std::make_shared<rtc::WebSocket>(config);
  socket_ = socket;

  EventLoop* loop = &loop_;
  socket->onOpen([this, loop, generation] {
    loop->post([this, generation] {
      if (generation != generation_) return;
      connected_ = true;
      attempts_ = 0;
      if (handlers_.onConnected) handlers_.onConnected();
    });
  });
  socket->onClosed([this, loop, generation] { loop->post([this, generation] { onClosed(generation); }); });
  socket->onError([this, loop, generation](const std::string&) {
    loop->post([this, generation] { onClosed(generation); });
  });
  socket->onMessage([this, loop, generation](rtc::message_variant data) {
    const auto* text = std::get_if<std::string>(&data);
    if (!text) return;
    loop->post([this, generation, text = *text] {
      if (generation != generation_) return;
      const json message = json::parse(text, nullptr, false);
      if (message.is_discarded() || !message.is_object()) return;
      if (message.value("type", "") == "response") {
        const auto it = pending_.find(message.value("id", 0));
        if (it == pending_.end()) return;
        auto callback = std::move(it->second);
        pending_.erase(it);
        callback(message);
      } else if (handlers_.onMessage) {
        handlers_.onMessage(message);
      }
    });
  });

  try {
    socket->open(url_);
  } catch (const std::exception&) {
    onClosed(generation);
  }
}

void SignalingClient::onClosed(uint64_t generation) {
  if (generation != generation_ || stopped_) return;
  ++generation_;  // ignore any further callbacks from this socket
  const bool wasConnected = connected_;
  connected_ = false;
  if (socket_) {
    socket_->resetCallbacks();
    socket_.reset();
  }
  failPending();
  if (wasConnected && handlers_.onDisconnected) handlers_.onDisconnected();

  // Reconnect with backoff: 1 s, 2 s, 4 s ... capped at 10 s.
  const auto delay = std::chrono::milliseconds(std::min(10'000, 1'000 << std::min(attempts_, 4)));
  ++attempts_;
  loop_.postDelayed(delay, [this] {
    if (!stopped_ && !socket_) connect();
  });
}

void SignalingClient::send(const json& message) {
  if (!connected_ || !socket_) return;
  try {
    socket_->send(message.dump());
  } catch (const std::exception&) {
    // Socket is closing; onClosed will handle reconnecting.
  }
}

void SignalingClient::request(json message, ResponseCallback callback, std::chrono::milliseconds timeout) {
  if (!connected_) {
    callback(std::nullopt);
    return;
  }
  const int id = nextRequestId_++;
  message["id"] = id;
  pending_[id] = std::move(callback);
  send(message);
  loop_.postDelayed(timeout, [this, id] {
    const auto it = pending_.find(id);
    if (it == pending_.end()) return;
    auto callback = std::move(it->second);
    pending_.erase(it);
    callback(std::nullopt);
  });
}

void SignalingClient::failPending() {
  auto pending = std::move(pending_);
  pending_.clear();
  for (auto& [id, callback] : pending) callback(std::nullopt);
}

}  // namespace p2p
