import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const csharpPath = new URL("../desktop/DeepSeekProxyManager.cs", import.meta.url);
const powershellPath = new URL("../desktop/DeepSeekProxyManager.ps1", import.meta.url);
const trayThemePath = new URL("../desktop/TrayMenuTheme.cs", import.meta.url);
const buildPath = new URL("../build-gui.ps1", import.meta.url);

test("persists a stable encrypted Gateway key in both GUI launchers", async () => {
  const [csharp, powershell] = await Promise.all([
    readFile(csharpPath, "utf8"),
    readFile(powershellPath, "utf8"),
  ]);

  assert.match(csharp, /GetValue\("ProxyApiKey", ""\)/);
  assert.match(csharp, /SetValue\("ProxyApiKey", ProtectSecret\(_gatewayApiKey\)/);
  assert.match(csharp, /EnvironmentVariables\["PROXY_API_KEY"\] = _gatewayApiKey/);
  assert.doesNotMatch(csharp, /ALLOW_LOCALHOST_NO_AUTH|AllowLocalhostNoAuth|allowLocalhostNoAuth/);

  assert.match(powershell, /-Name ProxyApiKey -Value \(Protect-Secret \$script:gatewayApiKey\)/);
  assert.match(powershell, /EnvironmentVariables\["PROXY_API_KEY"\] = \$script:gatewayApiKey/);
  assert.doesNotMatch(powershell, /ALLOW_LOCALHOST_NO_AUTH|AllowLocalhostNoAuth|allowLocalhostNoAuth/);
});

test("uses the shared light tray menu theme in both GUI launchers", async () => {
  const [csharp, powershell, trayTheme, build] = await Promise.all([
    readFile(csharpPath, "utf8"),
    readFile(powershellPath, "utf8"),
    readFile(trayThemePath, "utf8"),
    readFile(buildPath, "utf8"),
  ]);

  assert.match(csharp, /TrayMenuTheme\.CreateMenu\(\)/);
  assert.match(csharp, /if \(_trayMenu != null\) _trayMenu\.Dispose\(\)/);
  assert.match(powershell, /TrayMenuTheme\]::CreateMenu\(\)/);
  assert.match(powershell, /if \(\$menu\) \{ \$menu\.Dispose\(\) \}/);
  assert.match(trayTheme, /CreateRoundedPath\(bounds, 10\)/);
  assert.match(trayTheme, /Color\.FromArgb\(237, 243, 255\)/);
  assert.match(trayTheme, /new Font\("Microsoft YaHei UI", 9\.25f/);
  assert.match(trayTheme, /new FontFamily\("Segoe Fluent Icons"\)/);
  assert.match(trayTheme, /new FontFamily\("Segoe MDL2 Assets"\)/);
  assert.match(build, /\$trayThemeSourcePath/);
  assert.match(build, /Copy-Item -LiteralPath \$trayThemeSourcePath/);
});

test("authenticates GUI health checks with the Gateway key", async () => {
  const [csharp, powershell] = await Promise.all([
    readFile(csharpPath, "utf8"),
    readFile(powershellPath, "utf8"),
  ]);

  assert.match(csharp, /request\.Headers\[HttpRequestHeader\.Authorization\] = "Bearer " \+ gatewayKey/);
  assert.match(powershell, /\$request\.Headers\[\[Net\.HttpRequestHeader\]::Authorization\] = "Bearer \$gatewayKey"/);
});

test("ships the Gateway manager controls and its external XAML fallback", async () => {
  const [csharp, build] = await Promise.all([
    readFile(csharpPath, "utf8"),
    readFile(buildPath, "utf8"),
  ]);

  for (const name of [
    "GatewayKeySummaryText",
    "CopyGatewayKeyButton",
    "ManageGatewayKeyButton",
    "GatewayKeyBox",
    "GenerateGatewayKeyButton",
    "SaveGatewayKeyButton",
  ]) {
    assert.match(csharp, new RegExp(`x:Name=""${name}""`));
  }
  assert.match(csharp, /x:Key=""ButtonFocusVisual""/);
  assert.match(csharp, /AutomationProperties\.Name=""DeepSeek API Key""/);
  assert.match(csharp, /AutomationProperties\.Name=""Gateway 访问密钥""/);
  assert.match(
    csharp,
    /<Border Grid\.Row=""0"" Grid\.Column=""1"" Grid\.ColumnSpan=""3""[\s\S]*?x:Name=""EndpointText""/,
  );
  assert.match(csharp, /PanningMode=""VerticalOnly"" Margin=""0,4,0,4""/);
  assert.match(build, /GatewayKeyWindowXaml" -FileName "GatewayKeyWindow\.xaml"/);
});
