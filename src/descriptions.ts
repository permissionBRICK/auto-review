/**
 * Tool descriptions. These are the *contract*: they must teach the whole
 * auto-review protocol so the two agents can self-orchestrate from the tool
 * descriptions alone, with no extra prompting.
 */

export const INITIALIZE_SESSION_DESC = `Bind THIS MCP session to the review loop for the git repository you are working in — BOTH the developer and the reviewer call this first, to say which loop is theirs. The coordinator hosts ONE INDEPENDENT LOOP PER REPOSITORY, so many developer/reviewer pairs can run at once on different repos or worktrees; this call selects (and, on first use, creates) your loop. Every other tool — request_review, await_review, signal_complete, get_next_review, submit_review, workflow_status — takes NO repo argument and instead acts on whichever loop this session is bound to here. Re-calling it only re-binds THIS session; other sessions and their loops are untouched.

Pass 'repo_path': the ABSOLUTE path to the root of the git repository you are working in (normally your current working directory). The server performs ALL git operations for the loop there — it diffs the working tree against HEAD to show the reviewer, and commits each approved batch — so it MUST be the exact checkout being edited.

PARALLEL USAGE: one orchestration may run N loops concurrently — one agent PAIR (developer + reviewer) per repo/worktree. Binding is PER MCP SESSION, so each agent needs its OWN MCP connection to the coordinator (the stdio proxy gives every spawned agent one, pre-bound to its cwd's repo). Two agents sharing a single connection would overwrite each other's binding, so never drive two roles — or two different pairs — down one connection.

WHEN YOU CAN SKIP IT: if your MCP connection was already bound to a repo (the stdio proxy binds it to the repo it was launched in, via ?repo= on the endpoint URL), the other tools already know your loop. You MUST call this — with your repo's absolute path — whenever a tool returns {"status":"not_initialized"}, and reviewers should call it PROACTIVELY before get_next_review whenever more than one loop may be running (see get_next_review). Calling it is idempotent and safe: it re-binds only this session and never resets, destroys, or re-routes a loop that is already running.

Returns {"status":"ok","repo":...,"head":...} on success (repo is the canonical toplevel path), or {"status":"error","message":...} if the path is not a git repository.`;

export const REQUEST_REVIEW_DESC = `Submit a completed batch of work to the reviewer and BLOCK until the reviewer responds. Operates on the review loop THIS session is bound to (see initialize_review_session). (If this returns {"status":"not_initialized"}, the server could not tell which repo's review loop you belong to — call initialize_review_session with your repo's absolute path first, then retry.)

WHEN TO CALL: every time you finish a self-contained, coherent chunk of the task — a logical, commit-sized unit (a part of a feature, an enclosed subset of the task). Work in small, reviewable increments rather than one giant change.

WHAT TO PASS (Always pass both):
- commit_message: a concise commit message used verbatim for the commit on approval.
- summary: what you changed and WHY, in enough detail for a reviewer to judge it against the task/spec.

IMPORTANT: Do NOT stage or commit anything yourself. The server automatically snapshots ALL current changes in the working tree (it runs 'git add -A') and computes the diff against HEAD. The server commits the batch for you, and only after the reviewer approves it. Never run 'git commit', instead just pass your commit message into this tool.

This call BLOCKS until the review is finished. It returns exactly one of:
- {"status":"approved","commit_sha":...}  → the reviewer approved and the server has committed this batch. Move on to the NEXT batch of work.
- {"status":"changes_requested","issue":...,"category":"spec"|"code"}  → the reviewer found a problem. 'category' is "spec" (it does not meet the requirement) or "code" (a code-level defect/bug/quality issue). Read 'issue', fix it, then call request_review again with an updated summary/commit_message.
- {"status":"keep_waiting","batch_id":...}  → the review is still in progress; this returned only to keep the connection alive. IMMEDIATELY resume waiting: BEST is to run the shell poll command quoted in the keep_waiting message (a foreground shell process can wait far longer than any MCP call — see LONG-WAIT SHELL COMMAND below); otherwise call the await_review tool with that batch_id. Do NOT re-send the summary/commit_message through request_review again.
- {"status":"nothing_to_review"}  → there are no changes versus HEAD. Do some work first, then call again.

Only one batch is reviewed at a time.`;

