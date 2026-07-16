import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildEvidenceCodeContext } from "../mcp/lib/code-context.mjs";
import { captureRepositorySnapshot } from "../mcp/lib/repository-snapshot.mjs";
import { SessionStore } from "../mcp/lib/session-store.mjs";
import { TRANSLATION_CONSTRAINTS } from "../mcp/lib/translation-constraints.mjs";

async function makeDemoRepository() {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "demo2codex-demo-"));
  await mkdir(path.join(repoPath, "src", "components"), { recursive: true });
  await writeFile(
    path.join(repoPath, "package.json"),
    JSON.stringify({
      name: "demo-review-fixture",
      scripts: { dev: "vite", build: "vite build" },
      dependencies: { react: "^19.0.0" },
      devDependencies: { vite: "^6.0.0" },
    }),
  );
  await writeFile(path.join(repoPath, "package-lock.json"), "{}\n");
  await writeFile(path.join(repoPath, "index.html"), "<!doctype html><body><div id=\"root\"></div></body>\n");
  await writeFile(
    path.join(repoPath, "src", "components", "PricingCard.tsx"),
    [
      "export function PricingCard() {",
      "  return <section><button id=\"upgrade\">升级套餐</button></section>;",
      "}",
      "",
    ].join("\n"),
  );
  return repoPath;
}

test("repository snapshot includes a lightweight codebase profile", async (t) => {
  const repoPath = await makeDemoRepository();
  t.after(() => rm(repoPath, { recursive: true, force: true }));

  const snapshot = await captureRepositorySnapshot(repoPath);
  assert.equal(snapshot.repo_path, await realpath(repoPath));
  assert.equal(snapshot.repository.name, "demo-review-fixture");
  assert.equal(snapshot.repository.git, null);
  assert.deepEqual(Object.keys(snapshot.repository).sort(), ["context", "git", "name"]);
  assert.deepEqual(snapshot.repository.context.frameworks, ["React", "Vite"]);
  assert.equal(snapshot.repository.context.package_manager, "npm");
  assert.ok(snapshot.repository.context.source_roots.includes("src"));
  assert.ok(snapshot.repository.context.languages.some((language) => language.name === "TypeScript"));
});

test("code context maps page-focus evidence to approximate repository modules", async (t) => {
  const repoPath = await makeDemoRepository();
  t.after(() => rm(repoPath, { recursive: true, force: true }));
  const snapshot = await captureRepositorySnapshot(repoPath);
  const context = await buildEvidenceCodeContext({
    repoPath,
    repository: snapshot.repository,
    focusSegments: [{
      focus_id: "focus-pricing",
      page: { pathname: "/pricing", title: "Pricing" },
      focus: {
        label: "升级套餐",
        selector: "#upgrade",
        component: "PricingCard",
        componentStack: ["PricingCard", "PricingPage"],
      },
      transcript: ["主按钮需要更突出。"],
      transcript_event_ids: ["event-pricing"],
    }],
  });

  assert.equal(context.status, "ready");
  assert.equal(context.strategy, "deterministic-local-code-index");
  const mapping = context.focus_mappings[0];
  assert.equal(mapping.location_status, "candidate");
  assert.equal(mapping.module_candidates[0].module, "PricingCard");
  assert.deepEqual(mapping.module_candidates[0].paths, ["src/components/PricingCard.tsx"]);
  assert.equal(mapping.module_candidates[0].confidence, "high");
  assert.equal(mapping.module_candidates[0].location, undefined);
  assert.equal(mapping.module_candidates[0].excerpt, undefined);
  assert.ok(mapping.module_candidates[0].reasons.some((reason) => reason.kind === "component"));
});

