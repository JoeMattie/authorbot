#!/usr/bin/env python3
"""Submit one new Authorbot chapter draft with Python's standard library.

Usage:
    printf '%s\n' 'Chapter prose.' | python3 submit-chapter-draft.py 'Title'

Required environment variables:
    AUTHORBOT_API, AUTHORBOT_PROJECT, AUTHORBOT_TOKEN

Optional environment variables:
    AUTHORBOT_SLUG, AUTHORBOT_SUMMARY

The token is read only from the environment. Never pass it as an argument.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, NoReturn


USER_AGENT = "authorbot-agent/1.0"
POLL_INTERVAL_SECONDS = 1.0
POLL_TIMEOUT_SECONDS = 120.0


def fail(message: str) -> NoReturn:
    print(f"submit-chapter-draft: {message}", file=sys.stderr)
    raise SystemExit(1)


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        fail(f"{name} is required")
    return value


API = required_env("AUTHORBOT_API").rstrip("/")
PROJECT = required_env("AUTHORBOT_PROJECT")
TOKEN = required_env("AUTHORBOT_TOKEN")


def request(method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, Any]:
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {TOKEN}",
        # Cloudflare may reject urllib's default Python-urllib/... user agent
        # with error 1010 before the request reaches Authorbot.
        "User-Agent": USER_AGENT,
    }
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        headers["Idempotency-Key"] = str(uuid.uuid4())
        data = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(f"{API}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            payload: Any = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"detail": raw.strip() or error.reason}
        return error.code, payload
    except urllib.error.URLError as error:
        fail(f"request did not complete: {error.reason}")


def problem(payload: Any) -> str:
    if isinstance(payload, dict):
        code = payload.get("code")
        detail = payload.get("detail") or payload.get("title")
        if code and detail:
            return f"{code}: {detail}"
        if detail:
            return str(detail)
    return json.dumps(payload, ensure_ascii=False)


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: submit-chapter-draft.py 'Chapter title' < body.md")
    title = sys.argv[1].strip()
    body = sys.stdin.read()
    if not title:
        fail("chapter title must not be empty")
    if not body.strip():
        fail("chapter body must be provided on standard input")

    status, me = request("GET", "/v1/me")
    if status != 200 or not isinstance(me, dict):
        fail(f"identity check failed (HTTP {status}): {problem(me)}")
    actor = me.get("actor") if isinstance(me.get("actor"), dict) else {}
    memberships = me.get("memberships") if isinstance(me.get("memberships"), list) else []
    role = memberships[0].get("role") if memberships and isinstance(memberships[0], dict) else None
    scopes = me.get("scopes") if isinstance(me.get("scopes"), list) else []
    print(
        f"actor={actor.get('displayName', actor.get('id', 'unknown'))} "
        f"role={role or 'none'} scopes={','.join(str(scope) for scope in scopes)}"
    )

    command: dict[str, Any] = {"title": title, "body": body}
    slug = os.environ.get("AUTHORBOT_SLUG", "").strip()
    summary = os.environ.get("AUTHORBOT_SUMMARY", "").strip()
    if slug:
        command["slug"] = slug
    if summary:
        command["summary"] = summary

    project = urllib.parse.quote(PROJECT, safe="")
    status, accepted = request("POST", f"/v1/projects/{project}/chapter-submissions", command)
    if status != 202 or not isinstance(accepted, dict):
        fail(f"draft submission failed (HTTP {status}): {problem(accepted)}")

    operation_id = accepted.get("operationId")
    chapter_id = accepted.get("chapterId")
    if not isinstance(operation_id, str) or not isinstance(chapter_id, str):
        fail("202 response did not include chapterId and operationId")
    print(f"draft queued: chapter={chapter_id} operation={operation_id}")

    deadline = time.monotonic() + POLL_TIMEOUT_SECONDS
    operation_path = f"/v1/projects/{project}/operations/{urllib.parse.quote(operation_id, safe='')}"
    while time.monotonic() < deadline:
        status, operation = request("GET", operation_path)
        if status != 200 or not isinstance(operation, dict):
            fail(f"operation read failed (HTTP {status}): {problem(operation)}")
        state = operation.get("state")
        if state in {"committed", "verified"}:
            print(f"draft committed: {operation.get('commitSha', 'commit sha unavailable')}")
            return
        if state == "failed":
            fail(f"operation failed: {operation.get('error') or 'no error detail'}")
        time.sleep(POLL_INTERVAL_SECONDS)

    fail(f"operation {operation_id} did not finish within {POLL_TIMEOUT_SECONDS:.0f}s")


if __name__ == "__main__":
    main()
