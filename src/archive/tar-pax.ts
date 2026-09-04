import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  isAllowedResourceExtension,
  normalizeRelPosix,
} from "../tasks/files.js";
import { bufferContainsKnownSecrets } from "../tasks/sanitize.js";
import {
  MAX_ARCHIVE_MEMBERS,
  MAX_MEMBER_BYTES,
  MAX_UNCOMPRESSED_BYTES,
} from "./constants.js";
import { ArchiveError } from "./errors.js";

const BLOCK = 512;
const USTAR_MAGIC = Buffer.from("ustar\0");
const USTAR_VERSION = Buffer.from("00");

export interface TarMemberInput {
  relativePath: string;
  bytes: Buffer;
}

export interface ParsedTarMember {
  relativePath: string;
  displayName: string;
  bytes: Buffer;
  sizeBytes: number;
  sha256: string;
}

function encodeOctal(value: number, digits: number): Buffer {
  const s = value.toString(8).padStart(digits - 1, "0") + "\0";
  if (s.length > digits) {
    throw new ArchiveError("ARCHIVE_TAR_INVALID", "Octal field overflow");
  }
  return Buffer.from(s.padEnd(digits, "\0").slice(0, digits), "binary");
}

function checksumHeader(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 32 : header[i];
  }
  return sum;
}

function writeUstarHeader(
  name: string,
  size: number,
  typeflag: string,
  prefix = ""
): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(name.slice(0, 100), 0, "utf8");
  encodeOctal(0o644, 8).copy(header, 100); // mode
  encodeOctal(0, 8).copy(header, 108); // uid
  encodeOctal(0, 8).copy(header, 116); // gid
  encodeOctal(size, 12).copy(header, 124);
  encodeOctal(0, 12).copy(header, 136); // mtime
  header.write("        ", 148, "ascii"); // checksum placeholder
  header.write(typeflag, 156, "ascii");
  USTAR_MAGIC.copy(header, 257);
  USTAR_VERSION.copy(header, 263);
  // uname/gname empty
  if (prefix) header.write(prefix.slice(0, 155), 345, "utf8");
  const sum = checksumHeader(header);
  const sumStr = sum.toString(8).padStart(6, "0") + "\0 ";
  header.write(sumStr, 148, "ascii");
  return header;
}

function paxRecords(entries: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(entries)) {
    const body = `${key}=${value}\n`;
    // length includes the length digits themselves — iterate
    let len = Buffer.byteLength(body, "utf8") + 3;
    for (;;) {
      const rec = `${len} ${body}`;
      const actual = Buffer.byteLength(rec, "utf8");
      if (actual === len) {
        parts.push(Buffer.from(rec, "utf8"));
        break;
      }
      len = actual;
    }
  }
  return Buffer.concat(parts);
}

function padToBlock(size: number): number {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

function splitUstarPath(relPosix: string): { name: string; needsPax: boolean } {
  const bytes = Buffer.byteLength(relPosix, "utf8");
  if (bytes <= 100) {
    return { name: relPosix, needsPax: false };
  }
  return {
    name: ("./" + basename(relPosix)).slice(0, 100),
    needsPax: true,
  };
}

/** Pack regular-file members into a canonical pax tar (mtime/uid/gid=0). */
export function packTarPax(members: readonly TarMemberInput[]): Buffer {
  if (members.length === 0) {
    throw new ArchiveError("PACK_TOO_MANY_MEMBERS", "No members to pack");
  }
  if (members.length > MAX_ARCHIVE_MEMBERS) {
    throw new ArchiveError(
      "PACK_TOO_MANY_MEMBERS",
      `Too many members (max ${MAX_ARCHIVE_MEMBERS})`
    );
  }

  const sorted = [...members].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
  );
  const seen = new Set<string>();
  const chunks: Buffer[] = [];
  let total = 0;

  for (const m of sorted) {
    let rel: string;
    try {
      rel = normalizeRelPosix(m.relativePath);
    } catch {
      throw new ArchiveError("ARCHIVE_MEMBER_PATH_INVALID", "Invalid member path");
    }
    if (rel.startsWith("./")) {
      throw new ArchiveError("ARCHIVE_MEMBER_PATH_INVALID", "Leading ./ rejected");
    }
    if (seen.has(rel)) {
      throw new ArchiveError("ARCHIVE_MEMBER_DUPLICATE", `Duplicate path ${rel}`);
    }
    seen.add(rel);
    if (!isAllowedResourceExtension(rel)) {
      throw new ArchiveError("ARCHIVE_MEMBER_EXT_REJECTED", `Extension not allowed (${rel})`);
    }
    if (m.bytes.length > MAX_MEMBER_BYTES) {
      throw new ArchiveError("PACK_MEMBER_TOO_LARGE", `Member too large (${rel})`);
    }
    if (m.bytes.includes(0)) {
      throw new ArchiveError("ARCHIVE_MEMBER_BINARY", `NUL in member (${rel})`);
    }

    const { name, needsPax } = splitUstarPath(rel);
    const size = m.bytes.length;

    if (needsPax || size >= 0o77777777777) {
      const paxBody = paxRecords({ path: rel, size: String(size) });
      const paxName = `PaxHeader/${basename(rel)}`.slice(0, 100);
      chunks.push(writeUstarHeader(paxName, paxBody.length, "x"));
      chunks.push(paxBody);
      const pad = padToBlock(paxBody.length);
      if (pad) chunks.push(Buffer.alloc(pad, 0));
      total += BLOCK + paxBody.length + pad;
    }

    chunks.push(writeUstarHeader(name.slice(0, 100), size, "0"));
    chunks.push(m.bytes);
    const pad = padToBlock(size);
    if (pad) chunks.push(Buffer.alloc(pad, 0));
    total += BLOCK + size + pad;

    if (total > MAX_UNCOMPRESSED_BYTES) {
      throw new ArchiveError("PACK_TOTAL_TOO_LARGE", "Tar exceeds uncompressed cap");
    }
  }

  // Two zero blocks EOF
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  total += BLOCK * 2;
  if (total > MAX_UNCOMPRESSED_BYTES) {
    throw new ArchiveError("PACK_TOTAL_TOO_LARGE", "Tar exceeds uncompressed cap");
  }
  return Buffer.concat(chunks);
}

