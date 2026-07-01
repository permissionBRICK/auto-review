#!/usr/bin/env node
/**
 * Stdio entrypoint for the `command: "node"` MCP config type.
 *
 * Claude Code / Codex spawns ONE of these per agent (developer / reviewer) over
 * stdio. Because the two agents are separate processes, the shared review state
 * can't live inside them — so this is a thin PROXY:
 *
 *   client  ──stdio──▶  this proxy  ──HTTP──▶  shared coordinator (singleton)
 *
 * It ensures one background coordinator is running, connects to that
 * coordinator's role endpoint as an MCP client, and transparently forwards
 * tools/list and tools/call.
 *
 * The coordinator hosts one review loop per repo, so the proxy identifies its
 * repo — `--repo`/`AUTO_REVIEW_REPO`, else the git toplevel of its own cwd
 * (agent harnesses spawn it with cwd = the workspace folder) — and binds the
 * connection to that loop via `?repo=` on the endpoint URL. The same config
 * therefore works in every repo, and pairs in different repos run in parallel
 * without seeing each other.
 *
 * Usage (via .mcp.json / config.toml):
 *   command: node
 *   args: [".../dist/stdio.js", "--role", "developer"]
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { detectRepo, ensureCoordinator } from "./launch.js";
import type { RoleScope } from "./types.js";

interface ProxyConfig {
  role: RoleScope;
  repo?: string; // optional: defaults to the git toplevel of the proxy's own cwd
  host: string;
  port: number;
  pollSeconds: number;
  waitSeconds: number;
  maxDiffBytes: number;
}

function err(msg: string): void {
  process.stderr.write(`[auto-review stdio] ${msg}\n`);
}

function parseConfig(argv: string[]): ProxyConfig {
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const eq = key.indexOf("=");
    if (eq >= 0) opts.set(key.slice(0, eq), key.slice(eq + 1));
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opts.set(key, argv[++i]);
    else opts.set(key, "true");
  }
  const get = (k: string, env: string, dflt?: string) => opts.get(k) ?? process.env[env] ?? dflt;

  // Role is optional. With no role (the default) the proxy attaches to the
  // combined "/both" endpoint, which exposes every tool and lets the agent play
  // one user-assigned role. A preset role behaves exactly as before.
  const roleRaw = get("role", "AUTO_REVIEW_ROLE");
  const role = (roleRaw == null || roleRaw === "" ? "both" : roleRaw) as RoleScope;
  if (role !== "developer" && role !== "reviewer" && role !== "both") {
    err(
      `--role must be 'developer', 'reviewer', or 'both' (got: ${roleRaw}). ` +
        `Omit --role to expose both roles' tools (default).`,
    );
    process.exit(1);
  }
  // The coordinator's poll window must stay under undici's ~300s headersTimeout
  // (a longer single HTTP hold dies as "fetch failed"), hence the 270s clamp.
  const pollSeconds = Math.min(
    Number(get("poll-seconds", "AUTO_REVIEW_POLL_SECONDS", "240")),
    270,
  );
  return {
    role,
    repo: get("repo", "AUTO_REVIEW_REPO"),
    host: get("host", "AUTO_REVIEW_HOST", "127.0.0.1")!,
    port: Number(get("port", "AUTO_REVIEW_PORT", "8765")),
    pollSeconds,
    waitSeconds: Number(get("wait-seconds", "AUTO_REVIEW_WAIT_SECONDS", "600")),
    maxDiffBytes: Number(get("max-diff-bytes", "AUTO_REVIEW_MAX_DIFF_BYTES", "200000")),
  };
}

async function main(): Promise<void> {
  const cfg = parseConfig(process.argv.slice(2));

  // Which review loop this agent belongs to: explicit --repo/AUTO_REVIEW_REPO,
  // else the repo the proxy was spawned in. Without either, the session stays
  // unbound and the coordinator falls back to its single active loop.
  const repo = cfg.repo ?? (await detectRepo());
  if (!cfg.repo && repo) err(`repo detected from cwd: ${repo}`);
  if (!repo) {
    err(
      "no repo detected (cwd is not inside a git work tree); attaching unbound — " +
        "fine with a single review loop, ambiguous once several run in parallel.",
    );
  }
  await ensureCoordinator({ ...cfg, repo, log: err });

  // Connect to the coordinator as an MCP client on this agent's role endpoint,
  // bound to this repo's loop.
  const repoQuery = repo ? `?repo=${encodeURIComponent(repo)}` : "";
  const endpoint = `http://${cfg.host}:${cfg.port}/${cfg.role}/mcp${repoQuery}`;
  const client = new Client({ name: `auto-review-proxy-${cfg.role}`, version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));

  // Generous timeout for each forwarded call; the coordinator returns
  // keep_waiting within its poll window, so this only needs headroom.
  const callTimeoutMs = (cfg.pollSeconds + 30) * 1000;

  // Blocking waits are looped HERE, inside the proxy: the coordinator can hold
  // a single HTTP long-poll only ~270s (undici headersTimeout), so the proxy
  // absorbs its keep_waiting results and re-polls until the agent-facing wait
  // window (cfg.waitSeconds) elapses. The agent only sees keep_waiting every
  // waitSeconds instead of every coordinator poll window. The agent's MCP
  // client timeout must cover waitSeconds + pollSeconds + margin.
  const BLOCKING_TOOLS = new Set(["request_review", "await_review", "get_next_review"]);

  /** Extract {status, batch_id} from a tool result's JSON text, or null. */
  const parseStatus = (result: unknown): { status?: string; batch_id?: string } | null => {
    try {
      const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
      const text = content?.find((c) => c.type === "text")?.text;
      return text ? (JSON.parse(text) as { status?: string; batch_id?: string }) : null;
    } catch {
      return null;
    }
  };

  const callBlocking = async (params: { name: string; arguments?: Record<string, unknown> }) => {
    const deadline = Date.now() + cfg.waitSeconds * 1000;
    let current = params;
    for (;;) {
      const result = await client.callTool(current, undefined, { timeout: callTimeoutMs });
      const body = parseStatus(result);
      if (body?.status !== "keep_waiting" || Date.now() >= deadline) return result;
      // Re-poll quietly. After request_review registered the batch, switch to
      // the cheap await_review wait so the tree isn't re-snapshotted each round.
      if (current.name === "request_review" && body.batch_id) {
        current = { name: "await_review", arguments: { batch_id: body.batch_id } };
      }
    }
  };

  // Expose a stdio MCP server that transparently mirrors the coordinator's
  // tools (single source of truth = the coordinator).
  const server = new Server(
    { name: `auto-review-${cfg.role}`, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => client.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    BLOCKING_TOOLS.has(req.params.name)
      ? callBlocking(req.params)
      : client.callTool(req.params, undefined, { timeout: callTimeoutMs }),
  );

  const shutdown = async () => {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
  err(`ready: proxying ${cfg.role} → ${endpoint}`);
}

main().catch((e) => {
  err(`FATAL: ${e?.stack ?? String(e)}`);
  process.exit(1);
});
