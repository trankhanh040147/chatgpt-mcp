/** Multiset helpers for attachment chip verification (ADR-006). */

export function multisetFromNames(names: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const raw of names) {
    const key = normalizeChipName(raw);
    if (!key) continue;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

export function normalizeChipName(name: string): string {
  return name.trim().toLowerCase();
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

export function verifyAddedChipsMatchExpected(
  before: readonly string[],
  after: readonly string[],
  expectedDisplayNames: readonly string[]
): { ok: true } | { ok: false; expected: string[]; added: string[] } {
  const added = multisetDifference(before, after);
  const expected = expectedDisplayNames.map(normalizeChipName);
  const addedMultiset = multisetFromNames(added);
  const expectedMultiset = multisetFromNames(expected);
  if (multisetEqual(addedMultiset, expectedMultiset)) {
    return { ok: true };
  }
  return {
    ok: false,
    expected: [...expectedMultiset.keys()],
    added,
  };
}
