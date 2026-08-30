const healthPill = document.getElementById("health-pill");
const updatedEl = document.getElementById("updated");
const clock = document.getElementById("clock");
const planeKv = document.getElementById("plane-kv");
const workersEl = document.getElementById("workers");
const workerCount = document.getElementById("worker-count");
const tasksEl = document.getElementById("tasks");
const taskCount = document.getElementById("task-count");
const hintsEl = document.getElementById("hints");
const cmdsEl = document.getElementById("cmds");
const cmdsDownEl = document.getElementById("cmds-down");
const liveEl = document.getElementById("live");
const unreachableEl = document.getElementById("unreachable");
const lastSeenEl = document.getElementById("last-seen");
const drawer = document.getElementById("drawer");
const drawerBackdrop = document.getElementById("drawer-backdrop");
const drawerBody = document.getElementById("drawer-body");
const drawerContent = document.getElementById("drawer-content");
const drawerUsage = document.getElementById("drawer-usage");
const loadContentBtn = document.getElementById("load-content");
const failTaskBtn = document.getElementById("fail-task");
const drawerClose = document.getElementById("drawer-close");
const btnRecover = document.getElementById("btn-recover");
const btnRecoverQueued = document.getElementById("btn-recover-queued");
const opsResultEl = document.getElementById("ops-result");
const btnTopology = document.getElementById("btn-topology");
const topologyEl = document.getElementById("topology");
const opsModal = document.getElementById("ops-modal");
const opsForm = document.getElementById("ops-form");
const opsModalTitle = document.getElementById("ops-modal-title");
const opsModalPreview = document.getElementById("ops-modal-preview");
const opsModalError = document.getElementById("ops-modal-error");
const opsConfirmPhrase = document.getElementById("ops-confirm-phrase");
const opsConfirmInput = document.getElementById("ops-confirm-input");
const opsConfirmGo = document.getElementById("ops-confirm-go");
const opsConfirmBlock = document.getElementById("ops-confirm-block");
const opsUrlBlock = document.getElementById("ops-url-block");
const opsUrlInput = document.getElementById("ops-url-input");
const btnAddWorker = document.getElementById("btn-add-worker");
const workerAlert = document.getElementById("worker-alert");

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

