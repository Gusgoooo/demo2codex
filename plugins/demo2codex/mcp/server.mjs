#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { installDemoBridge } from "./lib/demo-bridge.mjs";
import { DemoReviewHttpServer } from "./lib/http-server.mjs";
import { captureRepositorySnapshot } from "./lib/repository-snapshot.mjs";
import { SessionStore } from "./lib/session-store.mjs";
import { TRANSLATION_CONSTRAINTS } from "./lib/translation-constraints.mjs";

const store = new SessionStore();
const configuredRepoPath = process.env.DEMO2CODEX_REPO || process.env.MEETING2PROMPT_REPO;
let lastRepoPath = firstUsableRepoPath([
  configuredRepoPath,
  process.env.INIT_CWD,
  process.env.PWD,
]);
const httpServer = new DemoReviewHttpServer({
  store,
  host: "127.0.0.1",
  port: Number(process.env.DEMO2CODEX_PORT || process.env.MEETING2PROMPT_PORT || 47831),
});
const httpReady = store.initialize().then(() => {
  lastRepoPath ||= store.getActive()?.repo_path || null;
  return httpServer.start();
}).catch((error) => {
  process.stderr.write(`[demo2codex] HTTP server failed: ${error.message}\n`);
  throw error;
});
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2024-11-05"];
const debugRpc = process.env.DEMO2CODEX_DEBUG_RPC === "1";
const pendingServerRequests = new Map();
let nextServerRequestId = 1;
let clientSupportsRoots = false;
let rootsReady = Promise.resolve();

