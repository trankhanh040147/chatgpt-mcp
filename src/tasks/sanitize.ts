/** ADR-005 — shared secret detector registry (not a DLP product). */

export type SecretDetectorId =
  | "sk"
  | "ghp"
  | "pem"
  | "jwt"
  | "bearer_tokenlike"
  | "password_assign"
  | "secret_assign";

export type SecretConfidence = "high" | "medium";

export interface SecretRedactionFileSummary {
  displayName: string;
  redactionCount: number;
  detectorIds: SecretDetectorId[];
}

/** Disclosure only — never includes matched secret values. */
export interface SecretRedactionDisclosure {
  filesRedacted: boolean;
  redactionCount: number;
  detectorIds: SecretDetectorId[];
  files?: SecretRedactionFileSummary[];
  /** Writeback UX: artifact bytes were modified for secret removal. */
  modifiedForSecretRemoval?: boolean;
}

export interface RedactTextResult {
  text: string;
  disclosure: SecretRedactionDisclosure;
}

export interface RedactBufferResult {
  buf: Buffer;
  disclosure: SecretRedactionDisclosure;
  /** Secrets indicated but buffer is not safely mutable text. */
  unsafeSecretHit: boolean;
}

const REDACT_PLACEHOLDER = "[REDACTED]";

const PROSE_BEARER_RHS = new Set([
  "field",
  "token",
  "header",
  "value",
  "auth",
  "authorization",
  "type",
  "scheme",
  "string",
  "literal",
  "option",
  "mode",
  "param",
  "parameter",
  "key",
  "secret",
  "password",
  "credential",
  "credentials",
]);

interface DetectorHit {
  id: SecretDetectorId;
  confidence: SecretConfidence;
  start: number;
  end: number;
}

interface DetectorDef {
  id: SecretDetectorId;
  confidence: SecretConfidence;
  find: (text: string) => DetectorHit[];
}

function emptyDisclosure(): SecretRedactionDisclosure {
  return { filesRedacted: false, redactionCount: 0, detectorIds: [] };
}

function mergeDetectorIds(
  into: Set<SecretDetectorId>,
  ids: readonly SecretDetectorId[]
): void {
  for (const id of ids) into.add(id);
}

export function mergeSecretRedactionDisclosures(
  parts: readonly SecretRedactionDisclosure[]
): SecretRedactionDisclosure | undefined {
  const meaningful = parts.filter((p) => p.redactionCount > 0 || p.filesRedacted);
  if (meaningful.length === 0) return undefined;
  const ids = new Set<SecretDetectorId>();
  let count = 0;
  const files: SecretRedactionFileSummary[] = [];
  let modified = false;
  for (const p of meaningful) {
    count += p.redactionCount;
    mergeDetectorIds(ids, p.detectorIds);
    if (p.files) files.push(...p.files);
    if (p.modifiedForSecretRemoval) modified = true;
  }
  return {
    filesRedacted: true,
    redactionCount: count,
    detectorIds: [...ids].sort(),
    files: files.length > 0 ? files : undefined,
    modifiedForSecretRemoval: modified || undefined,
  };
}

function isBase64UrlSegment(s: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(s) && s.length >= 4;
}

/** Structural JWT / compact JWS (three base64url segments; header decode when possible). */
export function isStructuralJwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  if (!parts.every(isBase64UrlSegment)) return false;
  if (parts[0].length < 8 || parts[1].length < 8) return false;
  try {
    const json = Buffer.from(parts[0], "base64url").toString("utf8");
    const header = JSON.parse(json) as Record<string, unknown>;
    return (
      header !== null &&
      typeof header === "object" &&
      ("alg" in header || "typ" in header)
    );
  } catch {
    return parts[0].length >= 10 && parts[1].length >= 10 && parts[2].length >= 8;
  }
}

