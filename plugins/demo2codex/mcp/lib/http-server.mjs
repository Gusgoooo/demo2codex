import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeBoolean } from "./utils.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIRECTORY = path.resolve(MODULE_DIRECTORY, "../../web");
const BODY_LIMIT = 25 * 1024 * 1024;

export class DemoReviewHttpServer {
  constructor({ store, host = "127.0.0.1", port = 47831 }) {
    this.store = store;
    this.host = host;
    this.port = Number(port);
    this.server = createServer((request, response) => this.handle(request, response));
  }

  async start() {
    try {
      await this.listen(this.port);
    } catch (error) {
      if (error.code !== "EADDRINUSE" || this.port === 0) throw error;
      this.port = 0;
      await this.listen(0);
    }
    const address = this.server.address();
    this.port = typeof address === "object" ? address.port : this.port;
    return this.url;
  }

  async listen(port) {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  get url() { return `http://${this.host}:${this.port}`; }

  async close() {
    if (!this.server.listening) return;
    await new Promise((resolve) => this.server.close(resolve));
  }

  async handle(request, response) {
    try {
      const url = new URL(request.url, this.url);
      if (!this.validHost(request.headers.host)) return sendJson(response, 403, { error: "Invalid Host header" });
      const origin = request.headers.origin;
      if (origin && !this.originAllowed(origin)) return sendJson(response, 403, { error: "Origin is not allowed" });
      applyCors(response, origin);
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Demo2Codex-Token, X-Meeting2Prompt-Token", "Access-Control-Max-Age": "600" });
        return response.end();
      }

      if (request.method === "GET" && ["/", "/app.js", "/styles.css", "/embed.js"].includes(url.pathname)) {
        return this.serveStatic(url.pathname, response);
      }
      if (request.method === "GET" && url.pathname === "/launch-recorder") {
        const session = this.store.getActive();
        if (!session) return sendJson(response, 404, { error: "No active review session" });
        if (!this.store.verifyBridgeKey(session, url.searchParams.get("bridge"))) {
          return sendJson(response, 401, { error: "Invalid bridge key" });
        }
        if (request.headers["sec-fetch-mode"] !== "navigate" || request.headers["sec-fetch-dest"] !== "document") {
          return sendJson(response, 403, { error: "Recorder launch requires a top-level browser navigation" });
        }
        const location = `${this.url}/?session=${encodeURIComponent(session.id)}&token=${encodeURIComponent(session.token)}&lang=${encodeURIComponent(session.language)}`;
        response.writeHead(302, {
          Location: location,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Cross-Origin-Opener-Policy": "same-origin",
        });
        return response.end();
      }
      if (request.method === "GET" && url.pathname === "/api/active-session") {
        const session = this.store.getActive();
        if (!session) return sendJson(response, 200, { active: false, session: null });
        if (!this.store.verifyBridgeKey(session, url.searchParams.get("bridge"))) {
          return sendJson(response, 401, { error: "Invalid bridge key" });
        }
        return sendJson(response, 200, {
          active: true,
          sessionId: session.id,
          title: session.title,
          status: session.status,
          recordingState: session.recording_state || "idle",
          currentFocus: session.current_focus,
          recorderLaunchUrl: `${this.url}/launch-recorder?bridge=${encodeURIComponent(session.bridge_key)}`,
        });
      }

      const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(events|audio|finish))?$/);
      if (!match) return sendJson(response, 404, { error: "Not found" });
      const session = this.store.get(decodeURIComponent(match[1]));
      const token = getToken(request, url);
      const tokenAuthorized = this.store.verifyToken(session, token);
      const bridgeAuthorized = this.store.verifyBridgeKey(session, url.searchParams.get("bridge"));