const tools = [
  {
    name: "start_review",
    title: "Start a Demo Review",
    description: "Start a local demo-review session grounded in the current repository. Capture a lightweight repository profile, open the recorder workflow, and install the page-focus bridge that can collect route, selector, framework component, component stack, and source-file evidence.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Absolute path to the repository. Defaults to the current Codex workspace or last active repository." },
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
    title: "Read Demo Review Status",
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
    title: "Finish a Demo Review",
    description: "Finish a demo review and return transcript evidence plus a lightweight repository module index. Each focused discussion is matched using captured source, component, route, selector, visible text, and code terms, producing relevant modules, paths, confidence, and reasons without code excerpts or line-level instructions. The user's active Codex model should inspect those modules and produce only the stated Chinese TODOs.",
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
    title: "Save Demo Review Tasks",
    description: "Save a Chinese review summary and editable TODO list. Each TODO is one short, direct Chinese instruction like a prompt the user would give Codex. Repository module clues remain separate and appear only as a compact hover hint in the recorder UI.",
    inputSchema: {
      type: "object",
      required: ["review_summary", "tasks"],
      properties: {
        session_id: { type: "string" },
        review_summary: { type: "string" },
        tasks: {
          type: "array",
          items: {
            type: "object",
            required: [
              "content",
              "grounding",
            ],
            properties: {
              id: { type: "string" },
              content: { type: "string", description: "One concise Chinese modification instruction. Do not include code paths, code details, evidence fields, or implementation commentary." },
              grounding: {
                type: "object",
                description: "Hidden internal evidence. It is stored separately and is not returned by the user-facing result API.",
                required: ["meeting_evidence", "module_candidates", "scope", "acceptance_criteria", "open_questions"],
                properties: {
                  meeting_evidence: { type: "array", items: {} },
                  module_candidates: {
                    type: "array",
                    description: "Hidden module-index clues with approximate module names and repository paths; do not include code excerpts, symbols, or line anchors.",
                    items: { type: "object" },
                  },
                  scope: { type: "string" },
                  acceptance_criteria: { type: "array", items: { type: "string" } },
                  open_questions: { type: "array", items: { type: "string" } },
                },
                additionalProperties: true,
              },
            },
            additionalProperties: true,
          },
        },
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

function listedResources() {
  const startUri = new URL("demo2codex://start-review");
  if (lastRepoPath && !isPluginDirectory(lastRepoPath)) {
    startUri.searchParams.set("repo_path", lastRepoPath);
  }
  return [
    {
      uri: startUri.toString(),
      name: "demo2codex_start_review",
      title: "Start a Demo2Codex Review",
      description: "Action resource: read this URI to start or resume a local demo review for the current workspace when the start_review tool is deferred or unavailable.",
      mimeType: "application/json",
    },
    {
      uri: "demo2codex://review-status",
      name: "demo2codex_review_status",
      title: "Read Demo2Codex Review Status",
      description: "Read the status of the active Demo2Codex review when the review_status tool is deferred or unavailable.",
      mimeType: "application/json",
    },
    {
      uri: "demo2codex://finish-review",
      name: "demo2codex_finish_review",
      title: "Finish a Demo2Codex Review",
      description: "Action resource: read this URI to finish the active review and retrieve meeting evidence mapped to an approximate repository module index when the finish_review tool is deferred or unavailable.",
      mimeType: "application/json",
    },
  ];
}

const resourceTemplates = [
  {
    uriTemplate: "demo2codex://start-review{?repo_path,title,language,demo_url,index_file}",
    name: "demo2codex_start_review_with_options",
    title: "Start a Demo2Codex Review with Options",
    description: "Start a review with an explicit repository path or optional recorder settings. Query parameter values must be URL-encoded.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "demo2codex://review-status{?session_id}",
    name: "demo2codex_review_status_by_id",
    title: "Read a Demo2Codex Review by ID",
    description: "Read the status of a specific review session.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "demo2codex://finish-review{?session_id}",
    name: "demo2codex_finish_review_by_id",
    title: "Finish a Demo2Codex Review by ID",
    description: "Finish a specific review session and retrieve its code-grounded evidence package.",
    mimeType: "application/json",
  },
];

async function callTool(name, args = {}) {
  await httpReady;
  switch (name) {
    case "start_review": {
      await rootsReady;
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
        resumed: Boolean(session.resumed),
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
    case "finish_review": {
      const result = await store.requestFinish(args.session_id);
      if (result.status !== "finished") return result;
      const session = store.get(result.session_id);
      return {
        ...result,
        result_submission: {
          method: "POST",
          url: `${httpServer.url}/api/sessions/${encodeURIComponent(session.id)}/result?token=${encodeURIComponent(session.token)}`,
          content_type: "application/json",
          body_contract: {
            review_summary: "Chinese string",
            tasks: [{
              id: "optional stable string",
              content: "one concise Chinese modification instruction",
              grounding: {
                meeting_evidence: "array with at least one captured item",
                module_candidates: "array of approximate module names and repository paths",
                scope: "non-empty string",
                acceptance_criteria: "array of strings",
                open_questions: "array of strings",
              },
            }],
          },
          instruction: "If save_review_result is deferred, submit the same JSON body directly to this local URL. This is a first-class plugin path; do not create a manual session or ask the user to reinstall.",
        },
      };
    }
    case "save_review_result":
      return store.saveArtifacts(args.session_id, { reviewSummary: args.review_summary, tasks: args.tasks });
    default:
      throw new RpcError(-32601, `Unknown tool: ${name}`);
  }
}

async function readResource(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new RpcError(-32602, "resources/read requires a valid Demo2Codex URI");
  }
  if (parsed.protocol !== "demo2codex:") {
    throw new RpcError(-32602, `Unsupported resource protocol: ${parsed.protocol}`);
  }
  const action = parsed.hostname || parsed.pathname.replace(/^\/+/, "");
  const args = Object.fromEntries(parsed.searchParams.entries());
  let result;
  switch (action) {
    case "start-review": {
      await rootsReady;
      if (!args.repo_path && (!lastRepoPath || isPluginDirectory(lastRepoPath))) {
        result = {
          status: "repo_path_required",
          message: "Retry this resource with the current workspace as the URL-encoded repo_path query parameter.",
          uri_template: "demo2codex://start-review{?repo_path,title,language,demo_url,index_file}",
        };
        break;
      }
      result = await callTool("start_review", args);
      break;
    }
    case "review-status":
      result = await callTool("review_status", args);
      break;
    case "finish-review":
      result = await callTool("finish_review", args);
      break;
    default:
      throw new RpcError(-32602, `Unknown Demo2Codex resource: ${uri}`);
  }
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(result, null, 2),
    }],
  };
}

