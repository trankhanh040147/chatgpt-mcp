#!/usr/bin/env python3
"""Wait for handoff completion and return followup_message for Cursor stop hook.

Prefers GET /tasks/:id/wait (server long-poll). Falls back to local polling if
the worker is an older build without that route.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return int(raw)


def db_path() -> str:
    raw = os.environ.get("HANDOFF_DB_PATH", "./data/handoff.sqlite")
    return os.path.abspath(os.path.expanduser(raw))


def http_base() -> str:
    port = env_int("HANDOFF_HTTP_PORT", 8787)
    return f"http://127.0.0.1:{port}"


def find_pending_task(conversation_id: str) -> dict | None:
    """Find an active handoff task for this conversation via HTTP or SQLite."""
    url = (
        f"{http_base()}/conversations/pending"
        f"?conversationId={urllib.parse.quote(conversation_id)}"
    )
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            pending = payload.get("pending")
            return pending if pending else None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        pass

    if not os.path.exists(db_path()):
        return None

    conn = sqlite3.connect(db_path())
    try:
        row = conn.execute(
            """
            SELECT id, status FROM handoff_tasks
            WHERE cursor_conversation_id = ?
              AND status IN (
                'QUEUED', 'DISPATCHING', 'DISPATCHED',
                'PROCESSING', 'WAITING_APPROVAL', 'RATE_LIMITED'
              )
            ORDER BY created_at ASC
            LIMIT 1
            """,
            (conversation_id,),
        ).fetchone()
        if not row:
            return None
        return {"id": row[0], "status": row[1]}
    finally:
        conn.close()


def get_task_status(task_id: str) -> str | None:
    url = f"{http_base()}/tasks/{urllib.parse.quote(task_id)}"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            return payload.get("status")
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        pass

    if not os.path.exists(db_path()):
        return None

    conn = sqlite3.connect(db_path())
    try:
        row = conn.execute(
            "SELECT status FROM handoff_tasks WHERE id = ?",
            (task_id,),
        ).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def wait_task_status(task_id: str, timeout_seconds: int) -> str | None:
    """Block until terminal status via server long-poll. None = use local fallback."""
    tick_ms = env_int("HANDOFF_WAIT_TICK_MS", 250)
    url = (
        f"{http_base()}/tasks/{urllib.parse.quote(task_id)}/wait"
        f"?timeoutSeconds={timeout_seconds}&tickMs={tick_ms}"
    )
    # urllib timeout must exceed server long-poll budget.
    http_timeout = timeout_seconds + 15
    try:
        with urllib.request.urlopen(url, timeout=http_timeout) as resp:
            if resp.status == 404:
                return None
            payload = json.loads(resp.read().decode("utf-8"))
            status = payload.get("status")
            return status if isinstance(status, str) else None
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return None
        return get_task_status(task_id)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None


def mark_ready_but_cursor_idle(task_id: str) -> None:
    url = f"{http_base()}/tasks/mark-idle"
    body = json.dumps({"taskId": task_id}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=5)
    except (urllib.error.URLError, TimeoutError):
        if not os.path.exists(db_path()):
            return
        conn = sqlite3.connect(db_path())
        try:
            conn.execute(
                "UPDATE handoff_tasks SET status = 'READY_BUT_CURSOR_IDLE' "
                "WHERE id = ? AND status = 'COMPLETED'",
                (task_id,),
            )
            conn.commit()
        finally:
            conn.close()


def completed_followup(task_id: str) -> str:
    return json.dumps(
        {
            "followup_message": (
                f"External ChatGPT handoff {task_id} completed. "
                f"Call handoff_get_result with taskId {task_id}, "
                "evaluate the result, and continue the original task. "
                "Do not poll handoff_get_task_status again."
            )
        }
    )


def failed_followup(task_id: str, status: str) -> str:
    return json.dumps(
        {
            "followup_message": (
                f"External ChatGPT handoff {task_id} ended with status {status}. "
                "Call handoff_get_result (or inspect worker logs / failure-*.png) to see the error, "
                "tell the user what failed, and either retry the handoff or continue without it. "
                "Do not keep polling status."
            )
        }
    )


def poll_locally(task_id: str, timeout: int, poll_interval: float) -> str | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = get_task_status(task_id)
        if status in ("COMPLETED", "FAILED", "CANCELLED"):
            return status
        time.sleep(poll_interval)
    return get_task_status(task_id)


def main() -> None:
    event = json.load(sys.stdin)
    conversation_id = event.get("conversation_id")

    if not conversation_id:
        print("{}")
        return

    pending = find_pending_task(conversation_id)
    if not pending:
        print("{}")
        return

    task_id = pending["id"]
    timeout = env_int("HANDOFF_WAIT_TIMEOUT", 960)
    poll_interval = float(os.environ.get("HANDOFF_POLL_INTERVAL", "0.5"))

    status = wait_task_status(task_id, timeout)
    if status is None:
        status = poll_locally(task_id, timeout, poll_interval)

    if status == "COMPLETED":
        print(completed_followup(task_id))
        return

    if status in ("FAILED", "CANCELLED"):
        print(failed_followup(task_id, status))
        return

    # Timed out while still non-terminal — one followup (loop_limit caps repeats).
    later_status = get_task_status(task_id)
    if later_status == "COMPLETED":
        mark_ready_but_cursor_idle(task_id)
        print(completed_followup(task_id))
        return
    if later_status in ("FAILED", "TIMED_OUT", "CANCELLED"):
        print(failed_followup(task_id, later_status))
        return

    print(failed_followup(task_id, later_status or "TIMEOUT"))


if __name__ == "__main__":
    main()
