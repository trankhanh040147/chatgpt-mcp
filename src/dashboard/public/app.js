const $ = (id) => (typeof document !== "undefined" ? document.getElementById(id) : null);

const healthPill = $("health-pill");
const updatedEl = $("updated");
const clock = $("clock");
const planeKv = $("plane-kv");
const workersEl = $("workers");
const workerCount = $("worker-count");
const tasksEl = $("tasks");
const taskCount = $("task-count");
const hintsEl = $("hints");
const cmdsEl = $("cmds");
const cmdsDownEl = $("cmds-down");
const liveEl = $("live");
const unreachableEl = $("unreachable");
const lastSeenEl = $("last-seen");
const drawer = $("drawer");
const drawerBackdrop = $("drawer-backdrop");
const drawerBody = $("drawer-body");
const drawerContent = $("drawer-content");
const drawerUsage = $("drawer-usage");
const loadContentBtn = $("load-content");
const failTaskBtn = $("fail-task");
const drawerClose = $("drawer-close");
const btnRecover = $("btn-recover");
const btnRecoverQueued = $("btn-recover-queued");
const opsResultEl = $("ops-result");
const btnTopology = $("btn-topology");
const topologyEl = $("topology");
const opsModal = $("ops-modal");
const opsForm = $("ops-form");
const opsModalTitle = $("ops-modal-title");
const opsModalPreview = $("ops-modal-preview");
const opsModalError = $("ops-modal-error");
const opsConfirmPhrase = $("ops-confirm-phrase");
const opsConfirmInput = $("ops-confirm-input");
const opsConfirmGo = $("ops-confirm-go");
const opsConfirmBlock = $("ops-confirm-block");
const opsUrlBlock = $("ops-url-block");
const opsUrlInput = $("ops-url-input");
const btnAddWorker = $("btn-add-worker");
const workerAlert = $("worker-alert");

// Headline triage elements
const headlinePanel = $("headline-panel");
const headlineStatus = $("headline-status");
const headlineTitle = $("headline-title");
const headlineSummary = $("headline-summary");
const btnHeadlineRecover = $("btn-headline-recover");
const btnHeadlineOverflow = $("btn-headline-overflow");
const headlineOverflowMenu = $("headline-overflow-menu");
const btnHeadlineRecoverQueued = $("btn-headline-recover-queued");

const COMMANDS = [
  "curl -s http://127.0.0.1:8787/health | jq",
  "make doctor",
  "npm run recover",
  "./scripts/start-broker-stack.sh",
];

let lastOkAt = null;
let lastBrokerOpsPort = 18788;
let selectedTaskId = null;
let selectedTaskStatus = null;
let opsCsrf = null;
let pendingOps = null; // { kind, phrase, planToken?, taskId?, workerId?, workerUrl?, mode? }
let opsInFlight = false;
let lastTaxonomy = null;
const optimisticBusyWorkers = new Set();
export const openDebugWorkers = new Set();
/** Ignore `<details>` toggle events while replacing worker card DOM (poll re-render). */
let suppressWorkerDebugToggle = false;

export function isWorkerDebugOpen(workerId) {
  return openDebugWorkers.has(workerId);
}

export function setWorkerDebugOpen(workerId, open) {
  if (open) openDebugWorkers.add(workerId);
  else openDebugWorkers.delete(workerId);
}

export function deriveWorkerCountState(liveCount, healthyCount) {
  if (liveCount === 0) {
    return { text: "0 registered", kind: "warn" };
  }
  if (healthyCount === 0) {
    return { text: `${liveCount} registered · 0 healthy`, kind: "bad" };
  }
  if (healthyCount < liveCount) {
    return { text: `${liveCount} registered · ${healthyCount} healthy`, kind: "warn" };
  }
  return { text: `${liveCount} registered · ${healthyCount} healthy`, kind: "ok" };
}

export function age(iso) {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  return `${Math.round(ms / 3_600_000)}h`;
}

