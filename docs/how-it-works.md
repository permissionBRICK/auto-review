# How it works

auto-review is one long-running, local MCP server that two coding agents — a **developer** and a
**reviewer** — connect to at the same time. They hand work back and forth through it with no human
in the middle of the loop.

The coordinator is **multi-tenant**: it hosts one independent review loop per repository, so
several developer/reviewer pairs — e.g. one pair per VS Code window, each in its own repo — run in
parallel through the same coordinator without seeing each other.

The protocol is taught entirely through the MCP **tool descriptions**, so the two agents
self-orchestrate from the tools alone.

## The protocol

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

## Roles

**One shared coordinator; the role is set by how you attach:**

- **No role (the default)** → the agent attaches to `…/both/mcp`, which exposes *all* tools at
  once; each tool's description then tells the agent it must play one user-assigned role and use
  only that role's tools. Handy when you'd rather assign roles by prompt than maintain two configs.
- **Pinned role** — pass `--role`/`AUTO_REVIEW_ROLE` to get just that role's tools:
  - Developer agent → `--role developer` (tools: `request_review`, `await_review`,
    `signal_complete`, plus the shared `initialize_review_session` and `workflow_status`)
  - Reviewer agent → `--role reviewer` (tools: `get_next_review`, `submit_review`, plus the shared
    `initialize_review_session` and `workflow_status`)

## One loop per repo

Loops are keyed by the **canonical repo path** (the realpath of `git rev-parse --show-toplevel`).
Anything inside one checkout resolves to the same loop; two worktrees of the same repository get
two independent loops — so you can even run parallel loops on two branches of one project.

Nothing repo-specific is baked into config. A call finds its loop like this (first match wins):

1. **Explicit `loop_id` (the reliable way).** `initialize_review_session` returns the loop's
   stable public `loop_id`; every other tool accepts it as an optional argument and, when present,
   addresses that loop directly and statelessly. Both roles use it: call
   `initialize_review_session` with your repo's absolute path first, then pass the returned
   `loop_id` on every call until the workflow completes. This is the **only** safe addressing when
   several agents share one MCP connection (e.g. parallel subagents multiplexed by one harness) —
   per-session state is last-writer-wins there. A `loop_id` from before a coordinator restart
   fails loud with guidance to re-initialize.
2. **Session binding via the stdio proxy: automatic.** The proxy detects the repo from its own
   working directory — agent harnesses spawn it with cwd = the workspace folder — and binds its
   connection to that repo's loop (via `?repo=<path>` on the coordinator endpoint URL). The same
   `.mcp.json` works in every repo. `--repo`/`AUTO_REVIEW_REPO` overrides the detection.
   `initialize_review_session` also (re-)binds the calling session as a fallback for calls without
   a `loop_id`.
3. **Single-loop fallback.** When exactly one loop is active, unbound sessions simply use it — the
   original one-repo setup keeps working with zero configuration.

The shell poll commands pick their loop the same way: `--loop <loop_id>`, `--repo <path>` (as
quoted by the server), or the working directory they are run from.

## Two ways to attach

- **stdio (recommended)** — each agent's `.mcp.json` runs `npx -y @permissionbrick/auto-review-mcp
  --role …`, a thin proxy. The first proxy auto-starts a single shared background coordinator; both
  proxies forward to it. No server to start by hand. The shared state lives in the coordinator, not
  the agents.
- **HTTP** — you start the coordinator yourself (`auto-review-server`) and point each agent at its
  URL (good for remote agents or sharing one coordinator across machines).

Setup commands and configs for both are in [Configuration](configuration.md).

## Blocking handoffs

`request_review` blocks until the reviewer rules; `get_next_review` blocks until a batch arrives.
Waiting is **event-driven**, so the actual handoff is instant.

Internally the coordinator holds each HTTP long-poll only up to a bounded **poll window**
(`AUTO_REVIEW_POLL_SECONDS`, ≤ ~270 s); the stdio proxy quietly loops over those polls and only
surfaces `keep_waiting` to the agent after the **wait window** (`AUTO_REVIEW_WAIT_SECONDS`, default
**600 s**). A `keep_waiting` reply quotes the **shell poll command** as the preferred way to resume
(a foreground shell process can wait far longer than any MCP call); the MCP alternatives are the
lightweight `await_review` tool for the developer (just the `batch_id` — no re-sending the summary)
and calling `get_next_review` again for the reviewer. This makes the wait effectively unbounded
while surviving connection drops and client timeouts. See
[Tuning how long a call waits](configuration.md#tuning-how-long-a-call-waits).

## The server owns the commits

On approval the server runs `git add -A` + `git commit` with the developer's commit message (plus a
`Reviewed-by: auto-review` trailer). HEAD advances, so each review's diff is naturally just the new
batch. The developer never commits.

## One batch at a time (per loop)

Each batch is identified by a `batch_id`, unique within its loop. The diff shown to the reviewer is
the full unified diff of the working tree vs HEAD (new/deleted files included).

## Notes & limitations

- **State is in-memory.** Restarting the server resets every loop (no batch is mid-flight unless an
  agent is actively blocked). There is no persistence yet.
- **One developer + one reviewer per loop.** A single batch flows through each loop at a time;
  extra connections bound to the same repo share that loop's state. Parallelism comes from running
  loops in *different* repos (or worktrees).
- **Commit hooks are respected.** If a pre-commit hook rejects an approved batch, the reviewer gets
  an error and the batch stays open to retry or send back as `changes_requested`.