function parseOctal(buf: Buffer): number {
  const s = buf.toString("utf8").replace(/\0/g, "").trim();
  if (!s) return 0;
  // base-256 GNU (high bit set) — reject for 0.9
  if (buf[0] & 0x80) {
    throw new ArchiveError("ARCHIVE_TAR_INVALID", "Base-256 size rejected");
  }
  if (!/^[0-7]+$/.test(s)) {
    throw new ArchiveError("ARCHIVE_TAR_INVALID", "Malformed octal field");
  }
  return parseInt(s, 8);
}

function parsePaxBody(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    let j = i;
    while (j < body.length && body[j] !== 0x20) j++;
    if (j >= body.length) {
      throw new ArchiveError("ARCHIVE_TAR_INVALID", "Malformed pax length");
    }
    const lenStr = body.subarray(i, j).toString("utf8");
    if (!/^[0-9]+$/.test(lenStr)) {
      throw new ArchiveError("ARCHIVE_TAR_INVALID", "Malformed pax length");
    }
    const len = Number(lenStr);
    if (len < 1 || i + len > body.length) {
      throw new ArchiveError("ARCHIVE_TAR_INVALID", "Malformed pax record length");
    }
    const rec = body.subarray(i, i + len);
    const content = rec.subarray(j - i + 1); // after space
    if (content[content.length - 1] !== 0x0a) {
      throw new ArchiveError("ARCHIVE_TAR_INVALID", "Pax record missing newline");
    }
    const line = content.subarray(0, content.length - 1).toString("utf8");
    const eq = line.indexOf("=");
    if (eq <= 0) {
      throw new ArchiveError("ARCHIVE_TAR_INVALID", "Malformed pax key");
    }
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === "path" && Object.prototype.hasOwnProperty.call(out, "path")) {
      throw new ArchiveError("ARCHIVE_TAR_INVALID", "Repeated pax path key");
    }
    out[key] = value;
    i += len;
  }
  return out;
}

function canonicalizeMemberPath(raw: string): string {
  if (!raw || raw.includes("\0")) {
    throw new ArchiveError("ARCHIVE_MEMBER_PATH_INVALID", "Empty or NUL path");
  }
  if (raw.includes("\\")) {
    throw new ArchiveError("ARCHIVE_MEMBER_PATH_INVALID", "Backslash path rejected");
  }
  if (raw.startsWith("/") || raw.startsWith("./")) {
    throw new ArchiveError("ARCHIVE_MEMBER_PATH_INVALID", "Absolute or ./ path rejected");
  }
  try {
    return normalizeRelPosix(raw);
  } catch {
    throw new ArchiveError("ARCHIVE_MEMBER_PATH_INVALID", `Invalid path ${raw}`);
  }
}

