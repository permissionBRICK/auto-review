/**
 * The shared rendezvous between the developer agent and the reviewer agent.
 *
 * A single instance is shared across both MCP sessions. It holds the one batch
 * currently moving through the loop and coordinates the two blocking calls
 * (developer's `request_review` and reviewer's `get_next_review`) using an
 * event-driven wait: any state change wakes the waiters, who re-check their
 * condition. Handoffs are therefore instant; the bounded wait window only
 * controls how long an *idle* waiter holds before returning `keep_waiting`.
 */
import { GitError, GitRepo } from "./git.js";
import type {
  Batch,
  GetNextReviewResult,
  InitializeSessionResult,
  IssueCategory,
  RequestReviewResult,
  SignalCompleteResult,
  SubmitReviewResult,
  WorkflowStatus,
} from "./types.js";

/** Promise-chain mutex: serialises the short critical sections (git + state). */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = this.tail.then(() => next);
    await prev;
    return release;
  }
}

const ACTIVE_STATUSES = new Set(["queued", "in_review"]);

export interface OrchestratorOptions {
  pollMs: number;
  maxDiffBytes: number;
  log?: (msg: string) => void;
}

export class Orchestrator {
  /** The repo the session operates on; set by the developer via initializeSession. */
  private git: GitRepo | null = null;
  private active: Batch | null = null;
  private complete = false;
  private completedCount = 0;
  private lastResolved: Batch | null = null;
  private seq = 0;

