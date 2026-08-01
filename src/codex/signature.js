// Validation for GPT reasoning signatures (the `encrypted_content` a Codex
// response carries and a later turn replays).
//
// Why validate at all: only reasoning the GPT backend itself issued can be
// replayed to it. A conversation that previously ran on a Claude account
// carries Anthropic-issued thinking signatures, and forwarding one as
// encrypted_content makes the backend reject the whole request. Dropping the
// block instead degrades gracefully — the turn loses its replayed reasoning but
// still completes.
//
// Ported from CLIProxyAPI internal/signature/gpt_validation.go.

// A Fernet token: version(1) + timestamp(8) + IV(16) + ciphertext(16n) + HMAC(32).
const VERSION_BYTE = 0x80;
const MIN_DECODED_LEN = 73;
const HEADER_LEN = 1 + 8 + 16; // version + timestamp + IV
const HMAC_LEN = 32;
const AES_BLOCK = 16;

// 32 MiB. A signature this large is certainly not one, and decoding it would be
// the expensive way to find that out.
const MAX_SIGNATURE_LEN = 32 * 1024 * 1024;

// Base64url alphabet, padding included.
const CHARSET = /^[A-Za-z0-9\-_=]*$/;

// Signatures may arrive tagged with the provider that issued them
// ("claude#<sig>"). An untagged one is inspected structurally.
const PROVIDER_PREFIXES = new Set(['claude', 'gemini', 'gpt', 'grok']);

/**
 * Split a "provider#signature" tag. Returns { provider, signature } with
 * provider null when the value carries no recognized tag.
 */
export function splitProviderPrefix(raw) {
  const sig = String(raw ?? '').trim();
  const hash = sig.indexOf('#');
  if (hash < 0) return { provider: null, signature: sig };
  const prefix = sig.slice(0, hash).toLowerCase();
  if (!PROVIDER_PREFIXES.has(prefix)) return { provider: null, signature: sig };
  return { provider: prefix, signature: sig.slice(hash + 1).trim() };
}

function decodeBase64Url(sig) {
  try {
    const buf = Buffer.from(sig, 'base64url');
    // Node's base64 decoder is lenient and silently drops trailing garbage, so
    // a round-trip check stands in for Go's strict decoder.
    if (buf.length === 0 && sig.length > 0) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * Is this a structurally valid GPT reasoning signature?
 *
 * Structural only — we cannot verify the HMAC without the backend's key. The
 * point is to reject signatures issued by a different provider, not to
 * authenticate our own.
 */
export function isValidGptReasoningSignature(raw) {
  const sig = String(raw ?? '').trim();
  if (sig === '' || sig.length > MAX_SIGNATURE_LEN) return false;

  // The literal prefix is the cheapest discriminator and rejects every other
  // provider's envelope before the charset scan or decode.
  if (!sig.startsWith('gAAAA')) return false;
  if (!CHARSET.test(sig)) return false;

  const decoded = decodeBase64Url(sig);
  if (!decoded || decoded.length < MIN_DECODED_LEN) return false;
  if (decoded[0] !== VERSION_BYTE) return false;

  const ciphertextLen = decoded.length - HEADER_LEN - HMAC_LEN;
  return ciphertextLen > 0 && ciphertextLen % AES_BLOCK === 0;
}

/**
 * Return the signature to send as encrypted_content, or null when the value
 * cannot be replayed to a GPT backend and its reasoning block should be dropped.
 */
export function compatibleGptSignature(raw) {
  const { provider, signature } = splitProviderPrefix(raw);
  // An explicit tag from another provider is authoritative: don't second-guess it.
  if (provider !== null && provider !== 'gpt') return null;
  return isValidGptReasoningSignature(signature) ? signature : null;
}
