import http from "node:http";
import fs from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

export const MODEL_MAP = {
  "claude-opus-4-5": "deepseek-v4-pro",
  "claude-sonnet-4-5": "deepseek-v4-flash",
};

const ALIASES = Object.keys(MODEL_MAP);

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || "127.0.0.1";
const UPSTREAM_BASE = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/anthropic").replace(/\/+$/, "");
const API_KEY = process.env.DEEPSEEK_API_KEY || "";
const PROXY_API_KEY = process.env.PROXY_API_KEY || "";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const LOG_FILE = process.env.LOG_FILE || "";
const TRANSFORM_RESPONSES = process.env.TRANSFORM_RESPONSES === "true";
const FILTER_THINKING_BLOCKS = process.env.FILTER_THINKING_BLOCKS === "true";
const FORCE_UPSTREAM_NON_STREAM = process.env.FORCE_UPSTREAM_NON_STREAM === "true";
const ALLOW_LOCALHOST_NO_AUTH = process.env.ALLOW_LOCALHOST_NO_AUTH === "true";

function isReadOnlyMethod(method) {
  return method === "GET" || method === "HEAD";
}

function addCorsHeaders(headers) {
  return {
    "access-control-allow-origin": CORS_ORIGIN,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-api-key,anthropic-version,anthropic-beta",
    ...headers,
  };
}

function logLine(level, message, extra = undefined) {
  const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
  const line = `${new Date().toISOString()} ${level} ${message}${suffix}`;

  if (level === "ERROR") {
    console.error(line);
  } else {
    console.log(line);
  }

  if (LOG_FILE) {
    fs.appendFile(LOG_FILE, `${line}\n`, (error) => {
      if (error) console.error(`${new Date().toISOString()} ERROR failed_to_write_log ${error.message}`);
    });
  }
}

function headerValue(headers, name) {
  const value = headers[name];
  if (Array.isArray(value)) return value.join(",");
  return value;
}

function describeError(error) {
  return {
    name: error?.name,
    message: error?.message,
    code: error?.code,
    stack: error?.stack,
    cause: error?.cause
      ? {
          name: error.cause.name,
          message: error.cause.message,
          code: error.cause.code,
          stack: error.cause.stack,
        }
      : undefined,
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, addCorsHeaders({
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  }));
  res.end(body);
}

function remoteAddress(req) {
  return req.socket?.remoteAddress || "";
}

function isLocalhostAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function buildHeaders(req) {
  const headers = {};
  const contentType = headerValue(req.headers, "content-type");
  const accept = headerValue(req.headers, "accept");
  const anthropicVersion = headerValue(req.headers, "anthropic-version");
  const anthropicBeta = headerValue(req.headers, "anthropic-beta");

  if (API_KEY) {
    headers["x-api-key"] = API_KEY;
  }

  if (contentType) headers["content-type"] = contentType;
  if (accept) headers.accept = accept;
  headers["anthropic-version"] = anthropicVersion || "2023-06-01";
  if (anthropicBeta) headers["anthropic-beta"] = anthropicBeta;

  return headers;
}

export function rewriteRequestBody(buffer, contentType) {
  return rewriteRequestBodyWithOptions(buffer, contentType).bufferInfo;
}

