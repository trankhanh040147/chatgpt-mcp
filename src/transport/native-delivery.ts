import type { Page } from "playwright";
import { ComposerAttachTransport } from "../browser/composer-attach.js";
import type { ResourceDeliveryTarget } from "./types.js";

export function createNativeDeliveryTarget(page: Page): ResourceDeliveryTarget {
  return new ComposerAttachTransport(page);
}

export type { ResourceDeliveryTarget, PrepareResult } from "./types.js";
