#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# End-to-end tests for the native build: real processes, real WebRTC.
#
#   bash tests/e2e.sh [work dir] [file size in MB]
#
# Runs on Linux/macOS and in Git Bash on Windows. Needs ~4x the file size of
# free disk space in the work dir (default: a temp dir).
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.."
BUILD="$PWD/build"
WORK="${1:-$(mktemp -d)}"
SIZE_MB="${2:-200}"
PORT=8765
SERVER="ws://127.0.0.1:$PORT"
EXE=""; [ -f "$BUILD/p2pshare.exe" ] && EXE=".exe"
P2P="$BUILD/p2pshare$EXE"
SIGNAL="$BUILD/p2pshare-signal$EXE"
mkdir -p "$WORK" && cd "$WORK" || exit 1

PASSED=0; FAILED=0
pass() { echo "PASS  $1"; PASSED=$((PASSED + 1)); }
fail() { echo "FAIL  $1"; FAILED=$((FAILED + 1)); }

# Process helpers that work with Git Bash (Windows PIDs) and POSIX shells.
pid_of() { if [ -r "/proc/$1/winpid" ]; then cat "/proc/$1/winpid"; else echo "$1"; fi; }
kill_hard() { if command -v taskkill >/dev/null; then taskkill //PID "$1" //F >/dev/null 2>&1; else kill -9 "$1" 2>/dev/null; fi; }
alive() { if command -v tasklist >/dev/null; then tasklist //FI "PID eq $1" 2>/dev/null | grep -q p2pshare; else kill -0 "$1" 2>/dev/null; fi; }
wait_gone() { for _ in $(seq 1 600); do alive "$1" || return 0; sleep 0.5; done; return 1; }
stop_all() { for p in ${PIDS:-}; do kill_hard "$p"; done; PIDS=""; }
trap stop_all EXIT

start_server() { "$SIGNAL" --port $PORT > "server-$1.log" 2>&1 & SERVER_PID=$(pid_of $!); PIDS="${PIDS:-} $SERVER_PID"; sleep 1; }
start_sender() { "$P2P" send test.bin --server "$SERVER" "$@" >> sender.log 2>&1 & SENDER_PID=$(pid_of $!); PIDS="$PIDS $SENDER_PID"; }
start_get() { "$P2P" get "$LINK" --out "$1" --exit-when-done > "$1.log" 2>&1 & GET_PID=$(pid_of $!); PIDS="$PIDS $GET_PID"; }
wait_link() { for _ in $(seq 1 120); do LINK=$(grep -o 'p2pshare://[^ ]*' sender.log | head -1); [ -n "$LINK" ] && return 0; sleep 0.5; done; return 1; }
chunks() { tr '\r' '\n' < "$1" | grep -oE '[0-9]+/[0-9]+ chunks' | tail -1 | cut -d/ -f1; }
percent() { tr '\r' '\n' < "$1" | grep -oE '^\[[a-z]+\] [0-9]+' | tail -1 | grep -oE '[0-9]+$'; }
wait_percent() { for _ in $(seq 1 480); do p=$(percent "$1"); [ -n "$p" ] && [ "$p" -ge "$2" ] && return 0; sleep 0.25; done; return 1; }
same_file() { [ -f "$1" ] && [ "$(sha256sum "$1" | cut -c1-64)" = "$EXPECTED" ]; }
fresh() { stop_all; rm -rf out* ./*.log; }

echo "Work dir: $WORK  ($SIZE_MB MB test file)"
head -c $((SIZE_MB * 1024 * 1024 + 4321)) /dev/urandom > test.bin
EXPECTED=$(sha256sum test.bin | cut -c1-64)

# 1. Unit tests
"$BUILD/p2pshare-tests$EXE" > unit.log 2>&1 && pass "unit tests ($(tail -1 unit.log))" || fail "unit tests"

# 2. Transfer + wrong key + 3-peer mesh
fresh; start_server mesh; start_sender; wait_link
"$P2P" get "${LINK%%#key=*}#key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" --out outBad > outBad.log 2>&1
grep -q "wrong #key" outBad.log && [ ! -e "outBad/test.bin" ] && pass "wrong key is rejected" || fail "wrong key"
start_get outB; PEER_B=$GET_PID
wait_percent outB.log 25
start_get outC; PEER_C=$GET_PID
wait_gone "$PEER_B"; wait_gone "$PEER_C"
FROM=$(tr '\r' '\n' < outC.log | grep '^\[complete\]' | tail -1 | grep -o 'from .*')
if same_file outB/test.bin && same_file outC/test.bin && echo "$FROM" | grep -q 'sender' && [ "$(echo "$FROM" | tr ',' '\n' | wc -l)" -ge 2 ]; then
  pass "mesh: two peers byte-identical; third peer received $FROM"
else
  fail "mesh ($FROM)"
fi

# 3. Receiver crash -> restart resumes from saved chunks
fresh; start_server a; start_sender; wait_link
start_get outA; wait_percent outA.log 40; BEFORE=$(chunks outA.log)
kill_hard "$GET_PID"; sleep 1
"$P2P" get "$LINK" --out outA --exit-when-done > outA2.log 2>&1
RESUMED=$(grep -o 'Resuming: [0-9]* of [0-9]*' outA2.log)
same_file outA/test.bin && [ -n "$RESUMED" ] && pass "receiver crash at $BEFORE chunks -> '$RESUMED'" || fail "receiver resume"

# 4. Sender crash -> receiver pauses -> sender --resume -> receiver continues
fresh; rm -f sender.log; start_server b; start_sender; wait_link
start_get outB; wait_percent outB.log 40; BEFORE=$(chunks outB.log)
kill_hard "$SENDER_PID"; sleep 8
PAUSED=$(grep -c 'Connection lost' outB.log)
start_sender --resume "$LINK"
wait_gone "$GET_PID"
LOWEST=$(tr '\r' '\n' < outB.log | grep -oE '[0-9]+/[0-9]+ chunks' | cut -d/ -f1 |
  awk -v b="$BEFORE" 'seen || $1 >= b {seen=1; if (min == "" || $1 < min) min = $1} END {print min}')
same_file outB/test.bin && [ "$PAUSED" -ge 1 ] && [ "$LOWEST" -ge "$BEFORE" ] &&
  pass "sender crash at $BEFORE chunks: receiver paused, then resumed (never below $LOWEST)" || fail "sender resume"

# 5. Signaling server dies mid-transfer: direct links keep going
fresh; rm -f sender.log; start_server c; start_sender; wait_link
start_get outC; wait_percent outC.log 20
kill_hard "$SERVER_PID"; AT=$(percent outC.log); sleep 3; LATER=$(percent outC.log)
start_server c2
wait_gone "$GET_PID"
same_file outC/test.bin && [ "$LATER" -gt "$AT" ] &&
  pass "signaling server killed at $AT%: reached $LATER% without it, then finished" || fail "signaling outage"

stop_all
sleep 2  # Windows releases file handles of killed processes asynchronously
rm -rf "$WORK"/test.bin "$WORK"/out*
echo
echo "$PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