function parseJsonRequestBody(buffer, contentType) {
  const normalizedContentType = Array.isArray(contentType) ? contentType.join(",") : contentType || "";
  if (!buffer.length || !normalizedContentType.toLowerCase().includes("application/json")) {
    return null;
  }

  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function rewriteRequestBodyWithOptions(buffer, contentType, options = {}) {
  const json = parseJsonRequestBody(buffer, contentType);
  if (!json) return { bufferInfo: { buffer, note: null }, didForceNonStream: false };

  let changed = false;
  let note = null;
  if (json && typeof json.model === "string" && MODEL_MAP[json.model]) {
    const from = json.model;
    json.model = MODEL_MAP[from];
    note = `${from} -> ${json.model}`;
    changed = true;
  }

  let didForceNonStream = false;
  if (options.forceNonStream && json.stream === true) {
    json.stream = false;
    didForceNonStream = true;
    changed = true;
  }

  return {
    bufferInfo: {
      buffer: changed ? Buffer.from(JSON.stringify(json)) : buffer,
      note,
    },
    didForceNonStream,
  };
}

function modelFromRequestBody(buffer, contentType) {
  const json = parseJsonRequestBody(buffer, contentType);
  return typeof json?.model === "string" ? json.model : null;
}

function requestWantsStream(buffer, contentType) {
  const json = parseJsonRequestBody(buffer, contentType);
  return json?.stream === true;
}

function rewriteResponseModel(payload, aliasModel) {
  if (!aliasModel || !payload || typeof payload !== "object") return payload;
  if (typeof payload.model === "string") payload.model = aliasModel;
  if (payload.message && typeof payload.message.model === "string") payload.message.model = aliasModel;
  return payload;
}

function filterThinkingFromJson(payload, aliasModel) {
  rewriteResponseModel(payload, aliasModel);

  if (Array.isArray(payload?.content)) {
    payload.content = payload.content.filter((block) => block?.type !== "thinking");
  }

  if (Array.isArray(payload?.message?.content)) {
    payload.message.content = payload.message.content.filter((block) => block?.type !== "thinking");
  }

  return payload;
}

function transformSseEvent(rawEvent, state) {
  const normalizedEvent = rawEvent.replace(/\r\n/g, "\n");
  const lines = normalizedEvent.split("\n");
  const dataLines = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) return `${rawEvent}\n\n`;
  const data = dataLines.join("\n");
  if (data === "[DONE]") return `${rawEvent}\n\n`;

  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return `${rawEvent}\n\n`;
  }

  if (FILTER_THINKING_BLOCKS && payload.type === "ping") return "";

  rewriteResponseModel(payload, state.aliasModel);

  if (FILTER_THINKING_BLOCKS) {
    if (payload.type === "content_block_start") {
      const originalIndex = payload.index;
      if (payload.content_block?.type === "thinking") {
        state.hiddenIndexes.add(originalIndex);
        return "";
      }

      if (!state.indexMap.has(originalIndex)) {
        state.indexMap.set(originalIndex, state.nextIndex++);
      }
      payload.index = state.indexMap.get(originalIndex);
    } else if (payload.type === "content_block_delta" || payload.type === "content_block_stop") {
      const originalIndex = payload.index;
      if (state.hiddenIndexes.has(originalIndex)) {
        if (payload.type === "content_block_stop") state.hiddenIndexes.delete(originalIndex);
        return "";
      }

      if (state.indexMap.has(originalIndex)) {
        payload.index = state.indexMap.get(originalIndex);
      }
    }
  }

  const outputLines = lines.map((line) => (line.startsWith("data:") ? `data: ${JSON.stringify(payload)}` : line));
  return `${outputLines.join("\n")}\n\n`;
}

async function* transformSseStream(webStream, aliasModel) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = { aliasModel, hiddenIndexes: new Set(), indexMap: new Map(), nextIndex: 0 };
  let buffer = "";

  for await (const chunk of Readable.fromWeb(webStream)) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || "";

    for (const part of parts) {
      const transformed = transformSseEvent(part, state);
      if (transformed) yield encoder.encode(transformed);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const transformed = transformSseEvent(buffer, state);
    if (transformed) yield encoder.encode(transformed);
  }
}

async function sendTransformedJson(upstream, res, responseHeaders, aliasModel) {
  const rawText = await upstream.text();
  let payload;

  try {
    payload = JSON.parse(rawText);
  } catch {
    const body = Buffer.from(rawText);
    res.writeHead(upstream.status, addCorsHeaders({ ...responseHeaders, "content-length": String(body.length) }));
    return res.end(body);
  }

  const body = Buffer.from(JSON.stringify(filterThinkingFromJson(payload, aliasModel)));
  res.writeHead(upstream.status, {
    ...baseResponseHeaders("application/json; charset=utf-8"),
    "content-length": String(body.length),
  });
  res.end(body);
}

