/**
 * Shared helper to ensure exactly one detached background coordinator is
 * running, used by both the stdio proxy and the poller CLI. The first caller on
 * a given port starts it; everyone else attaches to it. It outlives any caller.
 */
import { spawn } from "node:child_process";
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

/** Returns the coordinator's reported state if healthy, else null. */
export async function pingHealth(base: string): Promise<{ repo?: string | null } | null> {
  try {
    const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const body = (await r.json()) as { status?: { repo?: string | null } };
    return { repo: body.status?.repo ?? null };
  } catch {
    return null;
  }
}

/** Ensure a single background coordinator is running; resolves when it is healthy. */
export async function ensureCoordinator(cfg: CoordinatorTarget): Promise<void> {
  const log = cfg.log ?? (() => {});
  const base = `http://${cfg.host}:${cfg.port}`;

  const existing = await pingHealth(base);
  if (existing) {
    if (cfg.repo && existing.repo && existing.repo !== cfg.repo) {
      log(
        `WARNING: coordinator already running for repo '${existing.repo}', ` +
          `not '${cfg.repo}'. The running repo wins; point both agents at the same repo.`,
      );
    }
    return;
  }

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
