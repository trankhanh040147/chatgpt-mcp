import { spawnSync } from "node:child_process";
import { platform } from "node:os";

/**
 * Open a file or URL with the platform default handler.
 * Shared by `gptmcp open` and `gptmcp help --web`.
 */
export function openExternal(target: string): boolean {
  if (platform() === "darwin") {
    const res = spawnSync("open", [target], { stdio: "ignore" });
    return (res.status ?? 1) === 0;
  }
  if (platform() === "win32") {
    // `start` is a cmd built-in — must go through the shell.
    const res = spawnSync("cmd", ["/c", "start", "", target], {
      stdio: "ignore",
      windowsHide: true,
    });
    return (res.status ?? 1) === 0;
  }
  const res = spawnSync("xdg-open", [target], { stdio: "ignore" });
  return (res.status ?? 1) === 0;
}