function age(iso) {
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

function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function formatEstimatedTokens(value) {
  if (value == null || !Number.isFinite(value)) return null;
  if (value >= 1_000_000) return `≈${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `≈${(value / 1_000).toFixed(1)}k`;
  return `≈${Math.round(value)}`;
}

function formatEstimatedMoney(value) {
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

function middleTruncate(id, head = 10, tail = 5) {
  if (!id) return "—";
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

function healthStateClass(state) {
  switch (state) {
    case "READY":
      return "ok";
    case "DEGRADED":
      return "warn";
    case "BLOCKED":
    case "OFFLINE":
      return "bad";
    default:
      return "warn";
  }
}

function mergeWorkerRows(baseWorkers, healthWorkers) {
  const byId = new Map((healthWorkers ?? []).map((w) => [w.id, w]));
  return (baseWorkers ?? []).map((w) => ({
    ...w,
    ...(byId.get(w.id) ?? {}),
  }));
}

function formatConditions(conditions) {
  if (!conditions?.length) return "";
  return conditions
    .map((c) => `${c.type}:${c.status} (${c.reason})`)
    .join(" · ");
}

const MCP_PROBE_BANNERS = {
  MCP_SAFETY_BLOCKED: {
    title: "MCP safety blocked",
    body: "Chat binding OK — OpenAI blocked the write tool before remote-mcp.",
    action: "Try <em>New chat…</em> for a fresh conversation.",
    border: "rgba(200,120,48,.45)",
    bg: "rgba(200,120,48,.08)",
  },
  MCP_APPROVAL_REQUIRED: {
    title: "MCP approval required",
    body: "Approve handoff MCP writes in ChatGPT.",
    action: "<em>Retry verify</em> after allowing the tool.",
    border: "rgba(200,120,48,.45)",
    bg: "rgba(200,120,48,.08)",
  },
  MCP_TOOL_NOT_INVOKED: {
    title: "MCP tool not invoked",
    body: "ChatGPT replied in chat without calling the MCP write tool.",
    action: "<em>New chat…</em> or <em>Retry verify</em>.",
    border: "rgba(200,120,48,.45)",
    bg: "rgba(200,120,48,.08)",
  },
  MCP_SUBMIT_TIMEOUT: {
    title: "MCP submit timeout",
    body: "No MCP write reached remote-mcp in the verification window.",
    action: "Check connector permissions; <em>Retry verify</em> or <em>New chat…</em>.",
    border: "rgba(200,120,48,.45)",
    bg: "rgba(200,120,48,.08)",
  },
  PROBE_RESULT_MISMATCH: {
    title: "Probe result mismatch",
    body: "remote-mcp received a submit but the canary did not match.",
    action: "<em>Retry verify</em> or <em>New chat…</em>.",
    border: "rgba(200,120,48,.45)",
    bg: "rgba(200,120,48,.08)",
  },
};

function renderMcpProbeBanner(w) {
  const spec = MCP_PROBE_BANNERS[w.readinessReason];
  if (!spec) return "";
  return `<div class="worker-op-banner" style="border-color:${spec.border};background:${spec.bg}"><strong>${escapeHtml(spec.title)}</strong> — ${escapeHtml(spec.body)} ${spec.action}</div>`;
}

function workerNeedsUrlAssign(w) {
  if (w.chatAccessDenied) return true;
  if (w.recommendedAction === "ASSIGN_URL") return true;
  for (const c of w.conditions ?? []) {
    if (c.type === "BINDING" && c.status === "FALSE") return true;
    if (c.type === "URL" && c.status === "FALSE") return true;
  }
  return false;
}

function workerOpsBlocked(w) {
  return Boolean(w.activeOperation || w.stuckInFlightTaskId);
}

/** Which worker action buttons to show — varies by healthState / readiness. */
function deriveWorkerActionBar(w, opts = {}) {
  const stuck = workerOpsBlocked(w);
  const blocked = w.healthState === "BLOCKED";
  const sessionLost = w.status === "SESSION_LOST";
  const needsRetry =
    w.recommendedAction === "RETRY_VERIFY" ||
    w.readinessReason === "CONSENT_REQUIRED" ||
    w.readinessReason === "MCP_APPROVAL_REQUIRED";

  if (blocked) {
    return {
      clearStuck: stuck,
      retry: needsRetry && !sessionLost,
      recreate: sessionLost || w.recommendedAction === "RECREATE_CHAT",
      assign: true,
      newChat: false,
      toggle: false,
      remove: opts.canRemove,
    };
  }

  const mcpDegraded =
    w.healthState === "DEGRADED" &&
    w.readinessReason &&
    String(w.readinessReason).startsWith("MCP_");

  if (mcpDegraded) {
    return {
      clearStuck: stuck,
      retry: true,
      recreate: w.recommendedAction === "RECREATE_CHAT",
      assign: workerNeedsUrlAssign(w),
      newChat: true,
      toggle: true,
      remove: opts.canRemove && !stuck,
    };
  }

  return {
    clearStuck: stuck,
    retry: needsRetry,
    recreate: sessionLost || w.recommendedAction === "RECREATE_CHAT",
    assign: true,
    newChat: true,
    toggle: true,
    remove: opts.canRemove && !stuck,
  };
}

function renderWorkerActions(w, opts = {}) {
  const id = escapeHtml(w.id);
  const bar = deriveWorkerActionBar(w, opts);
  const parts = [];

  if (bar.clearStuck) {
    parts.push(
      `<button type="button" class="danger" data-worker-action="clear-stuck" data-worker-id="${id}">Clear stuck</button>`
    );
  }
  if (bar.recreate) {
    parts.push(
      `<button type="button" class="danger" data-worker-action="kill" data-worker-id="${id}">Recreate chat…</button>`
    );
  }
  if (bar.retry) {
    parts.push(
      `<button type="button" class="primary" data-worker-action="retry" data-worker-id="${id}">Retry verify</button>`
    );
  }
  if (bar.assign) {
    const assignPrimary = workerNeedsUrlAssign(w);
    parts.push(
      `<button type="button" data-worker-action="assign" data-worker-id="${id}"${assignPrimary ? " class=\"primary\"" : ""}>Assign URL…</button>`
    );
  }
  if (bar.newChat) {
    parts.push(
      `<button type="button" data-worker-action="create" data-worker-id="${id}">New chat…</button>`
    );
  }
  if (bar.toggle) {
    const enabled = w.errorCode !== "DISABLED";
    parts.push(
      `<button type="button" data-worker-action="toggle" data-worker-id="${id}" data-enabled="${enabled ? "0" : "1"}">${enabled ? "Disable…" : "Enable…"}</button>`
    );
  }
  if (bar.remove) {
    parts.push(
      `<button type="button" class="danger" data-worker-action="remove" data-worker-id="${id}">Remove…</button>`
    );
  }
  return parts.join("");
}

function formatActiveOperation(op) {
  if (!op) return "";
  const err = op.lastError
    ? `<span class="worker-op-error">${escapeHtml(op.lastError)}</span>`
    : "";
  return `<div class="worker-op-banner">
    <span class="worker-op-label">Worker op</span>
    <strong>${escapeHtml(op.kind)}</strong>
    <span class="mono">${escapeHtml(op.state)}</span>
    <span class="muted">attempt ${op.attempt}</span>
    ${err}
  </div>`;
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
      `<strong>Session lost</strong> on ${escapeHtml(names)} — log into ChatGPT in the CDP window, then <em>Recreate chat…</em> or <em>Retry verify</em>.`
    );
  }
  const stuck = (workers ?? []).filter(
    (w) => w.id !== "default" && w.activeOperation
  );
  const accessDenied = (workers ?? []).filter(
    (w) => w.id !== "default" && w.chatAccessDenied
  );
  if (accessDenied.length > 0) {
    messages.push(
      `<strong>Chat access denied</strong> on ${escapeHtml(accessDenied.map((w) => w.id).join(", "))} — CDP Chrome cannot open the saved /c/ URL. Use <em>Assign URL…</em> with a chat you created in CDP (see setup guide above).`
    );
  }
  const urlMismatch = (workers ?? []).filter(
    (w) => w.id !== "default" && workerNeedsUrlAssign(w) && !w.chatAccessDenied
  );
  if (urlMismatch.length > 0 && healthMeta?.brokerReachable === false) {
    messages.push(
      `<strong>URL / binding mismatch</strong> on ${escapeHtml(urlMismatch.map((w) => w.id).join(", "))} — start broker first, then <em>Assign URL…</em> with a chat from CDP Chrome.`
    );
  }
  if (stuck.length > 0 && healthMeta?.brokerReachable === false) {
    messages.push(
      `Active ops on ${escapeHtml(stuck.map((w) => w.id).join(", "))} will retry every few seconds or use <em>Cancel stuck op</em> on the worker card.`
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

async function beginWorkerAssign(workerId) {
  if (opsInFlight) return;
  const state = await fetchJson("/workers/health");
  const row = (state.workers ?? []).find((w) => w.id === workerId);
  const currentUrl =
    row?.chatUrl ?? row?.workerUrl ?? "https://chatgpt.com/c/";
  openOpsModal({
    title: `Assign URL · ${workerId}`,
    preview:
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
      "Broker opens a new tab in CDP Chrome, switches to Chat, attaches Cursor from + menu, sends bootstrap → /c/ URL → probe.\n" +
      "Any stuck handoff or prior worker op on this card is cleared automatically.\n" +
      "If + menu does not list Cursor: attach manually in CDP, then use Assign URL instead.",
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
      "Append a new worker id to workers.json with placeholder URL; assign real chat URL afterward.",
    typedConfirm: false,
    pending: { kind: "worker-add", typedConfirm: false },
  });
}

async function runWorkerFailStuck(workerId) {
  if (opsInFlight) return;
  opsInFlight = true;
  try {
    const result = await postOps("/ops/workers/release-stuck-task", {
      workerId,
    });
    showOpsResult(result);
    await tick();
  } catch (err) {
    showOpsResult(err instanceof Error ? err.message : String(err));
  } finally {
    opsInFlight = false;
  }
}

async function runWorkerClearStuck(workerId) {
  if (opsInFlight) return;
  opsInFlight = true;
  try {
    const result = await postOps("/ops/workers/clear-stuck", { workerId });
    showOpsResult(result);
    await tick();
  } catch (err) {
    showOpsResult(err instanceof Error ? err.message : String(err));
  } finally {
    opsInFlight = false;
  }
}

async function runWorkerCancel(workerId) {
  if (opsInFlight) return;
  opsInFlight = true;
  try {
    const result = await postOps("/ops/workers/cancel-operation", { workerId });
    showOpsResult(result);
    await tick();
  } catch (err) {
    showOpsResult(err instanceof Error ? err.message : String(err));
  } finally {
    opsInFlight = false;
  }
}

async function runWorkerRetry(workerId) {
  if (opsInFlight) return;
  opsInFlight = true;
  try {
    const result = await postOps("/ops/workers/retry-verify", { workerId });
    showOpsResult(result);
    await tick();
  } catch (err) {
    showOpsResult(err instanceof Error ? err.message : String(err));
  } finally {
    opsInFlight = false;
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
  el.textContent = text;
  el.className = `pill ${kind}`;
}

function escapeHtml(s) {
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
  opsModalTitle.textContent = title;
  opsModalPreview.textContent = preview;
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
  } else if (needTyped) {
    opsConfirmPhrase.textContent = phrase;
    opsConfirmInput.value = "";
    opsConfirmInput.focus();
  }
  opsConfirmGo.className =
    pending.kind === "fail" ? "danger" : typedConfirm ? "danger" : "primary";
  if (opsConfirmGo) {
    opsConfirmGo.textContent = showUrlField ? "Assign URL" : typedConfirm ? "Execute" : "Confirm";
  }
  syncOpsModalGoState();
  if (typeof opsModal.showModal === "function") opsModal.showModal();
  else opsModal.setAttribute("open", "");
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
  if (typeof opsModal.close === "function") opsModal.close();
  else opsModal.removeAttribute("open");
}

async function beginRecover(failQueued) {
  if (opsInFlight) return;
  opsInFlight = true;
  if (btnRecover) btnRecover.disabled = true;
  if (btnRecoverQueued) btnRecoverQueued.disabled = true;
  try {
    const preview = await postOps("/ops/recover/preview", { failQueued });
    openOpsModal({
      title: failQueued ? "Recover + fail queued" : "Recover",
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
        note: `Watch the Worker op banner on the card. Broker must be up (:${lastBrokerOpsPort}).`,
      });
      await tick();
    } else if (pendingOps.kind === "worker-create") {
      const result = await postOps("/ops/workers/create-chat", {
        workerId: pendingOps.workerId,
      });
      closeOpsModal();
      showOpsResult({
        ...result,
        note: `Watch the Worker op banner on the card. Broker must be up (:${lastBrokerOpsPort}).`,
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
        note: `Watch the Worker op banner on the card. Broker must be up (:${lastBrokerOpsPort}).`,
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
      showOpsResult(result);
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
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setOpsModalError(msg);
    showOpsResult(msg);
    if (err?.code === "plan_stale") closeOpsModal();
  } finally {
    opsInFlight = false;
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
  container.innerHTML = COMMANDS.map(
    (cmd) => `<div class="cmd-row">
      <code title="${escapeHtml(cmd)}">${escapeHtml(cmd)}</code>
      <button type="button" data-copy="${escapeHtml(cmd)}">copy</button>
    </div>`
  ).join("");
}

function bindCopy(root) {
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

function renderPlane(health, workersBody) {
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
  const usdAll = formatEstimatedMoney(allTime?.apiEquivalentAvoidedUsd);
  const scenario =
    health.costConfig?.scenarioDisplayName || "configured scenario";

  const items = [
    {
      label: "Health",
      value: health.ok ? "OK" : "DOWN",
      kind: health.ok ? "ok" : "bad",
    },
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
      label: "Requeued",
      value: stats ? String(stats.requeued ?? 0) : "—",
      kind: "",
    },
    {
      label: "Timed out",
      value: stats ? String(stats.timedOut ?? 0) : "—",
      kind: stats?.timedOut ? "warn" : "",
    },
    {
      label: "Failed",
      value: stats ? String(stats.failed ?? 0) : "—",
      kind: stats?.failed ? "bad" : "",
    },
    {
      metric: true,
      labelHtml: `Tokens ${metricWindow("24h", true)}`,
      valueHtml: renderMetricChip({
        kind: "tokens",
        value: tok24,
        ariaLabel: `Estimated visible-text tokens last 24 hours: ${tok24 || "none"}`,
        title: "Estimated from stored prompt and result text",
      }),
    },
  ];

  if (showRef) {
    items.push(
      {
        metric: true,
        labelHtml: `Ref. cost ${metricWindow("24h")}`,
        labelTitle: `Reference API cost vs ${scenario} — not ChatGPT billing`,
        valueHtml: renderMetricChip({
          kind: "money",
          value: usd24,
          ariaLabel: `Reference API cost last 24 hours: ${usd24 || "none"}`,
          title: `Reference API cost vs ${scenario} — not ChatGPT billing or savings`,
        }),
      },
      {
        metric: true,
        labelHtml: `Ref. cost ${metricWindow("all time")}`,
        labelTitle: `Reference API cost vs ${scenario} — not ChatGPT billing`,
        valueHtml: renderMetricChip({
          kind: "money",
          value: usdAll,
          ariaLabel: `Reference API cost all time: ${usdAll || "none"}`,
          title: `Reference API cost vs ${scenario} — not ChatGPT billing or savings`,
        }),
      }
    );
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

function renderWorkers(workers, showReference) {
  const live = workers.filter((w) => w.id !== "default");
  if (live.length === 0) {
    workerCount.textContent = "0 registered";
    workersEl.innerHTML = `<article class="card empty">
      <h3>No workers registered</h3>
      <p class="muted" style="margin:0.4rem 0 0">
        Start the broker stack, then wait for worker heartbeats.
      </p>
    </article>`;
    return;
  }
  const healthyN = live.filter((w) => w.healthy).length;
  workerCount.textContent = `${live.length} registered · ${healthyN} healthy`;
  workersEl.innerHTML = live
    .map((w) => {
      const kind = pillClass(w.status, w.healthy);
      const task = w.currentTaskId
        ? middleTruncate(w.currentTaskId)
        : "—";
      const inds = (w.indicators ?? [])
        .map(
          (i) =>
            `<span class="ind ${escapeHtml(i.severity)}">${escapeHtml(i.label)}</span>`
        )
        .join("");
      const chat = w.chatUrl
        ? `<a class="chat-link" href="${escapeHtml(w.chatUrl)}" target="_blank" rel="noopener noreferrer">Open worker chat</a>`
        : `<span class="muted" style="display:block;margin-top:0.55rem;font-size:11px;font-family:var(--mono)">Chat URL unavailable</span>`;
      const refRows = showReference
        ? `<div class="row metric-row">
          <span class="metric-row__label" title="Reference API cost — not ChatGPT billing">Ref. cost ${metricWindow("24h")}</span>
          ${renderMetricChip({
            kind: "money",
            value: formatEstimatedMoney(w.usage?.last24h?.apiEquivalentAvoidedUsd),
            compact: true,
            ariaLabel: `Worker ${w.id} reference cost 24h`,
            title: "Reference API cost for comparison scenario — not ChatGPT billing",
          })}
        </div>
        <div class="row metric-row">
          <span class="metric-row__label" title="Reference API cost — not ChatGPT billing">Ref. cost ${metricWindow("all time")}</span>
          ${renderMetricChip({
            kind: "money",
            value: formatEstimatedMoney(w.usage?.allTime?.apiEquivalentAvoidedUsd),
            compact: true,
            ariaLabel: `Worker ${w.id} reference cost all time`,
            title: "Reference API cost for comparison scenario — not ChatGPT billing",
          })}
        </div>`
        : `<div class="row"><span class="muted">Tokens 24h</span><span class="mono">${escapeHtml(formatEstimatedTokens(w.usage?.last24h?.estimatedTokens) || "—")}</span></div>`;
      return `<article class="card ${kind}">
        <div class="card-head">
          <h3>${escapeHtml(w.id)}</h3>
          <span class="pill ${kind}">${escapeHtml(w.status)}</span>
        </div>
        ${w.healthState ? `<div class="row"><span class="muted">Ops health</span><span class="pill ${healthStateClass(w.healthState)} health-state">${escapeHtml(w.healthState)}</span></div>` : ""}
        ${formatActiveOperation(w.activeOperation)}
        ${w.stuckInFlightTaskId ? `<div class="worker-op-banner worker-stuck-banner"><strong>Handoff stuck</strong> — <code>${escapeHtml(w.stuckInFlightTaskId)}</code>${w.activeOperation ? " · worker op in flight" : ""}. Click <em>Clear stuck</em>.</div>` : ""}
        ${w.chatAccessDenied ? `<div class="worker-op-banner" style="border-color:rgba(200,72,48,.45);background:rgba(200,72,48,.08)"><strong>Chat access denied</strong> — use <em>Assign URL…</em> with a chat from CDP Chrome.</div>` : ""}
        ${w.readinessReason === "ROTATION_PENDING" ? `<div class="worker-op-banner" style="border-color:rgba(200,72,48,.45);background:rgba(200,72,48,.08)"><strong>Rotation in progress</strong> — wait for the op banner or <em>Cancel stuck op</em>.</div>` : ""}
        ${w.readinessReason === "ROTATION_FAILED" ? `<div class="worker-op-banner" style="border-color:rgba(200,120,48,.45);background:rgba(200,120,48,.08)"><strong>Rotation failed</strong> — binding or registry step failed; retry <em>Assign URL…</em> or <em>New chat…</em>.</div>` : ""}
        ${renderMcpProbeBanner(w)}
        <div class="row"><span class="muted">Health</span><span>${w.healthy ? "Healthy" : "Unhealthy"}</span></div>
        <div class="row"><span class="muted">PID</span><span>${w.pidAlive ? `${w.pid ?? "—"} · alive` : "dead"}</span></div>
        <div class="row"><span class="muted">Heartbeat</span><span>${w.heartbeatStale ? "stale" : "fresh"} · ${age(w.lastSeenAt)}</span></div>
        <div class="row"><span class="muted">Current task</span><span class="mono" title="${escapeHtml(w.currentTaskId ?? "")}">${escapeHtml(task)}</span></div>
        <div class="row"><span class="muted">Chat budget</span><span class="mono">${w.tasksOnChat ?? 0}/${w.maxTasksPerChat ?? "—"}</span></div>
        <div class="row"><span class="muted">Completed 24h</span><span>${w.completedLast24h ?? 0}</span></div>
        <div class="row"><span class="muted">Failed / TO 24h</span><span>${w.failedLast24h ?? 0} / ${w.timedOutLast24h ?? 0}</span></div>
        ${refRows}
        <div class="row"><span class="muted">Error</span><span>${escapeHtml(w.errorCode ?? "—")}</span></div>
        ${w.conditions?.length ? `<div class="conditions" title="${escapeHtml(formatConditions(w.conditions))}">${escapeHtml(formatConditions(w.conditions))}</div>` : ""}
        ${inds ? `<div class="indicators">${inds}</div>` : ""}
        ${chat}
        <div class="worker-actions">${renderWorkerActions(w, { canRemove: live.length > 1 })}</div>
      </article>`;
    })
    .join("");
}

function renderTasks(tasks, showReference) {
  const rows = tasks.slice(0, 10);
  taskCount.textContent = `Last ${rows.length}`;
  if (rows.length === 0) {
    tasksEl.innerHTML = `<tr><td colspan="9" class="muted">No handoff tasks yet</td></tr>`;
    return;
  }
  tasksEl.innerHTML = rows
    .map((t) => {
      const kind = pillClass(t.status, true);
      const sel = t.id === selectedTaskId ? "selected" : "";
      const finished = t.terminalAt || t.completedAt;
      const dur = t.totalMs != null ? fmtMs(t.totalMs) : "—";
      const usage = renderMetricPair(t.usageEstimate, showReference);
      return `<tr class="task-row ${sel}" data-task-id="${escapeHtml(t.id)}">
        <td title="${escapeHtml(t.id)}">${escapeHtml(middleTruncate(t.id))}</td>
        <td><span class="pill ${kind}">${escapeHtml(t.status)}</span></td>
        <td>${escapeHtml(t.leaseOwner ?? "—")}</td>
        <td>${escapeHtml(t.type)}</td>
        <td>${escapeHtml(age(t.createdAt))}</td>
        <td title="${escapeHtml(finished ?? "")}">${finished ? escapeHtml(age(finished)) + " ago" : "—"}</td>
        <td title="queue ${fmtMs(t.queueMs)} · processing ${fmtMs(t.processingMs)}">${escapeHtml(dur)}</td>
        <td>${usage}</td>
        <td>${escapeHtml(t.errorCode ?? "—")}</td>
      </tr>`;
    })
    .join("");
}

function renderHints(workers, health) {
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
      w.healthState === "BLOCKED" ||
      w.readinessReason === "CONSENT_REQUIRED" ||
      w.readinessReason === "MCP_APPROVAL_REQUIRED" ||
      w.status === "SESSION_LOST"
  );
  if (blocked.length > 0) {
    hints.push({
      kind: "warn",
      text: `Worker ops: ${blocked.map((w) => w.id).join(", ")} need dashboard action (consent / session / bind)`,
    });
  }

  const mcpDegraded = live.filter((w) =>
    w.healthState === "DEGRADED" &&
    w.readinessReason &&
    String(w.readinessReason).startsWith("MCP_")
  );
  if (mcpDegraded.length > 0) {
    hints.push({
      kind: "warn",
      text: `MCP probe degraded (binding may be OK): ${mcpDegraded.map((w) => `${w.id} (${w.readinessReason})`).join(", ")}`,
    });
  }

  const readyN = live.filter((w) => w.healthState === "READY").length;
  if (readyN > 0 && readyN === live.length) {
    hints.push({
      kind: "ok",
      text: "All workers READY — URL changes reconcile without RESTART_REQUIRED",
    });
  } else if (healthy.length === 0) {
    hints.push({ kind: "bad", text: "No healthy workers" });
  }

  for (const w of live) {
    for (const ind of w.indicators ?? []) {
      if (ind.severity === "bad" || ind.severity === "warn") {
        hints.push({ kind: ind.severity, text: `${w.id}: ${ind.label}` });
      }
    }
  }

  hintsEl.innerHTML = hints
    .map((h) => `<li class="${h.kind}">${escapeHtml(h.text)}</li>`)
    .join("");
}

function setUnreachable(on, errMsg) {
  liveEl.classList.toggle("hidden", on);
  liveEl.hidden = on;
  unreachableEl.classList.toggle("hidden", !on);
  unreachableEl.hidden = !on;
  if (on) {
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
  drawer.classList.remove("hidden");
  drawer.hidden = false;
  drawerBackdrop.classList.remove("hidden");
  drawerBackdrop.hidden = false;
}

function closeDrawer() {
  drawer.classList.add("hidden");
  drawer.hidden = true;
  drawerBackdrop.classList.add("hidden");
  drawerBackdrop.hidden = true;
  drawerContent.classList.add("hidden");
  drawerContent.hidden = true;
  drawerContent.textContent = "";
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
  drawerBody.textContent = "Loading…";
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
    renderDrawerUsage(d.usageEstimate);
  } catch (err) {
    drawerBody.textContent =
      err instanceof Error ? err.message : String(err);
    renderDrawerUsage(null);
  }
}

async function loadRedactedContent() {
  if (!selectedTaskId) return;
  loadContentBtn.disabled = true;
  drawerContent.classList.remove("hidden");
  drawerContent.hidden = false;
  drawerContent.textContent = "Loading redacted content…";
  try {
    const c = await fetchJson(
      `/tasks/${encodeURIComponent(selectedTaskId)}/content`
    );
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
  } catch (err) {
    drawerContent.textContent =
      err instanceof Error ? err.message : String(err);
  } finally {
    loadContentBtn.disabled = false;
  }
}

async function tick() {
  const now = new Date();
  clock.textContent = formatClock(now);
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
    updatedEl.textContent = `Updated ${now.toLocaleTimeString(undefined, { hour12: false })}`;
    setUnreachable(false);
    setPill(
      healthPill,
      health.ok ? "API OK" : "API DOWN",
      health.ok ? "ok" : "bad"
    );
    renderPlane(health, workersBody);
    const showRef =
      health.referencePricingEnabled === true ||
      health.costConfig?.referencePricingEnabled === true;
    if (healthBody.brokerOpsPort) {
      lastBrokerOpsPort = healthBody.brokerOpsPort;
    }
    renderWorkerAlert(mergedWorkers, {
      brokerReachable: healthBody.brokerReachable,
      brokerConfigured: healthBody.brokerConfigured,
      brokerOpsPort: healthBody.brokerOpsPort ?? lastBrokerOpsPort,
    });
    renderWorkers(mergedWorkers, showRef);
    renderTasks(tasksBody.tasks ?? [], showRef);
    renderHints(mergedWorkers, health);
  } catch (err) {
    setPill(healthPill, "API DOWN", "bad");
    updatedEl.textContent = lastOkAt
      ? `Last seen ${age(lastOkAt)} ago`
      : "Updated —";
    setUnreachable(true, err instanceof Error ? err.message : String(err));
  }
}

tasksEl.addEventListener("click", (ev) => {
  const tr = ev.target.closest("tr[data-task-id]");
  if (!tr) return;
  const id = tr.getAttribute("data-task-id");
  if (id) void showTaskDetail(id);
});

function onClick(el, fn) {
  if (!el) return;
  el.addEventListener("click", fn);
}

onClick(drawerClose, closeDrawer);
onClick(drawerBackdrop, closeDrawer);
onClick(loadContentBtn, () => void loadRedactedContent());
onClick(failTaskBtn, () => void beginFailTask());
onClick(btnRecover, () => void beginRecover(false));
onClick(btnRecoverQueued, () => void beginRecover(true));
onClick(btnTopology, () => void loadTopology());
onClick(btnAddWorker, () => void beginAddWorker());

workersEl.addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-worker-action]");
  if (!btn) return;
  const workerId = btn.getAttribute("data-worker-id");
  const action = btn.getAttribute("data-worker-action");
  if (!workerId || !action) return;
  if (action === "assign") void beginWorkerAssign(workerId);
  else if (action === "create") void beginWorkerCreate(workerId);
  else if (action === "kill") void beginWorkerKill(workerId);
  else if (action === "clear-stuck") void runWorkerClearStuck(workerId);
  else if (action === "cancel") void runWorkerClearStuck(workerId);
  else if (action === "fail-stuck") void runWorkerClearStuck(workerId);
  else if (action === "retry") void runWorkerRetry(workerId);
  else if (action === "toggle") {
    const enable = btn.getAttribute("data-enabled") === "1";
    void beginWorkerToggle(workerId, enable);
  } else if (action === "remove") void beginWorkerRemove(workerId);
});

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

renderCommands(cmdsEl);
renderCommands(cmdsDownEl);
bindCopy(cmdsEl);
bindCopy(cmdsDownEl);
void ensureCsrf().catch(() => {});
if (topologyEl) void loadTopology();
tick();
setInterval(tick, 2000);
