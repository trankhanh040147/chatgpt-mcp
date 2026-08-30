const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /password\s*=\s*\S+/gi,
  /secret\s*=\s*\S+/gi,
];

function resetPattern(pattern: RegExp): void {
  pattern.lastIndex = 0;
}

/** Best-effort create-time guard — not a DLP boundary (ADR-005). */
export function containsKnownSecrets(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    resetPattern(pattern);
    if (pattern.test(text)) return true;
  }
  return false;
}

export function sanitizeSecrets(text: string): string {
  let sanitized = text;
  for (const pattern of SECRET_PATTERNS) {
    resetPattern(pattern);
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  return sanitized;
}

export function sanitizeContext<T extends Record<string, unknown>>(
  context: T | undefined
): T | undefined {
  if (!context) return undefined;
  const json = sanitizeSecrets(JSON.stringify(context));
  return JSON.parse(json) as T;
}
