import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MODEL_MAP, loadModelMap, rewriteRequestBody } from "../claude-deepseek-proxy.mjs";

const proxyPath = fileURLToPath(new URL("../claude-deepseek-proxy.mjs", import.meta.url));

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function startProxy(t, environment) {
  const child = spawn(process.execPath, [proxyPath], {
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: "test-upstream-key",
      LOG_FILE: "",
      ...environment,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.stdin.write(`${JSON.stringify({ command: "shutdown", reason: "test_cleanup" })}\n`);
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (child.exitCode === null) child.kill();
  });

  const deadline = Date.now() + 5_000;
  while (!output.includes("INFO listening")) {
    if (child.exitCode !== null) throw new Error(`Proxy exited early (${child.exitCode}):\n${output}`);
    if (Date.now() > deadline) throw new Error(`Proxy did not start:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return {
    child,
    getOutput: () => output,
  };
}

async function waitForOutput(proxy, pattern, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!pattern.test(proxy.getOutput())) {
    if (proxy.child.exitCode !== null) throw new Error(`Proxy exited early:\n${proxy.getOutput()}`);
    if (Date.now() > deadline) throw new Error(`Expected proxy output ${pattern}:\n${proxy.getOutput()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function stopProxy(proxy, reason) {
  const closed = once(proxy.child, "close");
  proxy.child.stdin.write(`${JSON.stringify({ command: "shutdown", reason })}\n`);
  const [code, signal] = await closed;
  assert.equal(signal, null);
  assert.equal(code, 0, `Proxy shutdown failed:\n${proxy.getOutput()}`);
  assert.doesNotMatch(proxy.getOutput(), /Assertion failed|shutdown_forced/);
}

function logEvents(proxy, event) {
  return proxy.getOutput().split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\S+ (?:INFO|WARN|ERROR) (\S+) (\{.*\})$/);
    return match?.[1] === event ? [JSON.parse(match[2])] : [];
  });
}

test("rewrites Claude-facing model IDs without changing stream mode", () => {
  const input = Buffer.from(JSON.stringify({
    model: "claude-sonnet-4-5",
    stream: true,
    messages: [],
  }));
  const result = rewriteRequestBody(input, "application/json");
  const body = JSON.parse(result.buffer);

  assert.equal(body.model, MODEL_MAP["claude-sonnet-4-5"]);
  assert.equal(MODEL_MAP["claude-haiku-4-5"], "deepseek-v4-flash");
  assert.equal(body.stream, true);
  assert.equal(result.note, "claude-sonnet-4-5 -> deepseek-v4-flash");
});

test("loads and validates manual model mappings", () => {
  assert.deepEqual(loadModelMap(JSON.stringify({
    "claude-sonnet-4-5": "deepseek-chat",
    "claude-opus-4-5": "deepseek-reasoner",
    "claude-haiku-4-5": "deepseek-chat",
  })), {
    "claude-sonnet-4-5": "deepseek-chat",
    "claude-opus-4-5": "deepseek-reasoner",
    "claude-haiku-4-5": "deepseek-chat",
  });
  assert.throws(() => loadModelMap("not-json"), /Invalid MODEL_MAP_JSON/);
  assert.throws(() => loadModelMap('{"claude-sonnet-4-5":"bad model"}'), /Invalid MODEL_MAP_JSON/);
});

test("enforces local browser isolation, body limits, and upstream timeouts", async (t) => {
  let successfulUpstreamRequest;
  const upstream = http.createServer(async (req, res) => {
    if (req.url?.includes("success=1")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      successfulUpstreamRequest = {
        apiKey: req.headers["x-api-key"],
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        url: req.url,
      };
      const responseBody = JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "deepseek-v4-flash",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(responseBody),
      });
      res.end(responseBody);
    }
    // Other requests are deliberately left open so the proxy timeout is exercised.
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.closeAllConnections());
  t.after(() => upstream.close());

  const reservation = http.createServer();
  const proxyPort = await listen(reservation);
  await new Promise((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));

  const proxy = await startProxy(t, {
    PORT: String(proxyPort),
    HOST: "127.0.0.1",
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstreamPort}/anthropic`,
    PROXY_API_KEY: "test-proxy-key",
    CORS_ORIGIN: "",
    MAX_BODY_BYTES: "256",
    UPSTREAM_TIMEOUT_MS: "150",
    MODEL_MAP_JSON: JSON.stringify({
      "custom-opus-alias": "deepseek-reasoner",
      "custom-sonnet-alias": "deepseek-chat",
      "custom-haiku-alias": "deepseek-chat",
    }),
  });

  const baseUrl = `http://127.0.0.1:${proxyPort}`;

  const health = await fetch(`${baseUrl}/health`, {
    headers: { authorization: "Bearer test-proxy-key" },
  });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const models = await (await fetch(`${baseUrl}/v1/models`, {
    headers: { authorization: "Bearer test-proxy-key" },
  })).json();
  assert.deepEqual(models.data.map((model) => model.id).sort(), ["custom-haiku-alias", "custom-opus-alias", "custom-sonnet-alias"]);

  const crossOrigin = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-proxy-key",
      origin: "https://example.invalid",
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.get("access-control-allow-origin"), null);

  const tokenCount = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-proxy-key" },
    body: JSON.stringify({
      system: "\u4f60\u597d",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "lookup", description: "search records" }],
    }),
  });
  assert.equal(tokenCount.status, 200);
  assert.ok((await tokenCount.json()).input_tokens >= 8);

  const successful = await fetch(`${baseUrl}/v1/messages?success=1`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-proxy-key" },
    body: JSON.stringify({
      model: "custom-sonnet-alias",
      max_tokens: 1,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(successful.status, 200);
  assert.equal((await successful.json()).content[0].text, "ok");
  assert.equal(successfulUpstreamRequest.apiKey, "test-upstream-key");
  assert.equal(successfulUpstreamRequest.body.model, "deepseek-chat");
  assert.match(successfulUpstreamRequest.url, /success=1/);
  await waitForOutput(proxy, /INFO request_complete /);
  assert.match(proxy.getOutput(), /INFO upstream_response \{"request_id":"[^"]+","status":200,"path":"\/v1\/messages","ttfb_ms":\d+\}/);
  const completion = logEvents(proxy, "request_complete")[0];
  assert.equal(completion.status, 200);
  assert.ok(completion.duration_ms >= completion.ttfb_ms);
  assert.equal(completion.requested_model, "custom-sonnet-alias");
  assert.equal(completion.upstream_model, "deepseek-chat");
  assert.equal(completion.stream, false);
  assert.equal(completion.upstream_stream, false);
  assert.equal(logEvents(proxy, "request_start")[0].request_id, completion.request_id);
  assert.match(proxy.getOutput(), /INFO startup \{"version":"1\.7\.00","pid":\d+,"node":"v[^\"]+","host":"127\.0\.0\.1","port":\d+\}/);

  const tooLarge = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-proxy-key" },
    body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(300) }] }),
  });
  assert.equal(tooLarge.status, 413);

  const timedOut = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-proxy-key" },
    body: JSON.stringify({
      model: "custom-sonnet-alias",
      max_tokens: 1,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(timedOut.status, 504);
  assert.match((await timedOut.json()).error.message, /timed out/i);
  await waitForOutput(proxy, /ERROR proxy_error .*timed out/);
  const timeoutLog = logEvents(proxy, "proxy_error").find((entry) => /timed out/i.test(entry.error?.message));
  assert.ok(timeoutLog);
  assert.equal(timeoutLog.requested_model, "custom-sonnet-alias");
  assert.equal(timeoutLog.upstream_model, "deepseek-chat");
  assert.equal(timeoutLog.stream, false);

  await stopProxy(proxy, "test_complete");
  assert.match(proxy.getOutput(), /INFO shutdown_requested \{"version":"1\.7\.00","pid":\d+,"reason":"test_complete","uptime_ms":\d+\}/);
  assert.match(proxy.getOutput(), /INFO shutdown_complete \{"version":"1\.7\.00","pid":\d+,"reason":"test_complete","uptime_ms":\d+,"exit_code":0\}/);
});

