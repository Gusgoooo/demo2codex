#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import { installDemoBridge } from "./lib/demo-bridge.mjs";
import { MeetingHttpServer } from "./lib/http-server.mjs";
import { captureRepositorySnapshot } from "./lib/repository-snapshot.mjs";
import { SessionStore } from "./lib/session-store.mjs";
import { TRANSLATION_CONSTRAINTS } from "./lib/translation-constraints.mjs";

const store = new SessionStore();
let lastRepoPath = process.env.MEETING2PROMPT_REPO ? path.resolve(process.env.MEETING2PROMPT_REPO) : null;
const httpServer = new MeetingHttpServer({
  store,
  host: "127.0.0.1",
  port: Number(process.env.MEETING2PROMPT_PORT || 47831),
});
const httpReady = store.initialize().then(() => {
  lastRepoPath ||= store.getActive()?.repo_path || null;
  return httpServer.start();
}).catch((error) => {
  process.stderr.write(`[meeting2prompt] HTTP server failed: ${error.message}\n`);
  throw error;
});
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2024-11-05"];

const tools = [
  {
    name: "start_review",
    description: "Start a local demo-review session for the current repository, open the recorder workflow, and install the optional page-focus bridge. Use the captured evidence later; do not infer requirements during this call.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Absolute path to the repository. Defaults to the last repository or server cwd." },
        title: { type: "string" },
        language: { type: "string", default: "zh-CN" },
        demo_url: { type: "string", description: "Optional local demo URL. Its origin may submit page-focus evidence." },
        index_file: { type: "string", description: "Optional repository-relative HTML entry file for the page-focus bridge." },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  {
    name: "review_status",
    description: "Read the current or named demo-review status, including recording state, current page focus, event counts, and saved file paths.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  {
    name: "finish_review",
    description: "Finish a demo review and return the raw evidence package: transcript, notes, page-focus segments, repository path and Git snapshot, audio path, and narrow translation constraints. The current Codex model should inspect the repository and translate only the user's stated changes into tasks.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  {
    name: "save_review_result",
    description: "Save the meeting summary and structured tasks produced by the user's active Codex model. This tool stores the model output without generating or expanding requirements.",
    inputSchema: {
      type: "object",
      required: ["meeting_summary", "tasks"],
      properties: {
        session_id: { type: "string" },
        meeting_summary: { type: "string" },
        tasks: { type: "array", items: { type: "object" } },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
];

async function callTool(name, args = {}) {
  await httpReady;
  switch (name) {
    case "start_review": {
      const repoPath = resolveRepoPath(args.repo_path);
      const snapshot = await captureRepositorySnapshot(repoPath);
      lastRepoPath = snapshot.repo_path;
      const demoUrl = args.demo_url || args.demoUrl;
      if (demoUrl) validateHttpUrl(demoUrl, "demo_url");
      const session = await store.start({
        repoPath: snapshot.repo_path,
        title: args.title,
        language: args.language,
        demoUrl,
        repository: snapshot.repository,
        serverUrl: httpServer.url,
      });
      const recorderUrl = `${httpServer.url}/?session=${encodeURIComponent(session.id)}&token=${encodeURIComponent(session.token)}&lang=${encodeURIComponent(session.language)}`;
      const bridgeUrl = `${httpServer.url}/embed.js?bridge=${encodeURIComponent(session.bridge_key)}`;
      let bridge;
      try {
        bridge = await installDemoBridge({
          repoPath: snapshot.repo_path,
          indexFile: args.index_file,
          serverUrl: bridgeUrl,
        });
      } catch (error) {
        bridge = {
          installed: false,
          strategy: "unavailable",
          error: error.message,
          instructions: "The review can continue without page-focus evidence.",
        };
      }
      return {
        session_id: session.id,
        status: session.status,
        recording_state: session.recording_state,
        repo_path: snapshot.repo_path,
        repository: snapshot.repository,
        recorder_url: recorderUrl,
        bridge_url: bridgeUrl,
        bridge,
        translation_constraints: TRANSLATION_CONSTRAINTS,
      };
    }
    case "review_status": {
      const session = store.get(args.session_id);
      return {
        ...store.publicSession(session),
        recorder_url: `${httpServer.url}/?session=${encodeURIComponent(session.id)}&token=${encodeURIComponent(session.token)}&lang=${encodeURIComponent(session.language)}`,
        bridge_url: `${httpServer.url}/embed.js?bridge=${encodeURIComponent(session.bridge_key)}`,
        translation_constraints: TRANSLATION_CONSTRAINTS,
      };
    }
    case "finish_review":
      return store.requestFinish(args.session_id);
    case "save_review_result":
      return store.saveArtifacts(args.session_id, { meetingSummary: args.meeting_summary, tasks: args.tasks });
    default:
      throw new RpcError(-32601, `Unknown tool: ${name}`);
  }
}

function resolveRepoPath(input) {
  return path.resolve(input || lastRepoPath || process.cwd());
}

function validateHttpUrl(input, label) {
  let parsed;
  try { parsed = new URL(input); } catch { throw new Error(`${label} must be a valid URL.`); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`${label} must use http or https.`);
}

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

async function handleMessage(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    throw new RpcError(-32600, "Invalid JSON-RPC request");
  }
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(message.params?.protocolVersion)
          ? message.params.protocolVersion
          : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "meeting2prompt", version: "0.2.0" },
      };
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;
    case "ping":
      return {};
    case "tools/list":
      return { tools };
    case "tools/call": {
      const name = message.params?.name;
      if (!name) throw new RpcError(-32602, "tools/call requires params.name");
      try {
        const result = await callTool(name, message.params?.arguments || {});
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
          isError: true,
        };
      }
    }
    default:
      throw new RpcError(-32601, `Method not found: ${message.method}`);
  }
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
input.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${error.message}` } });
    return;
  }
  try {
    const result = await handleMessage(message);
    if (message.id !== undefined && result !== undefined) send({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: error.code || -32603, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } });
  }
});

async function shutdown() {
  await httpServer.close().catch(() => {});
  process.exit(0);
}
input.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stderr.write(`[meeting2prompt] MCP stdio server starting; recorder will bind to 127.0.0.1:${httpServer.port}\n`);