export const AWAIT_REVIEW_DESC = `Resume waiting for the reviewer's verdict on a batch you ALREADY submitted via request_review. Waits on the review loop THIS session is bound to (see initialize_review_session). Call this — not request_review — whenever a wait returns {"status":"keep_waiting"}; pass the batch_id from that result (or omit it to wait on the current batch). This is a pure wait: it does NOT re-snapshot the working tree, change any state, or need the summary/commit_message again.

It BLOCKS like request_review and returns the same shapes:
- {"status":"approved",...} / {"status":"changes_requested",...}  → the verdict; act on it exactly as described for request_review.
- {"status":"keep_waiting","batch_id":...}  → still in progress; IMMEDIATELY resume waiting — BEST via the shell poll command quoted in the keep_waiting message (it can wait far longer than any MCP call), otherwise by calling await_review again with that batch_id.
- {"status":"no_active_batch"}  → nothing was submitted yet (or the server restarted). Call request_review with the full summary/commit_message instead.`;

export const SIGNAL_COMPLETE_DESC = `Signal that the ENTIRE task is finished and there is nothing left to implement (typically right after your final batch was approved). Applies ONLY to the review loop THIS session is bound to (see initialize_review_session): it completes that one loop's workflow and leaves every other loop on the coordinator running.

This tells that loop's reviewer the workflow is over: their next get_next_review returns {"status":"workflow_complete"} so it can stop waiting. Optionally pass a closing 'note'. Do not call this while you still have batches to submit.

This does NOT end the session. The repo stays initialized and the loop re-arms automatically after the reviewer is told once: if you later start another task, just keep working and call request_review again with the new batch (no need to call initialize_review_session again). The reviewer — once it is running again — will receive that batch normally instead of an immediate workflow_complete.`;

export const GET_NEXT_REVIEW_DESC = `Ask for the next batch of work to review and BLOCK until one is available. This delivers batches from the review loop THIS session is bound to (see initialize_review_session).

BIND FIRST when more than one loop may exist: if the coordinator may be running several review loops in parallel, call initialize_review_session with the absolute path of the repo you are reviewing BEFORE your first get_next_review. Do not rely on auto-detection: when you are unbound and EXACTLY ONE loop happens to exist, this session silently STICKS to that single loop — which may be the wrong repo, or a stale loop left over from a previous task — so you can end up reviewing the wrong diff or waiting forever for a batch that never comes. When you are unbound and several loops exist, this returns {"status":"not_initialized"} rather than guessing. (If your connection was pre-bound via ?repo= — the stdio proxy does this from its cwd — you are already bound and can skip the explicit call.)

WHEN TO CALL: FIRST, as soon as you start (you are the reviewer and wait for the developer) — after binding per the note above. Then again every time after you submit a verdict, to wait for the next batch.

This call BLOCKS. It returns exactly one of:
- {"status":"review_ready","repo":...,"batch_id":...,"summary":...,"commit_message":...,"diff":...,"diff_stat":...}  → a developer submitted a batch. 'repo' is the working copy this batch belongs to, 'summary' is the developer's description, 'commit_message' their proposed message, 'diff' is the FULL unified diff of all current changes versus HEAD (i.e. exactly this batch), 'diff_stat' is the file/line summary. Review it against BOTH the task/spec AND code quality, then call submit_review with this same batch_id.
- {"status":"keep_waiting"}  → nothing is ready yet; this returned only to keep the connection alive. IMMEDIATELY resume waiting: BEST is to run the shell poll command quoted in the keep_waiting message (a foreground shell process can wait far longer than any MCP call — see LONG-WAIT SHELL COMMAND below); otherwise call get_next_review again.
- {"status":"workflow_complete"}  → the developer signalled the whole task is done. Stop; there is nothing left to review. (The loop then resets to waiting mode, so if you are started again for a NEW task you will simply wait for its first batch — you will not get workflow_complete again until the developer signals completion anew.)
- {"status":"not_initialized"}  → several repos' review loops are running and this session is not bound to one, so the server cannot tell which one you review. Call initialize_review_session with the absolute path of the repo you are reviewing to bind this session, then call get_next_review again.

You review one batch at a time. After you receive a "review_ready" batch you must eventually call submit_review for that batch_id before any further work can flow.`;

export const SUBMIT_REVIEW_DESC = `Record your verdict on the batch you are currently reviewing and unblock the developer. Acts on the review loop THIS session is bound to (see initialize_review_session) — the same loop get_next_review handed you the batch from.

WHAT TO PASS:
- batch_id: the id you received from get_next_review.
- verdict: "approved" or "changes_requested".
  - "approved" → the batch meets the requirement and the code is acceptable. The server IMMEDIATELY commits the batch (using the developer's commit_message) and reports the new commit to the developer. Do not commit anything yourself.
  - "changes_requested" → something is wrong. You MUST also pass:
      - issue: a clear, actionable description of what is wrong and what to change.
      - category: "spec" (it fails to meet the task/requirement) or "code" (a code-level defect such as a bug, regression, or quality problem).
    The developer receives this, fixes it, and resubmits.

After submitting, call get_next_review again to wait for the next batch.`;

