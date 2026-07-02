/**
 * Shared types for the auto-review orchestrator.
 *
 * The wire shapes returned to the agents are plain JSON objects (serialised as
 * the text content of each tool result). They are intentionally small and
 * self-describing so an agent can act on them with no extra context.
 */

export type Role = "developer" | "reviewer";

/**
 * Endpoint / proxy scope. A single role exposes only that role's tools; "both"
 * (the default when no role is configured) exposes every tool on one endpoint
 * and lets the connected agent play one user-assigned role.
 */
export type RoleScope = Role | "both";

export type BatchStatus =
  | "queued" // submitted by the developer, not yet picked up by the reviewer
  | "in_review" // reviewer has it
  | "approved" // reviewer approved; committed by the server
  | "changes_requested"; // reviewer rejected with an issue

export type IssueCategory = "spec" | "code";

/** A single unit of work moving through the review loop. */
export interface Batch {
  id: string;
  commitMessage: string;
  summary: string;
  /** Full unified diff vs HEAD as shown to the reviewer (may be truncated). */
  diff: string;
  /** `git diff --stat` summary (never truncated). */
  diffStat: string;
  /** sha1 of the *full* (pre-truncation) diff — used for re-poll idempotency. */
  diffHash: string;
  /** True when `diff` was truncated to fit the size cap. */
  truncated: boolean;
  status: BatchStatus;
  issue?: string;
  category?: IssueCategory;
  commitSha?: string;
  createdAt: number;
  resolvedAt?: number;
}

// ---- Developer-facing result shapes ----

export type InitializeSessionResult =
  | { status: "ok"; loop_id: string; repo: string; head: string | null; message: string }
  | { status: "error"; message: string };

export type RequestReviewResult =
  | { status: "approved"; batch_id: string; commit_sha: string; commit_message: string }
  | { status: "changes_requested"; batch_id: string; issue: string; category: IssueCategory }
  | { status: "keep_waiting"; batch_id: string; message: string }
  | { status: "nothing_to_review"; message: string }
  | { status: "not_initialized"; message: string }
  // Emitted by the server boundary (not the orchestrator) when the call is
  // missing one of the two required arguments — see validateReviewArgs.
  | { status: "invalid_request"; missing: string[]; message: string };

export type AwaitReviewResult =
  | RequestReviewResult
  | { status: "no_active_batch"; message: string };

export type SignalCompleteResult =
  | { status: "ok"; message: string }
  // Emitted by the server boundary when the session's loop cannot be resolved.
  | { status: "not_initialized"; message: string };

// ---- Reviewer-facing result shapes ----

export type GetNextReviewResult =
  | {
      status: "review_ready";
      /** Id of the review loop this batch belongs to — echo it via loop_id on submit_review. */
      loop_id: string;
      /** Canonical path of the working copy this batch belongs to. */
      repo: string;
      batch_id: string;
      summary: string;
      commit_message: string;
      diff: string;
      diff_stat: string;
      truncated: boolean;
    }
  | { status: "keep_waiting"; message: string }
  | { status: "workflow_complete"; message: string }
  // Emitted by the server boundary when it cannot tell which review loop the
  // caller means (several repos are active and the session is not bound).
  | { status: "not_initialized"; message: string };

export type SubmitReviewResult =
  | { status: "recorded"; verdict: "approved"; batch_id: string; commit_sha: string }
  | { status: "recorded"; verdict: "changes_requested"; batch_id: string }
  // Emitted by the server boundary when the session's loop cannot be resolved.
  | { status: "not_initialized"; message: string }
  | { status: "error"; message: string };

// ---- Shared status snapshot ----

/** State of one review loop (= one working copy). */
export interface WorkflowStatus {
  phase: "idle" | "awaiting_review" | "reviewing";
  complete: boolean;
  active_batch: {
    batch_id: string;
    status: BatchStatus;
    summary: string;
    commit_message: string;
  } | null;
  last_verdict: {
    batch_id: string;
    status: BatchStatus;
    issue?: string;
    category?: IssueCategory;
    commit_sha?: string;
  } | null;
  completed_batches: number;
  loop_id: string;
  repo: string;
}

/** Coordinator-wide snapshot: every loop currently hosted, keyed by repo. */
export interface ServerStatus {
  loops: WorkflowStatus[];
}
