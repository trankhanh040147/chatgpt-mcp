#!/usr/bin/env python3
"""
Cursor beforeMCPExecution: record conversation_id for handoff_create_task.

CallDynamicTool often drops preToolUse updated_input. This hook cannot rewrite
MCP args, but it sees conversation_id — persist a hint the MCP server reads.
Always fail-open (permission allow).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

WRAPPED_TOOL_NAMES = frozenset(
    {
        "call_mcp_tool",
        "CallMcpTool",
        "CallDynamicTool",
        "call_dynamic_tool",
    }
)

CHATGPT_MCP_NAMESPACE_RE = (
    "chatgpt-mcp",
    "user-chatgpt-mcp",
)


def _hints_path() -> Path:
    raw = os.environ.get("HANDOFF_CURSOR_HINTS_PATH", "").strip()
    if raw:
        return Path(raw).expanduser()
    db = os.environ.get("HANDOFF_DB_PATH", "").strip()
    if db:
        return Path(db).expanduser().resolve().parent / "cursor-session-hints.jsonl"
    return Path.cwd() / "data" / "cursor-session-hints.jsonl"


def _record_session_hint(
    conversation_id: str,
    tool_name: str | None,
    prompt: str | None,
) -> None:
    path = _hints_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    prefix = (prompt or "").replace("\n", " ").strip()[:160]
    line = json.dumps(
        {
            "ts": __import__("datetime").datetime.utcnow().isoformat() + "Z",
            "conversationId": conversation_id,
            "toolName": tool_name,
            "promptPrefix": prefix,
        }
    )
    with path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def _extract_conversation_id(event: dict) -> str | None:
    for key in (
        "conversation_id",
        "conversationId",
        "composer_id",
        "composerId",
        "chat_id",
        "chatId",
        "session_id",
        "sessionId",
        "generation_id",
        "generationId",
    ):
        value = event.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _is_wrapped_tool_name(tool_name: str | None) -> bool:
    if not isinstance(tool_name, str):
        return False
    return tool_name in WRAPPED_TOOL_NAMES or tool_name.lower() in WRAPPED_TOOL_NAMES


def _strip_mcp_prefix(tool_name: str) -> str:
    if tool_name.upper().startswith("MCP:"):
        return tool_name[4:].strip()
    return tool_name


def _is_handoff_create_task(tool_name: str | None, tool_input: dict) -> bool:
    if isinstance(tool_name, str):
        bare = _strip_mcp_prefix(tool_name)
        if bare == "handoff_create_task":
            return True
        if _is_wrapped_tool_name(tool_name):
            ns = (
                tool_input.get("namespace")
                or tool_input.get("Namespace")
                or tool_input.get("server_name")
                or tool_input.get("serverName")
                or ""
            )
            inner = (
                tool_input.get("toolName")
                or tool_input.get("tool_name")
                or tool_input.get("ToolName")
                or ""
            )
            if any(tag in str(ns) for tag in CHATGPT_MCP_NAMESPACE_RE) and inner == "handoff_create_task":
                return True
    return False


def main() -> None:
    event = json.load(sys.stdin)
    tool_name = (
        event.get("tool_name")
        or event.get("toolName")
        or event.get("tool")
        or event.get("mcp_tool_name")
        or event.get("mcpToolName")
    )
    raw_input = (
        event.get("tool_input")
        or event.get("toolInput")
        or event.get("arguments")
        or event.get("args")
        or event.get("input")
        or {}
    )
    if not isinstance(raw_input, dict):
        raw_input = {}

    looks_like_handoff = _is_handoff_create_task(tool_name, raw_input) or (
        isinstance(tool_name, str)
        and _strip_mcp_prefix(tool_name) == "handoff_create_task"
    )
    if not looks_like_handoff:
        print("{}")
        return

    conversation_id = _extract_conversation_id(event)
    if not conversation_id:
        print(json.dumps({"permission": "allow"}))
        return

    prompt = raw_input.get("prompt")
    if prompt is None and _is_wrapped_tool_name(tool_name):
        args = raw_input.get("arguments") or raw_input.get("Arguments") or {}
        if isinstance(args, dict):
            prompt = args.get("prompt")

    _record_session_hint(
        conversation_id=conversation_id,
        tool_name=tool_name if isinstance(tool_name, str) else None,
        prompt=prompt if isinstance(prompt, str) else None,
    )
    print(json.dumps({"permission": "allow"}))


if __name__ == "__main__":
    main()
