#pragma once
// WebSocket client for p2pshare-signal. Reconnects automatically with backoff.
// Every method must be called on the event loop thread; socket callbacks are
// posted back onto the loop.

#include <rtc/rtc.hpp>

#include <nlohmann/json.hpp>

#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>

#include "core/event_loop.hpp"

namespace p2p {

class SignalingClient {
 public:
  struct Handlers {
    std::function<void()> onConnected;
    std::function<void()> onDisconnected;
    std::function<void(const nlohmann::json&)> onMessage;  // peer-joined, peer-left, signal
  };
  using ResponseCallback = std::function<void(std::optional<nlohmann::json>)>;

  SignalingClient(EventLoop& loop, std::string url, Handlers handlers);
  ~SignalingClient();

  void start();
  void stop();
  bool connected() const { return connected_; }

  /** Fire-and-forget message; dropped while disconnected. */
  void send(const nlohmann::json& message);
  /** Message with a response; the callback gets nullopt on timeout or disconnect. */
  void request(nlohmann::json message, ResponseCallback callback,
               std::chrono::milliseconds timeout = std::chrono::seconds(10));

 private:
  void connect();
  void onClosed(uint64_t generation);
  void failPending();

  EventLoop& loop_;
  std::string url_;
  Handlers handlers_;
  std::shared_ptr<rtc::WebSocket> socket_;
  uint64_t generation_ = 0;  // ignores callbacks from replaced sockets
  bool connected_ = false;
  bool stopped_ = false;
  int attempts_ = 0;
  int nextRequestId_ = 1;
  std::map<int, ResponseCallback> pending_;
};

}  // namespace p2p
