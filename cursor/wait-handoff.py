#!/usr/bin/env python3
"""Wait for handoff completion and return followup_message for Cursor stop hook.

Prefers GET /tasks/:id/wait (server long-poll). Falls back to local polling if
the worker is an older build without that route.

Followups are claimed once (terminal or wait-timeout) so FAILED/QUEUED tasks
cannot spam Cursor when stop.loop_limit is null or the agent ends another turn.
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


ACTIVE_STATUSES = (
    "QUEUED",
    "DISPATCHING",
    "DISPATCHED",
    "PROCESSING",
    "WAITING_APPROVAL",
    "RATE_LIMITED",
)
TERMINAL_STATUSES = ("COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT")


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


def http_json(url: str, timeout: float = 5) -> dict | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            return payload if isinstance(payload, dict) else None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None


def http_post_json(url: str, body: dict, timeout: float = 5) -> dict | None:
    raw = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=raw,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            return payload if isinstance(payload, dict) else None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None


def find_pending_task(conversation_id: str) -> dict | None:
    """Active handoff that has not already received a wait-timeout followup."""
    url = (
        f"{http_base()}/conversations/pending"
        f"?conversationId={urllib.parse.quote(conversation_id)}"
    )
    payload = http_json(url)
    if payload is not None:
        pending = payload.get("pending")
        return pending if pending else None

    if not os.path.exists(db_path()):
        return None

    conn = sqlite3.connect(db_path())
    try:
        row = conn.execute(
            f"""
            SELECT id, status FROM handoff_tasks
            WHERE cursor_conversation_id = ?
              AND status IN ({",".join("?" for _ in ACTIVE_STATUSES)})
              AND cursor_wait_notified_at IS NULL
            ORDER BY created_at ASC
            LIMIT 1
            """,
            (conversation_id, *ACTIVE_STATUSES),
        ).fetchone()
        if not row:
            return None
        return {"id": row[0], "status": row[1]}
    except sqlite3.OperationalError:
        # Pre-v7 schema without cursor_wait_notified_at.
        row = conn.execute(
            f"""
            SELECT id, status FROM handoff_tasks
            WHERE cursor_conversation_id = ?
              AND status IN ({",".join("?" for _ in ACTIVE_STATUSES)})
            ORDER BY created_at ASC
            LIMIT 1
            """,
            (conversation_id, *ACTIVE_STATUSES),
        ).fetchone()
        if not row:
            return None
        return {"id": row[0], "status": row[1]}
    finally:
        conn.close()


def find_unresumed_terminal(conversation_id: str) -> dict | None:
    url = (
        f"{http_base()}/conversations/unresumed-terminal"
        f"?conversationId={urllib.parse.quote(conversation_id)}"
    )
    payload = http_json(url)
    if payload is not None:
        task = payload.get("task")
        return task if task else None

    if not os.path.exists(db_path()):
        return None

    conn = sqlite3.connect(db_path())
    try:
        row = conn.execute(
            f"""
            SELECT id, status FROM handoff_tasks
            WHERE cursor_conversation_id = ?
              AND status IN ({",".join("?" for _ in TERMINAL_STATUSES)})
              AND cursor_followup_at IS NULL
            ORDER BY COALESCE(completed_at, created_at) ASC
            LIMIT 1
            """,
            (conversation_id, *TERMINAL_STATUSES),
        ).fetchone()
        if not row:
            return None
        return {"id": row[0], "status": row[1]}
    except sqlite3.OperationalError:
        return None
    finally:
        conn.close()


def get_task_status(task_id: str) -> str | None:
    url = f"{http_base()}/tasks/{urllib.parse.quote(task_id)}"
    payload = http_json(url)
    if payload is not None:
        status = payload.get("status")
        return status if isinstance(status, str) else None

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


def ack_followup(task_id: str, kind: str) -> bool:
    """Claim followup delivery. True = this invocation owns the message."""
    payload = http_post_json(
        f"{http_base()}/tasks/ack-followup",
        {"taskId": task_id, "kind": kind},
    )
    if payload is not None:
        return bool(payload.get("claimed"))

    if not os.path.exists(db_path()):
        return True  # fail-open: still emit once if API/DB unavailable

    conn = sqlite3.connect(db_path())
    try:
        now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"
        if kind == "wait_timeout":
            cur = conn.execute(
                f"""
                UPDATE handoff_tasks
                SET cursor_wait_notified_at = ?
                WHERE id = ?
                  AND cursor_wait_notified_at IS NULL
                  AND status IN ({",".join("?" for _ in ACTIVE_STATUSES)})
                """,
                (now, task_id, *ACTIVE_STATUSES),
            )
        else:
            cur = conn.execute(
                f"""
                UPDATE handoff_tasks
                SET cursor_followup_at = ?
                WHERE id = ?
                  AND cursor_followup_at IS NULL
                  AND status IN (
                    'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT',
                    'READY_BUT_CURSOR_IDLE'
                  )
                """,
                (now, task_id),
            )
        conn.commit()
        return cur.rowcount == 1
    except sqlite3.OperationalError:
        return True
    finally:
        conn.close()


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
            conn.execute(
                "UPDATE handoff_tasks SET cursor_followup_at = COALESCE(cursor_followup_at, ?) "
                "WHERE id = ?",
                (
                    time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
                    task_id,
                ),
            )
            conn.commit()
        except sqlite3.OperationalError:
            conn.rollback()
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


def timeout_still_pending_followup(task_id: str, status: str) -> str:
    return json.dumps(
        {
            "followup_message": (
                f"External ChatGPT handoff {task_id} is still {status} after the stop-hook wait budget. "
                "Tell the user the handoff has not finished yet. Do not keep waiting or polling in this turn. "
                f"They can check later with handoff_get_task_status taskId {task_id}. "
                "A later turn will resume automatically if the task completes or fails."
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


def emit_terminal(task_id: str, status: str) -> None:
    if not ack_followup(task_id, "terminal"):
        print("{}")
        return
    if status == "COMPLETED":
        print(completed_followup(task_id))
        return
    print(failed_followup(task_id, status))


def emit_wait_timeout(task_id: str, status: str) -> None:
    if not ack_followup(task_id, "wait_timeout"):
        print("{}")
        return
    print(timeout_still_pending_followup(task_id, status or "TIMEOUT"))


def main() -> None:
    event = json.load(sys.stdin)
    conversation_id = event.get("conversation_id")

    if not conversation_id:
        print("{}")
        return

    pending = find_pending_task(conversation_id)
    unresumed = None if pending else find_unresumed_terminal(conversation_id)

    if not pending and not unresumed:
        print("{}")
        return

    if unresumed and not pending:
        emit_terminal(unresumed["id"], unresumed.get("status") or "FAILED")
        return

    assert pending is not None
    task_id = pending["id"]
    timeout = env_int("HANDOFF_WAIT_TIMEOUT", 960)
    poll_interval = float(os.environ.get("HANDOFF_POLL_INTERVAL", "0.5"))

    status = wait_task_status(task_id, timeout)
    if status is None:
        status = poll_locally(task_id, timeout, poll_interval)

    if status == "COMPLETED":
        emit_terminal(task_id, status)
        return

    if status in ("FAILED", "CANCELLED", "TIMED_OUT"):
        emit_terminal(task_id, status)
        return

    # Timed out while still non-terminal — one followup, then stop re-waiting.
    later_status = get_task_status(task_id)
    if later_status == "COMPLETED":
        mark_ready_but_cursor_idle(task_id)
        emit_terminal(task_id, "COMPLETED")
        return
    if later_status in ("FAILED", "TIMED_OUT", "CANCELLED"):
        emit_terminal(task_id, later_status)
        return

    emit_wait_timeout(task_id, later_status or status or "TIMEOUT")


if __name__ == "__main__":
    main()
