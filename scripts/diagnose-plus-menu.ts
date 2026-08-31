/**
 * Live UI probe: composer + menu and Cursor candidates (no broker token).
 * Writes logs/plus-menu-dom.json and logs/diagnose-plus-menu.png.
 *
 * Usage: npm run diagnose:plus-menu
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const CDP = process.env.CHATGPT_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const LOG_DIR = process.env.LOG_DIR ?? join(process.cwd(), "logs");
const OUT_JSON = join(LOG_DIR, "plus-menu-dom.json");
const OUT_PNG = join(LOG_DIR, "diagnose-plus-menu.png");

/** Browser-side probe (string) — avoid tsx __name injection in page.evaluate. */
const PROBE_SCRIPT = `
(() => {
  const leaves = [];
  const nodes = document.querySelectorAll("span, div, button, li, a, p");
  for (let i = 0; i < nodes.length; i++) {
    const h = nodes[i];
    const kids = h.children;
    if (kids.length > 0) continue;
    const t = (h.innerText || "").trim();
    if (!t) continue;
    leaves.push({ el: h, text: t });
  }

  function bbox(el) {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  function chain(el) {
    const out = [];
    let p = el.parentElement;
    for (let d = 0; d < 8 && p; d++) {
      const role = p.getAttribute("role");
      out.push(p.tagName.toLowerCase() + (role ? "[role=" + role + "]" : ""));
      p = p.parentElement;
    }
    return out;
  }

  function cursorEntry(el) {
    const h = el;
    const r = h.getBoundingClientRect();
    return {
      tag: h.tagName,
      role: h.getAttribute("role"),
      testid: h.getAttribute("data-testid"),
      class: (h.className || "").slice(0, 80),
      visible: h.offsetParent !== null,
      bbox: bbox(h),
      ancestorChain: chain(h),
    };
  }

  const cursorLeaves = [];
  const addPhotosLeaves = [];
  for (let i = 0; i < leaves.length; i++) {
    const item = leaves[i];
    if (item.text === "Cursor") cursorLeaves.push(cursorEntry(item.el));
    if (item.text === "Add photos & files") {
      addPhotosLeaves.push({ tag: item.el.tagName, bbox: bbox(item.el) });
    }
  }

  return {
    url: location.href,
    popperWrappers: document.querySelectorAll("[data-radix-popper-content-wrapper]").length,
    roleMenu: document.querySelectorAll("[role='menu']").length,
    roleDialog: document.querySelectorAll("[role='dialog']").length,
    cursorLeaves,
    addPhotosLeaves,
  };
})()
`;

const PROBE_AFTER_PLUS_SCRIPT = `
((plusBox) => {
  const leaves = [];
  const nodes = document.querySelectorAll("span, div, button, li, a, p");
  for (let i = 0; i < nodes.length; i++) {
    const h = nodes[i];
    if (h.children.length > 0) continue;
    const t = (h.innerText || "").trim();
    if (!t) continue;
    leaves.push({ el: h, text: t });
  }

  function bbox(el) {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  function chain(el) {
    const out = [];
    let p = el.parentElement;
    for (let d = 0; d < 8 && p; d++) {
      const role = p.getAttribute("role");
      out.push(p.tagName.toLowerCase() + (role ? "[role=" + role + "]" : ""));
      p = p.parentElement;
    }
    return out;
  }

  function distToPlus(r) {
    if (!plusBox) return null;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const px = plusBox.x + plusBox.width / 2;
    const py = plusBox.y + plusBox.height / 2;
    return Math.hypot(cx - px, cy - py);
  }

  const cursorLeaves = [];
  for (let i = 0; i < leaves.length; i++) {
    if (leaves[i].text !== "Cursor") continue;
    const h = leaves[i].el;
    const r = h.getBoundingClientRect();
    const likelySidebar = r.x < 280;
    const dist = distToPlus(r);
    cursorLeaves.push({
      tag: h.tagName,
      role: h.getAttribute("role"),
      testid: h.getAttribute("data-testid"),
      visible: h.offsetParent !== null,
      bbox: bbox(h),
      likelySidebar,
      distToPlus: dist,
      ancestorChain: chain(h),
    });
  }

  const ranked = cursorLeaves.slice().sort(function (a, b) {
    if (a.likelySidebar !== b.likelySidebar) return a.likelySidebar ? 1 : -1;
    return (a.distToPlus || 1e9) - (b.distToPlus || 1e9);
  });

  const addPhotosLeaves = [];
  for (let i = 0; i < leaves.length; i++) {
    if (leaves[i].text !== "Add photos & files") continue;
    const h = leaves[i].el;
    addPhotosLeaves.push({ tag: h.tagName, bbox: bbox(h) });
  }

  return {
    url: location.href,
    popperWrappers: document.querySelectorAll("[data-radix-popper-content-wrapper]").length,
    roleMenu: document.querySelectorAll("[role='menu']").length,
    roleDialog: document.querySelectorAll("[role='dialog']").length,
    cursorLeaves,
    cursorMenuPick: ranked[0] || null,
    addPhotosLeaves,
  };
})
`;

async function main(): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true });

  const browser = await chromium.connectOverCDP(CDP, { noDefaults: true });
  const context = browser.contexts()[0];
  if (!context) throw new Error("no browser context");

  const page = await context.newPage();
  await page.goto("https://chatgpt.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(2000);

  const plus = page.locator('[data-testid="composer-plus-btn"]').first();
  const plusVisible = await plus.isVisible().catch(() => false);
  const plusBox = plusVisible ? await plus.boundingBox() : null;

  const before = await page.evaluate(PROBE_SCRIPT);

  let afterPlus: Record<string, unknown> | null = null;

  if (!plusVisible) {
    console.log("composer-plus-btn not visible — login in CDP Chrome first");
  } else {
    await plus.click({ timeout: 5000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: OUT_PNG, fullPage: false });
    afterPlus = (await page.evaluate(
      PROBE_AFTER_PLUS_SCRIPT,
      plusBox
    )) as Record<string, unknown>;
  }

  const report = {
    cdp: CDP,
    timestamp: new Date().toISOString(),
    plusBox,
    beforeClick: before,
    afterClick: afterPlus,
    screenshot: plusVisible ? OUT_PNG : null,
  };

  writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, json: OUT_JSON, screenshot: OUT_PNG }, null, 2));

  await page.close();
  console.log("done — diagnostic tab closed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