function baseResponseHeaders(contentType) {
  return addCorsHeaders({
    "content-type": contentType,
    "cache-control": "no-cache",
  });
}

function textFromMessagePayload(payload) {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

async function sendJsonAsSse(upstream, res, aliasModel, startedAt, path) {
  const rawText = await upstream.text();
  let payload;

  try {
    payload = JSON.parse(rawText);
  } catch {
    res.writeHead(upstream.status, baseResponseHeaders("text/plain; charset=utf-8"));
    res.end(rawText);
    return;
  }

  if (upstream.status >= 400) {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(upstream.status, {
      ...baseResponseHeaders("application/json; charset=utf-8"),
      "content-length": String(body.length),
    });
    res.end(body);
    return;
  }

  const message = filterThinkingFromJson(payload, aliasModel);
  const text = textFromMessagePayload(message);
  const id = message.id || `msg_${Date.now()}`;
  const usage = message.usage || {};

  const events = [
    ["message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: aliasModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage.input_tokens || 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
          cache_read_input_tokens: usage.cache_read_input_tokens || 0,
          output_tokens: 0,
          service_tier: usage.service_tier,
        },
      },
    }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", {
      type: "message_delta",
      delta: { stop_reason: message.stop_reason || "end_turn", stop_sequence: message.stop_sequence || null },
      usage,
    }],
    ["message_stop", { type: "message_stop" }],
  ];

  res.writeHead(200, baseResponseHeaders("text/event-stream; charset=utf-8"));
  for (const [event, data] of events) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
  res.end();
  logLine("INFO", "sse_complete", { path, duration_ms: Date.now() - startedAt, synthetic: true });
}

function credentialFromRequest(req) {
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey) return apiKey;

  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1];
  }

  return "";
}

function isAuthorized(req) {
  if (!PROXY_API_KEY || credentialFromRequest(req) === PROXY_API_KEY) return true;
  return ALLOW_LOCALHOST_NO_AUTH && isLocalhostAddress(remoteAddress(req));
}

function estimateTokensFromValue(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return Math.max(1, Math.ceil(value.length / 4));
  if (typeof value === "number" || typeof value === "boolean") return 1;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateTokensFromValue(item), 0);
  if (typeof value === "object") return Object.values(value).reduce((sum, item) => sum + estimateTokensFromValue(item), 0);
  return 0;
}

function handleCountTokens(rawBody, contentType, res) {
  const json = parseJsonRequestBody(rawBody, contentType);
  if (!json) {
    return sendJson(res, 400, {
      error: {
        type: "invalid_request_error",
        message: "Expected JSON request body.",
      },
    });
  }

  const estimated = Math.max(1, estimateTokensFromValue(json.messages || json));
  return sendJson(res, 200, { input_tokens: estimated });
}

