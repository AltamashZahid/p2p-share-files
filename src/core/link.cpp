#include "core/link.hpp"

namespace p2p {

bool isValidId(std::string_view id) {
  if (id.size() < 4 || id.size() > 64) return false;
  for (char c : id) {
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                    c == '-' || c == '_';
    if (!ok) return false;
  }
  return true;
}

std::optional<ShareLink> parseShareLink(std::string_view text) {
  ShareLink link;
  std::string_view rest;
  if (text.rfind("p2pshare://", 0) == 0) {
    rest = text.substr(11);
    link.serverUrl = "ws://";
  } else if (text.rfind("p2pshares://", 0) == 0) {
    rest = text.substr(12);
    link.serverUrl = "wss://";
  } else {
    return std::nullopt;
  }

  const size_t hash = rest.find('#');
  if (hash == std::string_view::npos) return std::nullopt;
  std::string_view fragment = rest.substr(hash + 1);
  rest = rest.substr(0, hash);

  const size_t slash = rest.find('/');
  if (slash == std::string_view::npos || slash == 0) return std::nullopt;
  link.serverUrl += std::string(rest.substr(0, slash));
  link.roomId = std::string(rest.substr(slash + 1));
  if (!isValidId(link.roomId)) return std::nullopt;

  if (fragment.rfind("key=", 0) != 0) return std::nullopt;
  link.keyString = std::string(fragment.substr(4));
  if (link.keyString.empty()) return std::nullopt;
  return link;
}

std::string buildShareLink(const ShareLink& link) {
  std::string_view server = link.serverUrl;
  std::string scheme = "p2pshare://";
  if (server.rfind("wss://", 0) == 0) {
    scheme = "p2pshares://";
    server.remove_prefix(6);
  } else if (server.rfind("ws://", 0) == 0) {
    server.remove_prefix(5);
  }
  while (!server.empty() && server.back() == '/') server.remove_suffix(1);
  return scheme + std::string(server) + "/" + link.roomId + "#key=" + link.keyString;
}

}  // namespace p2p
