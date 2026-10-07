// Unit tests for the crypto / protocol core. Run: p2pshare-tests
// Uses official test vectors (FIPS 180-2 for SHA-256, NIST GCM spec for AES-256-GCM).

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <string>
#include <vector>

#include "core/base64.hpp"
#include "core/bitfield.hpp"
#include "core/crypto.hpp"
#include "core/link.hpp"
#include "core/manifest.hpp"
#include "core/protocol.hpp"

using namespace p2p;

namespace {

int failures = 0;
int checks = 0;

void expect(bool condition, const char* what, int line) {
  ++checks;
  if (!condition) {
    ++failures;
    std::printf("  FAIL (line %d): %s\n", line, what);
  }
}
#define EXPECT(cond) expect((cond), #cond, __LINE__)

Bytes fromHex(const std::string& hex) {
  Bytes out;
  for (size_t i = 0; i + 1 < hex.size(); i += 2) out.push_back(static_cast<uint8_t>(std::stoi(hex.substr(i, 2), nullptr, 16)));
  return out;
}

std::string hexOf(const Bytes& bytes) { return toHex(bytes.data(), bytes.size()); }

void testBase64() {
  const std::string text = "any carnal pleasure.";
  const std::string encoded = base64urlEncode(reinterpret_cast<const uint8_t*>(text.data()), text.size());
  EXPECT(encoded == "YW55IGNhcm5hbCBwbGVhc3VyZS4");
  const Bytes decoded = base64urlDecode(encoded);
  EXPECT(std::string(decoded.begin(), decoded.end()) == text);
  EXPECT(base64urlEncode(Bytes{0xfb, 0xff}) == "-_8");  // URL-safe alphabet
  bool threw = false;
  try {
    base64urlDecode("a$b");
  } catch (const std::invalid_argument&) {
    threw = true;
  }
  EXPECT(threw);
}

void testSha256() {
  // FIPS 180-2 test vector.
  EXPECT(sha256Hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  EXPECT(sha256Hex("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
}

void testAesGcmVector() {
  // NIST GCM spec, test case 14: 256-bit zero key, zero IV, one zero block.
  const Key key = Key::fromString(base64urlEncode(Bytes(32, 0)));
  const Bytes iv(12, 0);
  const Bytes plain(16, 0);
  const Bytes out = encryptWithIv(key, iv.data(), plain.data(), plain.size(), nullptr, 0);
  EXPECT(hexOf(Bytes(out.begin() + 12, out.begin() + 28)) == "cea7403d4d606b6e074ec5d3baf39d18");
  EXPECT(hexOf(Bytes(out.begin() + 28, out.end())) == "d0d1c8a799996bf0265b98b5d48ab919");
}

void testAesGcmRoundTrip() {
  const Key key = Key::generate();
  const Key other = Key::generate();
  const std::string text = "peer-to-peer";
  const Bytes aad = {0, 0, 0, 7};
  const Bytes sealed =
      encrypt(key, reinterpret_cast<const uint8_t*>(text.data()), text.size(), aad.data(), aad.size());
  EXPECT(sealed.size() == text.size() + kIvSize + kTagSize);

  auto opened = decrypt(key, sealed.data(), sealed.size(), aad.data(), aad.size());
  EXPECT(opened && std::string(opened->begin(), opened->end()) == text);

  EXPECT(!decrypt(other, sealed.data(), sealed.size(), aad.data(), aad.size()));  // wrong key
  const Bytes wrongAad = {0, 0, 0, 8};
  EXPECT(!decrypt(key, sealed.data(), sealed.size(), wrongAad.data(), wrongAad.size()));  // replayed
  Bytes tampered = sealed;
  tampered[kIvSize] ^= 1;
  EXPECT(!decrypt(key, tampered.data(), tampered.size(), aad.data(), aad.size()));  // modified

  EXPECT(Key::fromString(key.toString()).toString() == key.toString());
  // Two encryptions of the same data use different IVs.
  const Bytes again =
      encrypt(key, reinterpret_cast<const uint8_t*>(text.data()), text.size(), aad.data(), aad.size());
  EXPECT(again != sealed);
}

void testBitfield() {
  Bitfield field(10);
  EXPECT(field.set(0));
  EXPECT(field.set(9));
  EXPECT(!field.set(9));
  EXPECT(!field.set(10));  // out of range
  EXPECT(field.count() == 2 && field.has(0) && field.has(9) && !field.has(1));
  // Byte layout: bit i -> byte i/8, mask 1 << (i % 8).
  EXPECT(base64urlDecode(field.toBase64()) == (Bytes{0x01, 0x02}));
  const Bitfield copy = Bitfield::fromBase64(10, field.toBase64());
  EXPECT(copy.count() == 2 && copy.has(9));
  EXPECT(Bitfield::full(13).complete());
}

void testFrames() {
  const Key key = Key::generate();
  const nlohmann::json message = {{"t", "request"}, {"indices", {1, 2, 3}}};
  const Bytes control = encodeControl(key, message);
  auto decoded = decodeFrame(key, control.data(), control.size());
  EXPECT(decoded && decoded->type == Frame::Type::Control && decoded->message == message);

  const Bytes data = {1, 2, 3, 4, 5};
  const Bytes chunk = encodeChunk(key, 42, data.data(), data.size());
  decoded = decodeFrame(key, chunk.data(), chunk.size());
  EXPECT(decoded && decoded->type == Frame::Type::Chunk && decoded->index == 42 && decoded->data == data);

  // A chunk relabelled with another index fails authentication.
  Bytes relabelled = chunk;
  relabelled[4] = 43;
  EXPECT(!decodeFrame(key, relabelled.data(), relabelled.size()));
  // Wrong key fails.
  const Key other = Key::generate();
  EXPECT(!decodeFrame(other, chunk.data(), chunk.size()));
}

void testLinks() {
  const ShareLink link{"ws://192.168.1.5:8000", "5d0a8f18", "abc_DEF-123"};
  const std::string text = buildShareLink(link);
  EXPECT(text == "p2pshare://192.168.1.5:8000/5d0a8f18#key=abc_DEF-123");
  auto parsed = parseShareLink(text);
  EXPECT(parsed && parsed->serverUrl == link.serverUrl && parsed->roomId == link.roomId &&
         parsed->keyString == link.keyString);
  EXPECT(parseShareLink("p2pshares://example.com/room1234#key=k")->serverUrl == "wss://example.com");
  EXPECT(!parseShareLink("p2pshare://host/room1234"));       // no key
  EXPECT(!parseShareLink("http://host/room1234#key=abc"));  // wrong scheme
  EXPECT(!parseShareLink("p2pshare://host/../x#key=abc"));  // invalid room id
}

void testManifest() {
  const auto path = std::filesystem::temp_directory_path() / "p2pshare-test.bin";
  {
    std::ofstream out(path, std::ios::binary);
    std::vector<char> data(kChunkSize * 2 + 100, 'x');
    out.write(data.data(), static_cast<std::streamsize>(data.size()));
  }
  const Manifest manifest = buildManifest(path);
  EXPECT(manifest.meta.totalChunks == 3);
  EXPECT(chunkLength(manifest.meta, 2) == 100);
  EXPECT(manifest.hashes[0] == manifest.hashes[1] && manifest.hashes[1] != manifest.hashes[2]);
  EXPECT(manifest.meta.fileId == computeFileId(manifest.hashes) && manifest.meta.fileId.size() == 32);

  auto meta = metaFromJson(metaToJson(manifest.meta));
  EXPECT(meta && meta->size == manifest.meta.size && meta->fileId == manifest.meta.fileId);
  nlohmann::json bad = metaToJson(manifest.meta);
  bad["totalChunks"] = 99;
  EXPECT(!metaFromJson(bad));
  std::filesystem::remove(path);

  EXPECT(chunkCountFor(0, kChunkSize) == 1);  // empty files still have one (empty) chunk
}

void testSanitize() {
  EXPECT(sanitizeFileName("report.pdf") == "report.pdf");
  EXPECT(sanitizeFileName("../../etc/passwd") == "passwd");
  EXPECT(sanitizeFileName("C:\\Windows\\evil.exe") == "evil.exe");
  EXPECT(sanitizeFileName("a<b>c:d.txt") == "a_b_c_d.txt");
  EXPECT(sanitizeFileName("..") == "download.bin");
}

}  // namespace

int main() {
  const std::vector<std::pair<const char*, std::function<void()>>> tests = {
      {"base64url", testBase64},       {"sha256 (FIPS 180-2)", testSha256},
      {"aes-256-gcm (NIST)", testAesGcmVector}, {"aes-256-gcm round trip", testAesGcmRoundTrip},
      {"bitfield", testBitfield},      {"frames", testFrames},
      {"share links", testLinks},      {"manifest", testManifest},
      {"file name sanitizing", testSanitize},
  };
  for (const auto& [name, test] : tests) {
    const int before = failures;
    test();
    std::printf("%s %s\n", failures == before ? "[ ok ]" : "[FAIL]", name);
  }
  std::printf("\n%d checks, %d failed\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
