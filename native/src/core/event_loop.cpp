#include "core/event_loop.hpp"

#include <exception>
#include <iostream>

namespace p2p {

void EventLoop::post(Task task) {
  {
    std::lock_guard lock(mutex_);
    if (stopped_) return;
    tasks_.push_back(std::move(task));
  }
  wake_.notify_one();
}

void EventLoop::postDelayed(std::chrono::milliseconds delay, Task task) {
  {
    std::lock_guard lock(mutex_);
    if (stopped_) return;
    timers_.emplace(Clock::now() + delay, std::move(task));
  }
  wake_.notify_one();
}

void EventLoop::stop() {
  {
    std::lock_guard lock(mutex_);
    stopped_ = true;
  }
  wake_.notify_one();
}

void EventLoop::run() {
  std::unique_lock lock(mutex_);
  while (!stopped_) {
    Task task;
    if (!tasks_.empty()) {
      task = std::move(tasks_.front());
      tasks_.pop_front();
    } else if (!timers_.empty() && timers_.begin()->first <= Clock::now()) {
      task = std::move(timers_.begin()->second);
      timers_.erase(timers_.begin());
    } else if (timers_.empty()) {
      wake_.wait(lock);
      continue;
    } else {
      wake_.wait_until(lock, timers_.begin()->first);
      continue;
    }

    lock.unlock();
    try {
      task();
    } catch (const std::exception& e) {
      std::cerr << "\n[error] " << e.what() << std::endl;
    }
    lock.lock();
  }
}

}  // namespace p2p
