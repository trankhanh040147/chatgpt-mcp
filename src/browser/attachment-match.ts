/** Multiset helpers for attachment chip verification (ADR-006). */

/** Above this count, ChatGPT DOM only exposes ~CHATGPT_DOM_CHIP_CAP chips. */
export const LARGE_BATCH_VERIFY_THRESHOLD = 15;
/** Observed max Remove-button chips in ChatGPT composer (CDP 2026-09). */
export const CHATGPT_DOM_CHIP_CAP = 20;

export function multisetFromNames(names: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const raw of names) {
    const key = normalizeChipName(raw);
    if (!key) continue;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

/** Strip ChatGPT numbered staging prefix ("file 1: a.ts" → "a.ts"). */
export function composerChipLabelToDisplayName(raw: string): string {
  const t = raw.trim();
  const m = t.match(/^file\s+\d+:\s*(.+)$/i);
  return m?.[1]?.trim() ?? t;
}

/** ChatGPT collision rename: restart.ts → restart(1).ts when a chip already exists. */
export function stripChatGptCollisionSuffix(filename: string): string {
  return filename.replace(/\(\d+\)(\.[^.]+)$/, "$1");
}

export function normalizeChipName(name: string): string {
  const base = composerChipLabelToDisplayName(name).trim();
  return stripChatGptCollisionSuffix(base).toLowerCase();
}

export function multisetEqual(
  a: Map<string, number>,
  b: Map<string, number>
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, va] of a) {
    if ((b.get(k) ?? 0) !== va) return false;
  }
  return true;
}

/** Names in `after` minus names in `before` (multiset difference). */
export function multisetDifference(
  before: readonly string[],
  after: readonly string[]
): string[] {
  const b = multisetFromNames(before);
  const a = multisetFromNames(after);
  const added: string[] = [];
  for (const [name, countAfter] of a) {
    const countBefore = b.get(name) ?? 0;
    const delta = countAfter - countBefore;
    for (let i = 0; i < delta; i += 1) {
      added.push(name);
    }
  }
  return added;
}

export type VerifyChipsResult =
  | { ok: true; mode: "exact" | "large_batch_subset" }
  | { ok: false; expected: string[]; added: string[] };

export function verifyAddedChipsMatchExpected(
  before: readonly string[],
  after: readonly string[],
  expectedDisplayNames: readonly string[]
): VerifyChipsResult {
  const added = multisetDifference(before, after);
  const expected = expectedDisplayNames.map(normalizeChipName);
  const addedMultiset = multisetFromNames(added);
  const expectedMultiset = multisetFromNames(expected);
  if (multisetEqual(addedMultiset, expectedMultiset)) {
    return { ok: true, mode: "exact" };
  }

  if (expectedDisplayNames.length > LARGE_BATCH_VERIFY_THRESHOLD) {
    const expectedSet = new Set(expected);
    const allAddedKnown = added.length > 0 && added.every((n) => expectedSet.has(n));
    const minVisible = Math.min(expectedDisplayNames.length, CHATGPT_DOM_CHIP_CAP);
    if (allAddedKnown && added.length >= minVisible) {
      return { ok: true, mode: "large_batch_subset" };
    }
  }

  return {
    ok: false,
    expected: [...expectedMultiset.keys()],
    added,
  };
}
