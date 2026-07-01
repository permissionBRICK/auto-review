/**
 * Registry of concurrent review loops, keyed by the canonical repo path
 * (realpath of `git rev-parse --show-toplevel`). One coordinator process hosts
 * any number of independent loops — one per working copy — so several
 * developer/reviewer pairs can run in parallel on the same machine. Two
 * worktrees of the same repository resolve to different keys and therefore get
 * independent loops; two paths inside one checkout resolve to the same loop.
 */
import { GitRepo } from "./git.js";
import { Orchestrator, type OrchestratorOptions } from "./orchestrator.js";

export class LoopRegistry {
  private readonly loops = new Map<string, Orchestrator>();
  /** Wakes callers blocked in waitForFirstLoop when a loop is created. */
  private readonly waiters = new Set<(orch: Orchestrator) => void>();

  constructor(private readonly optionsFor: (repoKey: string) => OrchestratorOptions) {}

  /**
   * Canonicalize `repoPath` and return its loop, creating one if this working
   * copy has none yet. Throws GitError when the path is not a git work tree.
   */
  async resolve(repoPath: string): Promise<Orchestrator> {
    const probe = new GitRepo(repoPath);
    await probe.assertRepo();
    const key = await probe.toplevel();
    // No awaits between the lookup and the set, so concurrent resolves of the
    // same repo cannot race into two loops.
    const existing = this.loops.get(key);
    if (existing) return existing;
    const orch = new Orchestrator(new GitRepo(key), this.optionsFor(key));
    this.loops.set(key, orch);
    for (const w of [...this.waiters]) w(orch);
    return orch;
  }

  /** The loop for an already-registered working copy, or null. Never creates. */
  async lookup(repoPath: string): Promise<Orchestrator | null> {
    const probe = new GitRepo(repoPath);
    try {
      await probe.assertRepo();
      return this.loops.get(await probe.toplevel()) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The single active loop when exactly one exists, else null. This is the
   * fallback for callers that did not say which repo they mean — it keeps the
   * original one-repo setup working with zero configuration.
   */
  single(): Orchestrator | null {
    return this.loops.size === 1 ? this.loops.values().next().value! : null;
  }

  /**
   * Block until any loop exists (up to `ms`), then return the first one. Lets
   * a reviewer that starts before its developer wait instead of erroring out.
   */
  waitForFirstLoop(ms: number): Promise<Orchestrator | null> {
    const first = this.loops.values().next().value;
    if (first) return Promise.resolve(first);
    return new Promise((resolve) => {
      const w = (orch: Orchestrator) => {
        clearTimeout(timer);
        this.waiters.delete(w);
        resolve(orch);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(w);
        resolve(null);
      }, ms);
      this.waiters.add(w);
    });
  }

  get size(): number {
    return this.loops.size;
  }

  all(): Orchestrator[] {
    return [...this.loops.values()];
  }

  keys(): string[] {
    return [...this.loops.keys()];
  }
}
