import http from "node:http";
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_MODEL_MAP = {
  "claude-opus-4-5": "deepseek-v4-pro",
  "claude-sonnet-4-5": "deepseek-v4-flash",
  "claude-haiku-4-5": "deepseek-v4-flash",
};

export function loadModelMap(rawValue = process.env.MODEL_MAP_JSON) {
  if (!rawValue) return { ...DEFAULT_MODEL_MAP };

  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch (error) {
    throw new Error(`Invalid MODEL_MAP_JSON: ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid MODEL_MAP_JSON: expected a JSON object.");
  }

  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.length > 32) {
    throw new Error("Invalid MODEL_MAP_JSON: expected between 1 and 32 mappings.");
  }

  const validatedEntries = [];
  for (const [alias, target] of entries) {
    if (
      !alias || alias.length > 128 || /[\x00-\x20]/.test(alias) ||
      typeof target !== "string" || !target || target.length > 128 || /[\x00-\x20]/.test(target)
    ) {
      throw new Error(`Invalid MODEL_MAP_JSON entry for alias: ${JSON.stringify(alias)}.`);
    }
    validatedEntries.push([alias, target]);
  }
  return Object.fromEntries(validatedEntries);
}

export const MODEL_MAP = Object.freeze(loadModelMap());

const ALIASES = Object.keys(MODEL_MAP);

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || "127.0.0.1";
const UPSTREAM_BASE = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/anthropic").replace(/\/+$/, "");
const API_KEY = process.env.DEEPSEEK_API_KEY || "";
const PROXY_API_KEY = process.env.PROXY_API_KEY || "";
const CORS_ORIGINS = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const LOG_FILE = process.env.LOG_FILE || "";
const LOG_MAX_BYTES = Number(process.env.LOG_MAX_BYTES || 1024 * 1024);
const LOG_BACKUPS = Number(process.env.LOG_BACKUPS || 3);
const LOG_COUNT_TOKENS = process.env.LOG_COUNT_TOKENS === "true";
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 120_000);
const TRANSFORM_RESPONSES = process.env.TRANSFORM_RESPONSES === "true";
const FILTER_THINKING_BLOCKS = process.env.FILTER_THINKING_BLOCKS === "true";
const FORCE_UPSTREAM_NON_STREAM = process.env.FORCE_UPSTREAM_NON_STREAM === "true";
const APP_VERSION = "1.6.14";
const PROCESS_STARTED_AT = Date.now();

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}
if (!Number.isFinite(MAX_BODY_BYTES) || MAX_BODY_BYTES <= 0) {
  throw new Error(`Invalid MAX_BODY_BYTES: ${process.env.MAX_BODY_BYTES}`);
}
if (!Number.isFinite(UPSTREAM_TIMEOUT_MS) || UPSTREAM_TIMEOUT_MS <= 0) {
  throw new Error(`Invalid UPSTREAM_TIMEOUT_MS: ${process.env.UPSTREAM_TIMEOUT_MS}`);
}
function isReadOnlyMethod(method) {
  return method === "GET" || method === "HEAD";
}

function originIsAllowed(origin) {
  return !origin || CORS_ORIGINS.includes("*") || CORS_ORIGINS.includes(origin);
}

function applyCorsHeaders(req, res) {
  const origin = headerValue(req.headers, "origin");
  if (!origin || !originIsAllowed(origin)) return;

  res.setHeader("access-control-allow-origin", CORS_ORIGINS.includes("*") ? "*" : origin);
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type,x-api-key,anthropic-version,anthropic-beta");
  if (!CORS_ORIGINS.includes("*")) res.setHeader("vary", "Origin");
}

let logFileBytes = (() => {
  if (!LOG_FILE) return 0;
  try {
    return fs.statSync(LOG_FILE).size;
  } catch {
    return 0;
  }
})();
let logWriteQueue = Promise.resolve();
let requestSequence = 0;

function createRequestId() {
  requestSequence = (requestSequence + 1) % 0x1000000;
  return `${Date.now().toString(36)}-${requestSequence.toString(36)}`;
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
    const entry = `${line}\n`;
    const entryBytes = Buffer.byteLength(entry);
    logWriteQueue = logWriteQueue
      .then(async () => {
        await rotateLogIfNeeded(entryBytes);
        await fs.promises.appendFile(LOG_FILE, entry);
        logFileBytes += entryBytes;
      })
      .catch((error) => {
        console.error(`${new Date().toISOString()} ERROR failed_to_write_log ${error.message}`);
      });
  }
}

async function flushLogs() {
  await logWriteQueue;
}

async function rotateLogIfNeeded(incomingBytes = 0) {
  if (!LOG_FILE || !Number.isFinite(LOG_MAX_BYTES) || LOG_MAX_BYTES <= 0) return;
  if (logFileBytes + incomingBytes <= LOG_MAX_BYTES) return;

  const backupCount = Number.isFinite(LOG_BACKUPS) && LOG_BACKUPS > 0 ? Math.floor(LOG_BACKUPS) : 0;
  if (backupCount === 0) {
    await fs.promises.writeFile(LOG_FILE, "");
    logFileBytes = 0;
    return;
  }

  const oldest = `${LOG_FILE}.${backupCount}`;
  await fs.promises.rm(oldest, { force: true });

  for (let index = backupCount - 1; index >= 1; index--) {
    const from = `${LOG_FILE}.${index}`;
    const to = `${LOG_FILE}.${index + 1}`;
    try {
      await fs.promises.rename(from, to);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  try {
    await fs.promises.rename(LOG_FILE, `${LOG_FILE}.1`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  logFileBytes = 0;
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
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function remoteAddress(req) {
  return req.socket?.remoteAddress || "";
}

class HttpError extends Error {
  constructor(statusCode, publicMessage) {
    super(publicMessage);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}

async function readBody(req) {
  const declaredLength = Number(headerValue(req.headers, "content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, `Request body exceeds the ${MAX_BODY_BYTES}-byte limit.`);
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new HttpError(413, `Request body exceeds the ${MAX_BODY_BYTES}-byte limit.`);
    }
    chunks.push(chunk);
  }
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
    res.writeHead(upstream.status, { ...responseHeaders, "content-length": String(body.length) });
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
  return {
    "content-type": contentType,
    "cache-control": "no-cache",
  };
}

function textFromMessagePayload(payload) {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

async function sendJsonAsSse(upstream, res, aliasModel, path, requestId) {
  const rawText = await upstream.text();
  let payload;

  try {
    payload = JSON.parse(rawText);
  } catch {
    res.writeHead(upstream.status, baseResponseHeaders("text/plain; charset=utf-8"));
    res.end(rawText);
    return upstream.status;
  }

  if (upstream.status >= 400) {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(upstream.status, {
      ...baseResponseHeaders("application/json; charset=utf-8"),
      "content-length": String(body.length),
    });
    res.end(body);
    return upstream.status;
  }

  const message = filterThinkingFromJson(payload, aliasModel);
  const unsupportedBlocks = (Array.isArray(message.content) ? message.content : [])
    .filter((block) => block?.type !== "text")
    .map((block) => block?.type || "unknown");
  if (unsupportedBlocks.length > 0) {
    logLine("ERROR", "synthetic_sse_unsupported_content", { request_id: requestId, path, content_types: unsupportedBlocks });
    sendJson(res, 502, {
      error: {
        type: "proxy_error",
        message: `Cannot safely convert non-stream content blocks to SSE: ${unsupportedBlocks.join(", ")}.`,
      },
    });
    return 502;
  }

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
  return 200;
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
  return credentialFromRequest(req) === PROXY_API_KEY;
}

function estimateTokensFromString(value) {
  const cjkPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
  const cjkCount = value.match(cjkPattern)?.length || 0;
  const remaining = value.replace(cjkPattern, "");
  return cjkCount + Math.ceil(remaining.length / 4);
}

function estimateTokensFromValue(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length === 0 ? 0 : Math.max(1, estimateTokensFromString(value));
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

  const estimated = Math.max(
    1,
    estimateTokensFromValue(json.system) +
      estimateTokensFromValue(json.messages) +
      estimateTokensFromValue(json.tools),
  );
  return sendJson(res, 200, { input_tokens: estimated });
}

async function handleProxy(req, res, context) {
  const startedAt = context.startedAt;
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  context.path = url.pathname;
  const origin = headerValue(req.headers, "origin");

  if (!originIsAllowed(origin)) {
    logLine("WARN", "origin_rejected", { method: req.method, path: url.pathname, origin, remote: remoteAddress(req) });
    return sendJson(res, 403, {
      error: {
        type: "permission_error",
        message: "This browser origin is not allowed to access the local proxy.",
      },
    });
  }

  applyCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
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

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    const rawBody = await readBody(req);
    if (LOG_COUNT_TOKENS) logLine("INFO", "count_tokens_local", { remote: remoteAddress(req) });
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

  const requestId = createRequestId();
  context.requestId = requestId;
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
  if (note) logLine("INFO", "model_rewrite", { request_id: requestId, rewrite: note });
  if (didForceNonStream) logLine("INFO", "force_upstream_non_stream", { request_id: requestId, path: url.pathname, model: aliasModel });

  const upstreamUrl = `${UPSTREAM_BASE}${url.pathname}${url.search}`;
  const abortController = new AbortController();
  let upstreamTimedOut = false;
  const timeout = setTimeout(() => {
    upstreamTimedOut = true;
    abortController.abort(new Error(`Upstream request timed out after ${UPSTREAM_TIMEOUT_MS} ms.`));
  }, UPSTREAM_TIMEOUT_MS);
  timeout.unref?.();

  const abortForClientDisconnect = () => {
    if (!res.writableEnded) {
      context.clientDisconnected = true;
      abortController.abort(new Error("Client disconnected."));
    }
  };
  req.once("aborted", abortForClientDisconnect);
  res.once("close", abortForClientDisconnect);

  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: buildHeaders(req),
      body: isReadOnlyMethod(req.method) ? undefined : body,
      signal: abortController.signal,
    });
    const ttfbMs = Date.now() - startedAt;
    context.ttfbMs = ttfbMs;

    if (upstream.status >= 400) {
      logLine("WARN", "upstream_error", { request_id: requestId, status: upstream.status, path: url.pathname, ttfb_ms: ttfbMs });
    } else {
      logLine("INFO", "upstream_response", { request_id: requestId, status: upstream.status, path: url.pathname, ttfb_ms: ttfbMs });
    }

    const logComplete = (status, extra = undefined) => {
      logLine("INFO", "request_complete", {
        request_id: requestId,
        status,
        path: url.pathname,
        ttfb_ms: ttfbMs,
        duration_ms: Date.now() - startedAt,
        ...extra,
      });
    };

    const responseHeaders = {};
    upstream.headers.forEach((value, key) => {
      if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });

    const contentType = upstream.headers.get("content-type") || "";
    const shouldTransformMessages = TRANSFORM_RESPONSES && url.pathname === "/v1/messages" && aliasModel;
    if (shouldTransformMessages && didForceNonStream && contentType.includes("application/json")) {
      const status = await sendJsonAsSse(upstream, res, aliasModel, url.pathname, requestId);
      logComplete(status, { synthetic_sse: true });
      return;
    }

    if (shouldTransformMessages && contentType.includes("text/event-stream") && upstream.body) {
      res.writeHead(upstream.status, baseResponseHeaders("text/event-stream; charset=utf-8"));
      const transformed = Readable.from(transformSseStream(upstream.body, aliasModel));
      try {
        await pipeline(transformed, res);
        logComplete(upstream.status, { transformed_sse: true });
      } catch (error) {
        logLine("ERROR", "sse_transform_error", { request_id: requestId, path: url.pathname, error: describeError(error) });
        throw error;
      }
      return;
    }

    if (shouldTransformMessages && contentType.includes("application/json")) {
      await sendTransformedJson(upstream, res, responseHeaders, aliasModel);
      logComplete(upstream.status, { transformed_json: true });
      return;
    }

    res.writeHead(upstream.status, responseHeaders);
    if (!upstream.body) {
      res.end();
      logComplete(upstream.status);
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body), res);
    logComplete(upstream.status);
  } catch (error) {
    if (upstreamTimedOut) {
      throw new HttpError(504, `Upstream request timed out after ${UPSTREAM_TIMEOUT_MS} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    req.off("aborted", abortForClientDisconnect);
    res.off("close", abortForClientDisconnect);
  }
}

export function handleRequest(req, res) {
  const context = {
    startedAt: Date.now(),
    requestId: "",
    path: "",
    ttfbMs: undefined,
    clientDisconnected: false,
  };
  handleProxy(req, res, context).catch((error) => {
    const details = {
      request_id: context.requestId || undefined,
      method: req.method,
      path: context.path,
      ttfb_ms: context.ttfbMs,
      duration_ms: Date.now() - context.startedAt,
      error: describeError(error),
    };
    if (context.clientDisconnected || req.aborted || res.destroyed) {
      logLine("WARN", "client_disconnected", details);
    } else {
      logLine("ERROR", "proxy_error", details);
    }
    if (!res.headersSent && !res.destroyed) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
      sendJson(res, statusCode, {
        error: {
          type: "proxy_error",
          message: error?.publicMessage || "The upstream provider could not be reached.",
        },
      });
    } else {
      res.end();
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!PROXY_API_KEY) {
    throw new Error("PROXY_API_KEY is required.");
  }
  const server = http.createServer(handleRequest);
  let shuttingDown = false;
  let shutdownTimer;

  const shutdown = (reason, exitCode = 0, details = {}) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const uptimeMs = Date.now() - PROCESS_STARTED_AT;
    logLine("INFO", "shutdown_requested", {
      version: APP_VERSION,
      pid: process.pid,
      reason,
      uptime_ms: uptimeMs,
      ...details,
    });

    shutdownTimer = setTimeout(async () => {
      logLine("WARN", "shutdown_forced", {
        version: APP_VERSION,
        pid: process.pid,
        reason,
        uptime_ms: Date.now() - PROCESS_STARTED_AT,
      });
      await flushLogs();
      process.exit(exitCode || 1);
    }, 2500);
    shutdownTimer.unref?.();

    server.close(async (error) => {
      clearTimeout(shutdownTimer);
      const finalExitCode = error ? 1 : exitCode;
      logLine(error ? "ERROR" : "INFO", "shutdown_complete", {
        version: APP_VERSION,
        pid: process.pid,
        reason,
        uptime_ms: Date.now() - PROCESS_STARTED_AT,
        exit_code: finalExitCode,
        ...(error ? { error: describeError(error) } : {}),
      });
      await flushLogs();
      process.exit(finalExitCode);
    });
  };

  process.once("SIGINT", () => shutdown("signal", 0, { signal: "SIGINT" }));
  process.once("SIGTERM", () => shutdown("signal", 0, { signal: "SIGTERM" }));

  if (!process.stdin.isTTY) {
    process.stdin.setEncoding("utf8");
    let commandBuffer = "";
    process.stdin.on("data", (chunk) => {
      commandBuffer += chunk;
      const lines = commandBuffer.split(/\r?\n/);
      commandBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const command = JSON.parse(line);
          if (command?.command === "shutdown") {
            const reason = typeof command.reason === "string" && command.reason
              ? command.reason.slice(0, 64)
              : "manager_request";
            shutdown(reason);
          }
        } catch (error) {
          logLine("WARN", "invalid_control_command", { error: describeError(error) });
        }
      }
    });
    process.stdin.resume();
  }

  server.once("error", async (error) => {
    logLine("ERROR", "server_error", {
      version: APP_VERSION,
      pid: process.pid,
      uptime_ms: Date.now() - PROCESS_STARTED_AT,
      error: describeError(error),
    });
    await flushLogs();
    if (!shuttingDown) process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    logLine("INFO", "startup", {
      version: APP_VERSION,
      pid: process.pid,
      node: process.version,
      host: HOST,
      port: PORT,
    });
    logLine("INFO", `listening http://${HOST}:${PORT}`);
    logLine("INFO", `upstream ${UPSTREAM_BASE}`);
    logLine("INFO", `aliases ${ALIASES.map((id) => `${id}=>${MODEL_MAP[id]}`).join(", ")}`);
    if (LOG_FILE) logLine("INFO", `log_file ${LOG_FILE}`);
    if (LOG_FILE) logLine("INFO", `log_rotation max_bytes=${LOG_MAX_BYTES} backups=${LOG_BACKUPS}`);
  });
}
