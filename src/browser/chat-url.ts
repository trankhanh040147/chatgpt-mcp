/** Extract ChatGPT conversation id from a /c/<id> URL. */
export function chatIdFromUrl(url: string): string | undefined {
  return url.match(/\/c\/([a-z0-9-]+)/i)?.[1]?.toLowerCase();
}

export function sameWorkerChat(currentUrl: string, workerUrl: string): boolean {
  const current = chatIdFromUrl(currentUrl);
  const expected = chatIdFromUrl(workerUrl);
  return Boolean(current && expected && current === expected);
}
