/**
 * End-to-end test of the auto-review loop.
 *
 * Spins up the built server against a throwaway git repo, connects a developer
 * client and a reviewer client, and drives a full cycle:
 *   keep_waiting → submit → review_ready → changes_requested → fix →
 *   review_ready → approved (+ commit) → signal_complete → workflow_complete.
 *
 * Run with:  npm run build && npm run demo
 * Exits 0 on success, 1 on any failed assertion.
 */
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const CALL_TIMEOUT = 60_000;

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

async function connect(path: string, name: string): Promise<Client> {
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}${path}`)));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res: any = await client.callTool({ name, arguments: args }, undefined, {
    timeout: CALL_TIMEOUT,
  });
  const text = res?.content?.[0]?.text ?? "{}";
  return JSON.parse(text);
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("server did not become healthy in time");
}

async function main(): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "auto-review-demo-"));
  let server: ChildProcess | undefined;
  try {
    // 1. Throwaway git repo with an initial commit.
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.name", "Demo"]);
    git(repo, ["config", "user.email", "demo@example.com"]);
    writeFileSync(join(repo, "README.md"), "# demo\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "initial"]);
    const headBefore = git(repo, ["rev-parse", "HEAD"]).trim();

    // 2. Start the built server WITHOUT --repo (the developer sets it at runtime).
    server = spawn(
      process.execPath,
      ["dist/server.js", "--port", String(PORT), "--host", "127.0.0.1", "--poll-seconds", "2"],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    await waitForHealth();

    const dev = await connect("/developer/mcp", "demo-developer");
    const rev = await connect("/reviewer/mcp", "demo-reviewer");

    console.log("\n[0] developer initializes the session");
    const preInit = await call(dev, "request_review", { summary: "x", commit_message: "x" });
    check("request_review before init → not_initialized", preInit.status === "not_initialized", preInit);
    const init = await call(dev, "initialize_review_session", { repo_path: repo });
    check(
      "initialize_review_session → ok (repo canonicalized)",
      init.status === "ok" && init.repo === realpathSync(repo),
      init,
    );

    console.log("\n[1] reviewer polls with nothing pending → keep_waiting");
    const kw = await call(rev, "get_next_review");
    check("returns keep_waiting", kw.status === "keep_waiting", kw);

    console.log("\n[2] developer implements a batch and requests review (blocking)");
    writeFileSync(join(repo, "feature.txt"), "first attempt\n");
    const devP1 = call(dev, "request_review", {
      summary: "Add feature.txt with the initial implementation.",
      commit_message: "feat: add feature.txt",
    });

    console.log("[3] reviewer receives the batch");
    const r1 = await call(rev, "get_next_review");
    check("status review_ready", r1.status === "review_ready", r1);
    check("diff includes the new file", typeof r1.diff === "string" && r1.diff.includes("feature.txt"), r1.diff_stat);
    check("carries the developer summary", String(r1.summary).includes("initial implementation"));

    console.log("[4] reviewer requests changes");
    const sub1 = await call(rev, "submit_review", {
      batch_id: r1.batch_id,
      verdict: "changes_requested",
      issue: "The file should say 'final', not 'first attempt'.",
      category: "code",
    });
    check("verdict recorded", sub1.status === "recorded" && sub1.verdict === "changes_requested", sub1);

    console.log("[5] developer's blocked call returns changes_requested");
    const dr1 = await devP1;
    check("developer got changes_requested", dr1.status === "changes_requested", dr1);
    check("issue text propagated", String(dr1.issue).includes("final"), dr1);
    check("no commit happened yet", git(repo, ["rev-parse", "HEAD"]).trim() === headBefore);

    console.log("\n[6] developer fixes and resubmits (new diff → new batch)");
    writeFileSync(join(repo, "feature.txt"), "final\n");
    const devP2 = call(dev, "request_review", {
      summary: "Address review: use 'final'.",
      commit_message: "feat: add feature.txt (final)",
    });
    const r2 = await call(rev, "get_next_review");
    check("status review_ready again", r2.status === "review_ready", r2);
    check("new batch id", r2.batch_id !== r1.batch_id, { first: r1.batch_id, second: r2.batch_id });
    check("diff reflects the fix", typeof r2.diff === "string" && r2.diff.includes("final"));

    console.log("[7] reviewer approves → server commits");
    const sub2 = await call(rev, "submit_review", { batch_id: r2.batch_id, verdict: "approved" });
    check("approval recorded with sha", sub2.status === "recorded" && sub2.verdict === "approved" && !!sub2.commit_sha, sub2);

    const dr2 = await devP2;
    check("developer got approved", dr2.status === "approved", dr2);
    check("developer got commit_sha", !!dr2.commit_sha && dr2.commit_sha === sub2.commit_sha, dr2);

    console.log("[8] verify the commit landed in the repo");
    const headAfter = git(repo, ["rev-parse", "HEAD"]).trim();
    check("HEAD advanced", headAfter !== headBefore && headAfter === dr2.commit_sha);
    const lastMsg = git(repo, ["log", "-1", "--pretty=%B"]);
    check("commit uses developer's message", lastMsg.includes("feat: add feature.txt (final)"), lastMsg);
    check("commit has Reviewed-by trailer", lastMsg.includes("Reviewed-by: auto-review"), lastMsg);
    const tracked = git(repo, ["ls-files"]);
    check("feature.txt is committed", tracked.includes("feature.txt"));

    console.log("\n[9] developer signals completion → reviewer told to stop");
    const done = await call(dev, "signal_complete", { note: "all done" });
    check("signal_complete ok", done.status === "ok", done);
    const last = await call(rev, "get_next_review");
    check("reviewer gets workflow_complete", last.status === "workflow_complete", last);

    await dev.close();
    await rev.close();
  } finally {
    if (server) server.kill("SIGTERM");
    rmSync(repo, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("demo crashed:", err);
  process.exit(1);
});
