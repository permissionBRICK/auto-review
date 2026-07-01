/**
 * Thin async wrapper around the `git` CLI for the project repo under review.
 *
 * All commands use `git -C <dir> ...` and `execFile` (no shell) so paths and
 * messages with spaces or special characters are safe.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DiffSnapshot {
  diff: string; // possibly truncated, for display to the reviewer
  diffStat: string; // full --stat summary
  diffHash: string; // sha1 of the full (untruncated) diff
  isEmpty: boolean; // no changes vs HEAD
  truncated: boolean; // diff was clipped to the size cap
  fullBytes: number; // size of the full diff in bytes
}

export class GitError extends Error {
  constructor(message: string, public readonly stderr?: string) {
    super(message);
    this.name = "GitError";
  }
}

export class GitRepo {
  constructor(public readonly dir: string) {}

  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync("git", ["-C", this.dir, ...args], {
        maxBuffer: 64 * 1024 * 1024, // 64MB — big diffs are fine
        encoding: "utf8",
      });
      return { stdout, stderr };
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      throw new GitError(
        `git ${args.join(" ")} failed: ${e.message ?? "unknown error"}`,
        e.stderr ?? e.stdout,
      );
    }
  }

  /** Throws a helpful error if `dir` is not inside a git work tree. */
  async assertRepo(): Promise<void> {
    try {
      const { stdout } = await this.git(["rev-parse", "--is-inside-work-tree"]);
      if (stdout.trim() !== "true") {
        throw new GitError(`${this.dir} is not a git work tree`);
      }
    } catch (err) {
      if (err instanceof GitError) {
        throw new GitError(
          `'${this.dir}' is not a git repository. Pass the absolute path of the project ` +
            `checkout the developer agent is editing (it must be a git work tree).`,
          err.stderr,
        );
      }
      throw err;
    }
  }

  /**
   * Canonical identity of this repo's working copy: the realpath of
   * `git rev-parse --show-toplevel`. Two paths inside the same checkout map to
   * the same string; two worktrees of one repo map to different strings. Used
   * as the key that identifies a review loop.
   */
  async toplevel(): Promise<string> {
    const { stdout } = await this.git(["rev-parse", "--show-toplevel"]);
    const top = stdout.trim();
    try {
      return await realpath(top);
    } catch {
      return top;
    }
  }

  /** Current HEAD sha, or null if the repo has no commits yet. */
  async head(): Promise<string | null> {
    try {
      const { stdout } = await this.git(["rev-parse", "HEAD"]);
      return stdout.trim();
    } catch {
      return null;
    }
  }

  /**
   * Stage everything (`git add -A`) and capture the full diff vs HEAD, including
   * new and deleted files. Staging means a later commit captures exactly what
   * was reviewed.
   */
  async captureDiff(maxBytes: number): Promise<DiffSnapshot> {
    await this.git(["add", "-A"]);
    const { stdout: stat } = await this.git(["diff", "--cached", "--stat"]);
    const { stdout: fullDiff } = await this.git(["diff", "--cached"]);

    const fullBytes = Buffer.byteLength(fullDiff, "utf8");
    const isEmpty = fullDiff.trim() === "";
    const diffHash = createHash("sha1").update(fullDiff).digest("hex");

    let diff = fullDiff;
    let truncated = false;
    if (fullBytes > maxBytes) {
      truncated = true;
      diff =
        fullDiff.slice(0, maxBytes) +
        `\n\n... [diff truncated: ${fullBytes} bytes total, showing first ${maxBytes}. ` +
        `See the --stat summary above for the full file list and inspect the working tree directly if needed.]`;
    }

    return { diff, diffStat: stat.trim(), diffHash, isEmpty, truncated, fullBytes };
  }

  /**
   * Commit the currently-staged changes with `message` plus a Reviewed-by
   * trailer. Returns the new commit sha. Throws GitError on failure (e.g. a
   * pre-commit hook rejected the change) so the caller can keep the batch open.
   */
  async commit(message: string): Promise<string> {
    await this.git(["commit", "-m", message, "--trailer", "Reviewed-by: auto-review"]);
    const sha = await this.head();
    if (!sha) throw new GitError("commit appeared to succeed but HEAD is still unset");
    return sha;
  }
}