      if (request.method === "GET" && !match[2]) {
        if (!tokenAuthorized) return sendJson(response, 401, { error: "Invalid review token" });
        return sendJson(response, 200, { session: this.store.publicSession(session) });
      }
      if (request.method === "POST" && match[2] === "events") {
        if (!tokenAuthorized && !bridgeAuthorized) {
          return sendJson(response, 401, { error: "Invalid review or bridge credential" });
        }
        const input = JSON.parse((await readBody(request, 2 * 1024 * 1024)).toString("utf8") || "{}");
        const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
        const normalized = normalizeWebEvent(input.type, payload);
        if (!tokenAuthorized && !["focus_start", "focus_end"].includes(normalized.type)) {
          return sendJson(response, 403, { error: "The demo bridge may only submit focus events" });
        }
        const event = await this.store.addEvent(session.id, {
          ...payload,
          ...input,
          ...normalized,
          text: normalized.text ?? input.text ?? payload.text,
          speaker: input.speaker ?? payload.speaker,
          focus: normalized.focus ?? input.focus ?? payload.focus ?? payload.element,
          metadata: input.metadata ?? { ...payload, elapsedMs: input.elapsedMs },
        });
        return sendJson(response, 202, { accepted: true, event });
      }
      if (request.method === "POST" && match[2] === "audio") {
        if (!tokenAuthorized) return sendJson(response, 401, { error: "Invalid review token" });
        const sequence = Number.parseInt(url.searchParams.get("seq") || "", 10);
        const bytes = await readBody(request, BODY_LIMIT);
        const result = await this.store.saveAudio(session.id, bytes, {
          sequence: Number.isInteger(sequence) ? sequence : undefined,
          final: normalizeBoolean(url.searchParams.get("final")),
          contentType: request.headers["content-type"],
        });
        return sendJson(response, 202, { accepted: true, audio: result });
      }
      if (request.method === "POST" && match[2] === "finish") {
        if (!tokenAuthorized) return sendJson(response, 401, { error: "Invalid review token" });
        await consumeOptionalBody(request);
        const result = await this.store.finish(session.id, { requireFinalAudio: true });
        return sendJson(response, 200, result);
      }
      return sendJson(response, 405, { error: "Method not allowed" });
    } catch (error) {
      const status = /too large/i.test(error.message) ? 413 : /Unknown review|No active/.test(error.message) ? 404 : 400;
      sendJson(response, status, { error: error.message });
    }
  }

  validHost(hostHeader = "") {
    const hostname = hostHeader.replace(/:\d+$/, "").toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost";
  }

  originAllowed(origin) {
    let parsed;
    try { parsed = new URL(origin); } catch { return false; }
    if (parsed.origin === this.url) return true;
    const demoUrl = this.store.getActive()?.demo_url;
    if (demoUrl) {
      try { return new URL(demoUrl).origin === parsed.origin; } catch { return false; }
    }
    return ["127.0.0.1", "localhost"].includes(parsed.hostname.toLowerCase());
  }

  async serveStatic(pathname, response) {
    const mapping = { "/": "index.html", "/app.js": "app.js", "/styles.css": "styles.css", "/embed.js": "embed.js" };
    const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
    const filePath = path.join(WEB_DIRECTORY, mapping[pathname]);
    try {
      const body = await readFile(filePath);
      const headers = { "Content-Type": contentTypes[path.extname(filePath)], "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
      if (pathname === "/") headers["Cross-Origin-Opener-Policy"] = "same-origin";
      response.writeHead(200, headers);
      response.end(body);
    } catch (error) {
      if (pathname === "/embed.js") {
        response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
        return response.end("console.warn('[Demo2Codex] embed.js is not available yet');\n");
      }
      sendJson(response, 404, { error: "Static asset not found" });
    }
  }
}

function applyCors(response, origin) {
  if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function getToken(request, url) {
  const authorization = request.headers.authorization || "";
  return (
    url.searchParams.get("token") ||
    request.headers["x-demo2codex-token"] ||
    request.headers["x-meeting2prompt-token"] ||
    (authorization.startsWith("Bearer ") ? authorization.slice(7) : "")
  );
}

function normalizeWebEvent(type, payload) {
  const normalized = String(type || "note").toLowerCase();
  if (normalized.startsWith("transcript.")) {
    return { type: "transcript", text: payload.text, final: normalized !== "transcript.interim" };
  }
  if (normalized === "focus.start") {
    return {
      type: "focus_start",
      focus_id: payload.focus_id || payload.focusId,
      focus: payload.focus || payload.element,
    };
  }
  if (normalized === "focus.end") {
    return {
      type: "focus_end",
      focus_id: payload.focus_id || payload.focusId || payload.id,
      focus: payload.focus || payload.element,
    };
  }
  if (normalized.startsWith("recording.")) {
    const action = normalized.slice("recording.".length);
    const state = action === "pause" ? "paused" : action === "start" || action === "resume" ? "recording" : action;
    return { type: "recorder_state", state, text: state };
  }
  return { type };
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error(`Request body is too large (limit ${limit} bytes)`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function consumeOptionalBody(request) {
  await readBody(request, 1024 * 1024);
}

function sendJson(response, status, value) {
  if (response.writableEnded) return;
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(body);
}
