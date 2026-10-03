# p2pshare

**Decentralized, end-to-end encrypted peer-to-peer file sharing in C++17.** Files move directly between peers over WebRTC data channels; a small signaling server only introduces them and never sees keys or file data.

```text
$ p2pshare send video.mkv
Share this link:

  p2pshare://192.168.1.20:8000/5d0a8f18#key=B4tjWvIA2qzMQNz4fFCri3_F9xS0NkRDnHgmzNnYrwo

$ p2pshare get "p2pshare://192.168.1.20:8000/5d0a8f18#key=B4tj..."
[transferring] 42.1% 252.6 MB/600.0 MB | down 25.0 MB/s | 2021/4801 chunks | from sender 180.2 MB, 9bc1aa 72.4 MB
```

## Features

| Feature | How it's done |
| --- | --- |
| **WebRTC data channels** | [libdatachannel](https://github.com/paullouisageneau/libdatachannel): ICE (libjuice), DTLS (OpenSSL) and SCTP data channels. File data only ever flows peer-to-peer. |
| **Signaling server** | `p2pshare-signal`, a C++ WebSocket server that introduces peers and relays SDP/ICE. It only sees opaque room and peer ids. |
| **SHA-256 chunk verification** | The sender hashes every 128 KB chunk into a manifest. Each chunk is checked before it's written, whichever peer sent it; peers that send 3 corrupt chunks are blocked. |
| **Zero-knowledge AES-256-GCM** | OpenSSL AES-256-GCM on every frame. The key lives only in the link's `#key=` fragment, and the CLI sends just the room id to the server. Chunk indices are bound as authenticated data. |
| **Multi-peer mesh swarming** | Full mesh of up to 8 peers. Pull-based like BitTorrent: bitfields, `have` announcements, 16 pipelined requests per peer. A newcomer downloads from the sender and every other peer at once, and finished peers keep seeding. |
| **Large files (>500 MB) without RAM limits** | Verified chunks are written at their offset in a pre-sized `.part` file, so memory stays flat. A 600 MB transfer peaked at **27 MB** RSS. |
| **Churn recovery and auto-resume** | The verified-chunk bitfield is saved next to the download after flushing the `.part` file. Restarts resume from the last verified chunk, broken links retry with backoff, crashed peers are detected within seconds, peers survive signaling-server outages, and a restarted sender reclaims its room with `--resume`. |

## Architecture

```text
  p2pshare send ─┐                         ┌─ p2pshare get (peer B)
                 │   WebSocket (JSON)      │
                 ├──► p2pshare-signal ◄────┤      only room/peer ids,
                 │   rooms, SDP/ICE relay  │      never keys or data
                 │                         │
                 └════ WebRTC data channels (DTLS/SCTP) ════┘
                        AES-256-GCM frames, full mesh
                                   ║
                             p2pshare get (peer C)
```

**Threading model.** libdatachannel invokes callbacks on its own network threads. Every callback only posts a task to a single-threaded **event loop** (`core/event_loop.*`), so the whole swarm state is touched by one thread: no locks and no data races. Callbacks from replaced connections are ignored by link id.

**Wire protocol.** Every frame is encrypted:

| Frame | Layout |
| --- | --- |
| control | `[0x01][IV 12][AES-GCM(JSON) + tag 16]`, AAD = `"control"` |
| chunk | `[0x02][index u32 BE][IV 12][AES-GCM(chunk) + tag 16]`, AAD = index |

Control messages are `hello` (peer id, run nonce, file id, bitfield), `meta`, `manifest` (chunk hashes), `bitfield`, `have` and `request`.

**Reconnects.** The peer with the lower id always makes the offer, so offers never collide. A per-run nonce tells a restarted peer apart from one that merely reconnected to the signaling server, so healthy links aren't torn down.

## Building

Requires a C++17 compiler, CMake ≥ 3.20, Ninja, OpenSSL and nlohmann-json. libdatachannel v0.24.6 is fetched and built automatically.

**Windows (MSYS2 UCRT64):**

```bash
pacman -S mingw-w64-ucrt-x86_64-{gcc,cmake,ninja,openssl,nlohmann-json}
bash build.sh          # from an MSYS2 UCRT64 shell, in the repo root
```

The executables are statically linked, so they run from any Windows terminal with no DLLs.

**Linux:**

```bash
sudo apt install g++ cmake ninja-build libssl-dev nlohmann-json3-dev git
bash build.sh
```

Output: `build/p2pshare`, `build/p2pshare-signal`, `build/p2pshare-tests`.

## Usage

```bash
# 1. Start the signaling server (any machine all peers can reach)
p2pshare-signal --port 8000                      # add --cert/--key for wss://

# 2. Share a file; prints the invite link
p2pshare send ./video.mkv --server ws://192.168.1.20:8000

# 3. On any number of other machines
p2pshare get "p2pshare://192.168.1.20:8000/<room>#key=<key>" --out ~/Downloads
```

| Option | Meaning |
| --- | --- |
| `send --server <ws-url>` | Signaling server (default `ws://127.0.0.1:8000`) |
| `send --resume <link>` | Sender restarted: same file, same room and key, so peers continue |
| `get --out <dir>` | Download directory (default: current directory) |
| `get --exit-when-done` | Quit after the download instead of seeding |
| `--ice <url>` | Extra STUN/TURN server, e.g. `turn:user:pass@host:3478` |

To resume an interrupted download, run the same `get` command again with the same `--out`.

## Tests

```bash
build/p2pshare-tests       # unit tests: FIPS 180-2 SHA-256 and NIST AES-256-GCM vectors,
                           # frames, bitfield, links, manifest, file-name sanitizing
bash tests/e2e.sh          # end-to-end with real processes and real WebRTC
```

`e2e.sh` results (200 MB file, Windows 11, localhost):

```text
PASS  unit tests (45 checks, 0 failed)
PASS  wrong key is rejected
PASS  mesh: two peers byte-identical; third peer received from 2e9281 71.1 MB, sender 128.9 MB
PASS  receiver crash at 645 chunks -> 'Resuming: 616 of 1601'
PASS  sender crash at 658 chunks: receiver paused, then resumed (never below 658)
PASS  signaling server killed at 23%: reached 47% without it, then finished
```

Crashes are simulated with hard kills. Progress is saved every second, so a crash re-downloads at most about one second's worth of chunks.

## Source Layout

```text
p2pshare/
├── CMakeLists.txt, build.sh
├── src/core/
│   ├── crypto.*        AES-256-GCM, SHA-256, random ids (OpenSSL)
│   ├── protocol.*      encrypted frame format
│   ├── manifest.*      chunk hashing, file metadata, name sanitizing
│   ├── bitfield.*      verified-chunk sets
│   ├── link.*          p2pshare:// share links
│   ├── event_loop.*    single-threaded task loop
│   ├── signaling.*     WebSocket client with reconnect/backoff
│   ├── storage.*       source reader + positional-write .part file
│   ├── resume.*        persisted resume state
│   └── swarm.*         mesh, scheduling, verification, seeding, churn recovery
├── src/server/main.cpp p2pshare-signal
├── src/cli/main.cpp    p2pshare send / get
└── tests/              unit tests + end-to-end script
```

## Limitations

- The signaling server is needed to discover peers; established transfers continue without it.
- Up to 8 peers per room (full mesh).
- Peers behind strict NATs need a TURN server (`--ice turn:...`).
