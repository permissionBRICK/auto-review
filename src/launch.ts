/**
 * Shared helpers for the stdio proxy and the poller CLI: ensure exactly one
 * detached background coordinator is running (the first caller on a given port
 * starts it; everyone else attaches; it outlives any caller), and detect which
 * repo — and therefore which review loop on that multi-tenant coordinator — the
 * calling process belongs to.
 */
import { execFile, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const SERVER_PATH = fileURLToPath(new URL("./server.js", import.meta.url));

export interface CoordinatorTarget {
  host: string;
  port: number;
  repo?: string;
  pollSeconds: number;
  maxDiffBytes: number;
  log?: (msg: string) => void;
}

/**
 * The toplevel of the git repo containing `cwd`, or undefined when not inside
 * one. Agent harnesses launch the proxy/CLI with cwd = the workspace folder,
 * so this identifies the caller's review loop with zero configuration. (The
 * coordinator canonicalizes further with realpath, so a plain toplevel is
 * enough here.)
 */
export function detectRepo(cwd: string = process.cwd()): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
      (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined),
    );
  });
}

/** Returns the coordinator's health snapshot if it is up, else null. */
export async function pingHealth(
  base: string,
): Promise<{ version?: string; loops?: unknown[] } | null> {
  try {
    const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const body = (await r.json()) as { ok?: boolean; version?: string; loops?: unknown[] };
    return body?.ok ? { version: body.version, loops: body.loops } : null;
  } catch {
    return null;
  }
}

/** Ensure a single background coordinator is running; resolves when it is healthy. */
export async function ensureCoordinator(cfg: CoordinatorTarget): Promise<void> {
  const log = cfg.log ?? (() => {});
  const base = `http://${cfg.host}:${cfg.port}`;

  if (await pingHealth(base)) return;

  const logFile = join(tmpdir(), `auto-review-coordinator-${cfg.port}.log`);
  const out = openSync(logFile, "a");
  log(`starting shared coordinator (logs: ${logFile})`);
  const serverArgs = [
    SERVER_PATH,
    "--host", cfg.host,
    "--port", String(cfg.port),
    "--poll-seconds", String(cfg.pollSeconds),
    "--max-diff-bytes", String(cfg.maxDiffBytes),
  ];
  if (cfg.repo) serverArgs.push("--repo", cfg.repo);
  const child = spawn(process.execPath, serverArgs, {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();

  for (let i = 0; i < 100; i++) {
    if (await pingHealth(base)) return;
    await sleep(100);
  }
  throw new Error(`coordinator did not become healthy at ${base} within 10s (see ${logFile})`);
}
