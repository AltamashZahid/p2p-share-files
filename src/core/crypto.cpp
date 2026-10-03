#include "core/crypto.hpp"

#include <openssl/evp.h>
#include <openssl/rand.h>

#include <memory>
#include <stdexcept>

namespace p2p {

namespace {

using CipherCtx = std::unique_ptr<EVP_CIPHER_CTX, decltype(&EVP_CIPHER_CTX_free)>;

CipherCtx newContext() {
  CipherCtx ctx(EVP_CIPHER_CTX_new(), &EVP_CIPHER_CTX_free);
  if (!ctx) throw std::runtime_error("EVP_CIPHER_CTX_new failed");
  return ctx;
}

void check(int result, const char* what) {
  if (result != 1) throw std::runtime_error(what);
}

}  // namespace

Key Key::generate() {
  Key key;
  randomBytes(key.bytes_.data(), key.bytes_.size());
  return key;
}

Key Key::fromString(std::string_view text) {
  const Bytes raw = base64urlDecode(text);
  if (raw.size() != kKeySize) throw std::invalid_argument("decryption key must be 256 bits");
  Key key;
  std::copy(raw.begin(), raw.end(), key.bytes_.begin());
  return key;
}

std::string Key::toString() const { return base64urlEncode(bytes_.data(), bytes_.size()); }

Bytes encrypt(const Key& key, const uint8_t* data, size_t size, const uint8_t* aad, size_t aadSize) {
  uint8_t iv[kIvSize];
  randomBytes(iv, sizeof iv);
  return encryptWithIv(key, iv, data, size, aad, aadSize);
}

Bytes encryptWithIv(const Key& key, const uint8_t* iv, const uint8_t* data, size_t size,
                    const uint8_t* aad, size_t aadSize) {
  Bytes out(kIvSize + size + kTagSize);
  std::copy(iv, iv + kIvSize, out.begin());

  CipherCtx ctx = newContext();
  int length = 0;
  check(EVP_EncryptInit_ex(ctx.get(), EVP_aes_256_gcm(), nullptr, key.data(), iv), "encrypt init");
  if (aadSize > 0) {
    check(EVP_EncryptUpdate(ctx.get(), nullptr, &length, aad, static_cast<int>(aadSize)), "encrypt aad");
  }
  if (size > 0) {
    check(EVP_EncryptUpdate(ctx.get(), out.data() + kIvSize, &length, data, static_cast<int>(size)),
          "encrypt update");
  }
  check(EVP_EncryptFinal_ex(ctx.get(), out.data() + kIvSize + size, &length), "encrypt final");
  check(EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_GET_TAG, kTagSize, out.data() + kIvSize + size),
        "get tag");
  return out;
}

std::optional<Bytes> decrypt(const Key& key, const uint8_t* payload, size_t size, const uint8_t* aad,
                             size_t aadSize) {
  if (size < kIvSize + kTagSize) return std::nullopt;
  const size_t cipherSize = size - kIvSize - kTagSize;
  const uint8_t* iv = payload;
  const uint8_t* ciphertext = payload + kIvSize;
  const uint8_t* tag = payload + kIvSize + cipherSize;

  Bytes plain(cipherSize);
  CipherCtx ctx = newContext();
  int length = 0;
  if (EVP_DecryptInit_ex(ctx.get(), EVP_aes_256_gcm(), nullptr, key.data(), iv) != 1) return std::nullopt;
  if (aadSize > 0 &&
      EVP_DecryptUpdate(ctx.get(), nullptr, &length, aad, static_cast<int>(aadSize)) != 1) {
    return std::nullopt;
  }
  if (cipherSize > 0 && EVP_DecryptUpdate(ctx.get(), plain.data(), &length, ciphertext,
                                          static_cast<int>(cipherSize)) != 1) {
    return std::nullopt;
  }
  if (EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_SET_TAG, kTagSize, const_cast<uint8_t*>(tag)) != 1) {
    return std::nullopt;
  }
  // Final fails if the authentication tag doesn't match: wrong key or tampering.
  if (EVP_DecryptFinal_ex(ctx.get(), plain.data() + cipherSize, &length) != 1) return std::nullopt;
  return plain;
}

std::array<uint8_t, 32> sha256(const uint8_t* data, size_t size) {
  std::array<uint8_t, 32> digest{};
  unsigned int length = 0;
  check(EVP_Digest(data, size, digest.data(), &length, EVP_sha256(), nullptr), "sha256");
  return digest;
}

std::string sha256Hex(const uint8_t* data, size_t size) {
  const auto digest = sha256(data, size);
  return toHex(digest.data(), digest.size());
}

void randomBytes(uint8_t* out, size_t size) {
  check(RAND_bytes(out, static_cast<int>(size)), "RAND_bytes");
}

std::string randomId(size_t bytes) {
  Bytes raw(bytes);
  randomBytes(raw.data(), raw.size());
  return toHex(raw.data(), raw.size());
}

}  // namespace p2p
