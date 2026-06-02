# auto-review-mcp

A local MCP server that orchestrates a **continuous review loop between two coding agents**: one
**developer** and one **reviewer**. They both connect to this one long-running server at the same
time and hand work back and forth through it — no human in the middle of the loop.

```
 developer agent                  auto-review server                 reviewer agent
 ───────────────                  ──────────────────                 ──────────────
 (works on a batch)
 request_review(summary, ──────▶  stages all changes, diffs vs HEAD
   commit_message)                registers the batch, BLOCKS dev
                                  wakes reviewer  ──────────────────▶ get_next_review()
                                                                      (returns summary + full diff)
                                                                      reviews it…
                                  ◀────────────────────────────────── submit_review(approved
                                  approved → git commit (dev's msg)        | changes_requested,
 ◀────── {approved, commit_sha}   changes → forward the issue              issue, category)
   or {changes_requested, issue}
 (continue / fix & resubmit)                                              get_next_review() …
```

The protocol is taught entirely through the MCP **tool descriptions**, so the two agents
self-orchestrate from the tools alone.

## How it works

- **One shared coordinator, two role-scoped endpoints**:
  - Developer agent → `…/developer/mcp` (tools: `initialize_review_session`, `request_review`,
    `signal_complete`, `workflow_status`)
  - Reviewer agent → `…/reviewer/mcp` (tools: `get_next_review`, `submit_review`,
    `workflow_status`)
  - Role is fixed by the endpoint, so there is no role/agent-id parameter on the calls.
- **The developer names the repo at runtime.** As its first step the developer agent calls
  `initialize_review_session` with the absolute path of the repo it's editing. The coordinator
  remembers it for its lifetime (or until called again). So there's nothing repo-specific to bake
  into config. (You can still pre-set it with `--repo`/`AUTO_REVIEW_REPO` if you prefer.)
