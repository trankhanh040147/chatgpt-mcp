import type { Page } from "playwright";
import { selectors } from "./selectors.js";
import {
  multisetDifference,
  normalizeChipName,
  verifyAddedChipsMatchExpected,
} from "./attachment-match.js";
import { log } from "../logging/logger.js";
import type { HandoffTaskFile } from "../tasks/task.types.js";
import {
  classifyPrepareFailure,
  type PrepareFailureReason,
  type PrepareResult,
} from "../transport/types.js";

const UPLOAD_WAIT_MS = 30_000;
const CHIP_POLL_MS = 250;

/** Test hook: fail after N successful file uploads (E2E partial failure). */
function injectFailAfter(): number | null {
  const raw = process.env.HANDOFF_ATTACH_FAIL_AFTER?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Read attachment chip display names from composer staging area. */
export async function readAttachmentChips(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const names: string[] = [];
    const seen = new Set<string>();

    const push = (raw: string | null | undefined) => {
      const t = (raw ?? "").trim();
      if (!t || seen.has(t.toLowerCase())) return;
      seen.add(t.toLowerCase());
      names.push(t);
    };

    for (const btn of document.querySelectorAll("button[aria-label]")) {
      const label = btn.getAttribute("aria-label") ?? "";
      const m = label.match(/^Remove\s+(.+?)(?:\s+file)?$/i);
      if (m?.[1]) push(m[1]);
    }

    const composer =
      document.querySelector("#prompt-textarea")?.closest("form") ??
      document.querySelector("main form") ??
      document.body;

    for (const el of composer.querySelectorAll(
      '[data-testid*="file"], [data-testid*="attachment"], [class*="attachment"]'
    )) {
      const text = (el.textContent ?? "").trim();
      if (!text || text.length > 120) continue;
      if (/\.(ts|tsx|js|jsx|md|txt|json|py|go|rs|sql|yml|yaml|toml|html|css|sh)$/i.test(text)) {
        push(text.split("\n")[0]!.trim());
      }
    }

    return names;
  });
}

async function findFileInput(page: Page) {
  let input = page.locator(selectors.fileInput).first();
  if (await input.count().catch(() => 0)) {
    return input;
  }

  const menuBtn = page.locator(selectors.attachMenuButton).first();
  if (await menuBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await menuBtn.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(400);
  }

  input = page.locator(selectors.fileInput).first();
  if (await input.count().catch(() => 0)) {
    return input;
  }

  return null;
}

async function waitForAddedChips(
  page: Page,
  before: string[],
  expected: string[],
  deadlineMs: number
): Promise<{ after: string[]; added: string[] } | null> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const after = await readAttachmentChips(page);
    const added = multisetDifference(before, after);
    const verify = verifyAddedChipsMatchExpected(before, after, expected);
    if (verify.ok) {
      return { after, added };
    }
    if (added.length >= expected.length) {
      return { after, added };
    }
    await page.waitForTimeout(CHIP_POLL_MS);
  }
  return null;
}

async function removeChipByName(page: Page, displayName: string): Promise<boolean> {
  const escaped = displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const btn = page
    .locator(selectors.attachmentRemoveButton)
    .filter({ hasText: new RegExp(escaped, "i") })
    .first();
  if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
    await btn.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(300);
    return true;
  }

  const byLabel = page.locator(`button[aria-label="Remove ${displayName}"]`).first();
  if (await byLabel.isVisible({ timeout: 800 }).catch(() => false)) {
    await byLabel.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(300);
    return true;
  }
  return false;
}

export class ComposerAttachTransport {
  private baseline: string[] = [];
  private lastAdded: string[] = [];

  constructor(private readonly page: Page) {}

  async prepare(
    files: readonly HandoffTaskFile[],
    taskId: string
  ): Promise<PrepareResult> {
    if (files.length === 0) {
      return { ok: true, expected: [], added: [] };
    }

    const expected = files.map((f) => f.displayName);
    this.baseline = await readAttachmentChips(this.page);
    this.lastAdded = [];

    for (const f of files) {
      log({
        event: "RESOURCE_PREPARE_STARTED",
        component: "composer-attach",
        taskId,
        message: `fileId=${f.fileId} displayName=${f.displayName} sizeBytes=${f.sizeBytes} sha256=${f.sha256}`,
      });
    }

    const fileInput = await findFileInput(this.page);
    if (!fileInput) {
      const observed = await readAttachmentChips(this.page);
      return {
        ok: false,
        expected,
        observed,
        ...classifyPrepareFailure("INPUT_NOT_FOUND"),
      };
    }

    const failAfter = injectFailAfter();
    const paths = files.map((f) => f.snapshotPath);

    try {
      if (failAfter === 0) {
        throw new Error("HANDOFF_ATTACH_INJECT_FAIL");
      }

      if (failAfter != null && failAfter < files.length) {
        const partial = paths.slice(0, failAfter);
        if (partial.length > 0) {
          await fileInput.setInputFiles(partial);
        }
        throw new Error("HANDOFF_ATTACH_INJECT_FAIL");
      }

      await fileInput.setInputFiles(paths);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const afterPartial = await readAttachmentChips(this.page);
      this.lastAdded = multisetDifference(this.baseline, afterPartial);
      const reason: PrepareFailureReason =
        message.includes("rejected") || message.includes("not allowed")
          ? "UPLOAD_REJECTED"
          : "UPLOAD_TIMEOUT";
      log({
        event: "RESOURCE_PREPARE_FAILED",
        component: "composer-attach",
        taskId,
        message: `reason=${reason} retryable=${classifyPrepareFailure(reason).retryable}`,
      });
      return {
        ok: false,
        expected,
        observed: afterPartial,
        added: this.lastAdded,
        ...classifyPrepareFailure(reason),
      };
    }

    log({
      event: "RESOURCE_ATTACHED",
      component: "composer-attach",
      taskId,
      message: `count=${files.length}`,
    });

    const waited = await waitForAddedChips(
      this.page,
      this.baseline,
      expected,
      UPLOAD_WAIT_MS
    );
    const after = waited?.after ?? (await readAttachmentChips(this.page));
    this.lastAdded = waited?.added ?? multisetDifference(this.baseline, after);

    const verify = verifyAddedChipsMatchExpected(this.baseline, after, expected);
    if (!verify.ok) {
      log({
        event: "RESOURCE_PREPARE_FAILED",
        component: "composer-attach",
        taskId,
        message: "reason=CHIP_MISMATCH retryable=true",
      });
      return {
        ok: false,
        expected: verify.expected,
        observed: after.map(normalizeChipName),
        added: verify.added,
        ...classifyPrepareFailure("CHIP_MISMATCH"),
      };
    }

    log({
      event: "RESOURCE_VERIFIED",
      component: "composer-attach",
      taskId,
      message: `added=${this.lastAdded.join(",")}`,
    });

    return { ok: true, expected, added: this.lastAdded };
  }

  async cleanup(): Promise<void> {
    const toRemove = [...this.lastAdded];
    if (toRemove.length === 0) {
      const current = await readAttachmentChips(this.page);
      for (const name of multisetDifference(this.baseline, current)) {
        toRemove.push(name);
      }
    }

    for (const name of toRemove) {
      await removeChipByName(this.page, name);
    }
    this.lastAdded = [];
  }

  async isClean(): Promise<boolean> {
    const current = await readAttachmentChips(this.page);
    const orphan = multisetDifference(this.baseline, current);
    return orphan.length === 0;
  }
}
