#!/usr/bin/env node
/**
 * Auto-review MCP orchestrator server.
 *
 * One long-running process serves the MCP over Streamable HTTP on two
 * role-scoped endpoints:
 *   - http://<host>:<port>/developer/mcp   → developer tools
 *   - http://<host>:<port>/reviewer/mcp    → reviewer tools
 *
 * The coordinator is multi-tenant: it hosts any number of independent review
 * loops at once, one per working copy, keyed by the canonical repo path
 * (realpath of `git rev-parse --show-toplevel`). Each session is bound to one
 * loop, either at connect time via a `?repo=<path>` query parameter on the
 * endpoint URL (the stdio proxy passes its cwd's repo automatically) or at
 * runtime via the initialize_review_session tool. When exactly one loop exists,
 * unbound callers fall back to it, so the original single-repo setup keeps
 * working with zero configuration. Role is fixed by the URL path, so no role
 * parameter is needed on the tool calls.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { Orchestrator } from "./orchestrator.js";
import { LoopRegistry } from "./registry.js";
import type { RequestReviewResult, RoleScope } from "./types.js";
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

/** Package version, surfaced on /healthz so clients can spot a stale coordinator. */
const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** Shell commands the agent can fall back to when its MCP client times out a blocking call. */
interface PollCommands {
  developer: string;
  reviewer: string;
}

// ---------------------------------------------------------------------------
// CLI / config
// ---------------------------------------------------------------------------