export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function formatEstimatedTokens(value) {
  if (value == null || !Number.isFinite(value)) return null;
  if (value >= 1_000_000) return `≈${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `≈${(value / 1_000).toFixed(1)}k`;
  return `≈${Math.round(value)}`;
}

export function formatEstimatedMoney(value) {
  if (value == null || !Number.isFinite(value)) return null;
  if (value > 0 && value < 0.01) return "<$0.01";
  if (value === 0) return "≈$0.00";
  return `≈$${value.toFixed(2)}`;
}

function metricIcon(name) {
  if (name !== "tokens" && name !== "dollar" && name !== "clock") return "";
  return `<svg class="metric-icon" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

function renderMetricChip({ kind, value, compact = false, ariaLabel, title }) {
  if (value == null) return `<span class="metric-empty">—</span>`;
  const money = kind === "money";
  const classes = [
    "metric-chip",
    money ? "metric-chip--money" : "",
    compact ? "metric-chip--compact" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<span class="${classes}" aria-label="${escapeHtml(ariaLabel || value)}"${titleAttr}>
    ${metricIcon(money ? "dollar" : "tokens")}
    <span class="metric-chip__value">${escapeHtml(value)}</span>
    <span class="metric-chip__unit">${money ? "est." : "tok"}</span>
  </span>`;
}

function renderMetricPair(u, showReference) {
  if (!u || !u.isEstimated) return `<span class="metric-empty">—</span>`;
  const tok = formatEstimatedTokens(u.totalTokens);
  const refUsd = u.referenceCostUsd ?? u.apiEquivalentAvoidedUsd;
  const usd = showReference ? formatEstimatedMoney(refUsd) : null;
  if (!showReference) {
    return renderMetricChip({
      kind: "tokens",
      value: tok,
      compact: true,
      ariaLabel: `Estimated tokens ${tok}`,
      title: "Estimated from stored prompt and result text",
    });
  }
  const label = `Usage estimate: ${tok || "—"} tokens; reference ${usd || "—"}`;
  return `<div class="metric-pair" aria-label="${escapeHtml(label)}">
    ${renderMetricChip({
      kind: "tokens",
      value: tok,
      compact: true,
      ariaLabel: `Estimated tokens ${tok}`,
    })}
    ${renderMetricChip({
      kind: "money",
      value: usd,
      compact: true,
      ariaLabel: `Reference API cost ${usd}`,
      title: "Reference API cost for the configured comparison scenario — not ChatGPT billing or savings",
    })}
  </div>`;
}

function metricWindow(text, withClock = false) {
  return `<span class="metric-window">${
    withClock ? metricIcon("clock") : ""
  }${escapeHtml(text)}</span>`;
}

export function middleTruncate(id, head = 10, tail = 5) {
  if (!id) return "—";
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function healthStateClass(state) {
  switch (state) {
    case "READY":
    case "OK":
      return "ok";
    case "DEGRADED":
    case "STARTING":
    case "ACTION_REQUIRED":
    case "SETUP":
      return "warn";
    case "BLOCKED":
    case "OFFLINE":
    case "ERROR":
    case "DOWN":
      return "bad";
    default:
      return "warn";
  }
}

export function operatorStateClass(state) {
  return healthStateClass(state);
}

export function mergeWorkerRows(baseWorkers, healthWorkers) {
  const byId = new Map((healthWorkers ?? []).map((w) => [w.id, w]));
  return (baseWorkers ?? []).map((w) => ({
    ...w,
    ...(byId.get(w.id) ?? {}),
  }));
}

export function formatConditions(conditions) {
  if (!conditions?.length) return "";
  return conditions
    .map((c) => `${c.type}:${c.status} (${c.reason})`)
    .join(" · ");
}

export function workerNeedsUrlAssign(w) {
  if (w.chatAccessDenied) return true;
  if (w.recommendedAction === "ASSIGN_URL") return true;
  for (const c of w.conditions ?? []) {
    if (c.type === "BINDING" && c.status === "FALSE") return true;
    if (c.type === "URL" && c.status === "FALSE") return true;
  }
  return false;
}

export function workerOpsBlocked(w) {
  return Boolean(w.activeOperation || w.inFlightTaskId);
}

// ==========================================================================
// System status taxonomy: OK, DEGRADED, SETUP, DOWN
// ==========================================================================
export function deriveSystemTaxonomy(health, workers) {
  if (!health || !health.ok) return "DOWN";
  const live = (workers ?? []).filter((w) => w.id !== "default");
  if (live.length === 0) return "SETUP";

  const hasIssues = live.some((w) => {
    if (!w.healthy) return true;
    if (w.pidAlive === false) return true;
    if (w.heartbeatStale) return true;
    const op = w.operatorState ?? w.healthState;
    if (op === "DEGRADED" || op === "ACTION_REQUIRED" || op === "ERROR" || op === "BLOCKED" || op === "OFFLINE") {
      return true;
    }
    return false;
  });

  return hasIssues ? "DEGRADED" : "OK";
}

// ==========================================================================
// deriveRecommendedAction(worker, systemState) — FRONTEND ONLY
// Single source for: card primary action, headline recommended block, attention sorting
// Output: { label, actionKey, reason, priority, destructive }
// ==========================================================================
export function deriveRecommendedAction(w, systemState = {}) {
  const brokerReachable = systemState.brokerReachable !== false;
  const opState = w.operatorState ?? w.healthState ?? "UNKNOWN";
  const action = w.operatorAction;
  const sessionLost = w.status === "SESSION_LOST";
  const deadPid = w.pidAlive === false;
  const hbStale = Boolean(w.heartbeatStale);

  // 1. Ghost worker (not in registry)
  if (w.inRegistry === false) {
    return {
      label: "Remove…",
      actionKey: "remove",
      reason: "Ghost worker in DB only",
      priority: 95,
      destructive: true,
    };
  }

  // 2. In-flight stuck task
  if (w.stuckInFlightTaskId) {
    return {
      label: "Clear stuck",
      actionKey: "clear-stuck",
      reason: `Stuck handoff ${middleTruncate(w.stuckInFlightTaskId)}`,
      priority: 90,
      destructive: false,
    };
  }

  // 3. Broker unreachable
  if (!brokerReachable) {
    return {
      label: "Start broker",
      actionKey: "start-broker",
      reason: "Browser broker unreachable",
      priority: 85,
      destructive: false,
    };
  }

  // 4. Chat access denied
  if (w.chatAccessDenied) {
    return {
      label: "Assign URL…",
      actionKey: "assign",
      reason: "CDP Chrome cannot open saved chat URL",
      priority: 80,
      destructive: false,
    };
  }

  // 5. Session lost
  if (sessionLost) {
    return {
      label: "Recreate chat…",
      actionKey: "kill",
      reason: "Chat session lost in browser",
      priority: 80,
      destructive: true,
    };
  }

  // 6. Dead PID
  if (deadPid) {
    return {
      label: "Recreate chat…",
      actionKey: "kill",
      reason: "Worker process died",
      priority: 75,
      destructive: true,
    };
  }

  // 7. Rotation failed
  if (w.readinessReason === "ROTATION_FAILED") {
    if (workerNeedsUrlAssign(w)) {
      return {
        label: "Assign URL…",
        actionKey: "assign",
        reason: "Rotation failed on binding step",
        priority: 70,
        destructive: false,
      };
    }
    return {
      label: "New chat…",
      actionKey: "create",
      reason: "Rotation failed — open fresh chat",
      priority: 70,
      destructive: false,
    };
  }

  // 8. MCP approval required / Continue
  if (
    action === "CONTINUE" ||
    w.readinessReason === "MCP_APPROVAL_REQUIRED" ||
    w.readinessReason === "CONSENT_REQUIRED" ||
    w.recommendedAction === "RETRY_VERIFY"
  ) {
    return {
      label: "Continue",
      actionKey: "continue",
      reason: "Approve MCP writes in ChatGPT, then Continue",
      priority: 65,
      destructive: false,
    };
  }

  // 9. Assign URL needed
  if (action === "ASSIGN_URL" || w.recommendedAction === "ASSIGN_URL" || workerNeedsUrlAssign(w)) {
    return {
      label: "Assign URL…",
      actionKey: "assign",
      reason: "Assign active chat URL from CDP Chrome",
      priority: 60,
      destructive: false,
    };
  }

  // 10. New Chat needed
  if (action === "NEW_CHAT") {
    return {
      label: "New chat…",
      actionKey: "create",
      reason: "Open fresh worker chat tab",
      priority: 55,
      destructive: false,
    };
  }

  // 11. Recreate chat needed
  if (action === "RECREATE_CHAT" || w.recommendedAction === "RECREATE_CHAT") {
    return {
      label: "Recreate chat…",
      actionKey: "kill",
      reason: "Recreate worker chat session",
      priority: 55,
      destructive: true,
    };
  }

  // 12. Stale heartbeat
  if (hbStale) {
    return {
      label: "Recreate chat…",
      actionKey: "kill",
      reason: "Heartbeat stale",
      priority: 50,
      destructive: true,
    };
  }

  // 13. Active operation in flight
  if (
    opState === "STARTING" ||
    (w.activeOperation &&
      w.activeOperation.state !== "SUCCEEDED" &&
      w.activeOperation.state !== "FAILED")
  ) {
    return {
      label: "Connecting…",
      actionKey: "none",
      reason: `${w.activeOperation?.kind ?? "Op"} ${w.activeOperation?.state ?? "running"}`,
      priority: 40,
      destructive: false,
    };
  }

  // 14. Healthy worker
  if (w.healthy) {
    if (w.chatUrl) {
      return {
        label: "Open worker chat",
        actionKey: "open-chat",
        reason: "Worker ready for handoffs",
        priority: 0,
        destructive: false,
      };
    }
    return {
      label: "Ready",
      actionKey: "none",
      reason: "Worker ready for handoffs",
      priority: 0,
      destructive: false,
    };
  }

  // Degraded / Unknown fallback
  return {
    label: "Recreate chat…",
    actionKey: "kill",
    reason: w.operatorDetail || w.error || "Worker degraded",
    priority: 30,
    destructive: true,
  };
}

// ==========================================================================
// Attention sorting: Unhealthy first, then ACTION_REQUIRED, then healthy
// ==========================================================================
export function sortWorkersByAttention(workers, systemState = {}) {
  const live = (workers ?? []).filter((w) => w.id !== "default");
  return [...live].sort((a, b) => {
    const actA = deriveRecommendedAction(a, systemState);
    const actB = deriveRecommendedAction(b, systemState);
    if (actA.priority !== actB.priority) {
      return actB.priority - actA.priority;
    }
    if (Boolean(a.healthy) !== Boolean(b.healthy)) {
      return a.healthy ? 1 : -1;
    }
    return a.id.localeCompare(b.id);
  });
}

// ==========================================================================
// Incident summary generator for headline
// Stale heartbeat + dead PID = same incident — summarize once
// Queue count belongs to metrics column, not incident sentence
// ==========================================================================
export function summarizeIncidents(workers, systemState = {}) {
  const live = (workers ?? []).filter((w) => w.id !== "default");
  if (live.length === 0) {
    return "No workers registered · start broker stack to connect";
  }

  const brokerReachable = systemState.brokerReachable !== false;
  if (!brokerReachable) {
    return "Browser broker unreachable — Chrome CDP or broker process down";
  }

  const issues = [];
  for (const w of live) {
    const deadPid = w.pidAlive === false;
    const hbStale = Boolean(w.heartbeatStale);

    if (w.inRegistry === false) {
      issues.push(`${w.id} not in registry`);
    } else if (w.stuckInFlightTaskId) {
      issues.push(`${w.id} handoff stuck`);
    } else if (w.chatAccessDenied) {
      issues.push(`${w.id} chat access denied`);
    } else if (w.status === "SESSION_LOST") {
      issues.push(`${w.id} session lost`);
    } else if (deadPid && hbStale) {
      // Group dead PID and stale heartbeat into ONE incident sentence
      issues.push(`${w.id} lost its process`);
    } else if (deadPid) {
      issues.push(`${w.id} process dead`);
    } else if (hbStale) {
      issues.push(`${w.id} heartbeat stale`);
    } else if (w.readinessReason === "ROTATION_FAILED") {
      issues.push(`${w.id} rotation failed`);
    } else if (w.readinessReason === "MCP_APPROVAL_REQUIRED") {
      issues.push(`${w.id} MCP approval needed`);
    } else if (w.readinessReason === "RESTART_REQUIRED") {
      issues.push(`${w.id} restart required`);
    } else if (!w.healthy) {
      issues.push(`${w.id} degraded`);
    }
  }

  if (issues.length === 0) {
    return "All workers ready for handoffs";
  }

  return issues.slice(0, 3).join(" · ") + (issues.length > 3 ? " …" : "");
}

// ==========================================================================
// Headline Rendering
// ==========================================================================
function renderHeadline(taxonomy, workers, health, healthBody) {
  if (!headlinePanel) return;

  const live = (workers ?? []).filter((w) => w.id !== "default");
  const healthyN = live.filter((w) => w.healthy).length;
  const systemState = {
    brokerReachable: healthBody?.brokerReachable,
    brokerConfigured: healthBody?.brokerConfigured,
    brokerOpsPort: healthBody?.brokerOpsPort ?? lastBrokerOpsPort,
  };

  // Trigger one-shot status pulse on headline when taxonomy changes
  if (lastTaxonomy && lastTaxonomy !== taxonomy) {
    headlinePanel.classList.remove("headline-pulse");
    void headlinePanel.offsetWidth;
    headlinePanel.classList.add("headline-pulse");
  }
  lastTaxonomy = taxonomy;

  // Status badge
  const taxClass = healthStateClass(taxonomy);
  if (headlineStatus) {
    headlineStatus.textContent = taxonomy;
    headlineStatus.className = `headline-status pill ${taxClass}`;
  }

  // Availability title
  if (headlineTitle) {
    if (taxonomy === "DOWN") {
      headlineTitle.textContent = "Control plane unreachable";
    } else if (taxonomy === "SETUP") {
      headlineTitle.textContent = "0 workers registered";
    } else if (taxonomy === "OK") {
      headlineTitle.textContent = `All ${live.length} workers available`;
    } else {
      headlineTitle.textContent = `${healthyN} of ${live.length} workers available`;
    }
  }

  // Incident summary sentence
  if (headlineSummary) {
    headlineSummary.textContent = summarizeIncidents(live, systemState);
  }

  // Recover buttons state
  if (btnHeadlineRecover) {
    btnHeadlineRecover.textContent = opsInFlight ? "Recovering…" : "Recover workers";
    btnHeadlineRecover.disabled = opsInFlight;
    if (opsInFlight) btnHeadlineRecover.classList.add("btn-busy");
    else btnHeadlineRecover.classList.remove("btn-busy");
  }
  if (btnHeadlineRecoverQueued) {
    btnHeadlineRecoverQueued.disabled = opsInFlight;
  }
}

// ==========================================================================
// Compact Control plane KV metrics
// ==========================================================================
function renderPlane(health, workersBody) {
  if (!planeKv) return;
  const stats = workersBody.lastReapStats;
  const tickAge = age(health.lastReapAt);
  const tickStale =
    health.lastReapAt && Date.now() - Date.parse(health.lastReapAt) > 30_000;
  const totals =
    health.usageTotals?.last24h ?? workersBody.usageTotals?.last24h;
  const allTime =
    health.usageTotals?.allTime ?? workersBody.usageTotals?.allTime;
  const showRef =
    health.referencePricingEnabled === true ||
    health.costConfig?.referencePricingEnabled === true;

  const tok24 = formatEstimatedTokens(totals?.estimatedTokens);
  const usd24 = formatEstimatedMoney(totals?.apiEquivalentAvoidedUsd);
  const scenario =
    health.costConfig?.scenarioDisplayName || "configured scenario";

  const items = [
    {
      label: "Lease reaper",
      value: health.reaper ? "ON" : "OFF",
      kind: health.reaper ? "ok" : "warn",
    },
    {
      label: "Last tick",
      value: health.lastReapAt ? `${tickAge} ago` : "—",
      kind: tickStale ? "warn" : "ok",
    },
    {
      label: "Timed out / Fail",
      value: `${stats?.timedOut ?? 0} / ${stats?.failed ?? 0}`,
      kind: (stats?.timedOut || stats?.failed) ? "bad" : "",
    },
    {
      metric: true,
      labelHtml: `Tokens ${metricWindow("24h", true)}`,
      valueHtml: renderMetricChip({
        kind: "tokens",
        value: tok24,
        compact: true,
        ariaLabel: `Estimated visible-text tokens last 24 hours: ${tok24 || "none"}`,
        title: "Estimated from stored prompt and result text",
      }),
    },
  ];

  if (showRef) {
    items.push({
      metric: true,
      labelHtml: `Ref. cost ${metricWindow("24h")}`,
      labelTitle: `Reference API cost vs ${scenario} — not ChatGPT billing`,
      valueHtml: renderMetricChip({
        kind: "money",
        value: usd24,
        compact: true,
        ariaLabel: `Reference API cost last 24 hours: ${usd24 || "none"}`,
        title: `Reference API cost vs ${scenario} — not ChatGPT billing or savings`,
      }),
    });
  }

  planeKv.innerHTML = items
    .map((it) => {
      if (it.metric) {
        return `<div class="kv metric-kv">
          <dt title="${escapeHtml(it.labelTitle || "")}">${it.labelHtml}</dt>
          <dd class="html">${it.valueHtml}</dd>
        </div>`;
      }
      return `<div class="kv">
        <dt>${escapeHtml(it.label)}</dt>
        <dd class="${it.kind}">${escapeHtml(it.value)}</dd>
      </div>`;
    })
    .join("");
}

// ==========================================================================
// Worker Card Actions (Primary + Secondary)
// ==========================================================================
function renderCardPrimaryAction(w, recAction) {
  const id = escapeHtml(w.id);
  const isBusy =
    optimisticBusyWorkers.has(w.id) ||
    (w.activeOperation &&
      w.activeOperation.state !== "SUCCEEDED" &&
      w.activeOperation.state !== "FAILED") ||
    w.operatorState === "STARTING";

  if (recAction.actionKey === "open-chat" && w.chatUrl) {
    return `<div class="card-primary-action">
      <a class="primary" href="${escapeHtml(w.chatUrl)}" target="_blank" rel="noopener noreferrer">
        <svg class="action-icon" aria-hidden="true"><use href="#icon-external"></use></svg>
        <span>Open worker chat</span>
      </a>
    </div>`;
  }

  if (recAction.actionKey === "none") {
    if (isBusy) {
      return `<div class="card-primary-action">
        <button type="button" class="primary btn-busy" disabled>Connecting…</button>
      </div>`;
    }
    return "";
  }

  const btnClass = recAction.destructive ? "danger" : "primary";
  const btnLabel = isBusy ? "Working…" : escapeHtml(recAction.label);
  const disabled = isBusy ? " disabled" : "";

  return `<div class="card-primary-action">
    <button type="button" class="${btnClass}${isBusy ? " btn-busy" : ""}" data-worker-action="${escapeHtml(recAction.actionKey)}" data-worker-id="${id}"${disabled}>
      ${btnLabel}
    </button>
  </div>`;
}

function renderCardSecondaryActions(w, recAction, canRemove) {
  const id = escapeHtml(w.id);
  const parts = [];
  const primaryKey = recAction.actionKey;

  if (primaryKey !== "assign") {
    parts.push(
      `<button type="button" class="worker-btn-action worker-btn-action--safe" data-worker-action="assign" data-worker-id="${id}">
        <svg class="action-icon" aria-hidden="true"><use href="#icon-link"></use></svg>
        <span>Assign URL…</span>
      </button>`
    );
  }
  if (primaryKey !== "create") {
    parts.push(
      `<button type="button" class="worker-btn-action worker-btn-action--safe" data-worker-action="create" data-worker-id="${id}">
        <svg class="action-icon" aria-hidden="true"><use href="#icon-plus"></use></svg>
        <span>New chat…</span>
      </button>`
    );
  }
  if (primaryKey !== "kill" && (w.operatorState !== "READY" || !w.healthy)) {
    parts.push(
      `<button type="button" class="worker-btn-action worker-btn-action--danger" data-worker-action="kill" data-worker-id="${id}">
        <svg class="action-icon" aria-hidden="true"><use href="#icon-refresh"></use></svg>
        <span>Recreate chat…</span>
      </button>`
    );
  }
  const enabled = w.errorCode !== "DISABLED";
  parts.push(
    `<button type="button" class="worker-btn-action worker-btn-action--safe" data-worker-action="toggle" data-worker-id="${id}" data-enabled="${enabled ? "0" : "1"}">
      <svg class="action-icon" aria-hidden="true"><use href="#icon-${enabled ? "pause" : "play"}"></use></svg>
      <span>${enabled ? "Disable…" : "Enable…"}</span>
    </button>`
  );
  if (canRemove || w.inRegistry === false) {
    parts.push(
      `<button type="button" class="worker-btn-action worker-btn-action--danger" data-worker-action="remove" data-worker-id="${id}">
        <svg class="action-icon" aria-hidden="true"><use href="#icon-trash"></use></svg>
        <span>Remove…</span>
      </button>`
    );
  }
  return parts.join("");
}

// ==========================================================================
// Worker cards rendering (compact, equal grid)
// ==========================================================================
function renderWorkers(workers, showReference, systemState = {}) {
  if (!workersEl) return;
  const live = (workers ?? []).filter((w) => w.id !== "default");
  if (live.length === 0) {
    if (workerCount) {
      const countState = deriveWorkerCountState(0, 0);
      workerCount.textContent = countState.text;
      workerCount.className = `worker-count-chip ${countState.kind}`;
    }
    workersEl.innerHTML = `<article class="card empty">
      <h3>No workers registered</h3>
      <p class="muted" style="margin:0.4rem 0 0">
        Start the broker stack, then wait for worker heartbeats.
      </p>
    </article>`;
    return;
  }

  const healthyN = live.filter((w) => w.healthy).length;
  if (workerCount) {
    const countState = deriveWorkerCountState(live.length, healthyN);
    workerCount.textContent = countState.text;
    workerCount.className = `worker-count-chip ${countState.kind}`;
  }

  // Preserve open debug details across DOM re-renders
  if (workersEl) {
    for (const details of workersEl.querySelectorAll("details.worker-debug[open]")) {
      const card = details.closest("[data-worker-card-id]");
      const wid = card?.getAttribute("data-worker-card-id");
      if (wid) openDebugWorkers.add(wid);
    }
  }

  // Attention sorting: Unhealthy first, then ACTION_REQUIRED, then healthy
  const sorted = sortWorkersByAttention(live, systemState);

  suppressWorkerDebugToggle = true;
  try {
    workersEl.innerHTML = sorted
    .map((w) => {
      const opState = w.operatorState ?? w.healthState ?? (w.healthy ? "READY" : "DEGRADED");
      const kind = healthStateClass(opState);
      const isBusy =
        optimisticBusyWorkers.has(w.id) ||
        (w.activeOperation &&
          w.activeOperation.state !== "SUCCEEDED" &&
          w.activeOperation.state !== "FAILED") ||
        opState === "STARTING";

      const recAction = deriveRecommendedAction(w, systemState);
      const task = w.currentTaskId ? middleTruncate(w.currentTaskId) : "—";
      const isDebugOpen = openDebugWorkers.has(w.id);

      // Surface line always visible during reload / activeOperation
      let surfaceLine = "";
      if (isBusy) {
        surfaceLine = `<div class="card-surface-banner"><strong>Connecting…</strong> opening tab · attaching Cursor</div>`;
      } else if (w.activeOperation) {
        surfaceLine = `<div class="card-surface-banner"><strong>${escapeHtml(w.activeOperation.kind)}</strong> <span class="mono">${escapeHtml(w.activeOperation.state)}</span></div>`;
      } else if (w.stuckInFlightTaskId) {
        surfaceLine = `<div class="card-surface-banner" style="border-color:rgba(180,35,46,0.4);background:rgba(180,35,46,0.08)"><strong>Handoff stuck</strong> · <code>${escapeHtml(w.stuckInFlightTaskId)}</code></div>`;
      }

      // Visible lines: ~3-4 for healthy, ~5 for unhealthy
      let visibleLines = "";
      if (w.healthy && opState === "READY") {
        visibleLines = `
          <div class="card-line">
            <span class="card-line__label">Status</span>
            <span class="card-line__val" style="color:var(--ok)">Ready for handoffs</span>
          </div>
          <div class="card-line">
            <span class="card-line__label">Task</span>
            <span class="card-line__val" title="${escapeHtml(w.currentTaskId ?? "")}">${escapeHtml(task)}</span>
          </div>
          <div class="card-line">
            <span class="card-line__label">Chat budget</span>
            <span class="card-line__val">${w.tasksOnChat ?? 0}/${w.maxTasksPerChat ?? "—"}</span>
          </div>
          <div class="card-line">
            <span class="card-line__label">24h stats</span>
            <span class="card-line__val">${w.completedLast24h ?? 0} done · ${w.failedLast24h ?? 0} fail</span>
          </div>`;
      } else {
        const issueDetail = recAction.reason || w.operatorDetail || w.error || "Needs attention";
        visibleLines = `
          <div class="card-line">
            <span class="card-line__label">Detail</span>
            <span class="card-line__val" style="color:var(--bad)">${escapeHtml(issueDetail)}</span>
          </div>
          <div class="card-line">
            <span class="card-line__label">Task</span>
            <span class="card-line__val" title="${escapeHtml(w.currentTaskId ?? "")}">${escapeHtml(task)}</span>
          </div>
          <div class="card-line">
            <span class="card-line__label">Chat budget</span>
            <span class="card-line__val">${w.tasksOnChat ?? 0}/${w.maxTasksPerChat ?? "—"}</span>
          </div>
          <div class="card-line">
            <span class="card-line__label">24h stats</span>
            <span class="card-line__val">${w.completedLast24h ?? 0} done · ${w.failedLast24h ?? 0} fail</span>
          </div>`;
      }

      const primaryActionHtml = renderCardPrimaryAction(w, recAction);
      const secondaryActionsHtml = renderCardSecondaryActions(w, recAction, live.length > 1);

      return `<article class="card ${kind}${isBusy ? " worker-card-busy" : ""}" data-worker-card-id="${escapeHtml(w.id)}">
        <div class="card-head">
          <h3>${escapeHtml(w.id)}</h3>
          <span class="pill ${kind}">${escapeHtml(opState)}</span>
        </div>
        ${surfaceLine}
        <div class="card-body-lines">
          ${visibleLines}
        </div>
        ${primaryActionHtml}
        <div class="worker-secondary-actions">
          ${secondaryActionsHtml}
        </div>
        <details class="worker-debug"${isDebugOpen ? " open" : ""}>
          <summary class="worker-debug-summary">Diagnostics</summary>
          <div class="worker-debug-body">
            <div class="card-line">
              <span class="card-line__label">PID</span>
              <span class="card-line__val">${w.pidAlive ? `${w.pid ?? "—"} · alive` : "dead"}</span>
            </div>
            <div class="card-line">
              <span class="card-line__label">Heartbeat</span>
              <span class="card-line__val">${w.heartbeatStale ? "stale" : "fresh"} · ${age(w.lastSeenAt)}</span>
            </div>
            <div class="card-line">
              <span class="card-line__label">MCP read</span>
              <span class="card-line__val">${w.mcpReadVerifiedAt ? escapeHtml(age(w.mcpReadVerifiedAt)) + " ago" : "unverified"}</span>
            </div>
            <div class="card-line">
              <span class="card-line__label">MCP write</span>
              <span class="card-line__val">${w.mcpWriteVerifiedAt ? escapeHtml(age(w.mcpWriteVerifiedAt)) + " ago" : w.mcpWriteStatus === "DEGRADED" ? "degraded" : "unverified"}</span>
            </div>
            ${w.errorCode ? `<div class="card-line"><span class="card-line__label">Error code</span><span class="card-line__val">${escapeHtml(w.errorCode)}</span></div>` : ""}
            ${w.conditions?.length ? `<div class="conditions" title="${escapeHtml(formatConditions(w.conditions))}">${escapeHtml(formatConditions(w.conditions))}</div>` : ""}
          </div>
        </details>
      </article>`;
    })
    .join("");
  } finally {
    suppressWorkerDebugToggle = false;
  }
}

// ==========================================================================
// Recent Tasks Rendering (compact table)
// ==========================================================================
function renderTasks(tasks, showReference) {
  if (!tasksEl) return;
  const rows = (tasks ?? []).slice(0, 10);
  if (taskCount) taskCount.textContent = `Last ${rows.length}`;
  if (rows.length === 0) {
    tasksEl.innerHTML = `<tr><td colspan="6" class="muted">No handoff tasks yet</td></tr>`;
    return;
  }
  tasksEl.innerHTML = rows
    .map((t) => {
      const kind = pillClass(t.status, true);
      const sel = t.id === selectedTaskId ? "selected" : "";
      const dur = t.totalMs != null ? fmtMs(t.totalMs) : "—";
      const usage = renderMetricPair(t.usageEstimate, showReference);
      const isFailed = t.status === "FAILED" || t.errorCode;
      const errSubtext = isFailed && t.errorCode
        ? `<span class="task-err-subtext" title="${escapeHtml(t.errorCode)}">error: ${escapeHtml(t.errorCode)}</span>`
        : "";

      return `<tr class="task-row ${sel}" data-task-id="${escapeHtml(t.id)}">
        <td><span class="pill ${kind}">${escapeHtml(t.status)}</span></td>
        <td title="${escapeHtml(t.id)}">
          <span>${escapeHtml(middleTruncate(t.id))}</span>
          ${errSubtext}
        </td>
        <td>${escapeHtml(t.leaseOwner ?? "—")}</td>
        <td>${escapeHtml(age(t.createdAt))}</td>
        <td title="queue ${fmtMs(t.queueMs)} · processing ${fmtMs(t.processingMs)}">${escapeHtml(dur)}</td>
        <td>${usage}</td>
      </tr>`;
    })
    .join("");
}

function renderHints(workers, health) {
  if (!hintsEl) return;
  const hints = [];
  const live = workers.filter((w) => w.id !== "default");
  const healthy = live.filter((w) => w.healthy);
  const staleHb = live.filter((w) => w.heartbeatStale || !w.pidAlive);

  if (!health.ok) {
    hints.push({ kind: "bad", text: "Control plane /health is not ok." });
  } else if (staleHb.length === 0 && live.length > 0) {
    hints.push({ kind: "ok", text: "All worker heartbeats are fresh" });
  }

  if (health.reaper && health.lastReapAt) {
    const stale = Date.now() - Date.parse(health.lastReapAt) > 30_000;
    hints.push({
      kind: stale ? "warn" : "ok",
      text: stale
        ? "Lease reaper tick looks stale"
        : "Lease reaper ticked within threshold",
    });
  } else if (!health.reaper) {
    hints.push({ kind: "warn", text: "Lease reaper is off on this status-api" });
  }

  hints.push({
    kind: "neutral",
    text: "Use doctor before restarting the stack",
  });

  const maxChat = live.find((w) => w.maxTasksPerChat)?.maxTasksPerChat;
  if (maxChat) {
    hints.push({
      kind: "neutral",
      text: `Chat rotation max ${maxChat} dispatches/chat — npm run rotate-worker -- --id=wN`,
    });
  }

  if (live.length === 0) {
    hints.push({
      kind: "warn",
      text: "No workers registered — start browser-broker / stack",
    });
  }

  const blocked = live.filter(
    (w) =>
      w.operatorState === "ACTION_REQUIRED" ||
      w.healthState === "BLOCKED" ||
      w.readinessReason === "CONSENT_REQUIRED" ||
      w.readinessReason === "MCP_APPROVAL_REQUIRED" ||
      w.status === "SESSION_LOST"
  );
  if (blocked.length > 0) {
    hints.push({
      kind: "warn",
      text: `Worker ops: ${blocked.map((w) => w.id).join(", ")} need dashboard action — use Continue after MCP approval`,
    });
  }

  const readyN = live.filter(
    (w) => w.operatorState === "READY" || w.healthState === "READY"
  ).length;
  if (readyN > 0 && readyN === live.length) {
    hints.push({
      kind: "ok",
      text: "All workers READY — URL changes reconcile without RESTART_REQUIRED",
    });
  } else if (healthy.length === 0 && live.length > 0) {
    hints.push({ kind: "bad", text: "No healthy workers" });
  }

  hintsEl.innerHTML = hints
    .map((h) => `<li class="${h.kind}">${escapeHtml(h.text)}</li>`)
    .join("");
}

function renderWorkerAlert(workers, healthMeta) {
  if (!workerAlert) return;
  const messages = [];
  if (
    healthMeta?.brokerConfigured &&
    healthMeta.brokerReachable === false
  ) {
    messages.push(
      `<strong>Browser broker unreachable</strong> (:${healthMeta.brokerOpsPort ?? lastBrokerOpsPort}) — New chat / assign cannot run. Start stack: <code>./scripts/start-broker-stack.sh</code> (Chrome CDP + browser-broker).`
    );
  }
  const lost = (workers ?? []).filter(
    (w) => w.id !== "default" && w.status === "SESSION_LOST"
  );
  if (lost.length > 0) {
    const names = lost.map((w) => w.id).join(", ");
    messages.push(
      `<strong>Session lost</strong> on ${escapeHtml(names)} — log into ChatGPT in the CDP window, then <em>Recreate chat…</em> or <em>Continue</em>.`
    );
  }
  const accessDenied = (workers ?? []).filter(
    (w) => w.id !== "default" && w.chatAccessDenied
  );
  if (accessDenied.length > 0) {
    messages.push(
      `<strong>Chat access denied</strong> on ${escapeHtml(accessDenied.map((w) => w.id).join(", "))} — CDP Chrome cannot open the saved /c/ URL. Use <em>Assign URL…</em> with a chat you created in CDP.`
    );
  }
  if (messages.length === 0) {
    workerAlert.classList.add("hidden");
    workerAlert.hidden = true;
    workerAlert.textContent = "";
    return;
  }
  workerAlert.classList.remove("hidden");
  workerAlert.hidden = false;
  workerAlert.innerHTML = messages.join("<br><br>");
}

// ==========================================================================
// Worker Actions Handlers (with optimistic busy state)
// ==========================================================================
async function beginWorkerAssign(workerId) {
  if (opsInFlight) return;
  const state = await fetchJson("/workers/health");
  const row = (state.workers ?? []).find((w) => w.id === workerId);
  const currentUrl =
    row?.chatUrl ?? row?.workerUrl ?? "https://chatgpt.com/c/";
  const activeOp = row?.activeOperation;
  const supersedeNote = activeOp
    ? `Active worker op (${activeOp.kind} ${activeOp.state}) will be cancelled automatically.\n`
    : "";
  openOpsModal({
    title: `Assign URL · ${workerId}`,
    preview:
      supersedeNote +
      "Updates workers.json, binds the broker tab, and runs SYSTEM_PROBE until READY.",
    typedConfirm: false,
    showUrlField: true,
    initialUrl: currentUrl.startsWith("http") ? currentUrl : "https://chatgpt.com/c/",
    pending: {
      kind: "worker-assign",
      typedConfirm: false,
      showUrlField: true,
      workerId,
    },
  });
}

async function beginWorkerCreate(workerId) {
  if (opsInFlight) return;
  openOpsModal({
    title: `Create chat · ${workerId}`,
    preview:
      "Opens a new CDP tab, types <code>@Cursor</code> → Enter, sends bootstrap OK.\n" +
      "Bootstrap OK often gets only a 👍 — that is normal. Worker then dispatches connector handshake (<code>TASK_ID=…</code>).\n" +
      "Click <strong>Always allow</strong> when ChatGPT asks to use Cursor MCP write tools.\n" +
      "Stuck handoff / prior worker op on this card is cleared automatically.",
    typedConfirm: false,
    pending: { kind: "worker-create", typedConfirm: false, workerId },
  });
}

async function beginWorkerKill(workerId) {
  if (opsInFlight) return;
  openOpsModal({
    title: `Kill + recreate · ${workerId}`,
    preview:
      "Unbind tab, create a fresh worker chat, update registry, probe until READY.",
    typedConfirm: false,
    pending: {
      kind: "worker-kill",
      typedConfirm: false,
      workerId,
      mode: "create",
    },
  });
}

async function beginWorkerToggle(workerId, enable) {
  if (opsInFlight) return;
  openOpsModal({
    title: enable ? `Enable ${workerId}` : `Disable ${workerId}`,
    preview: enable
      ? "Worker returns to dispatch pool after reconcile."
      : "Worker stops claiming tasks; broker binding unchanged.",
    typedConfirm: false,
    pending: {
      kind: "worker-toggle",
      typedConfirm: false,
      workerId,
      enabled: enable,
    },
  });
}

async function beginWorkerRemove(workerId) {
  if (opsInFlight) return;
  openOpsModal({
    title: `Remove worker · ${workerId}`,
    preview:
      `Delete ${workerId} from workers registry, unbind CDP tab, and clear worker_state.\n` +
      "Task history is kept. Run make restart so browser-broker drops page actors for removed ids.",
    typedConfirm: false,
    pending: {
      kind: "worker-remove",
      typedConfirm: false,
      workerId,
    },
  });
}

async function beginAddWorker() {
  if (opsInFlight) return;
  openOpsModal({
    title: "Add worker",
    preview:
      "Registers a new worker in the DB, then automatically runs <strong>New chat…</strong> " +
      "(opens a CDP Chrome tab, attaches Cursor, bootstrap OK).\n" +
      "Watch the worker card — status becomes <em>Connecting…</em> while the tab opens.\n" +
      "Then click <strong>Always allow</strong> when ChatGPT prompts for the Cursor connector.",
    typedConfirm: false,
    pending: { kind: "worker-add", typedConfirm: false },
  });
}

function beginStartBroker() {
  if (opsInFlight) return;
  openOpsModal({
    title: "Start browser broker",
    preview:
      "Browser broker is unreachable.\n\n" +
      "Start it in your terminal:\n" +
      "  ./scripts/start-broker-stack.sh\n\n" +
      "Or restart the full stack:\n" +
      "  make restart\n\n" +
      `Once started (port :${lastBrokerOpsPort}), this dashboard will automatically reconnect.`,
    typedConfirm: false,
    pending: { kind: "info-only", typedConfirm: false },
  });
}

async function runWorkerClearStuck(workerId) {
  if (opsInFlight) return;
  opsInFlight = true;
  optimisticBusyWorkers.add(workerId);
  try {
    const result = await postOps("/ops/workers/clear-stuck", { workerId });
    showOpsResult(result);
    await tick();
  } catch (err) {
    showOpsResult(err instanceof Error ? err.message : String(err));
  } finally {
    opsInFlight = false;
    optimisticBusyWorkers.delete(workerId);
  }
}

async function runWorkerContinue(workerId) {
  if (opsInFlight) return;
  opsInFlight = true;
  optimisticBusyWorkers.add(workerId);
  try {
    const result = await postOps("/ops/workers/continue-connection", { workerId });
    showOpsResult(result);
    await tick();
  } catch (err) {
    showOpsResult(err instanceof Error ? err.message : String(err));
  } finally {
    opsInFlight = false;
    optimisticBusyWorkers.delete(workerId);
  }
}

function pillClass(status, healthy) {
  if (healthy === false) return "bad";
  if (status === "READY" || status === "COMPLETED" || status === "OK") return "ok";
  if (
    status === "BUSY" ||
    status === "PROCESSING" ||
    status === "DISPATCHED" ||
    status === "DISPATCHING" ||
    status === "QUEUED"
  ) {
    return "warn";
  }
  if (status === "WAITING_APPROVAL" || status === "NEEDS_APPROVAL") return "info";
  if (
    status === "SESSION_LOST" ||
    status === "ERROR" ||
    status === "FAILED" ||
    status === "TIMED_OUT" ||
    status === "RATE_LIMITED"
  ) {
    return "bad";
  }
  return "warn";
}

function setPill(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.className = `pill ${kind}`;
}

export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function fetchJson(path, init) {
  const res = await fetch(path, init);
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const msg =
      (body && (body.error || body.message)) ||
      (text ? text.slice(0, 200) : `${path} → ${res.status}`);
    const err = new Error(msg);
    err.status = res.status;
    err.code = body?.code;
    err.body = body;
    throw err;
  }
  if (body && typeof body.csrf === "string") opsCsrf = body.csrf;
  return body ?? {};
}

async function ensureCsrf() {
  if (opsCsrf) return opsCsrf;
  const s = await fetchJson("/ops/session");
  opsCsrf = s.csrf;
  return opsCsrf;
}

function setOpsModalError(message) {
  if (!opsModalError) return;
  if (!message) {
    opsModalError.textContent = "";
    opsModalError.hidden = true;
    opsModalError.classList.add("hidden");
    return;
  }
  opsModalError.textContent = message;
  opsModalError.hidden = false;
  opsModalError.classList.remove("hidden");
}

function showOpsResult(obj) {
  if (!opsResultEl) return;
  opsResultEl.classList.remove("hidden");
  opsResultEl.hidden = false;
  const text =
    typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  opsResultEl.textContent = text;
  if (typeof obj === "string" && obj.length > 0) {
    opsResultEl.classList.add("ops-result--error");
  } else {
    opsResultEl.classList.remove("ops-result--error");
  }
}

async function postOps(path, body) {
  const csrf = await ensureCsrf();
  return fetchJson(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Ops-CSRF": csrf,
    },
    body: JSON.stringify(body),
  });
}

function formatRecoverPreview(p) {
  const lines = [
    `confirm: ${p.confirmPhrase}`,
    `mutations≈${p.mutationCount} (includes expireLeases)`,
    `DISPATCHING→FAILED: ${p.dispatching?.length ?? 0}`,
    `WAITING→TIMED_OUT: ${p.waiting?.length ?? 0}`,
    `QUEUED→FAILED: ${p.queued?.length ?? 0}`,
    `workers reset: ${p.workers?.length ?? 0}`,
    "",
  ];
  for (const w of p.workers ?? []) {
    lines.push(`  worker ${w.id} (${w.reason})`);
  }
  for (const t of [...(p.dispatching ?? []), ...(p.queued ?? [])].slice(0, 12)) {
    lines.push(`  task ${t.id} ${t.from}→${t.to}`);
  }
  if (p.truncated) lines.push("  …truncated");
  if (
    (p.dispatching?.length ?? 0) +
      (p.waiting?.length ?? 0) +
      (p.queued?.length ?? 0) +
      (p.workers?.length ?? 0) ===
    0
  ) {
    lines.push("(no row mutations planned — expireLeases still runs)");
  }
  return lines.join("\n");
}

function isValidWorkerChatUrl(url) {
  return /^https:\/\/chatgpt\.com\/c\/[a-z0-9-]+/i.test(String(url ?? "").trim());
}

function syncOpsModalGoState() {
  if (!opsConfirmGo || !pendingOps) return;
  if (pendingOps.showUrlField) {
    opsConfirmGo.disabled = !isValidWorkerChatUrl(opsUrlInput?.value);
    return;
  }
  if (pendingOps.typedConfirm) {
    opsConfirmGo.disabled =
      !pendingOps.phrase ||
      opsConfirmInput?.value.trim() !== pendingOps.phrase;
    return;
  }
  opsConfirmGo.disabled = false;
}

function openOpsModal({
  title,
  preview,
  phrase,
  pending,
  typedConfirm = true,
  showUrlField = false,
  initialUrl = "",
}) {
  pendingOps = { ...pending, typedConfirm, showUrlField };
  setOpsModalError("");
  if (opsModalTitle) opsModalTitle.textContent = title;
  if (opsModalPreview) opsModalPreview.textContent = preview;
  const needTyped = typedConfirm && phrase;
  if (opsConfirmBlock) {
    opsConfirmBlock.hidden = !needTyped;
    opsConfirmBlock.classList.toggle("hidden", !needTyped);
  }
  if (opsUrlBlock) {
    opsUrlBlock.hidden = !showUrlField;
    opsUrlBlock.classList.toggle("hidden", !showUrlField);
  }
  if (showUrlField && opsUrlInput) {
    opsUrlInput.value = initialUrl || "https://chatgpt.com/c/";
    opsUrlInput.focus();
  } else if (needTyped && opsConfirmInput && opsConfirmPhrase) {
    opsConfirmPhrase.textContent = phrase;
    opsConfirmInput.value = "";
    opsConfirmInput.focus();
  }
  if (opsConfirmGo) {
    opsConfirmGo.className =
      pending.kind === "fail" || pending.kind === "worker-kill" || pending.kind === "worker-remove"
        ? "danger"
        : typedConfirm
          ? "danger"
          : "primary";
    opsConfirmGo.textContent = showUrlField
      ? "Assign URL"
      : pending.kind === "info-only"
        ? "Got it"
        : typedConfirm
          ? "Execute"
          : "Confirm";
  }
  syncOpsModalGoState();
  if (opsModal) {
    if (typeof opsModal.showModal === "function") opsModal.showModal();
    else opsModal.setAttribute("open", "");
  }
}

function closeOpsModal() {
  pendingOps = null;
  setOpsModalError("");
  if (opsConfirmGo) opsConfirmGo.textContent = "Execute";
  if (opsUrlBlock) {
    opsUrlBlock.hidden = true;
    opsUrlBlock.classList.add("hidden");
  }
  if (opsUrlInput) opsUrlInput.value = "";
  if (opsModal) {
    if (typeof opsModal.close === "function") opsModal.close();
    else opsModal.removeAttribute("open");
  }
}

async function beginRecover(failQueued) {
  if (opsInFlight) return;
  opsInFlight = true;
  if (btnRecover) btnRecover.disabled = true;
  if (btnRecoverQueued) btnRecoverQueued.disabled = true;
  if (btnHeadlineRecover) btnHeadlineRecover.disabled = true;
  if (btnHeadlineRecoverQueued) btnHeadlineRecoverQueued.disabled = true;
  try {
    const preview = await postOps("/ops/recover/preview", { failQueued });
    openOpsModal({
      title: failQueued ? "Recover + fail queued" : "Recover workers",
      preview: formatRecoverPreview(preview),
      typedConfirm: false,
      pending: {
        kind: "recover",
        typedConfirm: false,
        planToken: preview.planToken,
      },
    });
  } catch (err) {
    showOpsResult(err instanceof Error ? err.message : String(err));
  } finally {
    opsInFlight = false;
    if (btnRecover) btnRecover.disabled = false;
    if (btnRecoverQueued) btnRecoverQueued.disabled = false;
    if (btnHeadlineRecover) btnHeadlineRecover.disabled = false;
    if (btnHeadlineRecoverQueued) btnHeadlineRecoverQueued.disabled = false;
  }
}

async function beginFailTask() {
  if (!selectedTaskId || opsInFlight) return;
  if (
    selectedTaskStatus === "COMPLETED" ||
    selectedTaskStatus === "FAILED" ||
    selectedTaskStatus === "CANCELLED" ||
    selectedTaskStatus === "TIMED_OUT"
  ) {
    showOpsResult(`Task already terminal: ${selectedTaskStatus}`);
    return;
  }
  openOpsModal({
    title: "Fail task",
    preview: `Mark ${selectedTaskId} (${selectedTaskStatus ?? "?"}) as FAILED.\nClears lease capability fields; preserves lease_owner for attribution.`,
    typedConfirm: false,
    pending: { kind: "fail", typedConfirm: false, taskId: selectedTaskId },
  });
}

async function executePendingOps() {
  if (!pendingOps || opsInFlight) return;
  opsInFlight = true;
  if (opsConfirmGo) opsConfirmGo.disabled = true;
  const workerId = pendingOps.workerId;
  if (workerId) optimisticBusyWorkers.add(workerId);
  try {
    if (pendingOps.kind === "recover") {
      const result = await postOps("/ops/recover", {
        planToken: pendingOps.planToken,
      });
      closeOpsModal();
      showOpsResult(result);
      await tick();
    } else if (pendingOps.kind === "fail") {
      const result = await postOps("/ops/tasks/fail", {
        taskId: pendingOps.taskId,
      });
      closeOpsModal();
      showOpsResult(result);
      if (selectedTaskId) await showTaskDetail(selectedTaskId);
      await tick();
    } else if (pendingOps.kind === "worker-assign") {
      const workerUrl = opsUrlInput?.value?.trim() ?? "";
      if (!isValidWorkerChatUrl(workerUrl)) {
        showOpsResult("Invalid URL — need https://chatgpt.com/c/<id>");
        return;
      }
      const result = await postOps("/ops/workers/assign-url", {
        workerId: pendingOps.workerId,
        workerUrl,
      });
      closeOpsModal();
      showOpsResult({
        ...result,
        note: `Watch the Worker card. Broker must be up (:${lastBrokerOpsPort}).`,
      });
      await tick();
    } else if (pendingOps.kind === "worker-create") {
      const result = await postOps("/ops/workers/create-chat", {
        workerId: pendingOps.workerId,
      });
      closeOpsModal();
      showOpsResult({
        ...result,
        note: `Watch the Worker card. Broker must be up (:${lastBrokerOpsPort}).`,
      });
      await tick();
    } else if (pendingOps.kind === "worker-kill") {
      const result = await postOps("/ops/workers/kill-recreate", {
        workerId: pendingOps.workerId,
        mode: pendingOps.mode ?? "create",
      });
      closeOpsModal();
      showOpsResult({
        ...result,
        note: `Watch the Worker card. Broker must be up (:${lastBrokerOpsPort}).`,
      });
      await tick();
    } else if (pendingOps.kind === "worker-toggle") {
      const result = await postOps("/ops/workers/set-enabled", {
        workerId: pendingOps.workerId,
        enabled: pendingOps.enabled,
      });
      closeOpsModal();
      showOpsResult(result);
      await tick();
    } else if (pendingOps.kind === "worker-add") {
      const result = await postOps("/ops/workers/add", {});
      closeOpsModal();
      const note = result.autoCreateChat
        ? `Auto New chat started (op ${result.operationId ?? "—"}). Watch CDP Chrome and this card.`
        : result.autoCreateChatError
          ? `Worker added but New chat did not start: ${result.autoCreateChatError}`
          : "Worker added — click New chat… on the card if no tab opens.";
      showOpsResult({ ...result, note });
      await loadTopology();
      await tick();
    } else if (pendingOps.kind === "worker-remove") {
      const result = await postOps("/ops/workers/remove", {
        workerId: pendingOps.workerId,
      });
      closeOpsModal();
      showOpsResult(result);
      await loadTopology();
      await tick();
    } else if (pendingOps.kind === "info-only") {
      closeOpsModal();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setOpsModalError(msg);
    showOpsResult(msg);
    if (err?.code === "plan_stale") closeOpsModal();
  } finally {
    opsInFlight = false;
    if (workerId) optimisticBusyWorkers.delete(workerId);
    syncOpsModalGoState();
  }
}

async function loadTopology() {
  if (!topologyEl) return;
  topologyEl.textContent = "Loading…";
  try {
    const t = await fetchJson("/ops/topology");
    const lines = [
      `source: ${t.source}`,
      `file: ${t.filePath ?? "—"}`,
      "",
      ...(t.workers ?? []).map(
        (w) =>
          `${w.id}  ${w.status ?? "—"}  port=${w.httpPort ?? "—"}  cdp=${w.cdpHost ?? "—"}  ${w.chatUrl ?? "—"}`
      ),
    ];
    if (!(t.workers ?? []).length) lines.push("(no workers in topology)");
    topologyEl.textContent = lines.join("\n");
  } catch (err) {
    topologyEl.textContent =
      err instanceof Error ? err.message : String(err);
  }
}

function renderCommands(container) {
  if (!container) return;
  container.innerHTML = COMMANDS.map(
    (cmd) => `<div class="cmd-row">
      <code title="${escapeHtml(cmd)}">${escapeHtml(cmd)}</code>
      <button type="button" data-copy="${escapeHtml(cmd)}">copy</button>
    </div>`
  ).join("");
}

function bindCopy(root) {
  if (!root) return;
  root.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button[data-copy]");
    if (!btn) return;
    const text = btn.getAttribute("data-copy") ?? "";
    try {
      await navigator.clipboard.writeText(text);
      const prev = btn.textContent;
      btn.textContent = "copied";
      setTimeout(() => {
        btn.textContent = prev;
      }, 1200);
    } catch {
      btn.textContent = "fail";
    }
  });
}

function setUnreachable(on, errMsg) {
  if (liveEl) {
    liveEl.classList.toggle("hidden", on);
    liveEl.hidden = on;
  }
  if (unreachableEl) {
    unreachableEl.classList.toggle("hidden", !on);
    unreachableEl.hidden = !on;
  }
  if (on && lastSeenEl) {
    lastSeenEl.textContent = lastOkAt
      ? `Last seen ${age(lastOkAt)} ago`
      : errMsg || "No successful poll yet";
  }
}

function formatClock(d = new Date()) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).format(d);
  } catch {
    return d.toLocaleTimeString();
  }
}

function openDrawer() {
  if (!drawer || !drawerBackdrop) return;
  drawer.classList.remove("hidden");
  drawer.hidden = false;
  drawerBackdrop.classList.remove("hidden");
  drawerBackdrop.hidden = false;
}

function closeDrawer() {
  if (!drawer || !drawerBackdrop) return;
  drawer.classList.add("hidden");
  drawer.hidden = true;
  drawerBackdrop.classList.add("hidden");
  drawerBackdrop.hidden = true;
  if (drawerContent) {
    drawerContent.classList.add("hidden");
    drawerContent.hidden = true;
    drawerContent.textContent = "";
  }
  if (drawerUsage) {
    drawerUsage.classList.add("hidden");
    drawerUsage.hidden = true;
    drawerUsage.innerHTML = "";
  }
  selectedTaskId = null;
  selectedTaskStatus = null;
}

function renderDrawerUsage(u) {
  if (!drawerUsage) return;
  if (!u || !u.isEstimated) {
    drawerUsage.classList.add("hidden");
    drawerUsage.hidden = true;
    drawerUsage.innerHTML = "";
    return;
  }
  const total = formatEstimatedTokens(u.tokens?.total);
  const inTok = formatEstimatedTokens(u.tokens?.input);
  const outTok = formatEstimatedTokens(u.tokens?.output);
  const showRef = u.referencePricingEnabled === true && u.comparison;
  const money = formatEstimatedMoney(
    u.cost?.referenceCostUsd ?? u.cost?.apiEquivalentAvoidedUsd
  );
  const low = formatEstimatedMoney(u.cost?.lowUsd);
  const high = formatEstimatedMoney(u.cost?.highUsd);
  const scenario = u.comparison?.scenarioLabel ?? "—";

  const refBlock = showRef
    ? `<div class="drawer-usage__highlights" style="margin-top:1rem">
        <div class="drawer-usage__highlight drawer-usage__highlight--money">
          <span class="drawer-usage__label">Reference API cost</span>
          <span class="drawer-usage__value">${escapeHtml(money || "—")}</span>
          <span class="drawer-usage__qualifier">hypothetical</span>
        </div>
      </div>
      <dl class="drawer-usage__details">
        <div><dt>Compared with</dt><dd title="Not the ChatGPT runtime model">${escapeHtml(scenario)}</dd></div>
        <div><dt>Reference rates</dt><dd>$${escapeHtml(String(u.comparison?.inputUsdPerMTok ?? "—"))} / $${escapeHtml(String(u.comparison?.outputUsdPerMTok ?? "—"))} MTok</dd></div>
        <div><dt>Range</dt><dd>${escapeHtml(low || "—")}–${escapeHtml(high || "—")}</dd></div>
        <div><dt>Basis</dt><dd>stored prompt + result</dd></div>
      </dl>
      <p class="drawer-usage__note">
        Hypothetical list-rate comparison for an alternative Cursor/API scenario.
        Not the model that ran this handoff, not a ChatGPT charge, and not verified savings.
      </p>`
    : `<p class="drawer-usage__note" style="margin-top:0.85rem">
        <strong>Billing not measured.</strong> Runs in ChatGPT web under your subscription;
        no per-handoff invoice is available.
        Enable optional reference pricing with
        <span class="mono">HANDOFF_REFERENCE_PRICING=on</span>
        (comparison scenario only — still not ChatGPT billing).
      </p>`;

  drawerUsage.classList.remove("hidden");
  drawerUsage.hidden = false;
  drawerUsage.innerHTML = `
    <header class="drawer-usage__header">
      <span class="drawer-usage__title-wrap">
        ${metricIcon("tokens")}
        <span id="drawer-usage-title" class="drawer-usage__title">Usage estimate</span>
      </span>
      ${metricWindow("stored text only")}
    </header>
    <div class="drawer-usage__highlights">
      <div class="drawer-usage__highlight">
        <span class="drawer-usage__label">Estimated total</span>
        <span class="drawer-usage__value">${escapeHtml(total || "—")}</span>
      </div>
    </div>
    <dl class="drawer-usage__details">
      <div><dt>Input</dt><dd>${escapeHtml(inTok || "—")} tokens</dd></div>
      <div><dt>Output</dt><dd>${escapeHtml(outTok || "—")} tokens</dd></div>
      <div><dt>Tokenizer proxy</dt><dd>${escapeHtml(u.estimation?.estimator ?? "—")}</dd></div>
      <div><dt>Confidence</dt><dd>${escapeHtml(u.estimation?.confidence ?? "—")}</dd></div>
    </dl>
    ${refBlock}`;
}

async function showTaskDetail(taskId) {
  selectedTaskId = taskId;
  selectedTaskStatus = null;
  openDrawer();
  if (drawerBody) drawerBody.textContent = "Loading…";
  if (drawerUsage) {
    drawerUsage.classList.add("hidden");
    drawerUsage.hidden = true;
    drawerUsage.innerHTML = "";
  }
  if (loadContentBtn) loadContentBtn.disabled = false;
  if (failTaskBtn) failTaskBtn.disabled = false;
  try {
    const d = await fetchJson(`/tasks/${encodeURIComponent(taskId)}/detail`);
    selectedTaskStatus = d.status;
    const terminal =
      d.status === "COMPLETED" ||
      d.status === "FAILED" ||
      d.status === "CANCELLED";
    if (failTaskBtn) failTaskBtn.disabled = terminal;
    if (drawerBody) {
      drawerBody.textContent = [
        `id: ${d.id}`,
        `status: ${d.status}`,
        `type: ${d.type}`,
        `owner: ${d.leaseOwner ?? "—"}`,
        `created: ${d.createdAt}`,
        `dispatchStarted: ${d.dispatchStartedAt ?? "—"}`,
        `dispatched: ${d.dispatchedAt ?? "—"}`,
        `processing: ${d.processingAt ?? "—"}`,
        `completed: ${d.completedAt ?? "—"}`,
        `queueMs: ${fmtMs(d.queueMs)}`,
        `processingMs: ${fmtMs(d.processingMs)}`,
        `totalMs: ${fmtMs(d.totalMs)}`,
        `error: ${d.errorCode ?? "—"}`,
        `hasPrompt: ${d.hasPrompt}`,
        `hasResult: ${d.hasResult}`,
        `contentMode: ${d.contentMode}`,
      ].join("\n");
    }
    renderDrawerUsage(d.usageEstimate);
  } catch (err) {
    if (drawerBody) {
      drawerBody.textContent =
        err instanceof Error ? err.message : String(err);
    }
    renderDrawerUsage(null);
  }
}

async function loadRedactedContent() {
  if (!selectedTaskId) return;
  if (loadContentBtn) loadContentBtn.disabled = true;
  if (drawerContent) {
    drawerContent.classList.remove("hidden");
    drawerContent.hidden = false;
    drawerContent.textContent = "Loading redacted content…";
  }
  try {
    const c = await fetchJson(
      `/tasks/${encodeURIComponent(selectedTaskId)}/content`
    );
    if (drawerContent) {
      drawerContent.textContent = [
        c.warning ?? "",
        "",
        "=== PROMPT ===",
        c.prompt?.available
          ? `${c.prompt.preview}${c.prompt.truncated ? "" : ""}`
          : "(none)",
        "",
        "=== RESULT ===",
        c.result?.available ? c.result.preview : "(none)",
      ].join("\n");
    }
  } catch (err) {
    if (drawerContent) {
      drawerContent.textContent =
        err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (loadContentBtn) loadContentBtn.disabled = false;
  }
}

// ==========================================================================
// Main Poll Tick
// ==========================================================================
export async function tick() {
  const now = new Date();
  if (clock) clock.textContent = formatClock(now);
  try {
    const [health, workersBody, healthBody, tasksBody] = await Promise.all([
      fetchJson("/health"),
      fetchJson("/workers"),
      fetchJson("/workers/health"),
      fetchJson("/tasks?limit=10"),
    ]);

    const mergedWorkers = mergeWorkerRows(
      workersBody.workers ?? [],
      healthBody.workers ?? []
    );
    lastOkAt = now.toISOString();
    if (updatedEl) {
      updatedEl.textContent = `Updated ${now.toLocaleTimeString(undefined, { hour12: false })}`;
    }
    setUnreachable(false);

    const taxonomy = deriveSystemTaxonomy(health, mergedWorkers);
    const taxClass = healthStateClass(taxonomy);
    setPill(healthPill, taxonomy, taxClass);

    if (healthBody.brokerOpsPort) {
      lastBrokerOpsPort = healthBody.brokerOpsPort;
    }

    const showRef =
      health.referencePricingEnabled === true ||
      health.costConfig?.referencePricingEnabled === true;

    renderHeadline(taxonomy, mergedWorkers, health, healthBody);
    renderPlane(health, workersBody);
    renderWorkerAlert(mergedWorkers, {
      brokerReachable: healthBody.brokerReachable,
      brokerConfigured: healthBody.brokerConfigured,
      brokerOpsPort: healthBody.brokerOpsPort ?? lastBrokerOpsPort,
    });
    renderWorkers(mergedWorkers, showRef, {
      brokerReachable: healthBody.brokerReachable,
      brokerConfigured: healthBody.brokerConfigured,
      brokerOpsPort: healthBody.brokerOpsPort ?? lastBrokerOpsPort,
    });
    renderTasks(tasksBody.tasks ?? [], showRef);
    renderHints(mergedWorkers, health);
  } catch (err) {
    setPill(healthPill, "DOWN", "bad");
    if (updatedEl) {
      updatedEl.textContent = lastOkAt
        ? `Last seen ${age(lastOkAt)} ago`
        : "Updated —";
    }
    setUnreachable(true, err instanceof Error ? err.message : String(err));
  }
}

// ==========================================================================
// Event Listeners and Setup
// ==========================================================================
function onClick(el, fn) {
  if (!el) return;
  el.addEventListener("click", fn);
}

if (tasksEl) {
  tasksEl.addEventListener("click", (ev) => {
    const tr = ev.target.closest("tr[data-task-id]");
    if (!tr) return;
    const id = tr.getAttribute("data-task-id");
    if (id) void showTaskDetail(id);
  });
}

onClick(drawerClose, closeDrawer);
onClick(drawerBackdrop, closeDrawer);
onClick(loadContentBtn, () => void loadRedactedContent());
onClick(failTaskBtn, () => void beginFailTask());
onClick(btnRecover, () => void beginRecover(false));
onClick(btnRecoverQueued, () => void beginRecover(true));
onClick(btnHeadlineRecover, () => void beginRecover(false));
onClick(btnHeadlineRecoverQueued, () => {
  if (headlineOverflowMenu) {
    headlineOverflowMenu.classList.add("hidden");
    headlineOverflowMenu.hidden = true;
  }
  void beginRecover(true);
});

onClick(btnHeadlineOverflow, (ev) => {
  ev.stopPropagation();
  if (!headlineOverflowMenu) return;
  const isHidden = headlineOverflowMenu.hidden;
  headlineOverflowMenu.hidden = !isHidden;
  headlineOverflowMenu.classList.toggle("hidden", !isHidden);
});

if (typeof document !== "undefined") {
  document.addEventListener("click", (ev) => {
    if (headlineOverflowMenu && !headlineOverflowMenu.hidden) {
      if (!ev.target.closest(".overflow-wrap")) {
        headlineOverflowMenu.classList.add("hidden");
        headlineOverflowMenu.hidden = true;
      }
    }
  });
}

onClick(btnTopology, () => void loadTopology());
onClick(btnAddWorker, () => void beginAddWorker());

if (workersEl) {
  workersEl.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-worker-action]");
    if (!btn) return;
    const workerId = btn.getAttribute("data-worker-id");
    const action = btn.getAttribute("data-worker-action");
    if (!action) return;

    if (action === "assign" && workerId) void beginWorkerAssign(workerId);
    else if (action === "create" && workerId) void beginWorkerCreate(workerId);
    else if (action === "kill" && workerId) void beginWorkerKill(workerId);
    else if (action === "clear-stuck" && workerId) void runWorkerClearStuck(workerId);
    else if ((action === "continue" || action === "retry") && workerId) void runWorkerContinue(workerId);
    else if (action === "start-broker") void beginStartBroker();
    else if (action === "toggle" && workerId) {
      const enable = btn.getAttribute("data-enabled") === "1";
      void beginWorkerToggle(workerId, enable);
    } else if (action === "remove" && workerId) void beginWorkerRemove(workerId);
  });

  workersEl.addEventListener(
    "toggle",
    (ev) => {
      if (suppressWorkerDebugToggle) return;
      const details = ev.target;
      if (details?.matches?.("details.worker-debug")) {
        const card = details.closest("[data-worker-card-id]");
        const workerId = card?.getAttribute("data-worker-card-id");
        if (workerId) {
          if (details.open) {
            openDebugWorkers.add(workerId);
          } else {
            openDebugWorkers.delete(workerId);
          }
        }
      }
    },
    true
  );
}

if (opsConfirmInput) {
  opsConfirmInput.addEventListener("input", () => syncOpsModalGoState());
}
if (opsUrlInput) {
  opsUrlInput.addEventListener("input", () => syncOpsModalGoState());
}

if (opsForm) {
  opsForm.addEventListener("submit", (ev) => {
    const submitter = ev.submitter;
    const value = submitter?.value ?? "cancel";
    if (value !== "ok") {
      pendingOps = null;
      return;
    }
    ev.preventDefault();
    if (!pendingOps || opsInFlight) return;
    if (pendingOps.showUrlField && !isValidWorkerChatUrl(opsUrlInput?.value)) {
      return;
    }
    if (
      pendingOps.typedConfirm &&
      opsConfirmInput.value.trim() !== pendingOps.phrase
    ) {
      return;
    }
    void executePendingOps();
  });
}

if (cmdsEl) renderCommands(cmdsEl);
if (cmdsDownEl) renderCommands(cmdsDownEl);
if (cmdsEl) bindCopy(cmdsEl);
if (cmdsDownEl) bindCopy(cmdsDownEl);

// Browser startup initialization
if (typeof window !== "undefined" && typeof document !== "undefined") {
  void ensureCsrf().catch(() => {});
  if (topologyEl) void loadTopology();
  tick();
  setInterval(tick, 2000);
}