test("exits cleanly immediately after short-lived upstream requests", { timeout: 15_000 }, async (t) => {
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* Drain the request body. */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }] }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const reservation = http.createServer();
  const proxyPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const proxy = await startProxy(t, {
    PORT: String(proxyPort), HOST: "127.0.0.1", PROXY_API_KEY: "test-proxy-key",
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    MODEL_MAP_JSON: "", FORCE_UPSTREAM_NON_STREAM: "false", TRANSFORM_RESPONSES: "false",
  });
  for (const model of Object.keys(MODEL_MAP)) {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer test-proxy-key", "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ model, stream: false, messages: [] }),
    });
    assert.equal(response.status, 200);
    await response.json();
  }
  // Do not delay shutdown: recent fetch work must be allowed to drain naturally.
  await stopProxy(proxy, "immediate_after_request");
  assert.equal(logEvents(proxy, "request_complete").length, 3);
  assert.equal(logEvents(proxy, "shutdown_complete")[0].exit_code, 0);
});

test("finishes an active stream before a graceful shutdown", { timeout: 15_000 }, async (t) => {
  let upstreamResponse;
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* Drain the request body. */ }
    upstreamResponse = res;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: ping\ndata: {"type":"ping"}\n\n');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const reservation = http.createServer();
  const proxyPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const proxy = await startProxy(t, {
    PORT: String(proxyPort), HOST: "127.0.0.1", PROXY_API_KEY: "test-proxy-key",
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    MODEL_MAP_JSON: "", FORCE_UPSTREAM_NON_STREAM: "false", TRANSFORM_RESPONSES: "false",
    UPSTREAM_TIMEOUT_MS: "5000",
  });
  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { authorization: "Bearer test-proxy-key", "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ model: "claude-sonnet-4-5", stream: true, messages: [] }),
  });
  assert.equal(response.status, 200);
  await Promise.all([
    stopProxy(proxy, "active_stream"),
    (async () => {
      await waitForOutput(proxy, /INFO shutdown_requested /);
      assert.equal(proxy.child.exitCode, null);
      upstreamResponse.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      assert.match(await response.text(), /event: message_stop/);
    })(),
  ]);
  assert.equal(logEvents(proxy, "request_complete")[0].status, 200);
  assert.equal(logEvents(proxy, "shutdown_complete")[0].exit_code, 0);
});

