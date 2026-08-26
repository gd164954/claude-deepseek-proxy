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
  proxy.child.stdin.write(`${JSON.stringify({ command: "shutdown", reason })}\n`);
  await once(proxy.child, "exit");
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
  assert.match(proxy.getOutput(), /INFO request_complete \{"request_id":"[^"]+","status":200,"path":"\/v1\/messages","ttfb_ms":\d+,"duration_ms":\d+\}/);
  assert.match(proxy.getOutput(), /INFO startup \{"version":"1\.6\.11","pid":\d+,"node":"v[^\"]+","host":"127\.0\.0\.1","port":\d+\}/);

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

  await stopProxy(proxy, "test_complete");
  assert.match(proxy.getOutput(), /INFO shutdown_requested \{"version":"1\.6\.11","pid":\d+,"reason":"test_complete","uptime_ms":\d+\}/);
  assert.match(proxy.getOutput(), /INFO shutdown_complete \{"version":"1\.6\.11","pid":\d+,"reason":"test_complete","uptime_ms":\d+,"exit_code":0\}/);
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
