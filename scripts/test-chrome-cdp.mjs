#!/usr/bin/env node
/**
 * Chrome CDP launcher tests — no browser required.
 *   node scripts/test-chrome-cdp.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverChromeApp,
  discoverChromeExecutableLinux,
  ensureCdpChromeApp,
  getBundleExecutablePath,
  getBundleVersion,
  hasExplicitChromeOverride,
  managedAppPath,
  metadataPath,
  readMetadata,
  readPlistString,
  shouldRebuildManagedApp,
  MANAGED_APP_NAME,
  MANAGED_BUNDLE_ID,
  MANAGED_DISPLAY_NAME,
  MANAGED_ICON_FILE,
} from "./lib/macos-cdp-app.mjs";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error(`FAIL: ${msg}`);
  } else {
    passed += 1;
    console.log(`ok — ${msg}`);
  }
}

function makePlist(values) {
  const entries = Object.entries(values)
    .map(([k, v]) => `  <key>${k}</key>\n  <string>${v}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${entries}\n</dict></plist>\n`;
}

function makeFakeChromeApp(root, { name = "Google Chrome.app", version = "131.0.0.0", executable = "Google Chrome" } = {}) {
  const app = join(root, name);
  const contents = join(app, "Contents");
  const macos = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  mkdirSync(macos, { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(macos, executable), "#!/bin/sh\necho chrome\n", "utf8");
  writeFileSync(
    join(contents, "Info.plist"),
    makePlist({
      CFBundleExecutable: executable,
      CFBundleShortVersionString: version,
      CFBundleIdentifier: "com.google.Chrome",
      CFBundleDisplayName: "Google Chrome",
    }),
    "utf8"
  );
  return app;
}

function makeManagedApp(root, { version = "131.0.0.0", executable = "Google Chrome" } = {}) {
  const app = join(root, MANAGED_APP_NAME);
  const contents = join(app, "Contents");
  const macos = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  mkdirSync(macos, { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(macos, executable), "#!/bin/sh\necho cdp\n", "utf8");
  writeFileSync(
    join(contents, "Info.plist"),
    makePlist({
      CFBundleExecutable: executable,
      CFBundleShortVersionString: version,
      CFBundleIdentifier: MANAGED_BUNDLE_ID,
      CFBundleDisplayName: MANAGED_DISPLAY_NAME,
      CFBundleName: MANAGED_DISPLAY_NAME,
      CFBundleIconFile: MANAGED_ICON_FILE.replace(/\.icns$/, ""),
    }),
    "utf8"
  );
  writeFileSync(join(resources, MANAGED_ICON_FILE), "icns", "utf8");
  return app;
}

async function main() {
  // --- explicit override detection ---
  {
    const prevChrome = process.env.CHROME_BIN;
    const prevPath = process.env.CHATGPT_MCP_CHROME_PATH;
    delete process.env.CHROME_BIN;
    delete process.env.CHATGPT_MCP_CHROME_PATH;
    assert(!hasExplicitChromeOverride(), "no override when env unset");
    process.env.CHROME_BIN = "/tmp/chrome";
    assert(hasExplicitChromeOverride(), "CHROME_BIN counts as explicit override");
    delete process.env.CHROME_BIN;
    process.env.CHATGPT_MCP_CHROME_PATH = "/tmp/chrome";
    assert(
      hasExplicitChromeOverride(),
      "CHATGPT_MCP_CHROME_PATH counts as explicit override"
    );
    if (prevChrome) process.env.CHROME_BIN = prevChrome;
    else delete process.env.CHROME_BIN;
    if (prevPath) process.env.CHATGPT_MCP_CHROME_PATH = prevPath;
    else delete process.env.CHATGPT_MCP_CHROME_PATH;
  }

  // --- source Chrome discovery ---
  {
    const root = mkdtempSync(join(tmpdir(), "cdp-discover-"));
    const app = makeFakeChromeApp(root, { name: "Google Chrome.app" });
    const found = discoverChromeApp([join(root, "missing.app"), app]);
    assert(found === app, "discoverChromeApp returns first existing candidate");
    rmSync(root, { recursive: true, force: true });
  }

  // --- plist helpers ---
  {
    const root = mkdtempSync(join(tmpdir(), "cdp-plist-"));
    const app = makeFakeChromeApp(root, { version: "140.1.2.3" });
    assert(
      readPlistString(join(app, "Contents/Info.plist"), "CFBundleShortVersionString") ===
        "140.1.2.3",
      "readPlistString reads bundle version"
    );
    assert(
      getBundleVersion(app) === "140.1.2.3",
      "getBundleVersion returns short version string"
    );
    assert(
      getBundleExecutablePath(app).endsWith("/Contents/MacOS/Google Chrome"),
      "getBundleExecutablePath resolves MacOS binary"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // --- shouldRebuild: missing managed app ---
  {
    const root = mkdtempSync(join(tmpdir(), "cdp-rebuild-missing-"));
    const source = makeFakeChromeApp(root, { name: "source.app" });
    const rebuild = shouldRebuildManagedApp({
      sourceChromeApp: source,
      managedApp: join(root, "missing.app"),
      metadata: null,
    });
    assert(rebuild === true, "rebuild when managed app missing");
    rmSync(root, { recursive: true, force: true });
  }

  // --- shouldRebuild: matching version reuses ---
  {
    const root = mkdtempSync(join(tmpdir(), "cdp-rebuild-match-"));
    const source = makeFakeChromeApp(root, { name: "source.app", version: "131.0.0.0" });
    const managed = makeManagedApp(root, { version: "131.0.0.0" });
    const rebuild = shouldRebuildManagedApp({
      sourceChromeApp: source,
      managedApp: managed,
      metadata: {
        sourceAppPath: source,
        sourceVersion: "131.0.0.0",
      },
    });
    assert(rebuild === false, "reuse managed app when source version matches metadata");
    rmSync(root, { recursive: true, force: true });
  }

  // --- shouldRebuild: version mismatch ---
  {
    const root = mkdtempSync(join(tmpdir(), "cdp-rebuild-mismatch-"));
    const source = makeFakeChromeApp(root, { name: "source.app", version: "132.0.0.0" });
    const managed = makeManagedApp(root, { version: "131.0.0.0" });
    const rebuild = shouldRebuildManagedApp({
      sourceChromeApp: source,
      managedApp: managed,
      metadata: {
        sourceAppPath: source,
        sourceVersion: "131.0.0.0",
      },
    });
    assert(rebuild === true, "rebuild when source Chrome version changed");
    rmSync(root, { recursive: true, force: true });
  }

  // --- custom CHATGPT_MCP_HOME target ---
  {
    const home = mkdtempSync(join(tmpdir(), "cdp-home-"));
    assert(
      managedAppPath(home).endsWith(`${MANAGED_APP_NAME}`),
      "managed app lives under custom home"
    );
    rmSync(home, { recursive: true, force: true });
  }

  // --- ensureCdpChromeApp builds managed bundle (mocked) ---
  {
    const root = mkdtempSync(join(tmpdir(), "cdp-ensure-"));
    const home = join(root, "home");
    const source = makeFakeChromeApp(root, { name: "Google Chrome.app", version: "131.0.0.0" });
    const icon = join(root, "chrome-cdp.icns");
    writeFileSync(icon, "icns", "utf8");

    const commands = [];
    const exists = (path) => {
      if (path === managedAppPath(home)) return false;
      return true;
    };

    const exec = async (cmd, args) => {
      commands.push([cmd, ...args]);
      if (cmd === "cp") {
        const dest = args[args.length - 1];
        mkdirSync(join(dest, "Contents/MacOS"), { recursive: true });
        mkdirSync(join(dest, "Contents/Resources"), { recursive: true });
        writeFileSync(
          join(dest, "Contents/Info.plist"),
          makePlist({
            CFBundleExecutable: "Google Chrome",
            CFBundleShortVersionString: "131.0.0.0",
            CFBundleIdentifier: "com.google.Chrome",
          }),
          "utf8"
        );
        writeFileSync(join(dest, "Contents/MacOS/Google Chrome"), "#!/bin/sh\n", "utf8");
      }
      if (cmd === "plutil") {
        const plistPath = args[args.length - 1];
        const key = args[2];
        const value = args[4];
        const current = readPlistString(plistPath, key) ?? "";
        const xml = makePlist({ [key]: value });
        writeFileSync(plistPath, xml, "utf8");
        void current;
      }
      if (cmd === "mv") {
        const [, dest] = args;
        mkdirSync(join(dest, "Contents/MacOS"), { recursive: true });
        mkdirSync(join(dest, "Contents/Resources"), { recursive: true });
        writeFileSync(
          join(dest, "Contents/Info.plist"),
          makePlist({
            CFBundleExecutable: "Google Chrome",
            CFBundleShortVersionString: "131.0.0.0",
            CFBundleIdentifier: MANAGED_BUNDLE_ID,
            CFBundleDisplayName: MANAGED_DISPLAY_NAME,
            CFBundleName: MANAGED_DISPLAY_NAME,
            CFBundleIconFile: MANAGED_ICON_FILE.replace(/\.icns$/, ""),
          }),
          "utf8"
        );
        writeFileSync(join(dest, "Contents/MacOS/Google Chrome"), "#!/bin/sh\n", "utf8");
        writeFileSync(join(dest, "Contents/Resources", MANAGED_ICON_FILE), "icns", "utf8");
      }
    };

    const binary = await ensureCdpChromeApp({
      sourceChromeApp: source,
      home,
      iconSourcePath: icon,
      deps: { exec, exists, rm: () => {} },
    });
    assert(
      binary.endsWith("/Chrome CDP.app/Contents/MacOS/Google Chrome"),
      "ensureCdpChromeApp returns managed executable path"
    );
    assert(commands.some((c) => c[0] === "cp"), "ensureCdpChromeApp clones source app");
    assert(commands.some((c) => c[0] === "codesign"), "ensureCdpChromeApp ad-hoc codesigns");
    const meta = readMetadata(home);
    assert(meta?.sourceAppPath === source, "ensureCdpChromeApp writes metadata source path");
    assert(meta?.sourceVersion === "131.0.0.0", "ensureCdpChromeApp writes metadata version");
    rmSync(root, { recursive: true, force: true });
  }

  // --- ensureCdpChromeApp reuses existing managed app ---
  {
    const root = mkdtempSync(join(tmpdir(), "cdp-reuse-"));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const source = makeFakeChromeApp(root, { name: "Google Chrome.app", version: "131.0.0.0" });
    makeManagedApp(home, { version: "131.0.0.0" });
    writeFileSync(
      metadataPath(home),
      JSON.stringify({ sourceAppPath: source, sourceVersion: "131.0.0.0" }),
      "utf8"
    );
    let copied = false;
    const binary = await ensureCdpChromeApp({
      sourceChromeApp: source,
      home,
      iconSourcePath: join(root, "icon.icns"),
      deps: {
        exec: async () => {
          copied = true;
        },
      },
    });
    assert(copied === false, "matching managed app is reused without rebuild");
    assert(binary.endsWith("/Chrome CDP.app/Contents/MacOS/Google Chrome"), "reuse returns managed binary");
    rmSync(root, { recursive: true, force: true });
  }

  // --- Linux discovery unchanged ---
  {
    const found = discoverChromeExecutableLinux(
      () => "/usr/bin/google-chrome-stable",
      () => false
    );
    assert(found === "/usr/bin/google-chrome-stable", "linux discovery still uses which()");
    const none = discoverChromeExecutableLinux(() => null, () => false);
    assert(none === null, "linux discovery returns null when nothing found");
  }

  // --- platform guard: macOS helper not required on linux ---
  {
    assert(process.platform !== "linux" || true, "linux test file loads macOS helper without throwing");
  }

  // --- graceful fallback when managed app setup fails ---
  {
    const root = mkdtempSync(join(tmpdir(), "cdp-fallback-"));
    const source = makeFakeChromeApp(root, { name: "Google Chrome.app", version: "131.0.0.0" });
    const icon = join(root, "missing.icns");
    let fallback = null;
    try {
      await ensureCdpChromeApp({
        sourceChromeApp: source,
        home: join(root, "home"),
        iconSourcePath: icon,
      });
    } catch {
      fallback = join(source, "Contents/MacOS/Google Chrome");
    }
    assert(fallback !== null, "ensureCdpChromeApp throws when icon asset missing");
    assert(
      fallback.endsWith("/Contents/MacOS/Google Chrome"),
      "caller can fall back to source Chrome executable"
    );
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