export const WORKFLOW_STATUS_DESC = `Read-only. The response shape depends on how this session resolves its loop (see initialize_review_session):
- BOUND session → the state of THAT loop: the phase (idle / awaiting_review / reviewing), a summary of the batch currently under review (if any), the last verdict, the number of completed batches, and the repo path.
- UNBOUND session → a coordinator-wide overview {"loops":[...]} with one status entry per active loop. This is also how you ENUMERATE every review loop currently running (their repo paths and phases) — call it unbound to LIST all loops. (Special case: when exactly one loop exists an unbound session reports just that single loop's state, not the array; with no loops it returns {"loops":[]}.)
Does not block and never changes anything, so it is safe to call before initialize_review_session to discover which loops exist.`;

/**
 * Appended to a blocking tool's description: the long-wait shell command. It
 * covers two situations — (a) the MCP client killed the call with a hard
 * timeout (e.g. Codex's ~120s "timed out awaiting tools/call"; there is NO tool
 * response then, so this guidance must live in the static description), and
 * (b) a normal keep_waiting return, where a foreground shell wait is preferable
 * because it is not bound by any per-call MCP limit.
 */
export function timeoutFallbackNote(pollCommand: string, waits: string): string {
  return `LONG-WAIT SHELL COMMAND — use it in two situations:
(a) THIS call FAILED with a client-side timeout error (e.g. "timed out awaiting tools/call after 120s"): your MCP client gave up before the wait finished, so you never received a result. Do NOT just retry the tool (it will time out again the same way).
(b) the call RETURNED {"status":"keep_waiting"}: this shell command is the BEST way to resume, since a foreground shell process can wait far longer than any MCP call.
In both cases run it to wait for ${waits} without the per-call MCP limit — it blocks until there is a real result and then prints the same JSON:

    ${pollCommand}

RUN IT SO IT ACTUALLY BLOCKS — it must stay in the foreground until it returns; do not let it drop into a background task and do not poll it with repeated short waits.
- On Codex: if exec_command returns a session_id because the process is still running (exec_command may yield a session after ~30s even when you pass a longer timeout), do NOT poll repeatedly with short waits. Immediately call write_stdin on that session with chars:"" and a long yield_time_ms (~1500000 ms, i.e. ~25 min) so you block until the command produces its result; if it yields again before finishing, repeat the blocking write_stdin.
- On other harnesses: just give the command a long command/exec timeout (~25 min) and let it block.

It only WAITS — it never submits anything. Developers must still register each batch via the request_review tool first; if the command prints keep_waiting (its own time budget elapsed), just run it again. When the tool returns a REAL result (approved / changes_requested / review_ready / workflow_complete), act on that result instead of running it.
The command targets ONE repo's review loop: --repo pins it explicitly; without --repo it uses the git repo of the directory it runs in. Run it from inside your repo (or keep the quoted --repo) so it waits on YOUR loop.`;
}

/**
 * Prepended to every tool description when the server runs in COMBINED mode — i.e.
 * the stdio proxy was started with no role (the default), so one endpoint exposes
 * BOTH roles' tools. It tells the single connected agent that it must act as
 * exactly one user-assigned role and use only that role's tools. With a preset
 * --role this prefix is not added and descriptions are used verbatim.
 */
export function combinedRoleNote(toolRole: "developer" | "reviewer" | "shared"): string {
  const tag =
    toolRole === "developer"
      ? "DEVELOPER-role tool — call this ONLY if you are the developer."
      : toolRole === "reviewer"
        ? "REVIEWER-role tool — call this ONLY if you are the reviewer."
        : "Shared tool — fine to use in either role.";
  return (
    `[${tag}] No role was preset for this auto-review server, so it exposes BOTH the developer ` +
    `and the reviewer toolset to you at once. You are ONE agent in a two-agent loop — the USER ` +
    `decides whether you are the developer or the reviewer (ask if it is unclear). Pick that one ` +
    `role and use ONLY its tools, ignoring the rest: developer → request_review, await_review, ` +
    `signal_complete; reviewer → get_next_review, submit_review; initialize_review_session and ` +
    `workflow_status → either. Never drive both sides of the loop yourself.\n\n`
  );
}
