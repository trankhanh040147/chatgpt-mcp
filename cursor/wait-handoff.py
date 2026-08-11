#!/usr/bin/env python3
"""Poll handoff status and return followup_message when a task completes."""

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
    return os.environ.get("HANDOFF_DB_PATH", "./data/handoff.sqlite")


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
    timeout = env_int("HANDOFF_WAIT_TIMEOUT", 480)
    poll_interval = env_int("HANDOFF_POLL_INTERVAL", 2)
    deadline = time.time() + timeout

    while time.time() < deadline:
        status = get_task_status(task_id)
        if status == "COMPLETED":
            print(
                json.dumps(
                    {
                        "followup_message": (
                            f"External ChatGPT handoff {task_id} completed. "
                            f"Call handoff_get_result with taskId {task_id}, "
                            "evaluate the result, and continue the original task."
                        )
                    }
                )
            )
            return
        if status in ("FAILED", "TIMED_OUT", "CANCELLED"):
            print("{}")
            return
        time.sleep(poll_interval)

    final_status = get_task_status(task_id)
    if final_status == "COMPLETED":
        print(
            json.dumps(
                {
                    "followup_message": (
                        f"External ChatGPT handoff {task_id} completed. "
                        f"Call handoff_get_result with taskId {task_id}, "
                        "evaluate the result, and continue the original task."
                    )
                }
            )
        )
        return

    # Timed out — if result arrives later, mark for manual recovery
    later_status = get_task_status(task_id)
    if later_status == "COMPLETED":
        mark_ready_but_cursor_idle(task_id)

    print("{}")


if __name__ == "__main__":
    main()