test("session returns raw evidence and saves model-generated results", async (t) => {
  const repoPath = await makeDemoRepository();
  t.after(() => rm(repoPath, { recursive: true, force: true }));
  const snapshot = await captureRepositorySnapshot(repoPath);
  const registryPath = path.join(repoPath, ".demo2codex-test-registry.json");
  const store = new SessionStore({ registryPath });
  const session = await store.start({
    repoPath,
    title: "套餐页 Demo 对焦",
    language: "zh-CN",
    repository: snapshot.repository,
    serverUrl: "http://127.0.0.1:47831",
  });
  assert.match(session.directory, /[\\/]\.demo2codex[\\/]reviews[\\/]/);

  await store.addEvent(session.id, {
    type: "focus.start",
    focus_id: "focus-pricing",
    focus: {
      label: "升级套餐",
      selector: "#upgrade",
      route: "/pricing",
      component: "PricingCard",
      source: `${repoPath}/src/components/PricingCard.tsx`,
    },
  });
  await store.addEvent(session.id, {
    type: "transcript",
    text: "主按钮需要更突出，但不要改变卡片整体层级。",
    final: true,
  });
  await store.addEvent(session.id, { type: "focus.end", focus_id: "focus-pricing" });
  await store.addEvent(session.id, { type: "note", text: "其他页面暂时不调整。" });
  await store.saveAudio(session.id, Buffer.from("audio-a"), { sequence: 0, contentType: "audio/webm" });
  await store.saveAudio(session.id, Buffer.from("audio-b"), { sequence: 1, final: true, contentType: "audio/webm" });

  const finished = await store.finish(session.id);
  assert.equal(finished.status, "finished");
  assert.equal(finished.repo_path, repoPath);
  assert.equal(finished.transcript.length, 1);
  assert.equal(finished.notes.length, 1);
  assert.equal(finished.focus_segments.length, 1);
  assert.equal(finished.focus_segments[0].focus_id, "focus-pricing");
  assert.equal(finished.focus_segments[0].focus.source, `${repoPath}/src/components/PricingCard.tsx`);
  assert.equal(finished.code_context.focus_mappings[0].location_status, "exact");
  assert.deepEqual(
    finished.code_context.focus_mappings[0].module_candidates[0].paths,
    ["src/components/PricingCard.tsx"],
  );
  assert.equal(finished.code_context.focus_mappings[0].module_candidates[0].confidence, "high");
  assert.deepEqual(finished.grounding_contract.public_todo_fields, ["content"]);
  assert.ok(finished.grounding_contract.internal_grounding_fields.includes("module_candidates"));
  assert.deepEqual(finished.translation_constraints, TRANSLATION_CONSTRAINTS);
  assert.equal((await readFile(finished.audio_file)).toString(), "audio-aaudio-b");
  assert.ok(finished.evidence_files.evidence);
  assert.ok(finished.evidence_files.code_context);
  assert.equal(JSON.parse(await readFile(finished.evidence_files.evidence, "utf8")).repo_path, repoPath);
  assert.equal(
    JSON.parse(await readFile(finished.evidence_files.code_context, "utf8")).focus_mappings[0].module_candidates[0].module,
    "PricingCard",
  );

  await assert.rejects(
    store.saveArtifacts(session.id, {
      reviewSummary: "# 不完整结果\n",
      tasks: [{ content: "强化套餐页升级按钮。" }],
    }),
    /grounding must be an object/,
  );
  await assert.rejects(
    store.saveArtifacts(session.id, {
      reviewSummary: "只调整套餐页主按钮层级。",
      tasks: [{
        content: "修改 src/components/PricingCard.tsx 里的按钮。",
        grounding: {
          meeting_evidence: ["focus-pricing"],
          module_candidates: [],
          scope: "仅调整套餐页按钮。",
          acceptance_criteria: [],
          open_questions: [],
        },
      }],
    }),
    /must not expose code paths/,
  );

  const artifacts = await store.saveArtifacts(session.id, {
    reviewSummary: "# 评审总结\n\n只调整套餐页主按钮层级。\n",
    tasks: [{
      id: "todo-pricing",
      content: "把套餐页的升级按钮做得更突出，但不要改变卡片整体层级。",
      grounding: {
        meeting_evidence: ["focus-pricing", "主按钮需要更突出，但不要改变卡片整体层级。"],
        module_candidates: [{
          module: "PricingCard",
          paths: ["src/components/PricingCard.tsx"],
        }],
        scope: "仅调整套餐页升级按钮的视觉层级，不改变卡片整体结构。",
        acceptance_criteria: ["升级按钮比卡片内次要操作更突出。"],
        open_questions: [],
      },
    }],
  });
  assert.deepEqual(JSON.parse(await readFile(artifacts.files.tasks, "utf8")), [
    {
      id: "todo-pricing",
      content: "把套餐页的升级按钮做得更突出，但不要改变卡片整体层级。",
      module_hint: {
        label: "PricingCard",
        paths: ["src/components/PricingCard.tsx"],
      },
    },
  ]);
  assert.deepEqual(JSON.parse(await readFile(artifacts.files.grounding, "utf8")), [
    {
      id: "todo-pricing",
      meeting_evidence: ["focus-pricing", "主按钮需要更突出，但不要改变卡片整体层级。"],
      module_candidates: [{
        module: "PricingCard",
        paths: ["src/components/PricingCard.tsx"],
      }],
      scope: "仅调整套餐页升级按钮的视觉层级，不改变卡片整体结构。",
      acceptance_criteria: ["升级按钮比卡片内次要操作更突出。"],
      open_questions: [],
    },
  ]);
  assert.deepEqual(artifacts.result.tasks[0], {
    id: "todo-pricing",
    content: "把套餐页的升级按钮做得更突出，但不要改变卡片整体层级。",
    module_hint: {
      label: "PricingCard",
      paths: ["src/components/PricingCard.tsx"],
    },
  });
  assert.equal(artifacts.result.tasks[0].grounding, undefined);

  const groundingBeforeEdit = await readFile(artifacts.files.grounding, "utf8");
  const edited = await store.updateReviewResult(session.id, {
    reviewSummary: "只调整套餐页按钮。",
    tasks: [
      {
        id: "todo-pricing",
        content: "把套餐页升级按钮的视觉层级提高，其他卡片内容保持不变。",
      },
      {
        id: "todo-user-added",
        content: "确认移动端按钮状态是否一致。",
      },
    ],
  });
  assert.deepEqual(edited.tasks[0].module_hint, {
    label: "PricingCard",
    paths: ["src/components/PricingCard.tsx"],
  });
  assert.equal(edited.tasks[1].module_hint, null);
  assert.equal(await readFile(artifacts.files.grounding, "utf8"), groundingBeforeEdit);
  assert.match(await readFile(artifacts.files.review_summary, "utf8"), /只调整套餐页/);
  assert.ok(artifacts.files.code_context);
  assert.equal(
    JSON.parse(await readFile(path.join(repoPath, ".demo2codex", "latest.json"), "utf8")).session_id,
    session.id,
  );
});

