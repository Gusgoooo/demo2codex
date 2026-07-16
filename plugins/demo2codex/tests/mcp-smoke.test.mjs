import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function makeFixture() {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "demo2codex-mcp-"));
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "mcp-fixture", scripts: { dev: "vite" } }));
  await writeFile(path.join(repoPath, "index.html"), "<!doctype html><html><body><main id=\"app\"></main></body></html>\n");
  await writeFile(path.join(repoPath, "src", "main.tsx"), "export {};\n");
  return repoPath;
}

function rpcClient(child) {
  let nextId = 1;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  return (method, params = {}) => {
    const id = nextId++;
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  };
}

test("MCP exposes four thin tools and completes a local review", { timeout: 20_000 }, async (t) => {
  const repoPath = await makeFixture();
  const child = spawn(process.execPath, [path.join(pluginRoot, "mcp", "server.mjs")], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      DEMO2CODEX_PORT: "0",
      DEMO2CODEX_REGISTRY: path.join(repoPath, ".demo2codex-test-registry.json"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await rm(repoPath, { recursive: true, force: true });
  });
  const rpc = rpcClient(child);

  const initialized = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
  assert.equal(initialized.serverInfo.name, "demo2codex");
  assert.equal(initialized.capabilities.resources.listChanged, false);
  assert.match(initialized.instructions, /read demo2codex:\/\/start-review/i);
  const listed = await rpc("tools/list");
  assert.deepEqual(listed.tools.map((tool) => tool.name), [
    "start_review",
    "review_status",
    "finish_review",
    "save_review_result",
  ]);
  assert.equal(listed.tools[1].annotations.readOnlyHint, true);

  const listedResources = await rpc("resources/list");
  assert.deepEqual(listedResources.resources.map((resource) => resource.uri), [
    "demo2codex://start-review",
    "demo2codex://review-status",
    "demo2codex://finish-review",
  ]);
  const listedTemplates = await rpc("resources/templates/list");
  assert.equal(listedTemplates.resourceTemplates.length, 3);

  const startUri = new URL("demo2codex://start-review");
  startUri.searchParams.set("repo_path", repoPath);
  startUri.searchParams.set("title", "MCP resource smoke review");
  startUri.searchParams.set("demo_url", "http://localhost:5173");
  const startedResource = await rpc("resources/read", {
    uri: startUri.toString(),
  });
  const started = JSON.parse(startedResource.contents[0].text);
  assert.equal(started.repository.name, "mcp-fixture");
  assert.equal(started.bridge.installed, true);
  assert.equal(started.translation_constraints.length, 5);
  const indexHtml = await readFile(path.join(repoPath, "index.html"), "utf8");
  assert.match(indexHtml, /type="module"/);
  assert.equal((indexHtml.match(/\/embed\.js/g) || []).length, 1);

  const recorderUrl = new URL(started.recorder_url);
  const bridgeUrl = new URL(started.bridge_url);
  const token = recorderUrl.searchParams.get("token");
  const bridgeKey = bridgeUrl.searchParams.get("bridge");
  const sessionId = started.session_id;
  assert.ok(token);
  assert.ok(bridgeKey);

  const origin = recorderUrl.origin;
  const missingBridgeKeyResponse = await fetch(`${origin}/api/active-session`, {
    headers: { Origin: "http://localhost:5173" },
  });
  assert.equal(missingBridgeKeyResponse.status, 401);
  const rejectedOriginResponse = await fetch(`${origin}/api/active-session`, {
    headers: { Origin: "http://localhost:9999" },
  });
  assert.equal(rejectedOriginResponse.status, 403);
  const activeResponse = await fetch(`${origin}/api/active-session?bridge=${encodeURIComponent(bridgeKey)}`, {
    headers: { Origin: "http://localhost:5173" },
  });
  assert.equal(activeResponse.status, 200);
  const activeSession = await activeResponse.json();
  assert.equal(activeSession.sessionId, sessionId);
  assert.equal(activeSession.token, undefined);
  assert.match(activeSession.recorderLaunchUrl, /\/launch-recorder\?bridge=/);

  const bridgeTranscriptResponse = await fetch(`${origin}/api/sessions/${sessionId}/events?bridge=${encodeURIComponent(bridgeKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: JSON.stringify({ type: "transcript", payload: { text: "bridge 不应能写逐字稿" } }),
  });
  assert.equal(bridgeTranscriptResponse.status, 403);

  const focusStartResponse = await fetch(`${origin}/api/sessions/${sessionId}/events?bridge=${encodeURIComponent(bridgeKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: JSON.stringify({
      type: "focus.start",
      payload: {
        focus_id: "focus-smoke",
        focus: { id: "primary", label: "主按钮", selector: "#primary", source: "src/main.tsx" },
        page: { pathname: "/review", title: "Review demo", href: "http://localhost:5173/review" },
      },
    }),
  });
  assert.equal(focusStartResponse.status, 202);
  const eventResponse = await fetch(`${origin}/api/sessions/${sessionId}/events?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: JSON.stringify({ type: "transcript", payload: { text: "把主按钮的层级提高。", final: true } }),
  });
  assert.equal(eventResponse.status, 202);
  const focusEndResponse = await fetch(`${origin}/api/sessions/${sessionId}/events?bridge=${encodeURIComponent(bridgeKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: JSON.stringify({ type: "focus.end", payload: { focus_id: "focus-smoke" } }),
  });
  assert.equal(focusEndResponse.status, 202);
  const audioResponse = await fetch(`${origin}/api/sessions/${sessionId}/audio?token=${encodeURIComponent(token)}&seq=0&final=1`, {
    method: "POST",
    headers: { "Content-Type": "audio/webm", Origin: "http://localhost:5173" },
    body: Buffer.from("smoke-audio"),
  });
  assert.equal(audioResponse.status, 202);
  const recordingStateResponse = await fetch(`${origin}/api/sessions/${sessionId}/events?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: JSON.stringify({ type: "recorder_state", payload: { state: "recording" } }),
  });
  assert.equal(recordingStateResponse.status, 202);

  const finishUri = new URL("demo2codex://finish-review");
  finishUri.searchParams.set("session_id", sessionId);
  const finishedResourcePromise = rpc("resources/read", {
    uri: finishUri.toString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const statusUri = new URL("demo2codex://review-status");
  statusUri.searchParams.set("session_id", sessionId);
  const finishingStatusResource = await rpc("resources/read", {
    uri: statusUri.toString(),
  });
  const finishingStatus = JSON.parse(finishingStatusResource.contents[0].text);
  assert.ok(finishingStatus.finish_requested_at);
  const stoppedStateResponse = await fetch(`${origin}/api/sessions/${sessionId}/events?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: JSON.stringify({ type: "recorder_state", payload: { state: "stopped" } }),
  });
  assert.equal(stoppedStateResponse.status, 202);
  const recorderFinishResponse = await fetch(`${origin}/api/sessions/${sessionId}/finish?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: "{}",
  });
  assert.equal(recorderFinishResponse.status, 200);

  const finishedResource = await finishedResourcePromise;
  const finished = JSON.parse(finishedResource.contents[0].text);
  assert.equal(finished.transcript[0].text, "把主按钮的层级提高。");
  assert.equal(finished.focus_segments[0].focus_id, "focus-smoke");
  assert.equal(finished.focus_segments[0].focus.source, "src/main.tsx");
  assert.equal(finished.translation_constraints.length, 5);
  assert.equal((await readFile(finished.audio_file)).toString(), "smoke-audio");

  const savedCall = await rpc("tools/call", {
    name: "save_review_result",
    arguments: {
      session_id: sessionId,
      review_summary: "# Review summary\n\nRaise the primary button hierarchy only.\n",
      tasks: [{ title: "Raise the primary button hierarchy", evidence: ["把主按钮的层级提高。"] }],
    },
  });
  assert.equal(savedCall.isError, false);
  assert.deepEqual(JSON.parse(await readFile(savedCall.structuredContent.files.tasks, "utf8")), [
    { title: "Raise the primary button hierarchy", evidence: ["把主按钮的层级提高。"] },
  ]);
});
