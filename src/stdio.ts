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

import { ensureCoordinator } from "./launch.js";
import type { RoleScope } from "./types.js";

interface ProxyConfig {
  role: RoleScope;
  repo?: string; // optional: the developer agent normally sets it via initialize_review_session
  host: string;
  port: number;
  pollSeconds: number;
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
  return {
    role,
    repo: get("repo", "AUTO_REVIEW_REPO"),
    host: get("host", "AUTO_REVIEW_HOST", "127.0.0.1")!,
    port: Number(get("port", "AUTO_REVIEW_PORT", "8765")),
    pollSeconds: Number(get("poll-seconds", "AUTO_REVIEW_POLL_SECONDS", "40")),
    maxDiffBytes: Number(get("max-diff-bytes", "AUTO_REVIEW_MAX_DIFF_BYTES", "200000")),
  };
}

async function main(): Promise<void> {
  const cfg = parseConfig(process.argv.slice(2));
  await ensureCoordinator({ ...cfg, log: err });

  // Connect to the coordinator as an MCP client on this agent's role endpoint.
  const endpoint = `http://${cfg.host}:${cfg.port}/${cfg.role}/mcp`;
  const client = new Client({ name: `auto-review-proxy-${cfg.role}`, version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));

  // Generous timeout for forwarded blocking calls; the coordinator returns
  // keep_waiting within its poll window, so this only needs headroom.
  const callTimeoutMs = (cfg.pollSeconds + 30) * 1000;

  // Expose a stdio MCP server that transparently mirrors the coordinator's
  // tools (single source of truth = the coordinator).
  const server = new Server(
    { name: `auto-review-${cfg.role}`, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => client.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    client.callTool(req.params, undefined, { timeout: callTimeoutMs }),
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
