#!/usr/bin/env python3
"""Inject Cursor conversation_id into handoff.create_task MCP calls."""

import json
import sys


def main() -> None:
    event = json.load(sys.stdin)
    tool_input = dict(event.get("tool_input") or {})
    conversation_id = event.get("conversation_id")

    if conversation_id:
        tool_input["cursorConversationId"] = conversation_id

    print(json.dumps({"updated_input": tool_input}))


if __name__ == "__main__":
    main()