async function handleProxy(req, res) {
  const startedAt = Date.now();
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, addCorsHeaders({}));
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, upstream: UPSTREAM_BASE, aliases: MODEL_MAP });
  }

  if (!isAuthorized(req)) {
    logLine("WARN", "auth_rejected", { method: req.method, path: url.pathname, remote: remoteAddress(req) });
    return sendJson(res, 401, {
      error: {
        type: "authentication_error",
        message: "Missing or invalid proxy API key.",
      },
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    const rawBody = await readBody(req);
    logLine("INFO", "count_tokens_local", { remote: remoteAddress(req) });
    return handleCountTokens(rawBody, req.headers["content-type"], res);
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    return sendJson(res, 200, {
      data: ALIASES.map((id) => ({
        type: "model",
        id,
        display_name: id,
        created_at: "2026-01-01T00:00:00Z",
      })),
      has_more: false,
      first_id: ALIASES[0],
      last_id: ALIASES.at(-1),
    });
  }

  if (!url.pathname.startsWith("/v1/")) {
    return sendJson(res, 404, {
      error: {
        type: "not_found_error",
        message: "Only /v1/* requests are proxied.",
      },
    });
  }

  const rawBody = await readBody(req);
  const aliasModel = modelFromRequestBody(rawBody, req.headers["content-type"]);
  const wantsStream = requestWantsStream(rawBody, req.headers["content-type"]);
  const forceNonStream =
    FORCE_UPSTREAM_NON_STREAM &&
    url.pathname === "/v1/messages" &&
    wantsStream &&
    Boolean(aliasModel);
  const { bufferInfo, didForceNonStream } = rewriteRequestBodyWithOptions(rawBody, req.headers["content-type"], {
    forceNonStream,
  });
  const { buffer: body, note } = bufferInfo;
  if (note) logLine("INFO", "model_rewrite", { rewrite: note });
  if (didForceNonStream) logLine("INFO", "force_upstream_non_stream", { path: url.pathname, model: aliasModel });

  const upstreamUrl = `${UPSTREAM_BASE}${url.pathname}${url.search}`;
  const upstream = await fetch(upstreamUrl, {
    method: req.method,
    headers: buildHeaders(req),
    body: isReadOnlyMethod(req.method) ? undefined : body,
  });

  if (upstream.status >= 400) {
    logLine("WARN", "upstream_error", { status: upstream.status, path: url.pathname, duration_ms: Date.now() - startedAt });
  } else {
    logLine("INFO", "upstream_response", { status: upstream.status, path: url.pathname, duration_ms: Date.now() - startedAt });
  }

  const responseHeaders = {};
  upstream.headers.forEach((value, key) => {
    if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key.toLowerCase())) {
      responseHeaders[key] = value;
    }
  });

  const contentType = upstream.headers.get("content-type") || "";
  const shouldTransformMessages = TRANSFORM_RESPONSES && url.pathname === "/v1/messages" && aliasModel;
  if (shouldTransformMessages && didForceNonStream && contentType.includes("application/json")) {
    return sendJsonAsSse(upstream, res, aliasModel, startedAt, url.pathname);
  }

  if (shouldTransformMessages && contentType.includes("text/event-stream") && upstream.body) {
    res.writeHead(upstream.status, baseResponseHeaders("text/event-stream; charset=utf-8"));
    const transformed = Readable.from(transformSseStream(upstream.body, aliasModel));
    transformed.on("end", () => logLine("INFO", "sse_complete", { path: url.pathname, duration_ms: Date.now() - startedAt }));
    transformed.on("error", (error) => logLine("ERROR", "sse_transform_error", describeError(error)));
    return transformed.pipe(res);
  }

  if (shouldTransformMessages && contentType.includes("application/json")) {
    return sendTransformedJson(upstream, res, responseHeaders, aliasModel);
  }

  res.writeHead(upstream.status, addCorsHeaders(responseHeaders));
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).pipe(res);
}

export function handleRequest(req, res) {
  handleProxy(req, res).catch((error) => {
    logLine("ERROR", "proxy_error", describeError(error));
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: {
          type: "proxy_error",
          message: error.message,
        },
      });
    } else {
      res.end();
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = http.createServer(handleRequest);

  server.listen(PORT, HOST, () => {
    logLine("INFO", `listening http://${HOST}:${PORT}`);
    logLine("INFO", `upstream ${UPSTREAM_BASE}`);
    logLine("INFO", `aliases ${ALIASES.map((id) => `${id}=>${MODEL_MAP[id]}`).join(", ")}`);
    if (LOG_FILE) logLine("INFO", `log_file ${LOG_FILE}`);
    if (!PROXY_API_KEY) logLine("WARN", "PROXY_API_KEY is not set. Do not expose this proxy publicly.");
    if (ALLOW_LOCALHOST_NO_AUTH) logLine("WARN", "ALLOW_LOCALHOST_NO_AUTH is enabled. Do not expose this proxy through Cloudflare while this is enabled.");
  });
}