test("exits after a listener error even when the control pipe stays open", { timeout: 10_000 }, async (t) => {
  const occupied = http.createServer();
  const port = await listen(occupied);
  t.after(() => occupied.close());
  const child = spawn(process.execPath, [proxyPath], {
    windowsHide: true,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", PROXY_API_KEY: "test-proxy-key",
      DEEPSEEK_API_KEY: "test-upstream-key", MODEL_MAP_JSON: "", LOG_FILE: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const [code, signal] = await once(child, "close");
  assert.equal(code, 1);
  assert.equal(signal, null);
  assert.match(output, /ERROR server_error .*EADDRINUSE/);
  assert.doesNotMatch(output, /Assertion failed/);
});

for (const scenario of [
  { name: "mapped streaming requests", model: "custom-alias", target: "deepseek-chat", stream: true },
  { name: "unmapped passthrough models", model: "provider-direct-model", target: "provider-direct-model", stream: false },
  { name: "upstream HTTP errors", model: "custom-alias", target: "deepseek-chat", stream: false, status: 400 },
  { name: "forced non-stream upstream requests", model: "custom-alias", target: "deepseek-chat", stream: true, force: true },
  { name: "invalid model text redaction", model: "private-model-text\nprivate-body", target: "private-model-text\nprivate-body", stream: false, redact: true },
  { name: "oversized model redaction", model: "x".repeat(129), target: "x".repeat(129), stream: false, redact: true },
  { name: "known credential redaction", model: "upstream-secret-test-value", target: "upstream-secret-test-value", stream: true, force: true, redact: true },
]) {
  test(`logs metadata without body content for ${scenario.name}`, async (t) => {
    let received;
    const upstream = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const payload = {
        id: "msg_metadata", type: "message", role: "assistant", model: scenario.target,
        content: [{ type: "text", text: "private-response-content" }],
        stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (received.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: payload })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`);
      } else {
        res.writeHead(scenario.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      }
    });
    const upstreamPort = await listen(upstream);
    t.after(() => { upstream.closeAllConnections(); upstream.close(); });
    const reservation = http.createServer();
    const proxyPort = await listen(reservation);
    await new Promise((resolve) => reservation.close(resolve));
    const proxy = await startProxy(t, {
      PORT: String(proxyPort), HOST: "127.0.0.1",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstreamPort}/anthropic`,
      DEEPSEEK_API_KEY: "upstream-secret-test-value", PROXY_API_KEY: "gateway-secret-test-value",
      MODEL_MAP_JSON: JSON.stringify({ "custom-alias": "deepseek-chat" }),
      FORCE_UPSTREAM_NON_STREAM: String(Boolean(scenario.force)),
      TRANSFORM_RESPONSES: String(Boolean(scenario.force)),
      UPSTREAM_TIMEOUT_MS: "2000", MAX_BODY_BYTES: "4096",
    });
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer gateway-secret-test-value" },
      body: JSON.stringify({ model: scenario.model, stream: scenario.stream, max_tokens: 1,
        system: "private-system-text", messages: [{ role: "user", content: "private-user-text" }] }),
    });
    assert.equal(response.status, scenario.status ?? 200);
    await response.text();
    await waitForOutput(proxy, /INFO request_complete /);
    assert.equal(received.model, scenario.target);
    assert.equal(received.stream, scenario.stream && !scenario.force);
    const start = logEvents(proxy, "request_start")[0];
    const complete = logEvents(proxy, "request_complete")[0];
    assert.equal(logEvents(proxy, "request_start").length, 1);
    assert.equal(logEvents(proxy, "request_complete").length, 1);
    assert.equal(start.request_id, complete.request_id);
    for (const event of [start, complete]) {
      assert.equal(event.requested_model, scenario.redact ? "[redacted]" : scenario.model);
      assert.equal(event.upstream_model, scenario.redact ? "[redacted]" : scenario.target);
      assert.equal(event.stream, scenario.stream);
      assert.equal(event.upstream_stream, scenario.stream && !scenario.force);
    }
    assert.equal(complete.status, scenario.status ?? 200);
    for (const forbidden of ["private-system-text", "private-user-text", "private-response-content",
      "upstream-secret-test-value", "gateway-secret-test-value", ...(scenario.redact ? [scenario.model] : [])]) {
      assert.ok(!proxy.getOutput().includes(forbidden), `must not log ${forbidden}`);
    }
  });
}

