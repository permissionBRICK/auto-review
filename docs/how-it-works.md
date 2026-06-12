# How it works

auto-review is one long-running, local MCP server that two coding agents — a **developer** and a
**reviewer** — connect to at the same time. They hand work back and forth through it with no human
in the middle of the loop.

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
  - Developer agent → `--role developer` (tools: `initialize_review_session`, `request_review`,
    `await_review`, `signal_complete`, `workflow_status`)
  - Reviewer agent → `--role reviewer` (tools: `get_next_review`, `submit_review`,
    `workflow_status`)

## The developer names the repo at runtime

As its first step the developer agent calls `initialize_review_session` with the absolute path of
the repo it's editing. The coordinator remembers it for its lifetime (or until called again). So
there's nothing repo-specific to bake into config. (You can still pre-set it with
`--repo`/`AUTO_REVIEW_REPO` if you prefer.)

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

## One batch at a time

Each batch is identified by a `batch_id`. The diff shown to the reviewer is the full unified diff
of the working tree vs HEAD (new/deleted files included).

## Notes & limitations (v1)

- **State is in-memory.** Restarting the server resets the loop (no batch is mid-flight unless an
  agent is actively blocked). There is no persistence yet.
- **One developer + one reviewer.** A single batch flows at a time; extra connections share the
  same state.
- **Commit hooks are respected.** If a pre-commit hook rejects an approved batch, the reviewer gets
  an error and the batch stays open to retry or send back as `changes_requested`.
