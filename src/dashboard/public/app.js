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
const opsConfirmPhrase = document.getElementById("ops-confirm-phrase");
const opsConfirmInput = document.getElementById("ops-confirm-input");
const opsConfirmGo = document.getElementById("ops-confirm-go");

const COMMANDS = [
  "curl -s http://127.0.0.1:8787/health | jq",
  "make doctor",
  "npm run recover",
  "./scripts/start-broker-stack.sh",
];

let lastOkAt = null;
let selectedTaskId = null;
let selectedTaskStatus = null;
let opsCsrf = null;
let pendingOps = null; // { kind, phrase, planToken?, taskId? }
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

function showOpsResult(obj) {
  if (!opsResultEl) return;
  opsResultEl.classList.remove("hidden");
  opsResultEl.hidden = false;
  opsResultEl.textContent =
    typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
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

function openOpsModal({ title, preview, phrase, pending }) {
  pendingOps = pending;
  opsModalTitle.textContent = title;
  opsModalPreview.textContent = preview;
  opsConfirmPhrase.textContent = phrase;
  opsConfirmInput.value = "";
  opsConfirmGo.disabled = true;
  opsConfirmGo.className = pending.kind === "fail" ? "danger" : "primary";
  if (typeof opsModal.showModal === "function") opsModal.showModal();
  else opsModal.setAttribute("open", "");
  opsConfirmInput.focus();
}

function closeOpsModal() {
  pendingOps = null;
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
      phrase: preview.confirmPhrase,
      pending: {
        kind: "recover",
        phrase: preview.confirmPhrase,
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
  const phrase = `FAIL ${selectedTaskId}`;
  openOpsModal({
    title: "Fail task",
    preview: `Mark ${selectedTaskId} (${selectedTaskStatus ?? "?"}) as FAILED.\nClears lease capability fields; preserves lease_owner for attribution.`,
    phrase,
    pending: { kind: "fail", phrase, taskId: selectedTaskId },
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
        confirm: pendingOps.phrase,
      });
      closeOpsModal();
      showOpsResult(result);
      await tick();
    } else if (pendingOps.kind === "fail") {
      const result = await postOps("/ops/tasks/fail", {
        confirm: pendingOps.phrase,
        taskId: pendingOps.taskId,
      });
      closeOpsModal();
      showOpsResult(result);
      if (selectedTaskId) await showTaskDetail(selectedTaskId);
      await tick();
    }
  } catch (err) {
    showOpsResult(err instanceof Error ? err.message : String(err));
    if (err?.code === "plan_stale") closeOpsModal();
  } finally {
    opsInFlight = false;
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
        <div class="row"><span class="muted">Health</span><span>${w.healthy ? "Healthy" : "Unhealthy"}</span></div>
        <div class="row"><span class="muted">PID</span><span>${w.pidAlive ? `${w.pid ?? "—"} · alive` : "dead"}</span></div>
        <div class="row"><span class="muted">Heartbeat</span><span>${w.heartbeatStale ? "stale" : "fresh"} · ${age(w.lastSeenAt)}</span></div>
        <div class="row"><span class="muted">Current task</span><span class="mono" title="${escapeHtml(w.currentTaskId ?? "")}">${escapeHtml(task)}</span></div>
        <div class="row"><span class="muted">Completed 24h</span><span>${w.completedLast24h ?? 0}</span></div>
        <div class="row"><span class="muted">Failed / TO 24h</span><span>${w.failedLast24h ?? 0} / ${w.timedOutLast24h ?? 0}</span></div>
        ${refRows}
        <div class="row"><span class="muted">Error</span><span>${escapeHtml(w.errorCode ?? "—")}</span></div>
        ${inds ? `<div class="indicators">${inds}</div>` : ""}
        ${chat}
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
  hints.push({
    kind: "neutral",
    text: "No rotation max configured — counts are informational (0.5 owns budget)",
  });

  if (live.length === 0) {
    hints.push({
      kind: "warn",
      text: "No workers registered — start browser-broker / stack",
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
    const [health, workersBody, tasksBody] = await Promise.all([
      fetchJson("/health"),
      fetchJson("/workers"),
      fetchJson("/tasks?limit=10"),
    ]);
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
    renderWorkers(workersBody.workers ?? [], showRef);
    renderTasks(tasksBody.tasks ?? [], showRef);
    renderHints(workersBody.workers ?? [], health);
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

if (opsConfirmInput) {
  opsConfirmInput.addEventListener("input", () => {
    if (!opsConfirmGo) return;
    opsConfirmGo.disabled =
      !pendingOps || opsConfirmInput.value.trim() !== pendingOps.phrase;
  });
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
    if (
      !pendingOps ||
      opsConfirmInput.value.trim() !== pendingOps.phrase ||
      opsInFlight
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
