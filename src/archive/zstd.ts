import {
  constants as zlibConstants,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";
import {
  MAX_COMPRESSED_BYTES,
  MAX_UNCOMPRESSED_BYTES,
  MAX_ZSTD_WINDOW,
  MAX_ZSTD_WINDOW_LOG,
} from "./constants.js";
import { ArchiveError } from "./errors.js";

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const SKIPPABLE_MAGIC_MAX = 0x184d2a5f;

export interface ZstdFrameInfo {
  headerBytes: number;
  frameBytes: number;
  windowSize: number;
  frameContentSize: number | null;
  singleSegment: boolean;
  hasChecksum: boolean;
  dictId: number;
}

function readU24LE(buf: Buffer, off: number): number {
  return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
}

/** Locate exact end of one Zstandard frame by walking block headers (no decompress). */
export function inspectSingleZstdFrame(buf: Buffer): ZstdFrameInfo {
  if (buf.length < 5) {
    throw new ArchiveError("ARCHIVE_ZSTD_INVALID", "Truncated zstd frame");
  }
  const magic = buf.readUInt32LE(0);
  if (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX) {
    throw new ArchiveError("ARCHIVE_ZSTD_INVALID", "Skippable zstd frame rejected");
  }
  if (magic !== ZSTD_MAGIC) {
    throw new ArchiveError("ARCHIVE_ZSTD_INVALID", "Invalid zstd magic");
  }

  const desc = buf[4];
  const fcsFlag = (desc >> 6) & 0x3;
  const singleSegment = ((desc >> 5) & 0x1) === 1;
  const unusedBit = ((desc >> 4) & 0x1) === 1;
  const reserved = ((desc >> 3) & 0x1) === 1;
  const hasChecksum = ((desc >> 2) & 0x1) === 1;
  const dictIdFlag = desc & 0x3;

  if (unusedBit || reserved) {
    throw new ArchiveError("ARCHIVE_ZSTD_INVALID", "Invalid frame descriptor bits");
  }

  let off = 5;
  let windowSize: number;

  if (!singleSegment) {
    if (off >= buf.length) {
      throw new ArchiveError("ARCHIVE_ZSTD_INVALID", "Truncated window descriptor");
    }
    const wd = buf[off++];
    const exponent = wd >> 3;
    const mantissa = wd & 0x7;
    const windowBase = 1 << (10 + exponent);
    windowSize = windowBase + (windowBase / 8) * mantissa;
  } else {
    windowSize = 0; // filled from FCS below
  }

  let dictId = 0;
  const dictSizes = [0, 1, 2, 4];
  const dictBytes = dictSizes[dictIdFlag];
  if (dictBytes > 0) {
    if (off + dictBytes > buf.length) {
      throw new ArchiveError("ARCHIVE_ZSTD_INVALID", "Truncated dictionary id");
    }
    if (dictBytes === 1) dictId = buf[off];
    else if (dictBytes === 2) dictId = buf.readUInt16LE(off);
    else dictId = buf.readUInt32LE(off);
    off += dictBytes;
  }
  if (dictId !== 0) {
    throw new ArchiveError("ARCHIVE_ZSTD_INVALID", "Zstd dictionary rejected");
  }

  let fcsFieldSize = 0;
  if (fcsFlag === 0) {
    fcsFieldSize = singleSegment ? 1 : 0;
  } else if (fcsFlag === 1) fcsFieldSize = 2;
  else if (fcsFlag === 2) fcsFieldSize = 4;
  else fcsFieldSize = 8;

  let frameContentSize: number | null = null;
  if (fcsFieldSize > 0) {
    if (off + fcsFieldSize > buf.length) {
      throw new ArchiveError("ARCHIVE_ZSTD_INVALID", "Truncated frame content size");
    }
    if (fcsFieldSize === 1) frameContentSize = buf[off];
    else if (fcsFieldSize === 2) frameContentSize = buf.readUInt16LE(off) + 256;
    else if (fcsFieldSize === 4) frameContentSize = buf.readUInt32LE(off);
    else {
      const lo = buf.readUInt32LE(off);
      const hi = buf.readUInt32LE(off + 4);
      if (hi !== 0) {
        throw new ArchiveError("ARCHIVE_ZSTD_INVALID", "Frame content size too large");
      }
      frameContentSize = lo;
    }
    off += fcsFieldSize;
  }

  if (singleSegment) {
    if (frameContentSize === null) {
      throw new ArchiveError("ARCHIVE_ZSTD_INVALID", "Single-segment requires FCS");
    }
    windowSize = frameContentSize;
  }

  if (windowSize > MAX_ZSTD_WINDOW) {
    throw new ArchiveError(
      "ARCHIVE_ZSTD_WINDOW_TOO_LARGE",
      `Zstd window ${windowSize} exceeds ${MAX_ZSTD_WINDOW}`
    );
  }
  if (frameContentSize !== null && frameContentSize > MAX_UNCOMPRESSED_BYTES) {
    throw new ArchiveError(
      "ARCHIVE_UNCOMPRESSED_TOO_LARGE",
      `FCS ${frameContentSize} exceeds uncompressed cap`
    );
  }

  const headerBytes = off;

  // Walk data blocks until Last_Block.
  while (true) {
    if (off + 3 > buf.length) {
      throw new ArchiveError("ARCHIVE_ZSTD_INVALID", "Truncated block header");
    }
    const blockHeader = readU24LE(buf, off);
    off += 3;
    const last = (blockHeader & 0x1) === 1;
    const blockType = (blockHeader >> 1) & 0x3;
    const blockSize = blockHeader >> 3;
    if (blockType === 1) {
      // RLE: 1 byte
      if (off + 1 > buf.length) {
        throw new ArchiveError("ARCHIVE_ZSTD_INVALID", "Truncated RLE block");
      }
      off += 1;
    } else if (blockType === 0 || blockType === 2) {
      if (off + blockSize > buf.length) {
        throw new ArchiveError("ARCHIVE_ZSTD_INVALID", "Truncated block content");
      }
      off += blockSize;
    } else {
      throw new ArchiveError("ARCHIVE_ZSTD_INVALID", "Reserved block type");
    }
    if (last) break;
  }

  if (hasChecksum) {
    if (off + 4 > buf.length) {
      throw new ArchiveError("ARCHIVE_ZSTD_INVALID", "Truncated content checksum");
    }
    off += 4;
  }

  if (off < buf.length) {
    throw new ArchiveError(
      "ARCHIVE_ZSTD_INVALID",
      "Trailing bytes or concatenated zstd frames"
    );
  }

  return {
    headerBytes,
    frameBytes: off,
    windowSize,
    frameContentSize,
    singleSegment,
    hasChecksum,
    dictId,
  };
}

export function compressTarZstd(tarBytes: Buffer): Buffer {
  if (tarBytes.length > MAX_UNCOMPRESSED_BYTES) {
    throw new ArchiveError(
      "PACK_TOTAL_TOO_LARGE",
      "Tar stream exceeds uncompressed cap"
    );
  }
  const compressed = zstdCompressSync(tarBytes, {
    params: {
      [zlibConstants.ZSTD_c_windowLog]: MAX_ZSTD_WINDOW_LOG,
      [zlibConstants.ZSTD_c_contentSizeFlag]: 1,
      [zlibConstants.ZSTD_c_checksumFlag]: 0,
      [zlibConstants.ZSTD_c_dictIDFlag]: 0,
    },
  });
  if (compressed.length > MAX_COMPRESSED_BYTES) {
    throw new ArchiveError(
      "PACK_COMPRESSED_TOO_LARGE",
      `Compressed archive ${compressed.length} exceeds ${MAX_COMPRESSED_BYTES}`
    );
  }
  // Validate our own output meets ingest profile.
  inspectSingleZstdFrame(compressed);
  return compressed;
}

/**
 * Decompress exactly one validated frame with streaming-style size bound.
 * Uses sync decompress after frame inspection (Node buffers the frame anyway);
 * abort if output would exceed MAX_UNCOMPRESSED_BYTES.
 */
export function decompressTarZstd(compressed: Buffer): Buffer {
  if (compressed.length > MAX_COMPRESSED_BYTES) {
    throw new ArchiveError(
      "ARCHIVE_COMPRESSED_TOO_LARGE",
      `Compressed archive exceeds ${MAX_COMPRESSED_BYTES}`
    );
  }
  const info = inspectSingleZstdFrame(compressed);
  if (
    info.frameContentSize !== null &&
    info.frameContentSize > MAX_UNCOMPRESSED_BYTES
  ) {
    throw new ArchiveError(
      "ARCHIVE_UNCOMPRESSED_TOO_LARGE",
      "Frame content size exceeds uncompressed cap"
    );
  }

  let out: Buffer;
  try {
    out = zstdDecompressSync(compressed, {
      params: {
        [zlibConstants.ZSTD_d_windowLogMax]: MAX_ZSTD_WINDOW_LOG,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/window|Window|memory/i.test(msg)) {
      throw new ArchiveError("ARCHIVE_ZSTD_WINDOW_TOO_LARGE", msg);
    }
    throw new ArchiveError("ARCHIVE_ZSTD_INVALID", `Zstd decompress failed: ${msg}`);
  }

  if (out.length > MAX_UNCOMPRESSED_BYTES) {
    throw new ArchiveError(
      "ARCHIVE_UNCOMPRESSED_TOO_LARGE",
      `Decompressed ${out.length} exceeds ${MAX_UNCOMPRESSED_BYTES}`
    );
  }
  if (
    info.frameContentSize !== null &&
    info.frameContentSize !== out.length
  ) {
    throw new ArchiveError(
      "ARCHIVE_ZSTD_INVALID",
      "Frame content size does not match decompressed length"
    );
  }
  return out;
}
