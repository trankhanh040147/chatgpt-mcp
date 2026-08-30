/**
 * macOS Chrome CDP.app manager — clone installed Chrome into a dedicated bundle
 * with distinct Dock icon and bundle identifier.
 */
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MANAGED_APP_NAME = "Chrome CDP.app";
export const MANAGED_BUNDLE_ID = "dev.chatgpt-mcp.chrome-cdp";
export const MANAGED_DISPLAY_NAME = "Chrome CDP";
export const MANAGED_ICON_FILE = "chrome-cdp.icns";
export const METADATA_FILE = "chrome-cdp-app.json";

const DARWIN_CHROME_APP_CANDIDATES = [
  "/Applications/Google Chrome.app",
  join(homedir(), "Applications/Google Chrome.app"),
  "/Applications/Chromium.app",
];

export function hasExplicitChromeOverride(env = process.env) {
  return Boolean(
    env.CHATGPT_MCP_CHROME_PATH?.trim() || env.CHROME_BIN?.trim()
  );
}

export function resolveUserPath(raw) {
  const trimmed = String(raw).trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(join(homedir(), trimmed.slice(2)));
  return resolve(trimmed);
}

export function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return existsSync(path);
  }
}

export function discoverChromeApp(
  candidates = DARWIN_CHROME_APP_CANDIDATES,
  exists = existsSync
) {
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function managedAppPath(home) {
  return join(home, MANAGED_APP_NAME);
}

export function managedAppTmpPath(home) {
  return join(home, `${MANAGED_APP_NAME}.tmp`);
}

export function metadataPath(home) {
  return join(home, METADATA_FILE);
}

export function readPlistString(plistPath, key) {
  const xml = readFileSync(plistPath, "utf8");
  const re = new RegExp(
    `<key>${escapeRegExp(key)}</key>\\s*<string>([^<]*)</string>`
  );
  const match = xml.match(re);
  return match?.[1] ?? null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getBundleExecutableName(appPath) {
  const plist = join(appPath, "Contents/Info.plist");
  return readPlistString(plist, "CFBundleExecutable");
}

export function getBundleVersion(appPath) {
  const plist = join(appPath, "Contents/Info.plist");
  return (
    readPlistString(plist, "CFBundleShortVersionString") ??
    readPlistString(plist, "CFBundleVersion") ??
    null
  );
}

export function getBundleExecutablePath(appPath) {
  const executable = getBundleExecutableName(appPath);
  if (!executable) {
    throw new Error(`Could not resolve executable for ${appPath}`);
  }
  return join(appPath, "Contents/MacOS", executable);
}

export function readMetadata(home, exists = existsSync, readFile = readFileSync) {
  const path = metadataPath(home);
  if (!exists(path)) return null;
  try {
    return JSON.parse(readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeMetadata(home, metadata) {
  mkdirSync(home, { recursive: true });
  writeFileSync(metadataPath(home), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

export function iconDigest(iconSourcePath, readFile = readFileSync) {
  return createHash("sha256").update(readFile(iconSourcePath)).digest("hex");
}

export function shouldRebuildManagedApp({
  sourceChromeApp,
  managedApp,
  metadata,
  iconSourcePath,
  getVersion = getBundleVersion,
  exists = existsSync,
  readFile = readFileSync,
}) {
  if (!exists(managedApp)) return true;
  const sourceVersion = getVersion(sourceChromeApp);
  if (!sourceVersion) return true;
  if (!metadata) return true;
  if (metadata.sourceAppPath !== sourceChromeApp) return true;
  if (metadata.sourceVersion !== sourceVersion) return true;
  if (
    iconSourcePath &&
    metadata.iconDigest &&
    metadata.iconDigest !== iconDigest(iconSourcePath, readFile)
  ) {
    return true;
  }

  const plist = join(managedApp, "Contents/Info.plist");
  if (!exists(plist)) return true;
  if (readPlistString(plist, "CFBundleIdentifier") !== MANAGED_BUNDLE_ID) {
    return true;
  }
  if (readPlistString(plist, "CFBundleDisplayName") !== MANAGED_DISPLAY_NAME) {
    return true;
  }
  const iconPath = join(managedApp, "Contents/Resources", MANAGED_ICON_FILE);
  if (!exists(iconPath)) return true;
  const appIconPath = join(managedApp, "Contents/Resources/app.icns");
  if (!exists(appIconPath)) return true;
  return false;
}

export async function copyAppBundle(source, dest, exec = execFileAsync) {
  try {
    await exec("cp", ["-cR", source, dest]);
  } catch {
    await exec("cp", ["-R", source, dest]);
  }
}

export async function patchManagedBundle(managedApp, iconSourcePath, exec = execFileAsync) {
  const plistPath = join(managedApp, "Contents/Info.plist");
  const resourcesDir = join(managedApp, "Contents/Resources");
  mkdirSync(resourcesDir, { recursive: true });
  const iconBase = MANAGED_ICON_FILE.replace(/\.icns$/, "");
  const managedIconPath = join(resourcesDir, MANAGED_ICON_FILE);
  copyFileSync(iconSourcePath, managedIconPath);
  // Chrome also resolves AppIcon via app.icns — overwrite so Dock cannot fall back.
  copyFileSync(iconSourcePath, join(resourcesDir, "app.icns"));

  const replacements = [
    ["CFBundleDisplayName", MANAGED_DISPLAY_NAME],
    ["CFBundleName", MANAGED_DISPLAY_NAME],
    ["CFBundleIdentifier", MANAGED_BUNDLE_ID],
    ["CFBundleIconFile", iconBase],
    ["CFBundleIconName", iconBase],
  ];
  for (const [key, value] of replacements) {
    await exec("plutil", ["-replace", key, "-string", value, plistPath]);
  }
}

export async function stripCodesignDetritus(managedApp, exec = execFileAsync) {
  await exec("xattr", ["-cr", managedApp]);
}

export async function codesignManagedApp(managedApp, exec = execFileAsync) {
  await stripCodesignDetritus(managedApp, exec);
  await exec("codesign", ["--force", "--deep", "--sign", "-", managedApp]);
}

export async function ensureCdpChromeApp({
  sourceChromeApp,
  home,
  iconSourcePath,
  log = () => {},
  deps = {},
}) {
  const exists = deps.exists ?? existsSync;
  const exec = deps.exec ?? execFileAsync;
  const rm = deps.rm ?? rmSync;
  const managedApp = managedAppPath(home);
  const managedTmp = managedAppTmpPath(home);
  const metadata = readMetadata(home, exists, deps.readFile ?? readFileSync);

  if (
    !shouldRebuildManagedApp({
      sourceChromeApp,
      managedApp,
      metadata,
      iconSourcePath,
      getVersion: deps.getVersion ?? getBundleVersion,
      exists,
      readFile: deps.readFile ?? readFileSync,
    })
  ) {
    return getBundleExecutablePath(managedApp);
  }

  log(
    `Preparing ${MANAGED_APP_NAME} from ${basename(sourceChromeApp)} (${getBundleVersion(sourceChromeApp) ?? "unknown version"})`
  );

  mkdirSync(home, { recursive: true });
  if (exists(managedTmp)) rm(managedTmp, { recursive: true, force: true });
  await copyAppBundle(sourceChromeApp, managedTmp, exec);
  if (!exists(iconSourcePath)) {
    throw new Error(`Missing CDP icon asset: ${iconSourcePath}`);
  }
  await patchManagedBundle(managedTmp, iconSourcePath, exec);
  await codesignManagedApp(managedTmp, exec);

  if (exists(managedApp)) rm(managedApp, { recursive: true, force: true });
  await exec("mv", [managedTmp, managedApp]);

  writeMetadata(home, {
    sourceAppPath: sourceChromeApp,
    sourceVersion: getBundleVersion(sourceChromeApp),
    iconDigest: iconDigest(iconSourcePath, deps.readFile ?? readFileSync),
    managedAppPath: managedApp,
    updatedAt: new Date().toISOString(),
  });

  return getBundleExecutablePath(managedApp);
}

export function discoverChromeExecutableLinux(which, isExec) {
  const names = [
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
  ];
  for (const name of names) {
    const found = which(name);
    if (found) return found;
  }
  const paths = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
  for (const p of paths) {
    if (isExec(p)) return p;
  }
  return null;
}

export function discoverChromeExecutableDarwinFallback(isExec) {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const c of candidates) {
    if (isExec(c)) return c;
  }
  return null;
}

export function which(cmd) {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [cmd], {
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}