  /** Resolvers waiting for any state change. */
  private waiters = new Set<() => void>();
  private readonly mutex = new Mutex();
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: OrchestratorOptions) {
    this.log = opts.log ?? (() => {});
  }

  /**
   * Point the workflow at a git repository (set by the developer agent at
   * runtime, or pre-set from --repo at startup). Validates the path, then
   * resets the session so a fresh review loop starts in the new repo. Held in
   * memory until the server stops or this is called again.
   */
  async initializeSession(repoPath: string): Promise<InitializeSessionResult> {
    const candidate = new GitRepo(repoPath);
    try {
      await candidate.assertRepo();
    } catch (err) {
      return { status: "error", message: (err as Error).message };
    }
    const release = await this.mutex.lock();
    try {
      this.git = candidate;
      // Fresh session.
      this.active = null;
      this.complete = false;
      this.completedCount = 0;
      this.lastResolved = null;
      this.notify();
      const head = await candidate.head();
      this.log(`session initialised for ${repoPath} (HEAD ${head ? head.slice(0, 8) : "none"})`);
      return {
        status: "ok",
        repo: repoPath,
        head,
        message: "Review session ready. Implement a batch, then call request_review.",
      };
    } finally {
      release();
    }
  }

  // ---- wait primitives ----

  /** Resolve either when notified or after `ms`. */
  private waitForChange(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const w = () => {
        clearTimeout(timer);
        this.waiters.delete(w);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(w);
        resolve();
      }, ms);
      this.waiters.add(w);
    });
  }

  /** Block until `pred()` is true or the window elapses. Returns pred()'s final value. */
  private async waitUntil(pred: () => boolean, windowMs: number): Promise<boolean> {
    if (pred()) return true;
    const deadline = Date.now() + windowMs;
    while (!pred()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await this.waitForChange(remaining);
    }
    return true;
  }

  private notify(): void {
    for (const w of [...this.waiters]) w();
  }

  private nextId(): string {
    this.seq += 1;
    return `batch-${this.seq}`;
  }

  /** True while a batch is queued or in review (i.e. the reviewer has work). */
  private pendingForReview(): boolean {
    return (
      this.active !== null &&
      (this.active.status === "queued" || this.active.status === "in_review")
    );
  }

  // ---- developer side ----

  /**
   * Snapshot the working tree, register/refresh the active batch, and block
   * until the reviewer rules on it (or the wait window elapses).
   */
  async requestReview(summary: string, commitMessage: string): Promise<RequestReviewResult> {
    const release = await this.mutex.lock();
    let batchId: string;
    try {
      if (!this.git) {
        return {
          status: "not_initialized",
          message:
            "No repository configured yet. Call initialize_review_session with the absolute path " +
            "to the git repo you are working in, then call request_review again.",
        };
      }
      const snap = await this.git.captureDiff(this.opts.maxDiffBytes);
      if (snap.isEmpty) {
        return {
          status: "nothing_to_review",
          message:
            "No changes versus HEAD. Implement a batch of work, then call request_review again.",
        };
      }

      const reusable =
        this.active &&
        ACTIVE_STATUSES.has(this.active.status) &&
        this.active.diffHash === snap.diffHash;

      if (!reusable) {
        const batch: Batch = {
          id: this.nextId(),
          summary,
          commitMessage,
          diff: snap.diff,
          diffStat: snap.diffStat,
          diffHash: snap.diffHash,
          truncated: snap.truncated,
          status: "queued",
          createdAt: Date.now(),
        };
        this.active = batch;
        this.log(`developer submitted ${batch.id} (${snap.fullBytes} byte diff): ${commitMessage}`);
        this.notify(); // wake a waiting reviewer
      } else {
        // identical diff while a review is pending → keep refreshed text, resume waiting
        this.active!.summary = summary;
        this.active!.commitMessage = commitMessage;
      }
      batchId = this.active!.id;
    } finally {
      release();
    }

    return this.waitForVerdict(batchId);
  }

  /**
   * Wait until `batchId` reaches a verdict (or the window elapses) and return
   * it. Reads the verdict WITHOUT clearing the batch, so it is safe to call
   * from several places at once — a re-polling developer, the `await-verdict`
   * poll command, or a retry after a client timeout. The batch is only replaced
   * when the developer submits the next one.
   */
  private async waitForVerdict(batchId: string): Promise<RequestReviewResult> {
    const resolved = await this.waitUntil(() => {
      const b = this.active;
      return (
        !!b && b.id === batchId && (b.status === "approved" || b.status === "changes_requested")
      );
    }, this.opts.pollMs);

    if (!resolved) {
      return {
        status: "keep_waiting",
        batch_id: batchId,
        message:
          "The reviewer has not finished yet. Call request_review again (same arguments) to keep waiting.",
      };
    }

    const b = this.active;
    if (!b || b.id !== batchId) {
      return {
        status: "keep_waiting",
        batch_id: batchId,
        message: "The batch was superseded; call request_review again to re-sync.",
      };
    }
    if (b.status === "approved") {
      return {
        status: "approved",
        batch_id: b.id,
        commit_sha: b.commitSha!,
        commit_message: b.commitMessage,
      };
    }
    return {
      status: "changes_requested",
      batch_id: b.id,
      issue: b.issue ?? "(no description provided)",
      category: b.category ?? "code",
    };
  }

  /**
   * Block until the current batch has a verdict — used by the `await-verdict`
   * poll command after the developer already submitted via request_review
   * (whose MCP call may have been cut off by a client timeout). Does not
   * re-snapshot the tree or resubmit.
   */
  async awaitVerdict(): Promise<
    RequestReviewResult | { status: "no_active_batch"; message: string }
  > {
    const b = this.active;
    if (!b) {
      return {
        status: "no_active_batch",
        message:
          "No batch is awaiting a verdict. Submit one with the request_review tool first.",
      };
    }
    return this.waitForVerdict(b.id);
  }

  async signalComplete(note?: string): Promise<SignalCompleteResult> {
    const release = await this.mutex.lock();
    try {
      this.complete = true;
      this.notify();
      this.log(`developer signalled workflow complete${note ? `: ${note}` : ""}`);
      return {
        status: "ok",
        message: "Workflow marked complete. The reviewer will be told to stop.",
      };
    } finally {
      release();
    }
  }

  // ---- reviewer side ----

  /** Block until a batch is queued for review (or the workflow completes / window elapses). */
  async getNextReview(): Promise<GetNextReviewResult> {
    // Fast path / idempotent re-poll under the lock.
    const tryClaim = async (): Promise<GetNextReviewResult | null> => {
      const release = await this.mutex.lock();
      try {
        if (this.active && this.active.status === "queued") {
          this.active.status = "in_review";
          this.log(`reviewer picked up ${this.active.id}`);
        }
        if (this.active && this.active.status === "in_review") {
          const b = this.active;
          return {
            status: "review_ready",
            batch_id: b.id,
            summary: b.summary,
            commit_message: b.commitMessage,
            diff: b.diff,
            diff_stat: b.diffStat,
            truncated: b.truncated,
          };
        }
        if (this.complete && !this.pendingForReview()) {
          return {
            status: "workflow_complete",
            message: "The developer signalled the task is finished. Nothing left to review.",
          };
        }
        return null;
      } finally {
        release();
      }
    };

    const immediate = await tryClaim();
    if (immediate) return immediate;

    const ready = await this.waitUntil(
      () => this.pendingForReview() || this.complete,
      this.opts.pollMs,
    );

    if (!ready) {
      return {
        status: "keep_waiting",
        message: "No batch is ready yet. Call get_next_review again to keep waiting.",
      };
    }
    const claimed = await tryClaim();
    return (
      claimed ?? {
        status: "keep_waiting",
        message: "No batch is ready yet. Call get_next_review again to keep waiting.",
      }
    );
  }

  /** Record the verdict for the in-review batch and (on approval) commit it. */
  async submitReview(
    batchId: string,
    verdict: "approved" | "changes_requested",
    issue?: string,
    category?: IssueCategory,
  ): Promise<SubmitReviewResult> {
    const release = await this.mutex.lock();
    try {
      const b = this.active;
      if (!b || b.status !== "in_review") {
        return {
          status: "error",
          message:
            "There is no batch currently in review. Call get_next_review to receive a batch first.",
        };
      }
      if (b.id !== batchId) {
        return {
          status: "error",
          message: `batch_id mismatch: the batch in review is '${b.id}', not '${batchId}'. Use the batch_id from get_next_review.`,
        };
      }

      if (verdict === "approved") {
        if (!this.git) {
          return { status: "error", message: "No repository configured; cannot commit." };
        }
        let sha: string;
        try {
          sha = await this.git.commit(b.commitMessage);
        } catch (err) {
          const detail = err instanceof GitError ? (err.stderr ?? err.message) : String(err);
          this.log(`commit FAILED for ${b.id}: ${detail}`);
          // Keep the batch in review so the reviewer can retry or request changes.
          return {
            status: "error",
            message:
              `Approval recorded but the commit failed (the batch is still in review). ` +
              `Fix the cause or submit changes_requested instead. git said: ${detail}`,
          };
        }
        b.status = "approved";
        b.commitSha = sha;
        b.resolvedAt = Date.now();
        this.completedCount += 1;
        this.lastResolved = b;
        this.log(`reviewer APPROVED ${b.id} → committed ${sha.slice(0, 8)}`);
        this.notify();
        return { status: "recorded", verdict: "approved", batch_id: b.id, commit_sha: sha };
      }

      // changes_requested
      if (!issue || issue.trim() === "") {
        return {
          status: "error",
          message: "changes_requested requires a non-empty 'issue' describing what to fix.",
        };
      }
      b.status = "changes_requested";
      b.issue = issue;
      b.category = category ?? "code";
      b.resolvedAt = Date.now();
      this.lastResolved = b;
      this.log(`reviewer requested changes on ${b.id} (${b.category}): ${issue}`);
      this.notify();
      return { status: "recorded", verdict: "changes_requested", batch_id: b.id };
    } finally {
      release();
    }
  }

  // ---- shared ----

  status(): WorkflowStatus {
    const phase: WorkflowStatus["phase"] = !this.active
      ? "idle"
      : this.active.status === "queued"
        ? "awaiting_review"
        : this.active.status === "in_review"
          ? "reviewing"
          : "idle"; // a resolved batch sitting until the next submit
    return {
      phase,
      complete: this.complete,
      active_batch: this.active
        ? {
            batch_id: this.active.id,
            status: this.active.status,
            summary: this.active.summary,
            commit_message: this.active.commitMessage,
          }
        : null,
      last_verdict: this.lastResolved
        ? {
            batch_id: this.lastResolved.id,
            status: this.lastResolved.status,
            issue: this.lastResolved.issue,
            category: this.lastResolved.category,
            commit_sha: this.lastResolved.commitSha,
          }
        : null,
      completed_batches: this.completedCount,
      repo: this.git ? this.git.dir : null,
    };
  }
}
