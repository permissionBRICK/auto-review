#!/usr/bin/env node
/**
 * Auto-review MCP orchestrator server.
 *
 * One long-running process serves the MCP over Streamable HTTP on two
 * role-scoped endpoints:
 *   - http://<host>:<port>/developer/mcp   → developer tools
 *   - http://<host>:<port>/reviewer/mcp    → reviewer tools
 *
 * Both Claude Code instances connect at the same time; all sessions share one
 * Orchestrator. Role is fixed by the URL path, so no role parameter is needed
 * on the tool calls.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { Orchestrator } from "./orchestrator.js";
import type { RoleScope } from "./types.js";
import {
  AWAIT_REVIEW_DESC,
  GET_NEXT_REVIEW_DESC,
  INITIALIZE_SESSION_DESC,
  REQUEST_REVIEW_DESC,
  SIGNAL_COMPLETE_DESC,
  SUBMIT_REVIEW_DESC,
  WORKFLOW_STATUS_DESC,
  combinedRoleNote,
  timeoutFallbackNote,
} from "./descriptions.js";

const CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));

/** Shell commands the agent can fall back to when its MCP client times out a blocking call. */
interface PollCommands {
  developer: string;
  reviewer: string;
}

// ---------------------------------------------------------------------------
// CLI / config
// ---------------------------------------------------------------------------

interface Config {
  repo?: string; // optional: developer sets it at runtime via initialize_review_session
  host: string;
  port: number;
  pollMs: number;
  maxDiffBytes: number;
}

function parseArgs(argv: string[]): Config {
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const eq = key.indexOf("=");
      if (eq >= 0) opts.set(key.slice(0, eq), key.slice(eq + 1));
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opts.set(key, argv[++i]);
      else opts.set(key, "true");
    }
  }
  const get = (k: string, env: string, dflt?: string) =>
    opts.get(k) ?? process.env[env] ?? dflt;

  const repo = get("repo", "AUTO_REVIEW_REPO");
  const pollSeconds = Number(get("poll-seconds", "AUTO_REVIEW_POLL_SECONDS", "1500"));
  return {
    repo,
    host: get("host", "AUTO_REVIEW_HOST", "0.0.0.0")!,
    port: Number(get("port", "AUTO_REVIEW_PORT", "8765")),
    pollMs: Math.max(1, pollSeconds) * 1000,
    maxDiffBytes: Number(get("max-diff-bytes", "AUTO_REVIEW_MAX_DIFF_BYTES", "200000")),
  };
}