test("concurrent finish callers wait for persisted evidence", async (t) => {
  const repoPath = await makeDemoRepository();
  t.after(() => rm(repoPath, { recursive: true, force: true }));
  const snapshot = await captureRepositorySnapshot(repoPath);
  const store = new SessionStore({
    registryPath: path.join(repoPath, ".demo2codex-test-registry.json"),
  });
  const session = await store.start({
    repoPath,
    title: "并发结束测试",
    language: "zh-CN",
    repository: snapshot.repository,
    serverUrl: "http://127.0.0.1:47831",
  });
  await store.addEvent(session.id, {
    type: "transcript",
    text: "只调整当前页面的主按钮。",
    final: true,
  });

  const finishPromise = store.finish(session.id);
  const requestedFinishPromise = store.requestFinish(session.id);
  const [finished, requestedFinish] = await Promise.all([
    finishPromise,
    requestedFinishPromise,
  ]);

  assert.equal(finished.evidence_files.evidence, requestedFinish.evidence_files.evidence);
  assert.equal(
    JSON.parse(await readFile(requestedFinish.evidence_files.evidence, "utf8")).session_id,
    session.id,
  );
});

test("session registry restores an active review after a server restart", async (t) => {
  const repoPath = await makeDemoRepository();
  t.after(() => rm(repoPath, { recursive: true, force: true }));
  const snapshot = await captureRepositorySnapshot(repoPath);
  const registryPath = path.join(repoPath, ".demo2codex-test-registry.json");
  const firstStore = new SessionStore({ registryPath });
  const session = await firstStore.start({
    repoPath,
    title: "恢复测试",
    language: "zh-CN",
    repository: snapshot.repository,
    serverUrl: "http://127.0.0.1:47831",
  });
  await firstStore.addEvent(session.id, { type: "transcript", text: "重启前的评审证据。" });

  const restoredStore = new SessionStore({ registryPath });
  await restoredStore.initialize();
  assert.equal(restoredStore.getActive().id, session.id);
  const resumed = await restoredStore.start({
    repoPath,
    title: "恢复测试",
    language: "zh-CN",
    repository: snapshot.repository,
    serverUrl: "http://127.0.0.1:50123",
  });
  assert.equal(resumed.id, session.id);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.server_url, "http://127.0.0.1:50123");
  const finished = await restoredStore.finish(session.id);
  assert.equal(finished.transcript[0].text, "重启前的评审证据。");
});

