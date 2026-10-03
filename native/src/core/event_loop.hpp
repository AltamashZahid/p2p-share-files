#pragma once
// ---------------------------------------------------------------------------
// Single-threaded event loop.
//
// libdatachannel calls our callbacks from its own network threads. Instead of
// locking the swarm state, every callback posts a task here, and the loop runs
// tasks one at a time on the main thread. All swarm state is therefore touched
// by exactly one thread: no data races and no locks in the engine.
// ---------------------------------------------------------------------------

#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <map>
#include <mutex>

namespace p2p {

class EventLoop {
 public:
  using Task = std::function<void()>;
  using Clock = std::chrono::steady_clock;

  /** Queue a task (thread-safe). Ignored once the loop has stopped. */
  void post(Task task);
  /** Run a task after a delay (thread-safe). */
  void postDelayed(std::chrono::milliseconds delay, Task task);

  /** Run tasks until stop() is called. */
  void run();
  void stop();

 private:
  std::mutex mutex_;
  std::condition_variable wake_;
  std::deque<Task> tasks_;
  std::multimap<Clock::time_point, Task> timers_;
  bool stopped_ = false;
};

}  // namespace p2p
