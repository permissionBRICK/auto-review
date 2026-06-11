/**
 * End-to-end test of the STDIO proxy path (the `command: "node"` config type).
 *
 * Spawns two `dist/stdio.js` proxies exactly as Claude Code would (one per
 * role), over stdio. The first proxy auto-starts the shared background
 * coordinator; both then share it. Drives the full review loop through the
 * proxies to prove tool mirroring + shared state work.
 *
 * Run with:  npm run build && npm run demo:stdio
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = 8791;
const STDIO_JS = fileURLToPath(new URL("../dist/stdio.js", import.meta.url));

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

async function connect(role: string, repo: string): Promise<Client> {
  const client = new Client({ name: `demo-${role}`, version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    // No --repo: the developer agent sets it at runtime via initialize_review_session.
    args: [STDIO_JS, "--role", role, "--port", String(PORT), "--poll-seconds", "3", "--wait-seconds", "6"],
    stderr: "inherit",
  });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  return JSON.parse(res?.content?.[0]?.text ?? "{}");
}

async function main(): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "auto-review-stdio-"));
  let dev: Client | undefined;
  let rev: Client | undefined;
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.name", "Demo"]);
    git(repo, ["config", "user.email", "demo@example.com"]);
    writeFileSync(join(repo, "README.md"), "# demo\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "initial"]);
    const headBefore = git(repo, ["rev-parse", "HEAD"]).trim();

    console.log("[1] developer proxy starts (auto-spawns the shared coordinator)");
    dev = await connect("developer", repo);
    const devTools = await dev.listTools();
    const devToolNames = devTools.tools.map((t) => t.name).sort();
    check("developer sees its tools (mirrored from coordinator)",
      JSON.stringify(devToolNames) === JSON.stringify(["await_review", "initialize_review_session", "request_review", "signal_complete", "workflow_status"]),
      devToolNames);

    console.log("[2] reviewer proxy starts (reuses the same coordinator)");
    rev = await connect("reviewer", repo);
    const revToolNames = (await rev.listTools()).tools.map((t) => t.name).sort();
    check("reviewer sees its tools (no initialize tool)",
      JSON.stringify(revToolNames) === JSON.stringify(["get_next_review", "submit_review", "workflow_status"]),
      revToolNames);

    console.log("[3] developer initializes the session, then the full loop runs");
    const init = await call(dev, "initialize_review_session", { repo_path: repo });
    check("initialize_review_session → ok", init.status === "ok", init);
    const noBatch = await call(dev, "await_review");
    check("await_review before any submission → no_active_batch", noBatch.status === "no_active_batch", noBatch);
    writeFileSync(join(repo, "feature.txt"), "v1\n");
    const devP1 = call(dev, "request_review", { summary: "add feature.txt", commit_message: "feat: feature" });
    const r1 = await call(rev, "get_next_review");
    check("reviewer gets review_ready with the diff", r1.status === "review_ready" && r1.diff.includes("feature.txt"), r1.status);
    await call(rev, "submit_review", { batch_id: r1.batch_id, verdict: "changes_requested", issue: "use v2", category: "code" });
    const dr1 = await devP1;
    check("developer gets changes_requested through the proxy", dr1.status === "changes_requested", dr1);

    writeFileSync(join(repo, "feature.txt"), "v2\n");
    const devP2 = call(dev, "request_review", { summary: "fix", commit_message: "feat: feature v2" });
    const r2 = await call(rev, "get_next_review");
    await call(rev, "submit_review", { batch_id: r2.batch_id, verdict: "approved" });
    const dr2 = await devP2;
    check("developer gets approved + commit_sha", dr2.status === "approved" && !!dr2.commit_sha, dr2);
    check("commit landed in the shared repo", git(repo, ["rev-parse", "HEAD"]).trim() === dr2.commit_sha && dr2.commit_sha !== headBefore);
    const again = await call(dev, "await_review", { batch_id: r2.batch_id });
    check("await_review(batch_id) re-reads the verdict", again.status === "approved" && again.commit_sha === dr2.commit_sha, again);

    await call(dev, "signal_complete", {});
    const last = await call(rev, "get_next_review");
    check("reviewer gets workflow_complete", last.status === "workflow_complete", last);
  } finally {
    if (dev) await dev.close().catch(() => {});
    if (rev) await rev.close().catch(() => {});
    // Kill the detached coordinator that the proxy started on the test port.
    try {
      execFileSync("pkill", ["-f", `dist/server.js.*--port ${PORT}`]);
    } catch {
      /* nothing to kill */
    }
    rmSync(repo, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? "ALL STDIO CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("stdio demo crashed:", err);
  process.exit(1);
});