test("retains request metadata when a streaming client disconnects", async (t) => {
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* Drain the small request body. */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: ping\ndata: {"type":"ping"}\n\n');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const reservation = http.createServer();
  const proxyPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const proxy = await startProxy(t, {
    PORT: String(proxyPort), HOST: "127.0.0.1", PROXY_API_KEY: "test-proxy-key",
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstreamPort}/anthropic`,
    MODEL_MAP_JSON: JSON.stringify({ "custom-alias": "deepseek-chat" }),
    TRANSFORM_RESPONSES: "false", FORCE_UPSTREAM_NON_STREAM: "false", UPSTREAM_TIMEOUT_MS: "5000",
  });
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST", signal: controller.signal,
    headers: { "content-type": "application/json", authorization: "Bearer test-proxy-key" },
    body: JSON.stringify({ model: "custom-alias", stream: true, messages: [] }),
  });
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await waitForOutput(proxy, /WARN client_disconnected /);
  const entry = logEvents(proxy, "client_disconnected")[0];
  assert.equal(entry.requested_model, "custom-alias");
  assert.equal(entry.upstream_model, "deepseek-chat");
  assert.equal(entry.stream, true);
  assert.equal(entry.upstream_stream, true);
  assert.equal(entry.request_id, logEvents(proxy, "request_start")[0].request_id);
  assert.equal(logEvents(proxy, "request_complete").length, 0);
});

test("requires Gateway authentication for localhost health and model endpoints", async (t) => {
  const reservation = http.createServer();
  const proxyPort = await listen(reservation);
  await new Promise((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));

  await startProxy(t, {
    PORT: String(proxyPort),
    HOST: "127.0.0.1",
    DEEPSEEK_BASE_URL: "http://127.0.0.1:1/anthropic",
    PROXY_API_KEY: "test-proxy-key",
    CORS_ORIGIN: "",
  });

  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  assert.equal((await fetch(`${baseUrl}/health`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/v1/models`)).status, 401);

  const authorized = await fetch(`${baseUrl}/health`, {
    headers: { authorization: "Bearer test-proxy-key" },
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { ok: true });
});
