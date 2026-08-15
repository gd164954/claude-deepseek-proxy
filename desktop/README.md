# DeepSeek Proxy Manager

Native Windows WPF control panel for the local Claude-to-DeepSeek proxy.

## Build

No .NET SDK or NuGet packages are required. Windows 10/11 with .NET Framework 4.8 is sufficient.

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\build-gui.ps1
```

Output:

```text
dist\DeepSeekProxyManager\
  DeepSeekProxyManager.exe
  DeepSeekProxyManager.ico
  Launch-DeepSeekProxyManager.cmd
  DeepSeekProxyManager.ps1
  TrayMenuTheme.cs
  ManagerWindow.xaml
  GatewayKeyWindow.xaml
  LogWindow.xaml
  claude-deepseek-proxy.mjs
  node.exe
  NODE-LICENSE.txt (when supplied by the local Node.js installation)
```

The default build is portable: `node.exe` is copied into the output directory. Copy the **entire** `dist\DeepSeekProxyManager` folder to another 64-bit Windows 10/11 PC; Node.js does not need to be installed there. Only use `-SkipBundledNode` when the target PC already has Node.js 20 or newer:

```powershell
.\build-gui.ps1 -SkipBundledNode
```

On an unmanaged PC, double-click `DeepSeekProxyManager.exe`. On an enterprise-managed PC that blocks newly compiled unsigned executables, double-click `Launch-DeepSeekProxyManager.cmd`; it opens the same WPF interface through the Microsoft-signed Windows PowerShell host. Enter the DeepSeek API Key, edit either side of the two model mappings if needed, save the settings, and select **启动代理**. The main page keeps model editing in the configuration area and presents the full local endpoint plus the Gateway access-key entry in the unified run center. Use **管理** to change or regenerate the stable Gateway API key. Every local request must provide it as a Bearer token or `x-api-key`. Runtime logs open in their own window from the **运行日志** button and are not shown on the main screen.

The DeepSeek key and Gateway key are encrypted with Windows DPAPI for the current Windows account. They are not passed on the process command line. A stable random Gateway key is generated on first launch; it is separate from the DeepSeek key. The manager listens only on `127.0.0.1`, disables browser CORS by default, and never terminates a proxy process it did not start itself.

The Windows, header, tray, and Explorer icons all use `DeepSeekProxyManager.ico`. The icon is embedded in the EXE and also copied beside the launchers for the PowerShell-compatible interface.
