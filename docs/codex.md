# Using Codex instead of Claude Code

Codex (OpenAI) works as the client, but it's the opposite of Claude Code on timeouts:

- It reads `~/.codex/config.toml`, **not** `.mcp.json`, and **ignores the `timeout` field**.
- All Codex harnesses (CLI, VS Code extension, Windows app) enforce a **hard ~120 s
  `awaiting tools/call` deadline** that `tool_timeout_sec` does **not** reliably raise
  ([openai/codex#13831](https://github.com/openai/codex/issues/13831)). So unlike Claude Code, a
  single blocking call **cannot exceed ~120 s** on Codex.

Therefore, do the **reverse** of the [Claude Code tuning](configuration.md#tuning-how-long-a-call-waits):
keep **both** windows safely **under** 120 s so the proxy returns `keep_waiting` before Codex gives
up, and the agent re-polls. `90` is a good value. See
[`configs/codex.config.toml`](../configs/codex.config.toml):

```toml
[mcp_servers.auto-review]
command = "npx"
args = ["-y", "@permissionbrick/auto-review-mcp", "--role", "developer"]  # reviewer in its own config
env = { AUTO_REVIEW_POLL_SECONDS = "90", AUTO_REVIEW_WAIT_SECONDS = "90" }   # MUST be < Codex's ~120 s ceiling
startup_timeout_sec = 30
tool_timeout_sec = 110
```

Handoffs are still instant — the windows only set how often an idle waiter re-polls. The
singleton-coordinator rule still applies: both agents need the same `AUTO_REVIEW_POLL_SECONDS`, and
you must kill any running coordinator for a changed poll window to take effect
(`AUTO_REVIEW_WAIT_SECONDS` lives in each proxy, so restarting the agent is enough for that one).

## Avoiding re-polls: the shell poll command

Re-polling under 120 s works but is chatty. To get long, quiet waits anyway, there's a built-in
escape hatch: an MCP tool call is capped at ~120 s, but a **shell command isn't**. When
`get_next_review` / `request_review` is killed by Codex's `timed out awaiting tools/call` error, the
agent never receives a result — so the tool **descriptions** (not the responses) tell it to fall
back to a blocking shell command that waits without the limit and prints the same JSON:

```
# the tool description already prints the exact command (absolute paths, ready to paste); by name:
npx -y -p @permissionbrick/auto-review-mcp auto-review-cli next-review    --port 8765 --timeout 1500   # reviewer
npx -y -p @permissionbrick/auto-review-mcp auto-review-cli await-verdict  --port 8765 --timeout 1500   # developer
```

These hit a plain-HTTP long-poll endpoint on the coordinator, hide `keep_waiting` internally, and
block until there's a real result (give the command a long *command* timeout, ~25 min). They're not
just for timeout errors: a normal `keep_waiting` reply quotes the matching command (with absolute
paths) as the **preferred** way to keep waiting, since one foreground shell wait replaces many MCP
re-polls.

With this fallback you can even set a **long** poll window (so the MCP call carries the fast case
within 120 s and the shell command carries longer waits). Verify it with `npm run demo:cli`.

## Prompting Codex agents

Use the [suggested prompts](../README.md#quick-start), allow shell commands, and add:

> If a `get_next_review`/`request_review` call ever fails with `timed out awaiting tools/call`,
> follow that tool's CLIENT-TIMEOUT FALLBACK instructions — run the shell command it names to wait,
> then continue.
