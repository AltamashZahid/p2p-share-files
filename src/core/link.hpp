#pragma once
// ---------------------------------------------------------------------------
// Share links:   p2pshare://<signaling host>:<port>/<roomId>#key=<base64url AES key>
//                p2pshares://...   (same, but the signaling server uses TLS / wss)
//
// The room id tells peers which room to join on the signaling server. The key
// sits in the fragment and is only ever used locally: peers send the room id
// to the server, never the key, so the server can't decrypt anything.
// ---------------------------------------------------------------------------

#include <optional>
#include <string>
#include <string_view>

namespace p2p {

struct ShareLink {
  std::string serverUrl;  // ws://host:port or wss://host:port
  std::string roomId;
  std::string keyString;
};

std::optional<ShareLink> parseShareLink(std::string_view text);
std::string buildShareLink(const ShareLink& link);

/** Room and peer ids: 4-64 characters of [A-Za-z0-9_-]. */
bool isValidId(std::string_view id);

}  // namespace p2p
