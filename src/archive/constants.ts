/** v0.9 tar.zst pack caps (pack path only — artifacts[] keeps 32/128). */
export const MAX_ARCHIVE_MEMBERS = 100;
export const MAX_MEMBER_BYTES = 64 * 1024 * 1024;
export const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
/** 2^23 = 8 MiB — RFC 8878 interop / RFC 9659 HTTP coding number. */
export const MAX_ZSTD_WINDOW = 8 * 1024 * 1024;
export const MAX_ZSTD_WINDOW_LOG = 23;

export const TASK_ID_CHIP_RE = /^ho_[0-9A-HJKMNP-TV-Z]{26}$/;
