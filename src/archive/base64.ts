import { ArchiveError } from "./errors.js";
import { MAX_COMPRESSED_BYTES } from "./constants.js";

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Reject non-canonical RFC 4648 base64; preflight decoded size before allocate. */
export function decodeCanonicalBase64(
  data: string,
  maxDecoded = MAX_COMPRESSED_BYTES
): Buffer {
  if (typeof data !== "string" || data.length === 0) {
    throw new ArchiveError("ARCHIVE_BASE64_INVALID", "Empty base64");
  }
  if (/[\s\r\n\t]/.test(data)) {
    throw new ArchiveError("ARCHIVE_BASE64_INVALID", "Whitespace in base64");
  }
  if (data.length % 4 !== 0) {
    throw new ArchiveError("ARCHIVE_BASE64_INVALID", "Invalid base64 length");
  }
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if (pad === 1 && data[data.length - 2] === "=") {
    throw new ArchiveError("ARCHIVE_BASE64_INVALID", "Invalid padding");
  }
  for (let i = 0; i < data.length - pad; i++) {
    if (!B64_ALPHABET.includes(data[i])) {
      throw new ArchiveError("ARCHIVE_BASE64_INVALID", "Invalid base64 alphabet");
    }
  }
  for (let i = data.length - pad; i < data.length; i++) {
    if (data[i] !== "=") {
      throw new ArchiveError("ARCHIVE_BASE64_INVALID", "Invalid padding chars");
    }
  }
  // Canonical: when pad=1, last quantum's leftover bits must be zero — Buffer.from is lenient;
  // re-encode check catches non-canonical forms.
  const decodedLen = (data.length / 4) * 3 - pad;
  if (decodedLen > maxDecoded) {
    throw new ArchiveError(
      "ARCHIVE_COMPRESSED_TOO_LARGE",
      `Decoded archive exceeds ${maxDecoded} bytes`
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(data, "base64");
  } catch {
    throw new ArchiveError("ARCHIVE_BASE64_INVALID", "Base64 decode failed");
  }
  if (buf.length !== decodedLen) {
    throw new ArchiveError("ARCHIVE_BASE64_INVALID", "Base64 decode length mismatch");
  }
  if (buf.toString("base64") !== data) {
    throw new ArchiveError("ARCHIVE_BASE64_INVALID", "Non-canonical base64");
  }
  if (buf.length > maxDecoded) {
    throw new ArchiveError(
      "ARCHIVE_COMPRESSED_TOO_LARGE",
      `Decoded archive exceeds ${maxDecoded} bytes`
    );
  }
  return buf;
}

export function encodeCanonicalBase64(buf: Buffer): string {
  return buf.toString("base64");
}
