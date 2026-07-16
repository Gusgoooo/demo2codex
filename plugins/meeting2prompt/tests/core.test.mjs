import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureRepositorySnapshot } from "../mcp/lib/repository-snapshot.mjs";
import { SessionStore } from "../mcp/lib/session-store.mjs";
import { TRANSLATION_CONSTRAINTS } from "../mcp/lib/translation-constraints.mjs";

async function makeDemoRepository() {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "meeting2prompt-demo-"));
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
  await writeFile(path.join(repoPath, "index.html"), "<!doctype html><body><div id=\"root\"></div></body>\n");
  await writeFile(path.join(repoPath, "src", "components", "PricingCard.tsx"), "export function PricingCard(){return <section />}\n");
  return repoPath;
}

test("repository snapshot keeps only path, repository name, and Git facts", async (t) => {
  const repoPath = await makeDemoRepository();
  t.after(() => rm(repoPath, { recursive: true, force: true }));

  const snapshot = await captureRepositorySnapshot(repoPath);
  assert.equal(snapshot.repo_path, await realpath(repoPath));
  assert.equal(snapshot.repository.name, "demo-review-fixture");
  assert.equal(snapshot.repository.git, null);
  assert.deepEqual(Object.keys(snapshot.repository).sort(), ["git", "name"]);
});

test("session returns raw evidence and saves model-generated results", async (t) => {
  const repoPath = await makeDemoRepository();
  t.after(() => rm(repoPath, { recursive: true, force: true }));
  const snapshot = await captureRepositorySnapshot(repoPath);
  const registryPath = path.join(repoPath, ".meeting2prompt-test-registry.json");
  const store = new SessionStore({ registryPath });
  const session = await store.start({
    repoPath,
    title: "套餐页 Demo 对焦",
    language: "zh-CN",
    repository: snapshot.repository,
    serverUrl: "http://127.0.0.1:47831",
  });

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
  assert.deepEqual(finished.translation_constraints, TRANSLATION_CONSTRAINTS);
  assert.equal((await readFile(finished.audio_file)).toString(), "audio-aaudio-b");
  assert.ok(finished.evidence_files.evidence);
  assert.equal(JSON.parse(await readFile(finished.evidence_files.evidence, "utf8")).repo_path, repoPath);

  const artifacts = await store.saveArtifacts(session.id, {
    meetingSummary: "# 会议总结\n\n只调整套餐页主按钮层级。\n",
    tasks: [{ title: "强化升级按钮", open_questions: [] }],
  });
  assert.deepEqual(JSON.parse(await readFile(artifacts.files.tasks, "utf8")), [
    { title: "强化升级按钮", open_questions: [] },
  ]);
  assert.match(await readFile(artifacts.files.meeting_summary, "utf8"), /只调整套餐页/);
});

test("session registry restores an active review after a server restart", async (t) => {
  const repoPath = await makeDemoRepository();
  t.after(() => rm(repoPath, { recursive: true, force: true }));
  const snapshot = await captureRepositorySnapshot(repoPath);
  const registryPath = path.join(repoPath, ".meeting2prompt-test-registry.json");
  const firstStore = new SessionStore({ registryPath });
  const session = await firstStore.start({
    repoPath,
    title: "恢复测试",
    language: "zh-CN",
    repository: snapshot.repository,
    serverUrl: "http://127.0.0.1:47831",
  });
  await firstStore.addEvent(session.id, { type: "transcript", text: "重启前的会议证据。" });

  const restoredStore = new SessionStore({ registryPath });
  await restoredStore.initialize();
  assert.equal(restoredStore.getActive().id, session.id);
  const finished = await restoredStore.finish(session.id);
  assert.equal(finished.transcript[0].text, "重启前的会议证据。");
});

test("focus attribution follows event time and does not absorb later transcript", async (t) => {
  const repoPath = await makeDemoRepository();
  t.after(() => rm(repoPath, { recursive: true, force: true }));
  const snapshot = await captureRepositorySnapshot(repoPath);
  const store = new SessionStore({
    registryPath: path.join(repoPath, ".meeting2prompt-test-registry.json"),
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