function resolveRepoPath(input) {
  const candidate = input ? path.resolve(input) : lastRepoPath;
  if (!candidate || isPluginDirectory(candidate)) {
    throw new Error("repo_path is required because the plugin process directory is not the user's workspace.");
  }
  return candidate;
}

function firstUsableRepoPath(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (!isPluginDirectory(resolved)) return resolved;
  }
  return null;
}

function isPluginDirectory(candidate) {
  return existsSync(path.join(candidate, ".codex-plugin", "plugin.json"));
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
  if (debugRpc) {
    process.stderr.write(`[demo2codex] RPC ${message?.method || "<invalid>"}\n`);
    if (message?.method === "initialize") {
      process.stderr.write(`[demo2codex] initialize params ${JSON.stringify(message.params || {})}\n`);
    }
  }
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    throw new RpcError(-32600, "Invalid JSON-RPC request");
  }
  switch (message.method) {
    case "initialize":
      clientSupportsRoots = Boolean(message.params?.capabilities?.roots);
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(message.params?.protocolVersion)
          ? message.params.protocolVersion
          : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: { name: "demo2codex", version: "0.4.1" },
        instructions: "Use start_review when the user asks to begin a demo review. Codex may defer custom MCP tools: if start_review, review_status, or finish_review is not callable, use the Demo2Codex resources through list_mcp_resources/read_mcp_resource. Read demo2codex://start-review or its repository-scoped form before claiming the recorder is unavailable. Repeated starts for the same repository resume the active session. Use finish_review (or the finish resource) to retrieve transcript evidence plus a lightweight module index. The module index only tells you which page, feature area, component, and repository paths are likely relevant; it contains no exact edit instructions, so inspect the real code yourself. User-facing output has three simple stages: recording, a collapsed read-only transcript, and an editable Chinese summary/TODO list. Each saved TODO exposes one short, direct Chinese instruction. Keep meeting evidence, module candidates, narrow scope, acceptance criteria, and open questions inside its grounding object. The UI may derive only a compact module hover hint from module candidates. Use save_review_result when callable. If it is deferred, POST the identical JSON body to the result_submission URL returned by finish_review; this is a supported plugin path and must not trigger manual session creation or a reinstall request.",
      };
    case "notifications/initialized":
      rootsReady = discoverClientRoots();
      await rootsReady;
      return undefined;
    case "notifications/cancelled":
      return undefined;
    case "ping":
      return {};
    case "tools/list":
      return { tools };
    case "resources/list":
      await rootsReady;
      return { resources: listedResources() };
    case "resources/templates/list":
      return { resourceTemplates };
    case "resources/read": {
      const uri = message.params?.uri;
      if (!uri) throw new RpcError(-32602, "resources/read requires params.uri");
      return readResource(uri);
    }
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

function sendServerRequest(method, params = {}, { timeoutMs = 2_000 } = {}) {
  const id = `demo2codex-${nextServerRequestId++}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingServerRequests.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pendingServerRequests.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

async function discoverClientRoots() {
  if (!clientSupportsRoots) return;
  try {
    const result = await sendServerRequest("roots/list");
    const rootPaths = (result?.roots || [])
      .map((root) => {
        try {
          return root?.uri?.startsWith("file:") ? fileURLToPath(root.uri) : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    lastRepoPath = firstUsableRepoPath(rootPaths) || lastRepoPath;
    if (debugRpc) process.stderr.write(`[demo2codex] workspace root ${lastRepoPath || "<unknown>"}\n`);
  } catch (error) {
    if (debugRpc) process.stderr.write(`[demo2codex] roots/list unavailable: ${error.message}\n`);
  }
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
  if (!message?.method && message?.id !== undefined && pendingServerRequests.has(message.id)) {
    const pending = pendingServerRequests.get(message.id);
    pendingServerRequests.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || "MCP client request failed"));
    } else {
      pending.resolve(message.result);
    }
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
process.stderr.write(`[demo2codex] MCP stdio server starting; recorder will bind to 127.0.0.1:${httpServer.port}\n`);