interface Config {
  repo?: string; // optional: pre-registers a loop at startup
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

/**
 * Guard the two request_review arguments at the server boundary. The schema
 * accepts them as optional so this handler runs even when one is absent — that
 * lets us return a clear, actionable message instead of the SDK's terse
 * "-32602 Input validation error: commit_message Required" envelope, which
 * developer agents routinely misread as a formatting/parsing/escaping fault and
 * then waste several retries mangling their summary instead of just supplying
 * the field. Returns an invalid_request result when something is missing, or
 * null when both are present and non-empty.
 */
function validateReviewArgs(
  commit_message: string | undefined,
  summary: string | undefined,
): RequestReviewResult | null {
  const missing: string[] = [];
  if (typeof commit_message !== "string" || commit_message.trim() === "") {
    missing.push("commit_message");
  }
  if (typeof summary !== "string" || summary.trim() === "") missing.push("summary");
  if (missing.length === 0) return null;

  const both = missing.length === 2;
  const fields = missing.join(" and ");
  return {
    status: "invalid_request",
    missing,
    message:
      `request_review requires BOTH 'commit_message' and 'summary', but ${fields} ` +
      `${both ? "were" : "was"} missing or empty. `,
  };
}

/**
 * The loop one MCP session operates on. Set at connect time when the endpoint
 * URL carried ?repo=, or lazily: by initialize_review_session, or by falling
 * back to the coordinator's single loop. Shared by reference between the
 * session record and the tool closures.
 */
interface LoopBinding {
  orch: Orchestrator | null;
}

/** Explains how an unbound caller can pick its loop; varies with what exists. */
function bindingHelp(registry: LoopRegistry): string {
  if (registry.size === 0) {
    return (
      "No review loop is registered yet. Call initialize_review_session with the absolute " +
      "path of the git repository you are working in (developers and reviewers both bind this " +
      "way — reviewers: the repo you are reviewing), then retry this call."
    );
  }
  return (
    `This coordinator is running ${registry.size} review loops in parallel ` +
    `(${registry.keys().join(", ")}) and this session is not bound to one of them. Call ` +
    "initialize_review_session with the absolute path of the git repository you are " +
    "working in — developers and reviewers alike, reviewers using the repo you are reviewing — " +
    "to bind this session, then retry this call."
  );
}

function buildMcpServer(
  role: RoleScope,
  registry: LoopRegistry,
  binding: LoopBinding,
  pollCmds: PollCommands,
  pollMs: number,
): McpServer {
  const server = new McpServer({ name: `auto-review-${role}`, version: VERSION });

  // In combined mode (no preset role) one endpoint exposes both toolsets, so each
  // description is prefixed with a note telling the agent to play one role only.
  const combined = role === "both";
  const devNote = combined ? combinedRoleNote("developer") : "";
  const revNote = combined ? combinedRoleNote("reviewer") : "";
  const sharedNote = combined ? combinedRoleNote("shared") : "";

  /**
   * Resolve the loop this session works on: the bound one, else the single
   * active loop (which then sticks, so later loops on other repos don't
   * re-route this session mid-task). Null when it cannot be determined.
   */
  const resolveLoop = (): Orchestrator | null => {
    if (!binding.orch) binding.orch = registry.single();
    return binding.orch;
  };

  // Shared: binds this session to the loop for a repo (creating it on first use).
  // Registered for BOTH roles — a reviewer needs it too when several loops run
  // and its session was not bound via ?repo= on the endpoint URL.
  server.registerTool(
    "initialize_review_session",
    {
      description: `${sharedNote}${INITIALIZE_SESSION_DESC}`,
      inputSchema: {
        repo_path: z
          .string()
          .min(1)
          .describe(
            "Absolute path to the root of the git repository you are working in (usually your cwd).",
          ),
      },
    },
    async ({ repo_path }) => {
      try {
        const orch = await registry.resolve(repo_path);
        binding.orch = orch;
        const head = await orch.git.head();
        log(`${role} session bound to loop ${orch.repo}`);
        return jsonResult({
          status: "ok",
          repo: orch.repo,
          head,
          message:
            `Review loop ready for ${orch.repo}; this session is bound to it. ` +
            "Developer: implement a batch, then call request_review. " +
            "Reviewer: call get_next_review to wait for the next batch.",
        });
      } catch (err) {
        return jsonResult({ status: "error", message: (err as Error).message });
      }
    },
  );

  if (combined || role === "developer") {
    server.registerTool(
      "request_review",
      {
        description: `${devNote}${REQUEST_REVIEW_DESC}\n\n${timeoutFallbackNote(pollCmds.developer, "the reviewer's verdict on the batch you just submitted")}`,
        inputSchema: {
          commit_message: z
            .string()
            .optional()
            .describe(
              "REQUIRED (always send together with 'summary'). The commit message for this batch (a subject line, optionally followed by a blank line and a body), used verbatim for the commit on approval.",
            ),
          summary: z
            .string()
            .optional()
            .describe(
              "REQUIRED (always send together with 'commit_message'). What you changed and why, detailed enough for a reviewer to judge it.",
            ),
        },
      },
      async ({ commit_message, summary }) => {
        const invalid = validateReviewArgs(commit_message, summary);
        if (invalid) return jsonResult(invalid);
        const orch = resolveLoop();
        if (!orch) {
          return jsonResult({ status: "not_initialized", message: bindingHelp(registry) });
        }
        return jsonResult(await orch.requestReview(commit_message!, summary!));
      },
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
      async ({ batch_id }) => {
        const orch = resolveLoop();
        if (!orch) {
          return jsonResult({ status: "not_initialized", message: bindingHelp(registry) });
        }
        return jsonResult(await orch.awaitVerdict(batch_id));
      },
    );

    server.registerTool(
      "signal_complete",
      {
        description: `${devNote}${SIGNAL_COMPLETE_DESC}`,
        inputSchema: { note: z.string().optional().describe("Optional closing note.") },
      },
      async ({ note }) => {
        const orch = resolveLoop();
        if (!orch) {
          return jsonResult({ status: "not_initialized", message: bindingHelp(registry) });
        }
        return jsonResult(await orch.signalComplete(note));
      },
    );
  }

  if (combined || role === "reviewer") {
    server.registerTool(
      "get_next_review",
      {
        description: `${revNote}${GET_NEXT_REVIEW_DESC}\n\n${timeoutFallbackNote(pollCmds.reviewer, "the next batch to review")}`,
        inputSchema: {},
      },
      async () => {
        let orch = resolveLoop();
        if (!orch && registry.size === 0) {
          // Reviewer started before any developer registered a loop: wait for
          // the first loop the way we'd wait for a batch, then bind to it.
          orch = await registry.waitForFirstLoop(pollMs);
          if (orch) binding.orch = orch;
        }
        if (!orch) {
          if (registry.size > 1) {
            return jsonResult({ status: "not_initialized", message: bindingHelp(registry) });
          }
          return jsonResult({
            status: "keep_waiting",
            message:
              "No developer has registered a review loop yet. Keep waiting: run the shell poll " +
              "command from the tool description (from inside the repo you are reviewing), or " +
              "call get_next_review again.",
          });
        }
        return jsonResult(await orch.getNextReview());
      },
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
      async ({ batch_id, verdict, issue, category }) => {
        const orch = resolveLoop();
        if (!orch) {
          return jsonResult({ status: "not_initialized", message: bindingHelp(registry) });
        }
        return jsonResult(await orch.submitReview(batch_id, verdict, issue, category));
      },
    );
  }

  // Shared read-only status tool, available in every mode. Bound sessions get
  // their loop's status; unbound sessions get the coordinator-wide overview.
  server.registerTool(
    "workflow_status",
    { description: `${sharedNote}${WORKFLOW_STATUS_DESC}`, inputSchema: {} },
    async () => {
      const orch = binding.orch ?? registry.single();
      return jsonResult(orch ? orch.status() : { loops: registry.all().map((o) => o.status()) });
    },
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
  // spaces survive copy-paste into a shell. The per-loop variant pins the loop
  // with --repo; the generic variant relies on the CLI detecting the repo from
  // the shell's working directory.
  const node = JSON.stringify(process.execPath);
  const cli = JSON.stringify(CLI_PATH);
  const pollCmdsFor = (repoKey: string | null): PollCommands => {
    const repoFlag = repoKey ? ` --repo ${JSON.stringify(repoKey)}` : "";
    return {
      developer: `${node} ${cli} await-verdict --port ${cfg.port}${repoFlag} --timeout 3600`,
      reviewer: `${node} ${cli} next-review --port ${cfg.port}${repoFlag} --timeout 3600`,
    };
  };

  const registry = new LoopRegistry((repoKey) => {
    log(`review loop created for ${repoKey}`);
    return {
      pollMs: cfg.pollMs,
      maxDiffBytes: cfg.maxDiffBytes,
      pollCommands: pollCmdsFor(repoKey),
      log: (msg) => log(`[${basename(repoKey)}] ${msg}`),
    };
  });

  // --repo is optional: if given, pre-register that loop; all other loops are
  // registered on demand (?repo= at connect, or initialize_review_session).
  if (cfg.repo) {
    try {
      await registry.resolve(cfg.repo);
    } catch (err) {
      log(
        `WARNING: --repo '${cfg.repo}' could not be used (${(err as Error).message}). ` +
          `Loops will be registered on demand instead.`,
      );
    }
  }

  const sessions = new Map<string, Session>();

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;

      if (pathname === "/healthz" || pathname === "/") {
        sendJson(res, 200, {
          ok: true,
          service: "auto-review",
          version: VERSION,
          loops: registry.all().map((o) => o.status()),
        });
        return;
      }

      // Plain-HTTP long-poll endpoints used by the `cli.js` poll command (no MCP
      // session). Each blocks up to the poll window, then returns JSON; the CLI
      // re-polls internally so the agent sees one long-blocking shell command.
      // ?repo=<path> picks (and creates, if needed) the loop; without it the
      // single active loop is used.
      if (
        req.method === "GET" &&
        (pathname === "/reviewer/next-review" || pathname === "/developer/await-verdict")
      ) {
        const repoParam = url.searchParams.get("repo");
        let orch: Orchestrator | null = null;
        if (repoParam) {
          try {
            orch = await registry.resolve(repoParam);
          } catch (err) {
            sendJson(res, 200, { status: "error", message: (err as Error).message });
            return;
          }
        } else {
          orch = registry.single();
        }

        if (pathname === "/reviewer/next-review") {
          if (!orch && registry.size === 0) orch = await registry.waitForFirstLoop(cfg.pollMs);
          if (!orch) {
            sendJson(
              res,
              200,
              registry.size > 1
                ? {
                    status: "error",
                    message:
                      `Several review loops are active (${registry.keys().join(", ")}); ` +
                      "re-run with --repo <absolute repo path> (or from inside the repo) to pick one.",
                  }
                : { status: "keep_waiting", message: "No review loop registered yet; poll again." },
            );
            return;
          }
          sendJson(res, 200, await orch.getNextReview());
          return;
        }

        // /developer/await-verdict
        if (!orch) {
          sendJson(res, 200, {
            status: registry.size > 1 ? "error" : "no_active_batch",
            message:
              registry.size > 1
                ? `Several review loops are active (${registry.keys().join(", ")}); ` +
                  "re-run with --repo <absolute repo path> (or from inside the repo) to pick one."
                : "No review loop registered yet. Submit a batch with the request_review tool first.",
          });
          return;
        }
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

        // New session for this role. ?repo=<path> on the endpoint URL binds it
        // to that repo's loop up front (the stdio proxy sends its cwd's repo).
        const binding: LoopBinding = { orch: null };
        const repoParam = url.searchParams.get("repo");
        if (repoParam) {
          try {
            binding.orch = await registry.resolve(repoParam);
          } catch (err) {
            jsonRpcError(res, 400, `Invalid ?repo= on ${pathname}: ${(err as Error).message}`);
            return;
          }
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, role });
            log(`${role} session initialised: ${id}${binding.orch ? ` → ${binding.orch.repo}` : ""}`);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
            log(`${role} session closed: ${transport.sessionId}`);
          }
        };
        const mcp = buildMcpServer(
          role,
          registry,
          binding,
          pollCmdsFor(binding.orch ? binding.orch.repo : null),
          cfg.pollMs,
        );
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
    log(`auto-review MCP server v${VERSION} listening on http://${cfg.host}:${cfg.port}`);
    log(`  loops             : ${registry.keys().join(", ") || "(none yet — registered on demand, one per repo)"}`);
    log(`  developer endpoint: http://${cfg.host}:${cfg.port}/developer/mcp`);
    log(`  reviewer endpoint : http://${cfg.host}:${cfg.port}/reviewer/mcp`);
    log(`  both (no role)    : http://${cfg.host}:${cfg.port}/both/mcp`);
    log(`  add ?repo=<absolute repo path> to bind a connection to its repo's loop`);
    log(`  poll window       : ${cfg.pollMs / 1000}s   max diff: ${cfg.maxDiffBytes} bytes`);
    log(`  set MCP_TOOL_TIMEOUT >= ${cfg.pollMs}ms in each agent instance`);
  });
}

main().catch((err) => {
  log(`FATAL: ${err?.stack ?? String(err)}`);
  process.exit(1);
});
