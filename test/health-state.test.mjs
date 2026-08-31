import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runFile = promisify(execFile);

test("resets health failure counters on lifecycle changes in both launchers", async () => {
  const cs = await readFile(new URL("../desktop/DeepSeekProxyManager.cs", import.meta.url), "utf8");
  const ps = await readFile(new URL("../desktop/DeepSeekProxyManager.ps1", import.meta.url), "utf8");
  for (const method of ["StartProxyAsync", "StopOwnedProxy", "OnProxyExited", "ReleaseExitedProxyProcess", "TestConnectionAsync"]) {
    const methodStart = cs.search(new RegExp(`private (?:async )?[^\\n]+ ${method}\\(`));
    assert.ok(methodStart >= 0, `missing C# method ${method}`);
    const methodEnd = cs.indexOf("\n        private ", methodStart + 1);
    assert.match(cs.slice(methodStart, methodEnd < 0 ? undefined : methodEnd), /_consecutiveHealthFailures = 0;/);
  }
  for (const method of ["Start-Proxy", "Stop-Proxy"]) {
    const methodStart = ps.indexOf(`function ${method}`);
    assert.ok(methodStart >= 0, `missing PowerShell function ${method}`);
    const methodEnd = ps.indexOf("\nfunction ", methodStart + 1);
    assert.match(ps.slice(methodStart, methodEnd < 0 ? undefined : methodEnd), /\$script:consecutiveHealthFailures = 0/);
  }
  assert.match(cs, /_stopButton\.IsEnabled = running && owned/);
  assert.match(cs, /_restartButton\.IsEnabled = running && owned/);
  assert.match(ps, /\$stopButton\.IsEnabled = \$Running -and \$Owned/);
  assert.match(ps, /\$restartButton\.IsEnabled = \$Running -and \$Owned/);
  assert.match(ps, /\$testButton\.add_Click\(\{\s+\$healthy = Test-ProxyHealth\s+if \(\$healthy\) \{ \$script:consecutiveHealthFailures = 0 \}/);
  assert.doesNotMatch(cs, /ShowTransientStatus\("代理已经运行"/);
});

test("both launcher health methods debounce failures and recover without stale probes", {
  skip: process.platform !== "win32" ? "requires Windows PowerShell and the .NET Framework compiler" : false,
}, async () => {
  const script = fileURLToPath(new URL("./health-state-checks.ps1", import.meta.url));
  const { stdout, stderr } = await runFile("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(stderr.trim(), "");
  const result = JSON.parse(stdout.trim());
  assert.ok(result.csharpAssertions >= 15);
  assert.ok(result.powershellAssertions >= 10);
});