- **Two ways to attach** (see [Connect the two agents](#connect-the-two-agents)):
  - **`node`/stdio (recommended)** — each agent's `.mcp.json` launches `dist/stdio.js`, a thin
    proxy. The first proxy auto-starts a single shared background coordinator; both proxies forward
    to it. No server to start by hand. The shared state lives in the coordinator, not the agents.
  - **HTTP** — you start `dist/server.js` yourself and point each agent at its URL (good for remote
    agents or sharing one coordinator across machines).
- **Blocking handoffs.** `request_review` blocks until the reviewer rules; `get_next_review`
  blocks until a batch arrives. Waiting is **event-driven**, so the actual handoff is instant. A
  call only holds the connection open up to a bounded **poll window** (`AUTO_REVIEW_POLL_SECONDS`),
  then returns `keep_waiting`; the agent immediately calls again. This makes the wait effectively
  unbounded while surviving connection drops and client timeouts. See
  [Tuning how long a call waits](#tuning-how-long-a-call-waits).
- **The server owns the commits.** On approval the server runs `git add -A` + `git commit` with
  the developer's commit message (plus a `Reviewed-by: auto-review` trailer). HEAD advances, so
  each review's diff is naturally just the new batch. The developer never commits.
- **One batch at a time**, identified by a `batch_id`. The diff shown to the reviewer is the full
  unified diff of the working tree vs HEAD (new/deleted files included).

## Install & build

```bash
npm install
npm run build
```

## Connect the two agents

Launch **two Claude Code instances** — one developer, one reviewer. Both must point at the **same
git repository** the developer edits (it must be a git repo, not this server's directory).

### Option A — `node`/stdio (recommended)

Each agent's `.mcp.json` launches the stdio proxy; the first one auto-starts the shared
coordinator. Nothing to run by hand, and **no repo path in config** — the developer agent declares
it at runtime via `initialize_review_session`. Sample configs are in [`configs/`](configs/) (adjust
the absolute path to `dist/stdio.js` if you cloned elsewhere):

```jsonc
// configs/developer.mcp.json  (reviewer.mcp.json is identical with --role reviewer)
{
  "mcpServers": {
    "auto-review": {
      "command": "node",
      "args": ["/root/repos/auto-review/dist/stdio.js", "--role", "developer"],
      "env": { "AUTO_REVIEW_POLL_SECONDS": "3000" },
      "timeout": 3600000
    }
  }
}
```

The shipped configs use a **240 s** poll window (`AUTO_REVIEW_POLL_SECONDS`) — the practical max
per single hold (see [Tuning how long a call waits](#tuning-how-long-a-call-waits)). Idle waiters
re-poll every ~240 s; handoffs are still instant. For long *uninterrupted* waits, use the poller
CLI, which loops over these windows.

```bash
# Developer instance
claude --mcp-config /root/repos/auto-review/configs/developer.mcp.json --strict-mcp-config
# Reviewer instance (separate terminal)
claude --mcp-config /root/repos/auto-review/configs/reviewer.mcp.json --strict-mcp-config
```

`--strict-mcp-config` makes each instance load *only* that file. No launch-time env is needed — the
config's `timeout` field raises Claude Code's per-call cap by itself.

Proxy env / args (also accepted as `--flags` in `args`): `AUTO_REVIEW_ROLE`, `AUTO_REVIEW_PORT`
(default `8765`), `AUTO_REVIEW_HOST` (default `127.0.0.1`), `AUTO_REVIEW_POLL_SECONDS` (default
`40` if unset; the shipped config sets `3000`), `AUTO_REVIEW_MAX_DIFF_BYTES` (default `200000`), and
optionally `AUTO_REVIEW_REPO` to pre-set the repo instead of using `initialize_review_session`. The
coordinator logs to `${TMPDIR}/auto-review-coordinator-<port>.log` and keeps running after the
agents exit (kill it via that port if you want a clean reset — also needed to apply a changed poll
window, see below).

### Option B — HTTP (manual start / remote agents)

Start the coordinator yourself and point each agent at its URL (configs:
`configs/*.http.mcp.json`):

```bash
node dist/server.js --port 8765 --poll-seconds 240   # keep ≤ ~270; optional: add --repo /path
claude --mcp-config configs/developer.http.mcp.json --strict-mcp-config
claude --mcp-config configs/reviewer.http.mcp.json  --strict-mcp-config
```

The HTTP configs carry `"timeout": 3600000`, so no launch env is needed here either. Server flags
(env var in parens): `--repo` (`AUTO_REVIEW_REPO`, optional — else the developer sets it via
`initialize_review_session`), `--port` (`AUTO_REVIEW_PORT`, `8765`), `--host` (`AUTO_REVIEW_HOST`,
`0.0.0.0` — reachable as `agent-vm.mshome.net`), `--poll-seconds` (`AUTO_REVIEW_POLL_SECONDS`,
`1500`), `--max-diff-bytes` (`AUTO_REVIEW_MAX_DIFF_BYTES`, `200000`). `GET /healthz` returns a JSON
snapshot of the workflow.

### Tuning how long a call waits

`get_next_review` and `request_review` each block in **one** call for up to the **poll window**,
then return `keep_waiting` and the agent re-calls. Two limits bound that single call:

| Knob | Where | Effect |
|------|-------|--------|
| `AUTO_REVIEW_POLL_SECONDS` | config `env` (stdio) / `--poll-seconds` (HTTP) | how long the server holds before `keep_waiting`. **Must stay under ~270 s** (see below). |
| `timeout` (ms) | per-server field in `.mcp.json` | Claude Code's per-call cap (default **60000**). Must be **≥ the poll window**. Overrides `MCP_TOOL_TIMEOUT`; not extended by progress. |

Handoffs themselves are event-driven (instant) regardless — the poll window only sets how long an
*idle* waiter holds before re-polling.

> ⚠️ **Hard ~5-minute ceiling on a single HTTP hold.** Every MCP client here is Node-based (the
> stdio proxy and the poller CLI both use Node's `fetch`/undici, whose default `headersTimeout` is
> **300 s**), so a long-poll held longer than ~5 min dies as `fetch failed`. Worse, the abandoned
> request leaves a server-side waiter that could swallow a batch. **So keep
> `AUTO_REVIEW_POLL_SECONDS` ≤ ~270 s** (the shipped configs use **240**). You cannot get a longer
> *single* hold by raising the window — for longer **effective** waits, the poller CLI loops over
> many ≤270 s polls (see [the Codex section](#avoiding-re-polls-on-codex-the-shell-poll-command)),
> and the CLI never fails fatally on a hiccup.

Two more caveats:

- **The coordinator is a singleton.** Changing the poll window only takes effect on a fresh
  coordinator — kill the running one (`fuser -k <port>/tcp`, or `kill` the pid on that port) so the
  next agent restarts it with the new value. Both agents should use the same window.
- Across machines (HTTP transport), a dropped connection isn't retried until the next poll; prefer
  a shorter window there too.

### Using Codex instead of Claude Code

Codex (OpenAI) works as the client, but it's the opposite of Claude Code on timeouts:

- It reads `~/.codex/config.toml`, **not** `.mcp.json`, and **ignores the `timeout` field**.
- All Codex harnesses (CLI, VS Code extension, Windows app) enforce a **hard ~120 s
  `awaiting tools/call` deadline** that `tool_timeout_sec` does **not** reliably raise
  ([openai/codex#13831](https://github.com/openai/codex/issues/13831)). So unlike Claude Code, a
  single blocking call **cannot exceed ~120 s** on Codex.

Therefore, do the **reverse** of the Claude tuning: keep the poll window safely **under** 120 s so
the coordinator returns `keep_waiting` before Codex gives up, and the agent re-polls. `90` is a good
value. See [`configs/codex.config.toml`](configs/codex.config.toml):

```toml
[mcp_servers.auto-review]
command = "node"
args = ["/opt/auto-review/dist/stdio.js", "--role", "developer"]  # reviewer in its own config
env = { AUTO_REVIEW_POLL_SECONDS = "90" }   # MUST be < Codex's ~120 s ceiling
startup_timeout_sec = 30
tool_timeout_sec = 110
```

Handoffs are still instant — the window only sets how often an idle waiter re-polls. The
singleton-coordinator rule still applies: both agents need the same `AUTO_REVIEW_POLL_SECONDS`, and
you must kill any running coordinator for a changed window to take effect.

#### Avoiding re-polls on Codex: the shell poll command

Re-polling under 120 s works but is chatty. To get long, quiet waits anyway, there's a built-in
escape hatch: an MCP tool call is capped at ~120 s, but a **shell command isn't**. When
`get_next_review` / `request_review` is killed by Codex's `timed out awaiting tools/call` error, the
agent never receives a result — so the tool **descriptions** (not the responses) tell it to fall
back to a blocking shell command that waits without the limit and prints the same JSON:

```
node /opt/auto-review/dist/cli.js next-review    --port 8765 --timeout 1500   # reviewer
node /opt/auto-review/dist/cli.js await-verdict  --port 8765 --timeout 1500   # developer
```

These hit a plain-HTTP long-poll endpoint on the coordinator, hide `keep_waiting` internally, and
block until there's a real result (give the command a long *command* timeout, ~25 min). The agent
should use them **only after an actual timeout error** — a normal `keep_waiting` return just means
"call the tool again", and running the shell command then would be a redundant double-wait.

With this fallback you can even set a **long** poll window (so the MCP call carries the fast case
within 120 s and the shell command carries longer waits). Verify it with `npm run demo:cli`.

## Suggested prompts

The tools are self-describing, so the prompts can be short.

**Developer:**
> You are the *developer*. First call `initialize_review_session` (the `auto-review` MCP) with the
> absolute path of this repo. Then implement <the task> in small, self-contained batches. After each
> batch, call `request_review` with a clear summary and commit message, and follow whatever it
> returns: on `changes_requested`, fix the issue and resubmit; on `approved`, continue with the next
> batch. Do not run `git commit` yourself. When the whole task is done and the last batch is
> approved, call `signal_complete`.

**Reviewer:**
> You are the *reviewer*. Repeatedly call `get_next_review` (the `auto-review` MCP) to receive each
> batch (summary + full diff vs HEAD), review it against <the task/spec> and for code quality, then
> call `submit_review` — `approved`, or `changes_requested` with a clear `issue` and `category`
> (`spec`/`code`). Keep looping until you get `workflow_complete`.

On **Codex**, also allow shell commands and add: *"If a `get_next_review`/`request_review` call ever
fails with `timed out awaiting tools/call`, follow that tool's CLIENT-TIMEOUT FALLBACK instructions
— run the shell command it names to wait, then continue."*

## Verify

End-to-end tests that spin up a throwaway git repo and drive the full loop (keep_waiting → submit →
review → changes_requested → fix → approve → commit → complete):

```bash
npm run build
npm run demo         # HTTP path: two SDK clients against a running server
npm run demo:stdio   # node/stdio path: two spawned proxies + auto-started coordinator
npm run demo:cli     # shell poll-command path: MCP for instant ops + cli.js for the blocking wait
```

Each prints a checklist and exits non-zero if anything fails.

## Notes & limitations (v1)

- **State is in-memory.** Restarting the server resets the loop (no batch is mid-flight unless an
  agent is actively blocked). There is no persistence yet.
- **One developer + one reviewer.** A single batch flows at a time; extra connections share the
  same state.
- **Commit hooks are respected.** If a pre-commit hook rejects an approved batch, the reviewer gets
  an error and the batch stays open to retry or send back as `changes_requested`.