/** Parse tar with type allowlist; enforce uncompressed accounting on stream bytes. */
export function parseTarPax(tar: Buffer): ParsedTarMember[] {
  if (tar.length > MAX_UNCOMPRESSED_BYTES) {
    throw new ArchiveError(
      "ARCHIVE_UNCOMPRESSED_TOO_LARGE",
      "Tar exceeds uncompressed cap"
    );
  }

  const members: ParsedTarMember[] = [];
  const seen = new Set<string>();
  let off = 0;
  let pendingPax: Record<string, string> | null = null;
  let zeroBlocks = 0;

  while (off < tar.length) {
    if (off + BLOCK > tar.length) {
      throw new ArchiveError("ARCHIVE_TAR_INVALID", "Truncated tar header");
    }
    const header = tar.subarray(off, off + BLOCK);
    off += BLOCK;

    if (header.every((b) => b === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) {
        if (off < tar.length) {
          // trailing must be all zeros (block padding) or empty
          if (!tar.subarray(off).every((b) => b === 0)) {
            throw new ArchiveError("ARCHIVE_TAR_INVALID", "Trailing data after tar EOF");
          }
        }
        if (pendingPax) {
          throw new ArchiveError("ARCHIVE_TAR_INVALID", "Pax header without following member");
        }
        break;
      }
      continue;
    }
    zeroBlocks = 0;

    const checksumField = header.subarray(148, 156);
    const storedSum = parseOctal(checksumField);
    if (checksumHeader(header) !== storedSum) {
      throw new ArchiveError("ARCHIVE_TAR_INVALID", "Bad tar header checksum");
    }

    const typeflag = String.fromCharCode(header[156] || 0x30);
    const size = parseOctal(header.subarray(124, 136));
    const nameRaw = header.subarray(0, 100).toString("utf8").replace(/\0/g, "");
    const prefixRaw = header.subarray(345, 500).toString("utf8").replace(/\0/g, "");
    const ustarPath = prefixRaw ? `${prefixRaw}/${nameRaw}` : nameRaw;

    const dataEnd = off + size;
    if (dataEnd > tar.length) {
      throw new ArchiveError("ARCHIVE_TAR_INVALID", "Truncated tar body");
    }
    const body = Buffer.from(tar.subarray(off, dataEnd));
    off = dataEnd + padToBlock(size);

    if (typeflag === "x") {
      if (pendingPax) {
        throw new ArchiveError("ARCHIVE_TAR_INVALID", "Consecutive pax headers");
      }
      pendingPax = parsePaxBody(body);
      continue;
    }

    if (typeflag === "g") {
      throw new ArchiveError(
        "ARCHIVE_MEMBER_TYPE_UNSUPPORTED",
        "Global pax header rejected"
      );
    }
    if (typeflag === "1" || typeflag === "2") {
      throw new ArchiveError(
        "ARCHIVE_MEMBER_TYPE_UNSUPPORTED",
        typeflag === "1" ? "Hardlink rejected" : "Symlink rejected"
      );
    }
    if (typeflag === "5") {
      throw new ArchiveError("ARCHIVE_MEMBER_TYPE_UNSUPPORTED", "Directory entry rejected");
    }
    if (typeflag !== "0" && typeflag !== "\0") {
      throw new ArchiveError(
        "ARCHIVE_MEMBER_TYPE_UNSUPPORTED",
        `Unsupported tar typeflag ${JSON.stringify(typeflag)}`
      );
    }

    const pax = pendingPax;
    pendingPax = null;
    const effectivePath = canonicalizeMemberPath(pax?.path ?? ustarPath);
    const effectiveSize = pax?.size !== undefined ? Number(pax.size) : size;
    if (!Number.isFinite(effectiveSize) || effectiveSize !== size) {
      // body length is authoritative from header size field we already read;
      // pax size must match when present
      if (pax?.size !== undefined && Number(pax.size) !== size) {
        throw new ArchiveError("ARCHIVE_TAR_INVALID", "Pax size mismatch");
      }
    }

    if (seen.has(effectivePath)) {
      throw new ArchiveError(
        "ARCHIVE_MEMBER_DUPLICATE",
        `Duplicate member ${effectivePath}`
      );
    }
    seen.add(effectivePath);

    if (!isAllowedResourceExtension(effectivePath)) {
      throw new ArchiveError(
        "ARCHIVE_MEMBER_EXT_REJECTED",
        `Extension not allowed (${effectivePath})`
      );
    }
    if (body.length > MAX_MEMBER_BYTES) {
      throw new ArchiveError(
        "ARCHIVE_MEMBER_TOO_LARGE",
        `Member too large (${effectivePath})`
      );
    }
    if (body.includes(0)) {
      throw new ArchiveError(
        "ARCHIVE_MEMBER_BINARY",
        `NUL/binary member (${effectivePath})`
      );
    }
    try {
      body.toString("utf8");
    } catch {
      throw new ArchiveError("ARCHIVE_MEMBER_BINARY", "Invalid UTF-8");
    }
    // Validate UTF-8 strictly
    if (Buffer.from(body.toString("utf8"), "utf8").compare(body) !== 0) {
      throw new ArchiveError("ARCHIVE_MEMBER_BINARY", "Invalid UTF-8");
    }
    if (bufferContainsKnownSecrets(body)) {
      throw new ArchiveError(
        "ARCHIVE_MEMBER_SECRET",
        `Secret pattern in member (${effectivePath})`
      );
    }

    members.push({
      relativePath: effectivePath,
      displayName: basename(effectivePath),
      bytes: body,
      sizeBytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    });

    if (members.length > MAX_ARCHIVE_MEMBERS) {
      throw new ArchiveError(
        "ARCHIVE_TOO_MANY_MEMBERS",
        `Too many members (max ${MAX_ARCHIVE_MEMBERS})`
      );
    }
  }

  if (zeroBlocks < 2) {
    throw new ArchiveError("ARCHIVE_TAR_INVALID", "Missing tar EOF (two zero blocks)");
  }
  if (pendingPax) {
    throw new ArchiveError("ARCHIVE_TAR_INVALID", "Pax header without following member");
  }
  if (members.length === 0) {
    throw new ArchiveError("ARCHIVE_TAR_INVALID", "Archive has no file members");
  }
  return members;
}
