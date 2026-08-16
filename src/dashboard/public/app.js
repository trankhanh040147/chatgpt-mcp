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
const loadContentBtn = document.getElementById("load-content");
const drawerClose = document.getElementById("drawer-close");

const COMMANDS = [
  "curl -s http://127.0.0.1:8787/health | jq",
  "make doctor",
  "npm run recover",
  "./scripts/start-broker-stack.sh",
];

let lastOkAt = null;
let selectedTaskId = null;

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

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
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
  ];
  planeKv.innerHTML = items
    .map(
      (it) => `<div class="kv">
        <dt>${escapeHtml(it.label)}</dt>
        <dd class="${it.kind}">${escapeHtml(it.value)}</dd>
      </div>`
    )
    .join("");
}

function renderWorkers(workers) {
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
        <div class="row"><span class="muted">Error</span><span>${escapeHtml(w.errorCode ?? "—")}</span></div>
        ${inds ? `<div class="indicators">${inds}</div>` : ""}
        ${chat}
      </article>`;
    })
    .join("");
}

function renderTasks(tasks) {
  const rows = tasks.slice(0, 10);
  taskCount.textContent = `Last ${rows.length}`;
  if (rows.length === 0) {
    tasksEl.innerHTML = `<tr><td colspan="8" class="muted">No handoff tasks yet</td></tr>`;
    return;
  }
  tasksEl.innerHTML = rows
    .map((t) => {
      const kind = pillClass(t.status, true);
      const sel = t.id === selectedTaskId ? "selected" : "";
      const finished = t.terminalAt || t.completedAt;
      const dur = t.totalMs != null ? fmtMs(t.totalMs) : "—";
      return `<tr class="task-row ${sel}" data-task-id="${escapeHtml(t.id)}">
        <td title="${escapeHtml(t.id)}">${escapeHtml(middleTruncate(t.id))}</td>
        <td><span class="pill ${kind}">${escapeHtml(t.status)}</span></td>
        <td>${escapeHtml(t.leaseOwner ?? "—")}</td>
        <td>${escapeHtml(t.type)}</td>
        <td>${escapeHtml(age(t.createdAt))}</td>
        <td title="${escapeHtml(finished ?? "")}">${finished ? escapeHtml(age(finished)) + " ago" : "—"}</td>
        <td title="queue ${fmtMs(t.queueMs)} · processing ${fmtMs(t.processingMs)}">${escapeHtml(dur)}</td>
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
  selectedTaskId = null;
}

async function showTaskDetail(taskId) {
  selectedTaskId = taskId;
  openDrawer();
  drawerBody.textContent = "Loading…";
  loadContentBtn.disabled = false;
  try {
    const d = await fetchJson(`/tasks/${encodeURIComponent(taskId)}/detail`);
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
  } catch (err) {
    drawerBody.textContent =
      err instanceof Error ? err.message : String(err);
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
    renderWorkers(workersBody.workers ?? []);
    renderTasks(tasksBody.tasks ?? []);
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

drawerClose.addEventListener("click", closeDrawer);
drawerBackdrop.addEventListener("click", closeDrawer);
loadContentBtn.addEventListener("click", () => void loadRedactedContent());

renderCommands(cmdsEl);
renderCommands(cmdsDownEl);
bindCopy(cmdsEl);
bindCopy(cmdsDownEl);
tick();
setInterval(tick, 2000);