function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// MCP server (per session) — registers the tools for one role
// ---------------------------------------------------------------------------

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function buildMcpServer(role: RoleScope, orch: Orchestrator, pollCmds: PollCommands): McpServer {
  const server = new McpServer({ name: `auto-review-${role}`, version: "0.1.1" });

  // In combined mode (no preset role) one endpoint exposes both toolsets, so each
  // description is prefixed with a note telling the agent to play one role only.
  const combined = role === "both";
  const devNote = combined ? combinedRoleNote("developer") : "";
  const revNote = combined ? combinedRoleNote("reviewer") : "";
  const sharedNote = combined ? combinedRoleNote("shared") : "";

  if (combined || role === "developer") {
    server.registerTool(
      "initialize_review_session",
      {
        description: `${devNote}${INITIALIZE_SESSION_DESC}`,
        inputSchema: {
          repo_path: z
            .string()
            .min(1)
            .describe(
              "Absolute path to the root of the git repository you are working in (usually your cwd).",
            ),
        },
      },
      async ({ repo_path }) => jsonResult(await orch.initializeSession(repo_path)),
    );

    server.registerTool(
      "request_review",
      {
        description: `${devNote}${REQUEST_REVIEW_DESC}\n\n${timeoutFallbackNote(pollCmds.developer, "the reviewer's verdict on the batch you just submitted")}`,
        inputSchema: {
          summary: z
            .string()
            .min(1)
            .describe("What you changed and why, detailed enough for a reviewer to judge it."),
          commit_message: z
            .string()
            .min(1)
            .describe("Commit message for this batch; used verbatim for the commit on approval."),
        },
      },
      async ({ summary, commit_message }) =>
        jsonResult(await orch.requestReview(summary, commit_message)),
    );

    server.registerTool(
      "await_review",
      {
        description: `${devNote}${AWAIT_REVIEW_DESC}\n\n${timeoutFallbackNote(pollCmds.developer, "the reviewer's verdict on the batch you already submitted")}`,
        inputSchema: {
          batch_id: z
            .string()
            .optional()
            .describe(
              "The batch_id from the keep_waiting result; omit to wait on the current batch.",
            ),
        },
      },
      async ({ batch_id }) => jsonResult(await orch.awaitVerdict(batch_id)),
    );

    server.registerTool(
      "signal_complete",
      {
        description: `${devNote}${SIGNAL_COMPLETE_DESC}`,
        inputSchema: { note: z.string().optional().describe("Optional closing note.") },
      },
      async ({ note }) => jsonResult(await orch.signalComplete(note)),
    );
  }

  if (combined || role === "reviewer") {
    server.registerTool(
      "get_next_review",
      {
        description: `${revNote}${GET_NEXT_REVIEW_DESC}\n\n${timeoutFallbackNote(pollCmds.reviewer, "the next batch to review")}`,
        inputSchema: {},
      },
      async () => jsonResult(await orch.getNextReview()),
    );

    server.registerTool(
      "submit_review",
      {
        description: `${revNote}${SUBMIT_REVIEW_DESC}`,
        inputSchema: {
          batch_id: z.string().min(1).describe("The batch_id returned by get_next_review."),
          verdict: z.enum(["approved", "changes_requested"]),
          issue: z
            .string()
            .optional()
            .describe("Required for changes_requested: what is wrong and what to change."),
          category: z
            .enum(["spec", "code"])
            .optional()
            .describe("Required for changes_requested: 'spec' (fails the requirement) or 'code'."),
        },
      },
      async ({ batch_id, verdict, issue, category }) =>
        jsonResult(await orch.submitReview(batch_id, verdict, issue, category)),
    );
  }

  // Shared read-only status tool, available in every mode.
  server.registerTool(
    "workflow_status",
    { description: `${sharedNote}${WORKFLOW_STATUS_DESC}`, inputSchema: {} },
    async () => jsonResult(orch.status()),
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP transport plumbing
// ---------------------------------------------------------------------------

interface Session {
  transport: StreamableHTTPServerTransport;
  role: RoleScope;
}

function roleForPath(pathname: string): RoleScope | null {
  if (pathname === "/developer" || pathname === "/developer/mcp") return "developer";
  if (pathname === "/reviewer" || pathname === "/reviewer/mcp") return "reviewer";
  if (pathname === "/both" || pathname === "/both/mcp") return "both";
  return null;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function jsonRpcError(res: http.ServerResponse, code: number, message: string): void {
  sendJson(res, code, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));

  // Shell commands the agents run for long waits — recommended both in the tool
  // descriptions (client-timeout fallback) and in keep_waiting results (a shell
  // process can block far longer than any MCP call). Quoted so paths with
  // spaces survive copy-paste into a shell.
  const node = JSON.stringify(process.execPath);
  const cli = JSON.stringify(CLI_PATH);
  const pollCmds: PollCommands = {
    developer: `${node} ${cli} await-verdict --port ${cfg.port} --timeout 3600`,
    reviewer: `${node} ${cli} next-review --port ${cfg.port} --timeout 3600`,
  };

  const orch = new Orchestrator({
    pollMs: cfg.pollMs,
    maxDiffBytes: cfg.maxDiffBytes,
    pollCommands: pollCmds,
    log,
  });

  // --repo is optional: if given, pre-initialize; otherwise the developer agent
  // sets it at runtime via initialize_review_session.
  if (cfg.repo) {
    const init = await orch.initializeSession(cfg.repo);
    if (init.status === "error") {
      log(`WARNING: --repo '${cfg.repo}' could not be used (${init.message}). ` +
        `Awaiting initialize_review_session from the developer agent.`);
    }
  }

  const sessions = new Map<string, Session>();

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;

      if (pathname === "/healthz" || pathname === "/") {
        sendJson(res, 200, { ok: true, service: "auto-review", status: orch.status() });
        return;
      }

      // Plain-HTTP long-poll endpoints used by the `cli.js` poll command (no MCP
      // session). Each blocks up to the poll window, then returns JSON; the CLI
      // re-polls internally so the agent sees one long-blocking shell command.
      if (req.method === "GET" && pathname === "/reviewer/next-review") {
        sendJson(res, 200, await orch.getNextReview());
        return;
      }
      if (req.method === "GET" && pathname === "/developer/await-verdict") {
        sendJson(res, 200, await orch.awaitVerdict());
        return;
      }

      const role = roleForPath(pathname);
      if (!role) {
        sendJson(res, 404, {
          error: "Unknown path. Use /developer/mcp, /reviewer/mcp, or /both/mcp.",
        });
        return;
      }

      const sidHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sidHeader) ? sidHeader[0] : sidHeader;

      if (req.method === "POST") {
        const body = await readBody(req).catch(() => undefined);
        const existing = sessionId ? sessions.get(sessionId) : undefined;

        if (existing) {
          if (existing.role !== role) {
            jsonRpcError(res, 400, `Session belongs to the '${existing.role}' endpoint.`);
            return;
          }
          await existing.transport.handleRequest(req, res, body);
          return;
        }

        if (sessionId) {
          jsonRpcError(res, 404, "Unknown or expired session id. Re-initialize.");
          return;
        }

        if (!isInitializeRequest(body)) {
          jsonRpcError(res, 400, "No session id and not an initialize request.");
          return;
        }

        // New session for this role.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, role });
            log(`${role} session initialised: ${id}`);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
            log(`${role} session closed: ${transport.sessionId}`);
          }
        };
        const mcp = buildMcpServer(role, orch, pollCmds);
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        const existing = sessionId ? sessions.get(sessionId) : undefined;
        if (!existing || existing.role !== role) {
          jsonRpcError(res, 400, "Invalid or missing session id for this endpoint.");
          return;
        }
        await existing.transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405, { allow: "GET, POST, DELETE" });
      res.end();
    } catch (err) {
      log(`request error: ${(err as Error).stack ?? String(err)}`);
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error.");
      else res.end();
    }
  });

  // No socket-level timeout: tool calls may legitimately be held open for the
  // full poll window. Keep TCP alive for long-held connections.
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 0;
  httpServer.keepAliveTimeout = 0;
  httpServer.timeout = 0;

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      // Another coordinator already owns the port (e.g. the other agent started
      // it first). That one serves both agents; this one is redundant.
      log(`port ${cfg.port} already in use — assuming another coordinator is running. Exiting.`);
      process.exit(0);
    }
    log(`FATAL: HTTP server error: ${err.stack ?? String(err)}`);
    process.exit(1);
  });

  httpServer.listen(cfg.port, cfg.host, () => {
    log(`auto-review MCP server listening on http://${cfg.host}:${cfg.port}`);
    log(`  repo under review : ${orch.status().repo ?? "(awaiting initialize_review_session)"}`);
    log(`  developer endpoint: http://${cfg.host}:${cfg.port}/developer/mcp`);
    log(`  reviewer endpoint : http://${cfg.host}:${cfg.port}/reviewer/mcp`);
    log(`  both (no role)    : http://${cfg.host}:${cfg.port}/both/mcp`);
    log(`  poll window       : ${cfg.pollMs / 1000}s   max diff: ${cfg.maxDiffBytes} bytes`);
    log(`  set MCP_TOOL_TIMEOUT >= ${cfg.pollMs}ms in each agent instance`);
  });
}

main().catch((err) => {
  log(`FATAL: ${err?.stack ?? String(err)}`);
  process.exit(1);
});
