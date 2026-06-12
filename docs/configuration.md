# Configuration

How to connect the two agents, every knob the server and proxy accept, and how to tune the wait
behaviour. For Codex-specific setup see [Using Codex](codex.md).

## Connect the two agents

Launch **two Claude Code instances** — one developer, one reviewer. Both must point at the **same
git repository** the developer edits (it must be a git repo, not this server's directory).

### Option A — `node`/stdio (recommended)

Each agent's `.mcp.json` runs the stdio proxy via `npx`; the first one auto-starts the shared
coordinator. Nothing to install or run by hand, and **no repo path in config** — the developer
agent declares it at runtime via `initialize_review_session`. Sample configs are in
[`configs/`](../configs/):

```jsonc
// configs/developer.mcp.json  (reviewer.mcp.json is identical with --role reviewer)
{
  "mcpServers": {
    "auto-review": {
      "command": "npx",
      "args": ["-y", "@permissionbrick/auto-review-mcp", "--role", "developer"],
      "env": { "AUTO_REVIEW_POLL_SECONDS": "240", "AUTO_REVIEW_WAIT_SECONDS": "600" },
      "timeout": 1800000
    }
  }
}
```

> **Tip:** drop the `"--role", "developer"` argument to give one agent *every* tool and assign its
> role in the prompt instead (it attaches to the combined `/both` endpoint). Keep `--role` to pin
> developer vs reviewer as above.

The shipped configs use a **240 s** poll window (`AUTO_REVIEW_POLL_SECONDS`, the practical max per
single HTTP hold) and a **600 s** agent-facing wait window (`AUTO_REVIEW_WAIT_SECONDS`): the proxy
loops over coordinator polls internally, so an *idle* agent is only re-prompted with `keep_waiting`
every ~10 min — and resuming costs just an `await_review(batch_id)` / `get_next_review()` call.
Handoffs are still instant. (See [Tuning how long a call waits](#tuning-how-long-a-call-waits).)

```bash
# Developer instance (point at the config above, e.g. configs/developer.mcp.json)
claude --mcp-config configs/developer.mcp.json --strict-mcp-config
# Reviewer instance (separate terminal)
claude --mcp-config configs/reviewer.mcp.json --strict-mcp-config
```

`--strict-mcp-config` makes each instance load *only* that file. No launch-time env is needed — the
config's `timeout` field raises Claude Code's per-call cap by itself.

The coordinator logs to `${TMPDIR}/auto-review-coordinator-<port>.log` and keeps running after the
agents exit (kill it via that port if you want a clean reset — also needed to apply a changed poll
window, see below).

### Option B — HTTP (manual start / remote agents)

Start the coordinator yourself and point each agent at its URL (configs:
[`configs/*.http.mcp.json`](../configs/)):

```bash
# start the shared HTTP coordinator (no install needed via npx; or use the global bin)
npx -y -p @permissionbrick/auto-review-mcp auto-review-server --port 8765 --poll-seconds 240   # keep ≤ ~270; optional: --repo /path
claude --mcp-config configs/developer.http.mcp.json --strict-mcp-config
claude --mcp-config configs/reviewer.http.mcp.json  --strict-mcp-config
```

The HTTP configs carry `"timeout": 3600000`, so no launch env is needed here either. `GET /healthz`
returns a JSON snapshot of the workflow.

## Reference: flags & environment variables

The stdio proxy accepts these as `env` vars or as `--flags` in `args`; the HTTP server accepts the
`--flag` form (env var equivalents in parentheses).

| Setting | Default | What it does |
|---|---|---|
| `AUTO_REVIEW_ROLE` / `--role` | *(none — all tools)* | Pin this agent to `developer` or `reviewer`; omit for the combined `/both` endpoint. |
| `AUTO_REVIEW_REPO` / `--repo` | *(set at runtime)* | Pre-set the target repo instead of using `initialize_review_session`. |
| `AUTO_REVIEW_PORT` / `--port` | `8765` | Coordinator port. |
| `AUTO_REVIEW_HOST` / `--host` | `127.0.0.1` (proxy) / `0.0.0.0` (server) | Coordinator bind/connect host. |
| `AUTO_REVIEW_POLL_SECONDS` / `--poll-seconds` | `240` (proxy, clamped ≤ `270`) / `1500` (server) | How long the coordinator holds one internal HTTP long-poll. |
| `AUTO_REVIEW_WAIT_SECONDS` | `600` | stdio proxy only — how long it loops over polls before returning `keep_waiting` to the agent. |
| `AUTO_REVIEW_MAX_DIFF_BYTES` / `--max-diff-bytes` | `200000` | Truncation limit for the diff shown to the reviewer. |
| `timeout` (ms, per-server field in `.mcp.json`) | `60000` (Claude Code default) | Claude Code's per-call cap. Must be ≥ wait window + poll window + margin; the shipped `1800000` covers the defaults. |

## Tuning how long a call waits

`get_next_review`, `request_review`, and `await_review` block in **one** agent-visible call for up
to the **wait window**, then return `keep_waiting`; the agent resumes via the shell poll command
quoted in that reply, or by re-calling over MCP (`await_review` with the `batch_id` on the
developer side; `get_next_review` again on the reviewer side). Three knobs bound that call:

| Knob | Where | Effect |
|------|-------|--------|
| `AUTO_REVIEW_WAIT_SECONDS` | config `env` (stdio proxy only) | how long the **proxy** waits — looping over coordinator polls — before returning `keep_waiting` to the **agent**. Default `600`. |
| `AUTO_REVIEW_POLL_SECONDS` | config `env` (stdio) / `--poll-seconds` (HTTP) | how long the coordinator holds **one internal HTTP long-poll**. **Must stay under ~270 s** (see below); the stdio proxy clamps it. Invisible to the agent in stdio mode. |
| `timeout` (ms) | per-server field in `.mcp.json` | Claude Code's per-call cap (default **60000**). Must be **≥ wait window + poll window + margin** (the shipped `1800000` covers the defaults comfortably). Overrides `MCP_TOOL_TIMEOUT`; not extended by progress. |

Handoffs themselves are event-driven (instant) regardless — the windows only set how long an
*idle* waiter holds before re-polling.

> ⚠️ **Hard ~5-minute ceiling on a single HTTP hold.** Every MCP client here is Node-based (the
> stdio proxy and the poller CLI both use Node's `fetch`/undici, whose default `headersTimeout` is
> **300 s**), so a long-poll held longer than ~5 min dies as `fetch failed`. Worse, the abandoned
> request leaves a server-side waiter that could swallow a batch. **So keep
> `AUTO_REVIEW_POLL_SECONDS` ≤ ~270 s** (the shipped configs use **240**). You cannot get a longer
> *single* HTTP hold by raising the poll window — longer **agent-facing** waits come from looping
> over polls instead: the stdio proxy does this up to `AUTO_REVIEW_WAIT_SECONDS`, and the poller
> CLI does the same for shell waits (see
> [the shell poll command](codex.md#avoiding-re-polls-the-shell-poll-command)); neither fails
> fatally on a hiccup.

Two more caveats:

- **The coordinator is a singleton.** Changing the poll window only takes effect on a fresh
  coordinator — kill the running one (`fuser -k <port>/tcp`, or `kill` the pid on that port) so the
  next agent restarts it with the new value. Both agents should use the same window.
- Across machines (HTTP transport), a dropped connection isn't retried until the next poll; prefer
  a shorter window there too.
