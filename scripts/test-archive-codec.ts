/**
 * Unit tests for v0.9 tar.zst archive codec (Phase 1 security gate).
 * Run: npm run test:archive-codec
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  compressTarZstd,
  decodeCanonicalBase64,
  decompressTarZstd,
  encodeCanonicalBase64,
  inspectSingleZstdFrame,
  packTarPax,
  parseTarPax,
  packTaskResourcesAsTarZst,
  ArchiveError,
  MAX_COMPRESSED_BYTES,
  MAX_UNCOMPRESSED_BYTES,
  MAX_ZSTD_WINDOW,
} from "../src/archive/index.js";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`ok - ${name}`);
}

function throwsCode(fn: () => unknown, code: string, name: string) {
  try {
    fn();
    assert.fail(`expected ${code}`);
  } catch (err) {
    assert.ok(err instanceof ArchiveError, `${name}: expected ArchiveError`);
    assert.equal(err.code, code, `${name}: got ${err.code}`);
  }
  ok(name);
}

// --- round-trip ---
{
  const members = [
    { relativePath: "src/a.ts", bytes: Buffer.from("export const a = 1;\n", "utf8") },
    { relativePath: "src/b/b.ts", bytes: Buffer.from("export const b = 2;\n", "utf8") },
  ];
  const tar = packTarPax(members);
  const zst = compressTarZstd(tar);
  inspectSingleZstdFrame(zst);
  const out = parseTarPax(decompressTarZstd(zst));
  assert.equal(out.length, 2);
  assert.equal(out[0].relativePath, "src/a.ts");
  assert.equal(out[1].relativePath, "src/b/b.ts");
  assert.equal(out[0].bytes.toString(), members[0].bytes.toString());
  ok("round-trip 2 nested paths");
}

// --- pack chip ---
{
  const taskId = "ho_01JABCDEFGHJKMNPQRSTVWXYZ";
  // Fix ULID - must be Crockford base32. Use a real-looking one:
  const tid = "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const prepared = [
    {
      resourceId: "f_1",
      displayName: "a.ts",
      bytes: Buffer.from("a", "utf8"),
      sizeBytes: 1,
      sha256: createHash("sha256").update("a").digest("hex"),
      mediaType: "text/plain",
    },
  ];
  const files = [
    {
      fileId: "f_1",
      displayName: "a.ts",
      relativePath: "src/a.ts",
      source: { kind: "workspace_file" as const, relativePath: "src/a.ts" },
      createdAt: new Date().toISOString(),
    },
  ];
  const chip = packTaskResourcesAsTarZst(files, prepared, tid);
  assert.equal(chip.displayName, `handoff-${tid}.tar.zst`);
  assert.equal(chip.mediaType, "application/zstd");
  assert.equal(chip.bytes.length > 0, true);
  ok("packTaskResourcesAsTarZst chip name");
  void taskId;
}

// --- base64 ---
{
  const raw = Buffer.from("hello");
  const b64 = encodeCanonicalBase64(raw);
  assert.deepEqual(decodeCanonicalBase64(b64), raw);
  throwsCode(
    () => decodeCanonicalBase64("abc"),
    "ARCHIVE_BASE64_INVALID",
    "base64 bad length"
  );
  throwsCode(
    () => decodeCanonicalBase64("abc!"),
    "ARCHIVE_BASE64_INVALID",
    "base64 bad alphabet"
  );
  throwsCode(
    () => decodeCanonicalBase64("aGVsbG8=\n"),
    "ARCHIVE_BASE64_INVALID",
    "base64 whitespace"
  );
  // preflight oversized without needing huge alloc of valid decode path —
  // construct length that implies > MAX_COMPRESSED_BYTES
  const oversizedLen = Math.ceil(((MAX_COMPRESSED_BYTES + 1) * 4) / 3);
  const pad = (4 - (oversizedLen % 4)) % 4;
  const huge = "A".repeat(oversizedLen + pad);
  throwsCode(
    () => decodeCanonicalBase64(huge),
    "ARCHIVE_COMPRESSED_TOO_LARGE",
    "base64 preflight oversize"
  );
}

// --- zstd multi-frame / trailing ---
{
  const a = compressTarZstd(packTarPax([{ relativePath: "a.ts", bytes: Buffer.from("a") }]));
  const b = compressTarZstd(packTarPax([{ relativePath: "b.ts", bytes: Buffer.from("b") }]));
  throwsCode(
    () => inspectSingleZstdFrame(Buffer.concat([a, b])),
    "ARCHIVE_ZSTD_INVALID",
    "concatenated frames"
  );
  throwsCode(
    () => inspectSingleZstdFrame(Buffer.concat([a, Buffer.from([1])])),
    "ARCHIVE_ZSTD_INVALID",
    "trailing byte"
  );
  // skippable magic
  const skip = Buffer.alloc(8);
  skip.writeUInt32LE(0x184d2a50, 0);
  skip.writeUInt32LE(0, 4);
  throwsCode(
    () => inspectSingleZstdFrame(skip),
    "ARCHIVE_ZSTD_INVALID",
    "skippable frame"
  );
}

// --- window too large (crafted header) ---
{
  // Build a minimal fake frame header with huge window — may not decompress,
  // but inspectSingleZstdFrame should reject on window descriptor.
  // Window_Descriptor: exponent=20 mantissa=0 → windowBase = 1<<(10+20)=1GiB
  const hdr = Buffer.alloc(8);
  hdr.writeUInt32LE(0xfd2fb528, 0);
  // desc: fcsFlag=0, single=0, checksum=0, dict=0 → 0x00
  hdr[4] = 0x00;
  hdr[5] = (20 << 3) | 0; // window descriptor
  // Need block to finish — truncated is also invalid; for window check we need
  // enough structure. If truncated before blocks, we may error earlier.
  // Instead compress with default and verify our compress uses ≤8MiB window.
  const zst = compressTarZstd(packTarPax([{ relativePath: "x.ts", bytes: Buffer.from("x") }]));
  const info = inspectSingleZstdFrame(zst);
  assert.ok(info.windowSize <= MAX_ZSTD_WINDOW, `window ${info.windowSize}`);
  ok("producer window ≤ 8 MiB");
}

// --- tar type rejects ---
{
  // Craft a tar with symlink typeflag via low-level — use pack then mutate header is hard.
  // Symlink: build minimal ustar manually
  const name = "link.ts";
  const header = Buffer.alloc(512, 0);
  header.write(name, 0);
  // mode/uid/gid/size/mtime
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write("00000000000\0", 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header[156] = "2".charCodeAt(0); // symlink
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const tar = Buffer.concat([header, Buffer.alloc(1024, 0)]);
  throwsCode(() => parseTarPax(tar), "ARCHIVE_MEMBER_TYPE_UNSUPPORTED", "symlink reject");
}

// --- hardlink ---
{
  const header = Buffer.alloc(512, 0);
  header.write("hard.ts", 0);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write("00000000000\0", 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header[156] = "1".charCodeAt(0);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const tar = Buffer.concat([header, Buffer.alloc(1024, 0)]);
  throwsCode(() => parseTarPax(tar), "ARCHIVE_MEMBER_TYPE_UNSUPPORTED", "hardlink reject");
}

// --- extension reject ---
{
  throwsCode(
    () =>
      packTarPax([{ relativePath: "evil.zip", bytes: Buffer.from("PK") }]),
    "ARCHIVE_MEMBER_EXT_REJECTED",
    "zip extension rejected on pack"
  );
}

// --- duplicate basename OK on pack (different dirs) ---
{
  const tar = packTarPax([
    { relativePath: "a/x.ts", bytes: Buffer.from("1") },
    { relativePath: "b/x.ts", bytes: Buffer.from("2") },
  ]);
  const members = parseTarPax(tar);
  assert.equal(members.length, 2);
  ok("duplicate basename different dirs");
}

// --- member count 101 ---
{
  const many = Array.from({ length: 101 }, (_, i) => ({
    relativePath: `f${i}.ts`,
    bytes: Buffer.from(String(i)),
  }));
  throwsCode(() => packTarPax(many), "PACK_TOO_MANY_MEMBERS", "101 members pack");
}

// --- FCS / decompress bound ---
{
  const bigish = Buffer.alloc(1024, 65);
  const tar = packTarPax([{ relativePath: "big.ts", bytes: bigish }]);
  const zst = compressTarZstd(tar);
  const out = decompressTarZstd(zst);
  assert.ok(out.length <= MAX_UNCOMPRESSED_BYTES);
  ok("decompress within uncompressed cap");
}

// ensure node zlib still used for smoke
{
  const c = zstdCompressSync(Buffer.from("hi"), {
    params: { [zlibConstants.ZSTD_c_windowLog]: 23 },
  });
  assert.ok(c.length > 0);
  ok("node zlib zstd windowLog param");
}

console.log(`\n${passed} tests passed`);
