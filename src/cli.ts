#!/usr/bin/env node
/**
 * Thin blocking poller for the auto-review coordinator — the shell command an
 * agent runs when its MCP client kills a blocking tool call with a hard timeout
 * (e.g. Codex's ~120s "timed out awaiting tools/call"). A shell process is NOT
 * bound by that MCP per-call limit, so this can wait far longer.
 *
 * It hits a plain-HTTP long-poll endpoint on the coordinator and hides
 * `keep_waiting` internally: it blocks until there is a REAL result, then prints
 * that JSON to stdout and exits. The agent reads stdout and acts on it.
 *
 *   next-review     wait for the next batch to review   (reviewer)
 *   await-verdict   wait for the verdict of the batch you already submitted (developer)
 *   status          print the package version + every review loop once and exit
 *
 * The coordinator hosts one review loop per repo. The CLI targets the loop
 * named by --repo/AUTO_REVIEW_REPO, else the git toplevel of its own cwd (the
 * agent normally runs it from inside the repo), else the coordinator's single
 * active loop.
 *
 * Flags: --repo <path> --port (8765) --host (127.0.0.1) --timeout <seconds>
 * (1500) and the usual --poll-seconds / --max-diff-bytes (only used if it has
 * to start the coordinator). On reaching --timeout it prints
 * {"status":"keep_waiting"} and exits 0, so the agent can simply run it again.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { detectRepo, ensureCoordinator } from "./launch.js";

const ENDPOINTS: Record<string, { path: string }> = {
  "next-review": { path: "/reviewer/next-review" },
  "await-verdict": { path: "/developer/await-verdict" },
};

function out(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}
function errlog(msg: string): void {
  process.stderr.write(`[auto-review cli] ${msg}\n`);
}

/**
 * Verbose-only diagnostics. The blocking poll loop re-polls every poll window
 * and aborts each request just under undici's ~300s headersTimeout; both are
 * normal and NOT a result. Printing on each iteration would wake a waiting agent
 * every few minutes, so these messages are emitted ONLY when AUTO_REVIEW_CLI_DEBUG
 * is set. By default the command stays completely silent until it has a real
 * result (or its overall --timeout budget elapses).
 */
const DEBUG = process.env.AUTO_REVIEW_CLI_DEBUG === "1" || process.env.AUTO_REVIEW_CLI_DEBUG === "true";
function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[auto-review cli] ${msg}\n`);
}

interface CliConfig {
  sub: string;
  repo?: string;
  host: string;
  port: number;
  timeoutSeconds: number;
  pollSeconds: number;
  maxDiffBytes: number;
}

function parse(argv: string[]): CliConfig {
  let sub = "";
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      if (!sub) sub = a;
      continue;
    }
    const key = a.slice(2);
    const eq = key.indexOf("=");
    if (eq >= 0) opts.set(key.slice(0, eq), key.slice(eq + 1));
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opts.set(key, argv[++i]);
    else opts.set(key, "true");
  }
  const get = (k: string, env: string, dflt?: string) => opts.get(k) ?? process.env[env] ?? dflt;
  return {
    sub,
    repo: get("repo", "AUTO_REVIEW_REPO"),
    host: get("host", "AUTO_REVIEW_HOST", "127.0.0.1")!,
    port: Number(get("port", "AUTO_REVIEW_PORT", "8765")),
    timeoutSeconds: Number(get("timeout", "AUTO_REVIEW_CLI_TIMEOUT", "3600")),
    pollSeconds: Number(get("poll-seconds", "AUTO_REVIEW_POLL_SECONDS", "240")),
    maxDiffBytes: Number(get("max-diff-bytes", "AUTO_REVIEW_MAX_DIFF_BYTES", "200000")),
  };
}

async function main(): Promise<void> {
  const cfg = parse(process.argv.slice(2));
  const base = `http://${cfg.host}:${cfg.port}`;

  if (cfg.sub === "status") {
    await ensureCoordinator({
      host: cfg.host,
      port: cfg.port,
      pollSeconds: cfg.pollSeconds,
      maxDiffBytes: cfg.maxDiffBytes,
      log: errlog,
    });
    const r = await fetch(`${base}/healthz`);
    const body = (await r.json()) as { version?: string; loops?: unknown };
    out(Array.isArray(body.loops) ? { version: body.version ?? null, loops: body.loops } : body);
    return;
  }

  // Which review loop to target on the (multi-tenant) coordinator: --repo,
  // else the repo this command runs in. Omitted entirely when neither exists —
  // the coordinator then falls back to its single active loop.
  const repo = cfg.repo ?? (await detectRepo());
  const repoQuery = repo ? `?repo=${encodeURIComponent(repo)}` : "";

  const endpoint = ENDPOINTS[cfg.sub];
  if (!endpoint) {
    errlog(`unknown command '${cfg.sub}'. Use: next-review | await-verdict | status`);
    process.exit(2);
  }

  const target = { ...cfg, repo, log: debug };
  await ensureCoordinator(target);
  const url = `${base}${endpoint.path}${repoQuery}`;
  const deadline = Date.now() + cfg.timeoutSeconds * 1000;

  // Cap each HTTP request well under Node/undici's default 300s headersTimeout,
  // which otherwise kills a longer-held long-poll with "fetch failed". The
  // coordinator returns keep_waiting within its (smaller) poll window, so this
  // cap normally never bites; it just bounds a single request for safety.
  const PER_REQUEST_MS = 270_000;

  // Loop until a real result or our own --timeout budget. Transient errors
  // (undici timeout, a coordinator restart, a network blip) are NEVER fatal
  // mid-wait — we self-heal and keep polling, so one shell command can wait
  // for the whole budget (default 1h) without ever returning "fetch failed".
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      out({ status: "keep_waiting", message: "Time budget elapsed; run this command again to keep waiting." });
      return;
    }
    let body: { status?: string } | undefined;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(remaining, PER_REQUEST_MS)) });
      if (!res.ok) {
        debug(`coordinator returned HTTP ${res.status}; retrying`);
        await sleep(2000);
        continue;
      }
      body = (await res.json()) as { status?: string };
    } catch (e) {
      // Per-request cap reached (the common case for a long, quiet wait), undici
      // headers/body timeout, or a blip. None of these is a result — re-ensure the
      // coordinator in case it died and re-poll WITHOUT printing anything, so the
      // agent's blocking wait is never interrupted by output.
      if (deadline - Date.now() > 1500) {
        debug(`poll retry (${(e as Error)?.name ?? e})`);
        await ensureCoordinator({ ...target, log: () => {} }).catch(() => {});
        await sleep(1000);
      }
      continue;
    }
    if (body.status === "keep_waiting") continue; // coordinator window elapsed → re-poll
    out(body);
    return;
  }
}

main().catch((e) => {
  errlog(`FATAL: ${e?.stack ?? String(e)}`);
  process.exit(1);
});