test("new registry imports active sessions from the legacy Meeting2Prompt registry", async (t) => {
  const repoPath = await makeDemoRepository();
  t.after(() => rm(repoPath, { recursive: true, force: true }));
  const snapshot = await captureRepositorySnapshot(repoPath);
  const legacyRegistryPath = path.join(repoPath, ".meeting2prompt-test-registry.json");
  const registryPath = path.join(repoPath, ".demo2codex-test-registry.json");
  const legacyStore = new SessionStore({ registryPath: legacyRegistryPath });
  const session = await legacyStore.start({
    repoPath,
    title: "旧会话迁移",
    language: "zh-CN",
    repository: snapshot.repository,
    serverUrl: "http://127.0.0.1:47831",
  });
  await legacyStore.addEvent(session.id, { type: "transcript", text: "保留旧评审证据。" });

  const migratedStore = new SessionStore({ registryPath, legacyRegistryPath });
  await migratedStore.initialize();
  assert.equal(migratedStore.getActive().id, session.id);
  const finished = await migratedStore.finish(session.id);
  assert.equal(finished.transcript[0].text, "保留旧评审证据。");
  const migratedRegistry = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(migratedRegistry.sessions[session.id].status, "finished");
});

test("focus attribution follows event time and does not absorb later transcript", async (t) => {
  const repoPath = await makeDemoRepository();
  t.after(() => rm(repoPath, { recursive: true, force: true }));
  const snapshot = await captureRepositorySnapshot(repoPath);
  const store = new SessionStore({
    registryPath: path.join(repoPath, ".demo2codex-test-registry.json"),
  });
  const session = await store.start({
    repoPath,
    title: "乱序对焦测试",
    language: "zh-CN",
    repository: snapshot.repository,
    serverUrl: "http://127.0.0.1:47831",
  });
  await store.addEvent(session.id, {
    type: "focus_start",
    focus_id: "focus-a",
    timestamp: "2026-07-16T02:00:10.000Z",
    focus: { id: "dom-a", label: "区域 A", selector: "#a" },
  });
  await store.addEvent(session.id, {
    type: "focus_start",
    focus_id: "focus-b",
    timestamp: "2026-07-16T02:00:20.000Z",
    focus: { id: "dom-b", label: "区域 B", selector: "#b" },
  });
  await store.addEvent(session.id, {
    type: "focus_end",
    focus_id: "focus-a",
    timestamp: "2026-07-16T02:00:15.000Z",
  });
  await store.addEvent(session.id, {
    type: "transcript",
    timestamp: "2026-07-16T02:00:12.000Z",
    text: "这句属于 A。",
  });
  await store.addEvent(session.id, {
    type: "transcript",
    timestamp: "2026-07-16T02:00:21.000Z",
    text: "这句属于 B。",
  });
  await store.addEvent(session.id, {
    type: "focus_end",
    focus_id: "focus-b",
    timestamp: "2026-07-16T02:00:22.000Z",
  });
  await store.addEvent(session.id, {
    type: "transcript",
    timestamp: "2026-07-16T02:00:23.000Z",
    text: "这句属于全局。",
  });

  const finished = await store.finish(session.id);
  assert.equal(finished.transcript[0].focus_id, "focus-a");
  assert.equal(finished.transcript[1].focus_id, "focus-b");
  assert.equal(finished.transcript[2].focus_id, undefined);
  assert.deepEqual(finished.focus_segments.map((segment) => segment.focus_id), ["focus-a", "focus-b"]);
});
