import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const csharpPath = new URL("../desktop/DeepSeekProxyManager.cs", import.meta.url);
const powershellPath = new URL("../desktop/DeepSeekProxyManager.ps1", import.meta.url);
const trayThemePath = new URL("../desktop/TrayMenuTheme.cs", import.meta.url);
const buildPath = new URL("../build-gui.ps1", import.meta.url);
const nodeLicensePath = new URL("../third_party/NODE-LICENSE.txt", import.meta.url);
const startProxyPath = new URL("../start-proxy.ps1", import.meta.url);

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

test("ships the Node.js license with portable builds", async () => {
  const [build, nodeLicense] = await Promise.all([
    readFile(buildPath, "utf8"),
    readFile(nodeLicensePath, "utf8"),
  ]);

  assert.match(build, /third_party\\NODE-LICENSE\.txt/);
  assert.match(build, /throw "No Node\.js license notice was found/);
  assert.match(nodeLicense, /Node\.js is licensed for use as follows:/);
});

test("authenticates GUI health checks with the Gateway key", async () => {
  const [csharp, powershell] = await Promise.all([
    readFile(csharpPath, "utf8"),
    readFile(powershellPath, "utf8"),
  ]);

  assert.match(csharp, /request\.Headers\[HttpRequestHeader\.Authorization\] = "Bearer " \+ gatewayKey/);
  assert.match(csharp, /IsProxyModelsAvailableAsync\(\)/);
  assert.match(csharp, /\/v1\/models/);
  assert.match(powershell, /\$request\.Headers\[\[Net\.HttpRequestHeader\]::Authorization\] = "Bearer \$gatewayKey"/);
  assert.match(powershell, /function Test-ProxyModels/);
  assert.match(powershell, /\/v1\/models/);
});

test("reduces long-running GUI rendering and polling work", async () => {
  const [csharp, powershell] = await Promise.all([
    readFile(csharpPath, "utf8"),
    readFile(powershellPath, "utf8"),
  ]);

  assert.match(csharp, /AssemblyVersion\("1\.7\.0\.0"\)/);
  assert.match(csharp, /AssemblyFileVersion\("1\.7\.0\.0"\)/);
  assert.match(csharp, /AssemblyInformationalVersion\("1\.7\.00"\)/);
  assert.match(csharp, /RenderOptions\.ProcessRenderMode = RenderMode\.SoftwareOnly/);
  assert.match(csharp, /foreground \? 10 : 45/);
  assert.match(csharp, /_lastStatusKind == kind/);
  assert.match(csharp, /_logTimer\.Stop\(\)/);
  assert.doesNotMatch(csharp, /<DropShadowEffect/);
  assert.doesNotMatch(csharp, /Property=""Effect""/);

  assert.match(powershell, /if \(\$signature -eq \$script:lastStatusSignature\) \{ return \}/);
  assert.match(powershell, /RenderOptions\]::ProcessRenderMode = \[Windows\.Interop\.RenderMode\]::SoftwareOnly/);
  assert.match(powershell, /if \(\$foreground\) \{ 10 \} else \{ 45 \}/);
  assert.match(powershell, /\$logTimer\.Stop\(\)/);
});

test("closes health probes and records deliberate proxy shutdowns", async () => {
  const [csharp, powershell] = await Promise.all([
    readFile(csharpPath, "utf8"),
    readFile(powershellPath, "utf8"),
  ]);

  assert.match(csharp, /request\.KeepAlive = false/);
  assert.match(csharp, /RedirectStandardInput = true/);
  assert.match(csharp, /TryRequestGracefulShutdown\(process, reason\)/);
  assert.match(csharp, /StopOwnedProxy\("manager_exit"\)/);
  assert.match(csharp, /StopOwnedProxy\("restart"\)/);

  assert.match(powershell, /\$request\.KeepAlive = \$false/);
  assert.match(powershell, /\$info\.RedirectStandardInput = \$true/);
  assert.match(powershell, /command = "shutdown"; reason = \$Reason/);
  assert.match(powershell, /Stop-Proxy -Reason "manager_exit"/);
  assert.match(powershell, /Stop-Proxy -Reason "restart"/);
});

test("supports three editable and persistent model mappings", async () => {
  const [csharp, powershell, startProxy] = await Promise.all([
    readFile(csharpPath, "utf8"),
    readFile(powershellPath, "utf8"),
    readFile(startProxyPath, "utf8"),
  ]);

  for (const source of [csharp, powershell]) {
    assert.match(source, /HaikuAliasModel/);
    assert.match(source, /HaikuTargetModel/);
    assert.match(source, /claude-haiku-4-5/);
    assert.match(source, /deepseek-v4-flash/);
  }
  assert.match(csharp, /x:Name=""HaikuAliasBox""/);
  assert.match(csharp, /x:Name=""HaikuTargetBox""/);
  assert.match(csharp, /三条映射的 Claude 模型 ID 不能重复/);
  assert.match(powershell, /\$modelMap\[\$models\.HaikuAlias\] = \$models\.HaikuTarget/);
  assert.match(startProxy, /\[string\]\$HaikuAliasModel = "claude-haiku-4-5"/);
  assert.match(startProxy, /\$modelMap\[\$HaikuAliasModel\] = \$HaikuTargetModel/);
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
  assert.match(
    csharp,
    /Text=""运行保障""[\s\S]*?Margin=""0,7,0,0""[\s\S]*?Height=""24""[\s\S]*?Height=""1""[\s\S]*?Height=""24""[\s\S]*?Height=""1""[\s\S]*?Height=""24""/,
  );
  assert.match(build, /GatewayKeyWindowXaml" -FileName "GatewayKeyWindow\.xaml"/);
});

test("uses one deliberate typography scale across the main window", async () => {
  const csharp = await readFile(csharpPath, "utf8");
  const windowXamlMatch = csharp.match(
    /private const string WindowXaml = @"([\s\S]*?)";\s*private const string GatewayKeyWindowXaml/,
  );

  assert.ok(windowXamlMatch, "main window XAML should be embedded in the manager");
  const windowXaml = windowXamlMatch[1];

  assert.match(windowXaml, /TextElement\.FontFamily=""Microsoft YaHei UI"" TextElement\.FontSize=""13""/);
  for (const [styleName, fontSize] of [
    ["DisplayText", "22"],
    ["HeroText", "20"],
    ["SectionTitleText", "16"],
    ["SubsectionTitleText", "14"],
    ["SecondaryText", "12"],
    ["CaptionText", "11"],
  ]) {
    assert.match(
      windowXaml,
      new RegExp(`x:Key=""${styleName}""[\\s\\S]*?FontSize"" Value=""${fontSize}""`),
    );
  }
  assert.match(windowXaml, /x:Key=""TechnicalInput""[\s\S]*?FontFamily"" Value=""Consolas""[\s\S]*?FontSize"" Value=""12""/);
  assert.match(windowXaml, /x:Key=""MonoValueText""[\s\S]*?FontFamily"" Value=""Consolas""[\s\S]*?FontSize"" Value=""13""/);
  assert.doesNotMatch(windowXaml, /FontSize=""\d+\.\d+""/);
});