/** Bearer RHS looks like a credential, not English prose ("field"). */
export function isBearerTokenLike(rhs: string): boolean {
  if (!rhs || rhs.length < 16) return false;
  const bare = rhs.replace(/^["']|["']$/g, "");
  if (PROSE_BEARER_RHS.has(bare.toLowerCase())) return false;
  if (isStructuralJwt(bare)) return true;
  if (!/^[A-Za-z0-9._\-+/=]+$/.test(bare)) return false;
  const hasDigit = /\d/.test(bare);
  const hasUpper = /[A-Z]/.test(bare);
  const hasLower = /[a-z]/.test(bare);
  return bare.length >= 20 && (hasDigit || (hasUpper && hasLower));
}

/** password=/secret= RHS looks credential-like (not docs placeholders). */
export function isCredentialAssignRhs(rhs: string): boolean {
  let value = rhs.trim();
  if (!value) return false;
  value = value.replace(/^["']|["']$/g, "");
  if (value.length < 8) return false;
  if (/^[<\[{]/.test(value)) return false;
  if (/^(?:\.{2,}|…+)$/.test(value)) return false;
  if (/redacted|placeholder|example|changeme|your[_-]?/i.test(value)) return false;
  if (/^(?:value|password|secret|xxx+|todo|none|null|undefined)$/i.test(value)) {
    return false;
  }
  return true;
}

function findRegexHits(
  text: string,
  id: SecretDetectorId,
  confidence: SecretConfidence,
  pattern: RegExp
): DetectorHit[] {
  const hits: DetectorHit[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    hits.push({ id, confidence, start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return hits;
}

const DETECTORS: DetectorDef[] = [
  {
    id: "sk",
    confidence: "high",
    find: (text) => findRegexHits(text, "sk", "high", /sk-[A-Za-z0-9_-]{10,}/g),
  },
  {
    id: "ghp",
    confidence: "high",
    find: (text) => findRegexHits(text, "ghp", "high", /ghp_[A-Za-z0-9]{20,}/g),
  },
  {
    id: "pem",
    confidence: "high",
    find: (text) =>
      findRegexHits(
        text,
        "pem",
        "high",
        /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/g
      ),
  },
  {
    id: "jwt",
    confidence: "high",
    find: (text) => {
      const hits: DetectorHit[] = [];
      const re = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (isStructuralJwt(m[0])) {
          hits.push({
            id: "jwt",
            confidence: "high",
            start: m.index,
            end: m.index + m[0].length,
          });
        }
      }
      return hits;
    },
  },
  {
    id: "bearer_tokenlike",
    confidence: "medium",
    find: (text) => {
      const hits: DetectorHit[] = [];
      const re = /\bBearer\s+(\S+)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const rhs = m[1] ?? "";
        if (!isBearerTokenLike(rhs)) continue;
        hits.push({
          id: "bearer_tokenlike",
          confidence: "medium",
          start: m.index,
          end: m.index + m[0].length,
        });
      }
      return hits;
    },
  },
  {
    id: "password_assign",
    confidence: "medium",
    find: (text) => {
      const hits: DetectorHit[] = [];
      const re = /password\s*=\s*(\S+)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (!isCredentialAssignRhs(m[1] ?? "")) continue;
        hits.push({
          id: "password_assign",
          confidence: "medium",
          start: m.index,
          end: m.index + m[0].length,
        });
      }
      return hits;
    },
  },
  {
    id: "secret_assign",
    confidence: "medium",
    find: (text) => {
      const hits: DetectorHit[] = [];
      const re = /secret\s*=\s*(\S+)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (!isCredentialAssignRhs(m[1] ?? "")) continue;
        hits.push({
          id: "secret_assign",
          confidence: "medium",
          start: m.index,
          end: m.index + m[0].length,
        });
      }
      return hits;
    },
  },
];

function collectHits(text: string): DetectorHit[] {
  const all: DetectorHit[] = [];
  // Run detectors only when their cheap markers appear (avoid multi-MiB scans).
  if (text.includes("sk-")) all.push(...DETECTORS.find((d) => d.id === "sk")!.find(text));
  if (text.includes("ghp_")) all.push(...DETECTORS.find((d) => d.id === "ghp")!.find(text));
  if (text.includes("BEGIN")) all.push(...DETECTORS.find((d) => d.id === "pem")!.find(text));
  if (text.includes(".") && text.includes("eyJ")) {
    all.push(...DETECTORS.find((d) => d.id === "jwt")!.find(text));
  }
  if (/Bearer/i.test(text)) {
    all.push(...DETECTORS.find((d) => d.id === "bearer_tokenlike")!.find(text));
  }
  if (/password\s*=/i.test(text)) {
    all.push(...DETECTORS.find((d) => d.id === "password_assign")!.find(text));
  }
  if (/secret\s*=/i.test(text)) {
    all.push(...DETECTORS.find((d) => d.id === "secret_assign")!.find(text));
  }
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  // Drop overlaps (prefer earlier / longer)
  const kept: DetectorHit[] = [];
  let cursor = -1;
  for (const hit of all) {
    if (hit.start < cursor) continue;
    kept.push(hit);
    cursor = hit.end;
  }
  return kept;
}

function disclosureFromHits(hits: readonly DetectorHit[]): SecretRedactionDisclosure {
  if (hits.length === 0) return emptyDisclosure();
  const ids = new Set<SecretDetectorId>();
  for (const h of hits) ids.add(h.id);
  return {
    filesRedacted: true,
    redactionCount: hits.length,
    detectorIds: [...ids].sort(),
  };
}

function applyRedactions(text: string, hits: readonly DetectorHit[]): string {
  if (hits.length === 0) return text;
  let out = "";
  let last = 0;
  for (const hit of hits) {
    out += text.slice(last, hit.start);
    out += REDACT_PLACEHOLDER;
    last = hit.end;
  }
  out += text.slice(last);
  return out;
}

/** Scan + redact UTF-8 text. Always safe for string inputs. */
export function redactSecretsInText(text: string): RedactTextResult {
  const hits = collectHits(text);
  return {
    text: applyRedactions(text, hits),
    disclosure: disclosureFromHits(hits),
  };
}

/**
 * Scan buffer as UTF-8 text and redact when safe.
 * NUL in the first 8 KiB → unsafe (caller should fail-closed if hits exist;
 * binary rejection usually happens before this).
 */
export function redactSecretsInBuffer(buf: Buffer): RedactBufferResult {
  if (buf.subarray(0, 8192).includes(0)) {
    const textProbe = buf.toString("utf8");
    const hits = collectHits(textProbe);
    return {
      buf,
      disclosure: disclosureFromHits(hits),
      unsafeSecretHit: hits.length > 0,
    };
  }
  const text = buf.toString("utf8");
  const { text: redacted, disclosure } = redactSecretsInText(text);
  if (disclosure.redactionCount === 0) {
    return { buf, disclosure, unsafeSecretHit: false };
  }
  return {
    buf: Buffer.from(redacted, "utf8"),
    disclosure,
    unsafeSecretHit: false,
  };
}

/** True if any registry detector fires (compat / diagnostics). */
export function containsKnownSecrets(text: string): boolean {
  return collectHits(text).length > 0;
}

/** Full-buffer scan (compat). Prefer redactSecretsInBuffer for attach/writeback. */
export function bufferContainsKnownSecrets(buf: Buffer): boolean {
  return containsKnownSecrets(buf.toString("utf8"));
}

export function sanitizeSecrets(text: string): string {
  return redactSecretsInText(text).text;
}

export function sanitizeContext<T extends Record<string, unknown>>(
  context: T | undefined
): T | undefined {
  if (!context) return undefined;
  const json = sanitizeSecrets(JSON.stringify(context));
  return JSON.parse(json) as T;
}

export function fileRedactionSummary(
  displayName: string,
  disclosure: SecretRedactionDisclosure
): SecretRedactionFileSummary | undefined {
  if (disclosure.redactionCount === 0) return undefined;
  return {
    displayName,
    redactionCount: disclosure.redactionCount,
    detectorIds: disclosure.detectorIds,
  };
}
