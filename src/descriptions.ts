/**
 * Tool descriptions. These are the *contract*: they must teach the whole
 * auto-review protocol so the two agents can self-orchestrate from the tool
 * descriptions alone, with no extra prompting.
 */

export const INITIALIZE_SESSION_DESC = `Start the auto-review session by telling the server which git repository this workflow operates on. CALL THIS ONCE, FIRST — before request_review.

Pass 'repo_path': the ABSOLUTE path to the root of the git repository you are working in (normally your current working directory). The server performs ALL git operations there — it diffs your working tree against HEAD to show the reviewer, and commits each approved batch — so it MUST be the exact checkout you are editing.

The repository is remembered for the lifetime of the server, or until you call this again (which starts a fresh session). Returns {"status":"ok","repo":...,"head":...} on success, or {"status":"error","message":...} if the path is not a git repository.`;

export const REQUEST_REVIEW_DESC = `Submit a completed batch of work to the reviewer and BLOCK until the reviewer responds. (Call initialize_review_session once first; if you haven't, this returns {"status":"not_initialized"}.)

WHEN TO CALL: every time you finish a self-contained, coherent chunk of the task — a logical, commit-sized unit (a part of a feature, an enclosed subset of the task). Work in small, reviewable increments rather than one giant change.

WHAT TO PASS:
- summary: what you changed and WHY, in enough detail for a reviewer to judge it against the task/spec.
- commit_message: a good commit message for this batch (this exact message is used for the commit on approval).

IMPORTANT: Do NOT stage or commit anything yourself. The server automatically snapshots ALL current changes in the working tree (it runs 'git add -A') and computes the diff against HEAD. The server commits the batch for you, and only after the reviewer approves it. Never run 'git commit'.

This call BLOCKS until the review is finished. It returns exactly one of:
- {"status":"approved","commit_sha":...}  → the reviewer approved and the server has committed this batch. Move on to the NEXT batch of work.
- {"status":"changes_requested","issue":...,"category":"spec"|"code"}  → the reviewer found a problem. 'category' is "spec" (it does not meet the requirement) or "code" (a code-level defect/bug/quality issue). Read 'issue', fix it, then call request_review again with an updated summary/commit_message.
- {"status":"keep_waiting"}  → the review is still in progress; this returned only to keep the connection alive. IMMEDIATELY call request_review again with the SAME arguments to keep waiting. (Re-submitting unchanged work does not create a duplicate review.)
- {"status":"nothing_to_review"}  → there are no changes versus HEAD. Do some work first, then call again.

Only one batch is reviewed at a time.`;

export const SIGNAL_COMPLETE_DESC = `Signal that the ENTIRE task is finished and there is nothing left to implement (typically right after your final batch was approved).

This tells the reviewer the workflow is over: the reviewer's next get_next_review will return {"status":"workflow_complete"} so it can stop waiting. Optionally pass a closing 'note'. Do not call this while you still have batches to submit.

This does NOT end the session. The repo stays initialized and the loop re-arms automatically after the reviewer is told once: if you later start another task, just keep working and call request_review again with the new batch (no need to call initialize_review_session again). The reviewer — once it is running again — will receive that batch normally instead of an immediate workflow_complete.`;

export const GET_NEXT_REVIEW_DESC = `Ask for the next batch of work to review and BLOCK until one is available.

WHEN TO CALL: FIRST, as soon as you start (you are the reviewer and wait for the developer). Then again every time after you submit a verdict, to wait for the next batch.

This call BLOCKS. It returns exactly one of:
- {"status":"review_ready","batch_id":...,"summary":...,"commit_message":...,"diff":...,"diff_stat":...}  → a developer submitted a batch. 'summary' is the developer's description, 'commit_message' their proposed message, 'diff' is the FULL unified diff of all current changes versus HEAD (i.e. exactly this batch), 'diff_stat' is the file/line summary. Review it against BOTH the task/spec AND code quality, then call submit_review with this same batch_id.
- {"status":"keep_waiting"}  → nothing is ready yet; this returned only to keep the connection alive. IMMEDIATELY call get_next_review again to keep waiting.
- {"status":"workflow_complete"}  → the developer signalled the whole task is done. Stop; there is nothing left to review. (The loop then resets to waiting mode, so if you are started again for a NEW task you will simply wait for its first batch — you will not get workflow_complete again until the developer signals completion anew.)

You review one batch at a time. After you receive a "review_ready" batch you must eventually call submit_review for that batch_id before any further work can flow.`;

export const SUBMIT_REVIEW_DESC = `Record your verdict on the batch you are currently reviewing and unblock the developer.

WHAT TO PASS:
- batch_id: the id you received from get_next_review.
- verdict: "approved" or "changes_requested".
  - "approved" → the batch meets the requirement and the code is acceptable. The server IMMEDIATELY commits the batch (using the developer's commit_message) and reports the new commit to the developer. Do not commit anything yourself.
  - "changes_requested" → something is wrong. You MUST also pass:
      - issue: a clear, actionable description of what is wrong and what to change.
      - category: "spec" (it fails to meet the task/requirement) or "code" (a code-level defect such as a bug, regression, or quality problem).
    The developer receives this, fixes it, and resubmits.

After submitting, call get_next_review again to wait for the next batch.`;

export const WORKFLOW_STATUS_DESC = `Read-only. Return the current state of the auto-review workflow: the phase (idle / awaiting_review / reviewing), a summary of the batch currently under review (if any), the last verdict, the number of completed batches, and the repo path. Does not block and never changes anything.`;

/**
 * Appended to a blocking tool's description so the agent can recover when its
 * MCP client kills the call with a hard timeout (e.g. Codex's ~120s
 * "timed out awaiting tools/call"). On that timeout there is NO tool response,
 * so this guidance must live in the static description — not in any result.
 */
export function timeoutFallbackNote(pollCommand: string, waits: string): string {
  return `CLIENT-TIMEOUT FALLBACK — only when THIS call FAILS with a client-side timeout error (e.g. "timed out awaiting tools/call after 120s"): your MCP client gave up before the wait finished, so you never received a result. Do NOT just retry the tool (it will time out again the same way). Instead run this shell command to wait for ${waits} without the per-call MCP limit — it blocks until there is a real result and then prints the same JSON:

    ${pollCommand}

RUN IT SO IT ACTUALLY BLOCKS — it must stay in the foreground until it returns; do not let it drop into a background task and do not poll it with repeated short waits.
- On Codex: if exec_command returns a session_id because the process is still running (exec_command may yield a session after ~30s even when you pass a longer timeout), do NOT poll repeatedly with short waits. Immediately call write_stdin on that session with chars:"" and a long yield_time_ms (~1500000 ms, i.e. ~25 min) so you block until the command produces its result; if it yields again before finishing, repeat the blocking write_stdin.
- On other harnesses: just give the command a long command/exec timeout (~25 min) and let it block.

Only use this on an actual timeout error. If the tool RETURNS normally — including a "keep_waiting" result — do NOT run the shell command; just call the tool again as usual. Running it after a normal return would be a redundant double-wait.`;
}
