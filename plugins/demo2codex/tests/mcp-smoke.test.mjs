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
  await writeFile(
    path.join(repoPath, "src", "main.tsx"),
    "export function ReviewPage(){return <button id=\"primary\">主按钮</button>}\n",
  );
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

test("plugin starter fails closed when Demo2Codex actions are unavailable", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
  );
  const prompt = manifest.interface.defaultPrompt[0];
  assert.ok(prompt.length <= 128);
  assert.match(prompt, /start_review/);
  assert.match(prompt, /demo2codex:\/\/start-review/);
  assert.match(prompt, /unavailable, stop/i);
  assert.match(prompt, /do not audit, build, run, or edit/i);
});

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
  assert.equal(initialized.serverInfo.version, "0.4.1");
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
  assert.ok(started.repository.context.languages.some((language) => language.name === "TypeScript"));
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
  const recorderPage = await fetch(`${origin}/`).then((response) => response.text());
  assert.match(recorderPage, /<details class="card transcript-card">/);
  assert.doesNotMatch(recorderPage, /<details[^>]*\sopen(?:\s|>)/);
  assert.doesNotMatch(recorderPage, /手动补充|手动记录/);
  const recorderStyles = await fetch(`${origin}/styles.css`).then((response) => response.text());
  assert.match(recorderStyles, /--radius:\s*0\.625rem/);
  assert.match(recorderStyles, /--background:\s*oklch/);
  assert.doesNotMatch(recorderStyles, /linear-gradient|radial-gradient/);
  const recorderScript = await fetch(`${origin}/app.js`).then((response) => response.text());
  assert.match(recorderScript, /查看大概模块位置/);
  assert.match(recorderScript, /task\.module_hint/);

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
  assert.equal(finished.code_context.focus_mappings[0].location_status, "exact");
  assert.deepEqual(finished.code_context.focus_mappings[0].module_candidates[0].paths, ["src/main.tsx"]);
  assert.equal(finished.code_context.focus_mappings[0].module_candidates[0].location, undefined);
  assert.ok(finished.grounding_contract.internal_grounding_fields.includes("meeting_evidence"));
  assert.equal(finished.translation_constraints.length, 5);
  assert.equal((await readFile(finished.audio_file)).toString(), "smoke-audio");
  assert.equal(finished.result_submission.method, "POST");
  assert.match(finished.result_submission.url, new RegExp(`/api/sessions/${sessionId}/result\\?token=`));
  assert.match(finished.result_submission.instruction, /do not create a manual session/i);
  const storedEvidence = JSON.parse(await readFile(finished.evidence_files.evidence, "utf8"));
  assert.equal(storedEvidence.result_submission, undefined);

  const fallbackSaveResponse = await fetch(finished.result_submission.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      review_summary: "只提高当前页面主按钮的视觉层级。",
      tasks: [{
        id: "todo-fallback",
        content: "把当前页面的主按钮做得更突出。",
        grounding: {
          meeting_evidence: ["focus-smoke", "把主按钮的层级提高。"],
          module_candidates: [{ module: "ReviewPage", paths: ["src/main.tsx:18"] }],
          scope: "只调整当前页面主按钮的视觉层级。",
          acceptance_criteria: ["主按钮比相邻操作更突出。"],
          open_questions: [],
        },
      }],
    }),
  });
  assert.equal(fallbackSaveResponse.status, 200);
  const fallbackSaved = await fallbackSaveResponse.json();
  assert.deepEqual(fallbackSaved.result.tasks[0].module_hint, {
    label: "ReviewPage",
    paths: ["src/main.tsx"],
  });

  const savedCall = await rpc("tools/call", {
    name: "save_review_result",
    arguments: {
      session_id: sessionId,
      review_summary: "只提高当前页面主按钮的视觉层级。",
      tasks: [{
        id: "todo-primary",
        content: "把当前页面的主按钮做得更突出。",
        grounding: {
          meeting_evidence: ["focus-smoke", "把主按钮的层级提高。"],
          module_candidates: [{ module: "ReviewPage", paths: ["src/main.tsx"] }],
          scope: "只调整当前页面主按钮的视觉层级。",
          acceptance_criteria: ["主按钮比相邻操作更突出。"],
          open_questions: [],
        },
      }],
    },
  });
  assert.equal(savedCall.isError, false);
  assert.deepEqual(JSON.parse(await readFile(savedCall.structuredContent.files.tasks, "utf8")), [
    {
      id: "todo-primary",
      content: "把当前页面的主按钮做得更突出。",
      module_hint: {
        label: "ReviewPage",
        paths: ["src/main.tsx"],
      },
    },
  ]);

  const resultResponse = await fetch(`${origin}/api/sessions/${sessionId}/result?token=${encodeURIComponent(token)}`);
  assert.equal(resultResponse.status, 200);
  const publicResult = await resultResponse.json();
  assert.equal(publicResult.tasks[0].content, "把当前页面的主按钮做得更突出。");
  assert.equal(publicResult.tasks[0].grounding, undefined);
  assert.deepEqual(publicResult.tasks[0].module_hint, {
    label: "ReviewPage",
    paths: ["src/main.tsx"],
  });

  const editedResponse = await fetch(`${origin}/api/sessions/${sessionId}/result?token=${encodeURIComponent(token)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      review_summary: "只修改当前页面的主按钮。",
      tasks: [{
        id: "todo-primary",
        content: "提高当前页面主按钮的视觉层级。",
        module_hint: { label: "客户端不能覆盖", paths: ["wrong.ts"] },
      }],
    }),
  });
  assert.equal(editedResponse.status, 200);
  const editedResult = await editedResponse.json();
  assert.deepEqual(editedResult.tasks[0].module_hint, {
    label: "ReviewPage",
    paths: ["src/main.tsx"],
  });
});
