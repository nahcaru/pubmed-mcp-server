"""Canonical MCP `tools/list` hash (Exp 5, spec §Exp 5).

Launches an MCP server over stdio per a launch spec, retrieves the full
tools/list (following pagination cursors), canonicalizes it, and hashes it:

    normalized = sorted([{name, description, schema=inputSchema}], key=name)
    tools_hash = sha256(json.dumps(normalized, sort_keys=True))

The formula follows the spec sketch exactly so the CI-side value (embedded in
the SBOM as `mcp:tools_hash`) and the runtime-side value are comparable.

This file is self-contained (stdlib + `mcp` only): setup_tools_hash.py copies
it verbatim into each fork as .github/scripts/mcp_tools_hash.py, and the local
checker imports it. Keep it dependency-light.

Launch spec JSON:
    {
      "setup":   ["npm install", "npm run build"],   # run once, in cwd
      "command": "node",
      "args":    ["dist/index.js"],
      "env":     {"MCP_TRANSPORT_TYPE": "stdio"}     # merged over os.environ
    }

Usage:
    python mcp_tools_hash.py --launch mcp-launch.json --output tools-hash.json \
        [--cwd DIR] [--skip-setup] [--timeout 120] [--setup-timeout 900]

Output JSON: {tools_hash, tool_count, tool_names, tools, elapsed_s,
              setup_elapsed_s, error}. Exit code 1 if no hash was produced
    (the output file is still written so CI can upload it).
"""

import argparse
import asyncio
import hashlib
import json
import os
import subprocess
import sys
import time

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def canonicalize(tools) -> list[dict]:
    """Spec-normalized tool list: name + description + inputSchema, sorted."""
    return sorted(
        [
            {"name": t.name, "description": t.description, "schema": t.inputSchema}
            for t in tools
        ],
        key=lambda x: x["name"],
    )


def tools_hash(normalized: list[dict]) -> str:
    return hashlib.sha256(json.dumps(normalized, sort_keys=True).encode()).hexdigest()


async def _list_all_tools(session: ClientSession):
    tools, cursor = [], None
    while True:
        result = await session.list_tools(cursor=cursor)
        tools.extend(result.tools)
        cursor = result.nextCursor
        if not cursor:
            return tools


async def get_runtime_tools(command: str, args: list[str], env: dict, cwd: str,
                            timeout: float):
    """Launch the server over stdio and return its full tools/list."""
    params = StdioServerParameters(
        command=command,
        args=args,
        env={**os.environ, **env},
        cwd=cwd,
    )

    async def _run():
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                return await _list_all_tools(session)

    return await asyncio.wait_for(_run(), timeout=timeout)


def run_setup(commands: list[str], env: dict, cwd: str, timeout: float) -> None:
    for cmd in commands:
        print(f"[setup] {cmd}", file=sys.stderr, flush=True)
        subprocess.run(
            cmd, shell=True, cwd=cwd, env={**os.environ, **env},
            timeout=timeout, check=True,
            stdout=sys.stderr,  # keep stdout clean; all setup noise -> stderr
        )


def compute(spec: dict, cwd: str, skip_setup: bool, timeout: float,
            setup_timeout: float) -> dict:
    out = {
        "tools_hash": None, "tool_count": None, "tool_names": None,
        "tools": None, "elapsed_s": None, "setup_elapsed_s": None, "error": None,
    }
    try:
        if not skip_setup and spec.get("setup"):
            t0 = time.monotonic()
            run_setup(spec["setup"], spec.get("env", {}), cwd, setup_timeout)
            out["setup_elapsed_s"] = round(time.monotonic() - t0, 2)
        t0 = time.monotonic()
        tools = asyncio.run(
            get_runtime_tools(
                spec["command"], spec.get("args", []), spec.get("env", {}),
                cwd, timeout,
            )
        )
        normalized = canonicalize(tools)
        out.update(
            tools_hash=tools_hash(normalized),
            tool_count=len(normalized),
            tool_names=[t["name"] for t in normalized],
            tools=normalized,
            elapsed_s=round(time.monotonic() - t0, 3),
        )
    except BaseException as exc:  # incl. TimeoutError/CancelledError
        out["error"] = f"{type(exc).__name__}: {exc}"
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--launch", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--cwd", default=".")
    ap.add_argument("--skip-setup", action="store_true")
    ap.add_argument("--timeout", type=float, default=120)
    ap.add_argument("--setup-timeout", type=float, default=900)
    args = ap.parse_args()

    spec = json.load(open(args.launch))
    out = compute(spec, args.cwd, args.skip_setup, args.timeout, args.setup_timeout)
    with open(args.output, "w") as f:
        json.dump(out, f, indent=2)
    print(json.dumps({k: out[k] for k in ("tools_hash", "tool_count", "error")}))
    sys.exit(0 if out["tools_hash"] else 1)


if __name__ == "__main__":
    main()
