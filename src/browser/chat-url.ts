/** Extract ChatGPT conversation id from a /c/<id> URL. */
export function chatIdFromUrl(url: string): string | undefined {
  const id = url.match(/\/c\/([a-z0-9-]+)/i)?.[1]?.toLowerCase();
  if (!id) return undefined;
  // Reject transient routes (e.g. /c/web) — real chats look like UUIDs.
  if (id === "web" || id === "share" || !id.includes("-") || id.length < 20) {
    return undefined;
  }
  return id;
}

export function sameWorkerChat(currentUrl: string, workerUrl: string): boolean {
  const current = chatIdFromUrl(currentUrl);
  const expected = chatIdFromUrl(workerUrl);
  return Boolean(current && expected && current === expected);
}

/** Registry URL is a real ChatGPT /c/<uuid> — not onboarding placeholder text. */
export function isAssignableWorkerUrl(url: string | null | undefined): boolean {
  if (!url?.trim()) return false;
  if (/REPLACE_WORKER/i.test(url)) return false;
  return Boolean(chatIdFromUrl(url.trim()));
}
