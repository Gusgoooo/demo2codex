import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TRANSLATION_CONSTRAINTS } from "./translation-constraints.mjs";
import {
  atomicWriteFile,
  ensureDirectory,
  escapeMarkdown,
  isoTimestamp,
  jsonClone,
  makeId,
  sanitizeFileExtension,
} from "./utils.mjs";

export class SessionStore {
  constructor(options = {}) {
    this.sessions = new Map();
    this.activeSessionId = null;
    this.registryPath = path.resolve(
      options.registryPath ||
      process.env.MEETING2PROMPT_REGISTRY ||
      path.join(os.homedir(), ".meeting2prompt", "registry.json"),
    );
    this.initialization = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      let registry = null;
      try {
        registry = JSON.parse(await readFile(this.registryPath, "utf8"));
      } catch {
        registry = null;
      }
      for (const entry of Object.values(registry?.sessions || {})) {
        if (!entry?.session_file) continue;
        try {
          const session = JSON.parse(await readFile(entry.session_file, "utf8"));
          if (!session?.id || !session?.directory || !session?.token) continue;
          session.bridge_key ||= randomBytes(32).toString("base64url");
          session.finish_requested_at ??= null;
          session.audio_finalized ??= false;
          this.sessions.set(session.id, session);
        } catch {
          // A repository may have moved or been deleted; keep other sessions recoverable.
        }
      }
      const activeSessions = [...this.sessions.values()]
        .filter((session) => session.status === "recording")
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      this.activeSessionId = activeSessions[0]?.id || null;
      this.initialized = true;
    })();
    return this.initialization;
  }

  async start({ repoPath, title, language, demoUrl, repository, serverUrl }) {
    await this.initialize();
    const active = this.getActive();
    if (active) throw new Error(`Review ${active.id} is already recording. Finish it before starting another.`);

    const id = makeId("review", randomBytes(4));
    const token = randomBytes(32).toString("base64url");
    const directory = path.join(repoPath, ".meeting2prompt", "reviews", id);
    const now = isoTimestamp();
    const session = {
      schema_version: 2,
      id,
      token,
      bridge_key: randomBytes(32).toString("base64url"),
      status: "recording",
      recording_state: "idle",
      finish_requested_at: null,
      title: title?.trim() || `Demo review ${now.slice(0, 10)}`,
      language: language || "zh-CN",
      repo_path: repoPath,
      repository: repository || { name: path.basename(repoPath), git: null },
      demo_url: demoUrl || null,
      server_url: serverUrl,
      directory,
      started_at: now,
      ended_at: null,
      updated_at: now,
      event_count: 0,
      audio_chunks: 0,
      audio_bytes: 0,
      audio_finalized: false,
      current_focus: null,
      evidence_files: null,
      artifacts: null,
    };

    await ensureDirectory(path.join(directory, "audio"));
    this.sessions.set(id, session);
    this.activeSessionId = id;
    try {
      await this.persist(session);
    } catch (error) {
      this.sessions.delete(id);
      this.activeSessionId = null;
      throw error;
    }
    return jsonClone(session);
  }

  getActive() {
    const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : null;
    return session?.status === "recording" ? session : null;
  }

  get(id) {
    const session = id ? this.sessions.get(id) : this.getActive();
    if (!session) throw new Error(id ? `Unknown review session: ${id}` : "No active review session.");
    return session;
  }

  publicSession(session, { includeToken = false } = {}) {
    const result = jsonClone(session);
    if (!includeToken) {
      delete result.token;
      delete result.bridge_key;
    }
    return result;
  }

  verifyToken(session, candidate) {
    return verifySecret(session.token, candidate);
  }

  verifyBridgeKey(session, candidate) {
    return verifySecret(session.bridge_key, candidate);
  }

  async requestFinish(id, { waitMs = 15_000 } = {}) {
    const session = this.get(id);
    if (session.status === "finished") return this.buildResult(session, await this.events(session));
    if (session.recording_state === "idle" || (session.recording_state === "stopped" && session.audio_finalized)) {
      return this.finish(session.id);
    }

    session.finish_requested_at ||= isoTimestamp();
    session.updated_at = isoTimestamp();
    await this.persist(session);
    const deadline = Date.now() + waitMs;
    while (session.status !== "finished" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (session.status === "finished") return this.buildResult(session, await this.events(session));
    return {
      session_id: session.id,
      status: "finish_pending",
      recording_state: session.recording_state,
      finish_requested_at: session.finish_requested_at,
      translation_constraints: TRANSLATION_CONSTRAINTS,
      message: "The recorder is stopping and uploading its final audio. Keep the recorder page open, then call finish_review again.",
    };
  }

  async addEvent(id, input) {
    const session = this.get(id);
    if (session.status !== "recording") throw new Error(`Review ${session.id} is not recording.`);
    const type = String(input.type || "note").trim().toLowerCase().replace(/[.-]+/g, "_");
    const now = isoTimestamp(input.timestamp || Date.now());
    const event = {
      id: makeId("event", randomBytes(3)),
      type,
      timestamp: now,
      text: input.text === undefined ? undefined : String(input.text),
      speaker: input.speaker === undefined ? undefined : String(input.speaker),
      final: input.final === undefined ? undefined : Boolean(input.final),
      focus_id: input.focus_id === undefined ? undefined : String(input.focus_id),
      focus_assignment: input.focus_id === undefined ? undefined : "explicit",
      focus: input.focus && typeof input.focus === "object" ? input.focus : undefined,
      metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : undefined,
    };

    if (["focus_start", "dom_focus_start"].includes(type)) {
      event.type = "focus_start";
      event.focus_id = input.focus_id || makeId("focus", randomBytes(3));
      const page = event.metadata?.page;
      if (event.focus && page?.pathname && !event.focus.route) {
        event.focus = { ...event.focus, route: page.pathname };
      }
      const currentStartedAt = Date.parse(session.current_focus?.started_at || "");
      if (!session.current_focus || !Number.isFinite(currentStartedAt) || Date.parse(now) >= currentStartedAt) {
        session.current_focus = {
          ...(event.focus || {}),
          focus_id: event.focus_id,
          started_at: now,
          ...(page ? { page } : {}),
        };
      }
    } else if (["focus_end", "dom_focus_end"].includes(type)) {
      event.type = "focus_end";
      event.focus_id = input.focus_id || session.current_focus?.focus_id;
      const endsCurrentFocus = Boolean(
        session.current_focus &&
        (!event.focus_id || event.focus_id === session.current_focus.focus_id),
      );
      if (!event.focus && endsCurrentFocus) event.focus = session.current_focus;
      if (endsCurrentFocus) session.current_focus = null;
    } else if (!event.focus_id && session.current_focus) {
      event.focus_id = session.current_focus.focus_id;
      event.focus_assignment = "arrival";
    }

    if (event.type === "recorder_state") {
      session.recording_state = String(input.state || input.metadata?.state || input.text || "unknown");
    }

    Object.keys(event).forEach((key) => event[key] === undefined && delete event[key]);
    await appendFile(path.join(session.directory, "events.ndjson"), `${JSON.stringify(event)}\n`, "utf8");
    session.event_count += 1;
    session.updated_at = now;
    await this.persist(session);
    return jsonClone(event);
  }

  async saveAudio(id, bytes, { sequence, final, contentType }) {
    const session = this.get(id);
    if (session.status !== "recording") throw new Error(`Review ${session.id} is not recording.`);
    const seq = Number.isInteger(sequence) && sequence >= 0 ? sequence : session.audio_chunks;
    const extension = sanitizeFileExtension(contentType);
    const fileName = `chunk-${String(seq).padStart(6, "0")}${extension}`;
    const filePath = path.join(session.directory, "audio", fileName);
    await atomicWriteFile(filePath, bytes, { mode: 0o600 });
    session.audio_chunks = Math.max(session.audio_chunks, seq + 1);
    session.audio_bytes += bytes.length;
    if (final) session.audio_finalized = true;
    session.updated_at = isoTimestamp();
    await this.persist(session);
    return { sequence: seq, bytes: bytes.length, final: Boolean(final), file: filePath };
  }

  async events(session) {
    try {
      const contents = await readFile(path.join(session.directory, "events.ndjson"), "utf8");
      return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async finish(id, { requireFinalAudio = false } = {}) {
    const session = this.get(id);
    if (session.status === "finished") return this.buildResult(session, await this.events(session));
    if (
      requireFinalAudio &&
      session.recording_state !== "idle" &&
      (session.recording_state !== "stopped" || !session.audio_finalized)
    ) {
      throw new Error("The recorder has not stopped and uploaded its final audio chunk yet.");
    }
    if (session.current_focus) {
      await this.addEvent(session.id, {
        type: "focus_end",
        focus_id: session.current_focus.focus_id,
        focus: session.current_focus,
      });
    }

    session.status = "finished";
    session.recording_state = "finished";
    session.ended_at = isoTimestamp();
    session.updated_at = session.ended_at;
    if (this.activeSessionId === session.id) this.activeSessionId = null;
    session.audio_file = await this.combineAudio(session);

    const events = await this.events(session);
    const result = this.buildResult(session, events);
    const evidenceDirectory = path.join(session.directory, "evidence");
    await ensureDirectory(evidenceDirectory);
    const files = {
      evidence: path.join(evidenceDirectory, "evidence.json"),
      transcript: path.join(evidenceDirectory, "transcript.md"),
    };
    await Promise.all([
      atomicWriteFile(files.evidence, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8" }),
      atomicWriteFile(files.transcript, result.transcript_markdown, { encoding: "utf8" }),
    ]);
    session.evidence_files = files;
    result.evidence_files = jsonClone(files);
    await this.persist(session);
    return result;
  }

  buildResult(session, events) {
    const intervals = buildFocusIntervals(events);
    const transcriptEvents = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === "transcript" && event.text?.trim())
      .map(({ event, index }) => {
        if (event.focus_assignment === "explicit") return event;
        const resolvedFocusId = focusAtTimestamp(event.timestamp, index, intervals);
        if (resolvedFocusId) return { ...event, focus_id: resolvedFocusId, focus_assignment: "timestamp" };
        if (!intervals.length && event.focus_id) return event;
        const resolved = { ...event };
        delete resolved.focus_id;
        delete resolved.focus_assignment;
        return resolved;
      });
    const transcriptByFocus = new Map();
    for (const event of transcriptEvents) {
      if (!event.focus_id) continue;
      if (!transcriptByFocus.has(event.focus_id)) transcriptByFocus.set(event.focus_id, []);
      transcriptByFocus.get(event.focus_id).push(event);
    }
    const focusStarts = new Map(events.filter((event) => event.type === "focus_start").map((event) => [event.focus_id, event]));
    const focusSegments = intervals.map((interval) => {
      const start = focusStarts.get(interval.focus_id);
      const items = transcriptByFocus.get(interval.focus_id) || [];
      return {
        focus_id: interval.focus_id,
        focus: start?.focus || null,
        page: start?.metadata?.page || null,
        started_at: start?.timestamp || null,
        ended_at: Number.isFinite(interval.end) ? new Date(interval.end).toISOString() : null,
        transcript: items.map((event) => event.text),
        transcript_event_ids: items.map((event) => event.id),
      };
    });
    const notes = events.filter((event) => event.type === "note" && event.text?.trim());
    const evidenceEvents = events.filter((event) => (
      event.type === "transcript" ||
      event.type === "note" ||
      event.type === "focus_start" ||
      event.type === "focus_end"
    ));
    const transcriptMarkdown = transcriptEvents.length
      ? transcriptEvents.map((event) => `- ${event.timestamp} ${event.speaker ? `**${escapeMarkdown(event.speaker)}**: ` : ""}${event.text}${event.focus_id ? `  <!-- focus:${event.focus_id} -->` : ""}`).join("\n") + "\n"
      : "_No transcript was captured._\n";

    return {
      session_id: session.id,
      status: session.status,
      title: session.title,
      repo_path: session.repo_path,
      repository: session.repository || null,
      started_at: session.started_at,
      ended_at: session.ended_at,
      event_count: events.length,
      transcript: transcriptEvents,
      transcript_markdown: transcriptMarkdown,
      notes,
      focus_segments: focusSegments,
      evidence_events: evidenceEvents,
      translation_constraints: TRANSLATION_CONSTRAINTS,
      audio_file: session.audio_file || null,
      evidence_files: session.evidence_files || null,
    };
  }

  async combineAudio(session) {
    const audioDirectory = path.join(session.directory, "audio");
    const chunkNames = (await readdir(audioDirectory).catch(() => []))
      .filter((name) => /^chunk-\d+\.[a-z0-9]+$/i.test(name))
      .sort();
    if (!chunkNames.length) return null;
    const extension = path.extname(chunkNames[0]) || ".bin";
    const outputPath = path.join(audioDirectory, `recording${extension}`);
    const chunks = await Promise.all(chunkNames.map((name) => readFile(path.join(audioDirectory, name))));
    await atomicWriteFile(outputPath, Buffer.concat(chunks), { mode: 0o600 });
    return outputPath;
  }

  async saveArtifacts(id, { meetingSummary, tasks }) {
    const session = this.get(id);
    if (session.status !== "finished") {
      throw new Error(`Review ${session.id} must finish before model-generated results can be saved.`);
    }
    if (typeof meetingSummary !== "string" || !meetingSummary.trim()) {
      throw new Error("meeting_summary must be a non-empty string.");
    }
    if (!Array.isArray(tasks)) throw new Error("tasks must be an array.");

    const result = this.buildResult(session, await this.events(session));
    const artifactDirectory = path.join(session.directory, "artifacts");
    await ensureDirectory(artifactDirectory);
    const files = {
      meeting_summary: path.join(artifactDirectory, "meeting-summary.md"),
      transcript: path.join(artifactDirectory, "transcript.md"),
      tasks: path.join(artifactDirectory, "tasks.json"),
      evidence: path.join(artifactDirectory, "evidence.json"),
    };
    await Promise.all([
      atomicWriteFile(files.meeting_summary, meetingSummary, { encoding: "utf8" }),
      atomicWriteFile(files.transcript, result.transcript_markdown, { encoding: "utf8" }),
      atomicWriteFile(files.tasks, `${JSON.stringify(tasks, null, 2)}\n`, { encoding: "utf8" }),
      atomicWriteFile(files.evidence, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8" }),
    ]);
    session.artifacts = files;
    session.updated_at = isoTimestamp();
    await this.persist(session);
    await atomicWriteFile(
      path.join(session.repo_path, ".meeting2prompt", "latest.json"),
      `${JSON.stringify({ session_id: session.id, artifacts: files, updated_at: session.updated_at }, null, 2)}\n`,
      { encoding: "utf8" },
    );
    return { session_id: session.id, artifact_directory: artifactDirectory, files };
  }

  async persist(session) {
    await atomicWriteFile(path.join(session.directory, "session.json"), `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    if (this.initialized) await this.persistRegistry();
  }

  async persistRegistry() {
    let registry;
    try {
      registry = JSON.parse(await readFile(this.registryPath, "utf8"));
    } catch {
      registry = { schema_version: 2, sessions: {} };
    }
    registry.schema_version = 2;
    registry.sessions ||= {};
    for (const session of this.sessions.values()) {
      registry.sessions[session.id] = {
        session_file: path.join(session.directory, "session.json"),
        repo_path: session.repo_path,
        status: session.status,
        updated_at: session.updated_at,
      };
    }
    registry.updated_at = isoTimestamp();
    await atomicWriteFile(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

function buildFocusIntervals(events) {
  const starts = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "focus_start" && event.focus_id)
    .map(({ event, index }) => ({ focus_id: event.focus_id, start: Date.parse(event.timestamp), start_index: index }))
    .filter((item) => Number.isFinite(item.start))
    .sort((a, b) => comparePosition(a.start, a.start_index, b.start, b.start_index));
  const endsByFocus = new Map();
  for (const [index, event] of events.entries()) {
    if (event.type !== "focus_end" || !event.focus_id) continue;
    const endedAt = Date.parse(event.timestamp);
    if (!Number.isFinite(endedAt)) continue;
    if (!endsByFocus.has(event.focus_id)) endsByFocus.set(event.focus_id, []);
    endsByFocus.get(event.focus_id).push({ time: endedAt, index });
  }
  for (const values of endsByFocus.values()) {
    values.sort((a, b) => comparePosition(a.time, a.index, b.time, b.index));
  }
  return starts.map((start, index) => {
    const explicitEnd = (endsByFocus.get(start.focus_id) || []).find(
      (end) => comparePosition(end.time, end.index, start.start, start.start_index) >= 0,
    ) || { time: Infinity, index: Infinity };
    const nextStart = starts[index + 1]
      ? { time: starts[index + 1].start, index: starts[index + 1].start_index }
      : { time: Infinity, index: Infinity };
    const end = comparePosition(explicitEnd.time, explicitEnd.index, nextStart.time, nextStart.index) <= 0
      ? explicitEnd
      : nextStart;
    return { ...start, end: end.time, end_index: end.index };
  });
}

function focusAtTimestamp(timestamp, eventIndex, intervals) {
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return null;
  const matches = intervals
    .filter((interval) => (
      comparePosition(interval.start, interval.start_index, at, eventIndex) <= 0 &&
      comparePosition(at, eventIndex, interval.end, interval.end_index) < 0
    ))
    .sort((a, b) => comparePosition(b.start, b.start_index, a.start, a.start_index));
  return matches[0]?.focus_id || null;
}

function comparePosition(leftTime, leftIndex, rightTime, rightIndex) {
  return leftTime - rightTime || leftIndex - rightIndex;
}

function verifySecret(expectedValue, candidate) {
  if (!expectedValue || !candidate || typeof candidate !== "string") return false;
  const expected = Buffer.from(expectedValue);
  const provided = Buffer.from(candidate);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
