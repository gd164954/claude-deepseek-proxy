param([switch]$AutoStart)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Security
[Windows.Media.RenderOptions]::ProcessRenderMode = [Windows.Interop.RenderMode]::SoftwareOnly

$trayThemePath = Join-Path $PSScriptRoot "TrayMenuTheme.cs"
if (-not ("ClaudeDeepSeekProxyManager.TrayMenuTheme" -as [type])) {
  if (-not (Test-Path -LiteralPath $trayThemePath -PathType Leaf)) {
    throw "找不到托盘菜单主题：$trayThemePath"
  }
  Add-Type -LiteralPath $trayThemePath -ReferencedAssemblies System.Windows.Forms, System.Drawing
}

$createdNew = $false
$singleInstance = New-Object Threading.Mutex($true, "Local\ClaudeDeepSeekProxyManager.PowerShell.Singleton", [ref]$createdNew)
if (-not $createdNew) {
  [Windows.MessageBox]::Show("DeepSeek 代理管理器已经在运行。请检查系统托盘。", "DeepSeek 代理管理器") | Out-Null
  exit
}

$script:appDirectory = $PSScriptRoot
$script:proxyScript = Join-Path $script:appDirectory "claude-deepseek-proxy.mjs"
$script:logPath = Join-Path $script:appDirectory "proxy.log"
$script:settingsPath = "HKCU:\Software\ClaudeDeepSeekProxyManager"
$script:runPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$script:runValueName = "ClaudeDeepSeekProxyManager"
$script:ownedProcess = $null
$script:externalProxy = $false
$script:exiting = $false
$script:lastLogText = ""
$script:nodePath = ""
$script:nodeVersion = ""
$script:applicationIcon = $null
$script:logWindow = $null
$script:logBox = $null
$script:gatewayApiKey = ""
$script:lastStatusSignature = ""
$script:lastButtonSignature = ""

$xamlPath = Join-Path $script:appDirectory "ManagerWindow.xaml"
$gatewayKeyXamlPath = Join-Path $script:appDirectory "GatewayKeyWindow.xaml"
if (-not (Test-Path -LiteralPath $xamlPath -PathType Leaf)) {
  [Windows.MessageBox]::Show("找不到界面资源：`n$xamlPath", "启动失败", "OK", "Error") | Out-Null
  exit 1
}

$viewRoot = [Windows.Markup.XamlReader]::Parse((Get-Content -LiteralPath $xamlPath -Raw))
$window = New-Object Windows.Window
$window.Title = "DeepSeek Claude Proxy"
$workArea = [Windows.SystemParameters]::WorkArea
$window.MinWidth = [Math]::Min(1000, $workArea.Width)
$window.MinHeight = [Math]::Min(680, $workArea.Height)
$window.Width = [Math]::Min(1120, [Math]::Max($window.MinWidth, $workArea.Width - 48))
$window.Height = [Math]::Min(728, [Math]::Max($window.MinHeight, $workArea.Height))
$window.WindowStartupLocation = "CenterScreen"
$window.Background = [Windows.Media.BrushConverter]::new().ConvertFromString("#F6F8FC")
$window.FontFamily = New-Object Windows.Media.FontFamily("Microsoft YaHei UI")
$window.FontSize = 13
$window.Content = $viewRoot

$apiKeyBox = $viewRoot.FindName("ApiKeyBox")
$portBox = $viewRoot.FindName("PortBox")
$sonnetAliasBox = $viewRoot.FindName("SonnetAliasBox")
$sonnetTargetBox = $viewRoot.FindName("SonnetTargetBox")
$opusAliasBox = $viewRoot.FindName("OpusAliasBox")
$opusTargetBox = $viewRoot.FindName("OpusTargetBox")
$headerIcon = $viewRoot.FindName("HeaderIcon")
$statusText = $viewRoot.FindName("StatusText")
$statusDetail = $viewRoot.FindName("StatusDetail")
$proxyStateTitle = $viewRoot.FindName("ProxyStateTitle")
$statusDot = $viewRoot.FindName("StatusDot")
$centerStatusDot = $viewRoot.FindName("CenterStatusDot")
$nodeText = $viewRoot.FindName("NodeText")
$endpointText = $viewRoot.FindName("EndpointText")
$gatewayKeySummaryText = $viewRoot.FindName("GatewayKeySummaryText")
$startButton = $viewRoot.FindName("StartButton")
$stopButton = $viewRoot.FindName("StopButton")
$restartButton = $viewRoot.FindName("RestartButton")
$testButton = $viewRoot.FindName("TestButton")
$openLogButton = $viewRoot.FindName("OpenLogButton")
$copyEndpointButton = $viewRoot.FindName("CopyEndpointButton")
$copyGatewayKeyButton = $viewRoot.FindName("CopyGatewayKeyButton")
$manageGatewayKeyButton = $viewRoot.FindName("ManageGatewayKeyButton")
$saveKeyButton = $viewRoot.FindName("SaveKeyButton")
$openFolderButton = $viewRoot.FindName("OpenFolderButton")
$autoStartCheck = $viewRoot.FindName("AutoStartCheck")
$minimizeCheck = $viewRoot.FindName("MinimizeToTrayCheck")

$iconPath = Join-Path $script:appDirectory "DeepSeekProxyManager.ico"
if (Test-Path -LiteralPath $iconPath -PathType Leaf) {
  try {
    $windowIcon = [Windows.Media.Imaging.BitmapFrame]::Create([Uri]$iconPath)
    $window.Icon = $windowIcon
    $iconStream = [IO.File]::OpenRead($iconPath)
    try {
      $decoder = [Windows.Media.Imaging.BitmapDecoder]::Create(
        $iconStream,
        [Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat,
        [Windows.Media.Imaging.BitmapCacheOption]::OnLoad
      )
      $headerFrame = $decoder.Frames | Sort-Object { [Math]::Abs($_.PixelWidth - 48) } | Select-Object -First 1
      $headerIcon.Source = if ($headerFrame) { $headerFrame } else { $windowIcon }
    } finally {
      $iconStream.Dispose()
    }
  } catch { }
}

function Set-Status {
  param([ValidateSet("Stopped", "Starting", "Success", "Error")][string]$Kind, [string]$Title, [string]$Detail)
  $signature = "$Kind`0$Title`0$Detail"
  if ($signature -eq $script:lastStatusSignature) { return }
  $script:lastStatusSignature = $signature
  $statusText.Text = $Title
  $statusDetail.Text = $Detail
  $proxyStateTitle.Text = $Title
  $colors = @{ Stopped = "#97A2B2"; Starting = "#EEA437"; Success = "#1FAA68"; Error = "#E14B4B" }
  $statusBrush = [Windows.Media.BrushConverter]::new().ConvertFromString($colors[$Kind])
  $statusDot.Fill = $statusBrush
  $centerStatusDot.Fill = $statusBrush
  if ($script:tray) {
    $trayText = "DeepSeek 代理 - $Title"
    $trayText = $trayText.Substring(0, [Math]::Min(63, $trayText.Length))
    if ($script:tray.Text -ne $trayText) { $script:tray.Text = $trayText }
  }
}

function Update-PollingCadence {
  if (-not $healthTimer) { return }
  $foreground = $window.IsVisible -and $window.WindowState -ne [Windows.WindowState]::Minimized
  $healthTimer.Interval = [TimeSpan]::FromSeconds($(if ($foreground) { 10 } else { 45 }))
}

function Get-ConfiguredPort {
  $port = 0
  if (-not [int]::TryParse($portBox.Text, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { return $null }
  return $port
}

function Update-ConfigurationPreview {
  $port = Get-ConfiguredPort
  $endpoint = if ($port) { "http://127.0.0.1:$port" } else { "http://127.0.0.1:<端口>" }
  $endpointText.Text = $endpoint
}

function Get-ModelMapping {
  $pattern = '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  $sonnetAlias = $sonnetAliasBox.Text.Trim()
  $sonnetTarget = $sonnetTargetBox.Text.Trim()
  $opusAlias = $opusAliasBox.Text.Trim()
  $opusTarget = $opusTargetBox.Text.Trim()
  if ($sonnetAlias -notmatch $pattern) {
    [Windows.MessageBox]::Show("Sonnet 的 Claude 模型 ID 无效。只能使用字母、数字、点、下划线、冒号、斜杠和连字符。", "模型映射无效", "OK", "Warning") | Out-Null
    $sonnetAliasBox.Focus() | Out-Null
    return $null
  }
  if ($sonnetTarget -notmatch $pattern) {
    [Windows.MessageBox]::Show("Sonnet 的 DeepSeek 模型 ID 无效。只能使用字母、数字、点、下划线、冒号、斜杠和连字符。", "模型映射无效", "OK", "Warning") | Out-Null
    $sonnetTargetBox.Focus() | Out-Null
    return $null
  }
  if ($opusAlias -notmatch $pattern) {
    [Windows.MessageBox]::Show("Opus 的 Claude 模型 ID 无效。只能使用字母、数字、点、下划线、冒号、斜杠和连字符。", "模型映射无效", "OK", "Warning") | Out-Null
    $opusAliasBox.Focus() | Out-Null
    return $null
  }
  if ($opusTarget -notmatch $pattern) {
    [Windows.MessageBox]::Show("Opus 的 DeepSeek 模型 ID 无效。只能使用字母、数字、点、下划线、冒号、斜杠和连字符。", "模型映射无效", "OK", "Warning") | Out-Null
    $opusTargetBox.Focus() | Out-Null
    return $null
  }
  if ($sonnetAlias -ieq $opusAlias) {
    [Windows.MessageBox]::Show("两条映射的 Claude 模型 ID 不能相同。", "模型映射无效", "OK", "Warning") | Out-Null
    $opusAliasBox.Focus() | Out-Null
    return $null
  }
  return @{ SonnetAlias = $sonnetAlias; SonnetTarget = $sonnetTarget; OpusAlias = $opusAlias; OpusTarget = $opusTarget }
}

function Test-ProxyHealth {
  $port = Get-ConfiguredPort
  if (-not $port) { return $false }
  $gatewayKey = $script:gatewayApiKey
  if ([string]::IsNullOrWhiteSpace($gatewayKey)) { return $false }
  try {
    $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$port/health")
    $request.Method = "GET"
    $request.Timeout = 500
    $request.ReadWriteTimeout = 500
    $request.Proxy = $null
    $request.KeepAlive = $false
    $request.Headers[[Net.HttpRequestHeader]::Authorization] = "Bearer $gatewayKey"
    $response = $request.GetResponse()
    try {
      $reader = New-Object IO.StreamReader($response.GetResponseStream())
      try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
      return $response.StatusCode -eq [Net.HttpStatusCode]::OK -and $body -match '"ok"\s*:\s*true'
    } finally { $response.Dispose() }
  } catch { return $false }
}

function Test-ProxyModels {
  $port = Get-ConfiguredPort
  if (-not $port) { return $false }
  $gatewayKey = $script:gatewayApiKey
  if ([string]::IsNullOrWhiteSpace($gatewayKey)) { return $false }
  try {
    $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$port/v1/models")
    $request.Method = "GET"
    $request.Timeout = 1500
    $request.ReadWriteTimeout = 1500
    $request.Proxy = $null
    $request.KeepAlive = $false
    $request.Headers[[Net.HttpRequestHeader]::Authorization] = "Bearer $gatewayKey"
    $response = $request.GetResponse()
    try {
      $reader = New-Object IO.StreamReader($response.GetResponseStream())
      try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
      return $response.StatusCode -eq [Net.HttpStatusCode]::OK -and $body -match '"data"\s*:\s*\[\s*\{'
    } finally { $response.Dispose() }
  } catch { return $false }
}

function Find-NodeExecutable {
  $candidates = @(
    (Join-Path $script:appDirectory "node.exe"),
    (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin\node.exe"),
    (Join-Path $env:ProgramFiles "nodejs\node.exe"),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe" })
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
  }
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

function Protect-Secret([string]$Value) {
  $plain = [Text.Encoding]::UTF8.GetBytes($Value)
  try {
    $encrypted = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [Convert]::ToBase64String($encrypted)
  } finally { [Array]::Clear($plain, 0, $plain.Length) }
}

function Unprotect-Secret([string]$Value) {
  $encrypted = [Convert]::FromBase64String($Value)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  try { return [Text.Encoding]::UTF8.GetString($plain) } finally { [Array]::Clear($plain, 0, $plain.Length) }
}

function New-GatewayApiKey {
  $random = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($random) } finally { $generator.Dispose() }
  return [Convert]::ToBase64String($random)
}

function Update-GatewayKeySummary {
  if (-not $gatewayKeySummaryText) { return }
  $gatewayKeySummaryText.Text = "已安全配置 · 请求必须携带密钥"
  $gatewayKeySummaryText.Foreground = [Windows.Media.BrushConverter]::new().ConvertFromString("#1F8A5E")
}

function Save-GatewaySecuritySettings {
  New-Item -Path $script:settingsPath -Force | Out-Null
  New-ItemProperty -Path $script:settingsPath -Name ProxyApiKey -Value (Protect-Secret $script:gatewayApiKey) -PropertyType String -Force | Out-Null
  Update-GatewayKeySummary
}

function Save-Settings([bool]$IncludeKey) {
  $port = Get-ConfiguredPort
  if (-not $port) {
    [Windows.MessageBox]::Show("端口必须是 1 到 65535 之间的整数。", "端口无效", "OK", "Warning") | Out-Null
    return $false
  }
  $models = Get-ModelMapping
  if (-not $models) { return $false }
  New-Item -Path $script:settingsPath -Force | Out-Null
  New-ItemProperty -Path $script:settingsPath -Name Port -Value $port -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $script:settingsPath -Name SonnetAliasModel -Value $models.SonnetAlias -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $script:settingsPath -Name SonnetTargetModel -Value $models.SonnetTarget -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $script:settingsPath -Name OpusAliasModel -Value $models.OpusAlias -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $script:settingsPath -Name OpusTargetModel -Value $models.OpusTarget -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $script:settingsPath -Name MinimizeToTray -Value ([int]($minimizeCheck.IsChecked -eq $true)) -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $script:settingsPath -Name AutoStart -Value ([int]($autoStartCheck.IsChecked -eq $true)) -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $script:settingsPath -Name ProxyApiKey -Value (Protect-Secret $script:gatewayApiKey) -PropertyType String -Force | Out-Null
  if ($IncludeKey -and $apiKeyBox.Password) {
    New-ItemProperty -Path $script:settingsPath -Name ApiKey -Value (Protect-Secret $apiKeyBox.Password) -PropertyType String -Force | Out-Null
  }
  return $true
}

function Load-Settings {
  $settings = Get-ItemProperty -LiteralPath $script:settingsPath -ErrorAction SilentlyContinue
  $portBox.Text = if ($settings.Port) { [string]$settings.Port } else { "3210" }
  $sonnetAliasBox.Text = if ($settings.SonnetAliasModel) { [string]$settings.SonnetAliasModel } else { "claude-sonnet-4-5" }
  $sonnetTargetBox.Text = if ($settings.SonnetTargetModel) { [string]$settings.SonnetTargetModel } else { "deepseek-v4-flash" }
  $opusAliasBox.Text = if ($settings.OpusAliasModel) { [string]$settings.OpusAliasModel } else { "claude-opus-4-5" }
  $opusTargetBox.Text = if ($settings.OpusTargetModel) { [string]$settings.OpusTargetModel } else { "deepseek-v4-pro" }
  $minimizeCheck.IsChecked = if ($null -ne $settings.MinimizeToTray) { [bool]$settings.MinimizeToTray } else { $true }
  $autoStartCheck.IsChecked = [bool]$settings.AutoStart
  if ($settings.ApiKey) {
    try { $apiKeyBox.Password = Unprotect-Secret $settings.ApiKey } catch { $apiKeyBox.Password = "" }
  }
  if ($settings.ProxyApiKey) {
    try { $script:gatewayApiKey = Unprotect-Secret $settings.ProxyApiKey } catch { $script:gatewayApiKey = "" }
  }
  if ([string]::IsNullOrWhiteSpace($script:gatewayApiKey)) {
    $script:gatewayApiKey = New-GatewayApiKey
    New-Item -Path $script:settingsPath -Force | Out-Null
    New-ItemProperty -Path $script:settingsPath -Name ProxyApiKey -Value (Protect-Secret $script:gatewayApiKey) -PropertyType String -Force | Out-Null
  }
  Update-GatewayKeySummary
}

function Copy-GatewayKey {
  try {
    [Windows.Clipboard]::SetText($script:gatewayApiKey)
    Set-Status Success "访问密钥已复制" "请仅粘贴到受信任的本机客户端。"
  } catch {
    [Windows.MessageBox]::Show("无法复制 Gateway API Key：$($_.Exception.Message)", "复制失败", "OK", "Warning") | Out-Null
  }
}

function Show-GatewayKeyManager {
  if (-not (Test-Path -LiteralPath $gatewayKeyXamlPath -PathType Leaf)) {
    [Windows.MessageBox]::Show("找不到 Gateway 密钥管理界面：`n$gatewayKeyXamlPath", "无法打开", "OK", "Error") | Out-Null
    return
  }

  $root = [Windows.Markup.XamlReader]::Parse((Get-Content -LiteralPath $gatewayKeyXamlPath -Raw))
  $dialog = New-Object Windows.Window
  $dialog.Title = "Gateway 访问密钥"
  $dialog.Width = 560
  $dialog.Height = 360
  $dialog.MinWidth = 560
  $dialog.MinHeight = 360
  $dialog.MaxWidth = 560
  $dialog.MaxHeight = 360
  $dialog.ResizeMode = "NoResize"
  $dialog.WindowStartupLocation = "CenterOwner"
  $dialog.Owner = $window
  $dialog.Background = [Windows.Media.BrushConverter]::new().ConvertFromString("#F6F8FC")
  $dialog.FontFamily = New-Object Windows.Media.FontFamily("Microsoft YaHei UI")
  $dialog.FontSize = 13
  $dialog.Content = $root
  $dialog.Icon = $window.Icon
  $dialog.ShowInTaskbar = $false

  $keyBox = $root.FindName("GatewayKeyBox")
  $saveButton = $root.FindName("SaveGatewayKeyButton")
  $cancelButton = $root.FindName("CancelGatewayKeyButton")
  $generateButton = $root.FindName("GenerateGatewayKeyButton")
  $copyButton = $root.FindName("CopyGatewayKeyDialogButton")
  $state = [PSCustomObject]@{ Restart = $false }

  $keyBox.Password = $script:gatewayApiKey
  $generateButton.add_Click({
    $keyBox.Password = New-GatewayApiKey
    [void]$keyBox.Focus()
    $keyBox.SelectAll()
  })
  $copyButton.add_Click({
    try { [Windows.Clipboard]::SetText($keyBox.Password) }
    catch { [Windows.MessageBox]::Show($dialog, "无法复制访问密钥：$($_.Exception.Message)", "复制失败", "OK", "Warning") | Out-Null }
  })
  $cancelButton.add_Click({ $dialog.DialogResult = $false })
  $saveButton.add_Click({
    $value = $keyBox.Password.Trim()
    if ($value.Length -lt 16 -or $value.Length -gt 256 -or [regex]::IsMatch($value, '[\x00-\x1F\x7F]')) {
      [Windows.MessageBox]::Show($dialog, "Gateway API Key 必须为 16–256 个可见字符。", "访问密钥无效", "OK", "Warning") | Out-Null
      [void]$keyBox.Focus()
      return
    }

    $changed = $value -cne $script:gatewayApiKey
    $ownedRunning = $script:ownedProcess -and -not $script:ownedProcess.HasExited
    if ($changed -and $ownedRunning) {
      $answer = [Windows.MessageBox]::Show($dialog, "访问安全设置变更后，正在运行的代理必须重启。是否保存并立即重启？", "需要重新启动代理", "YesNo", "Question")
      if ($answer -ne "Yes") { return }
      $state.Restart = $true
    }

    $script:gatewayApiKey = $value
    Save-GatewaySecuritySettings
    $dialog.DialogResult = $true
  })

  $saved = $dialog.ShowDialog() -eq $true
  if (-not $saved) { return }
  if ($state.Restart) {
    Stop-Proxy -Reason "settings_restart"
    Start-Sleep -Milliseconds 300
    Start-Proxy
    return
  }
  if ($script:externalProxy) {
    [Windows.MessageBox]::Show($window, "设置已经保存，但当前代理不是由本管理器启动。新的访问密钥将在下次由本管理器启动代理时生效。", "设置已保存", "OK", "Information") | Out-Null
  } else {
    Set-Status Success "Gateway 设置已保存" "所有本机请求都必须携带访问密钥。"
  }
}

function Set-WindowsAutoStart([bool]$Enabled) {
  try {
    if ($Enabled) {
      $launcher = Join-Path $script:appDirectory "DeepSeekProxyManager.ps1"
      $command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "' + $launcher + '" -AutoStart'
      New-ItemProperty -Path $script:runPath -Name $script:runValueName -Value $command -PropertyType String -Force | Out-Null
    } else {
      Remove-ItemProperty -Path $script:runPath -Name $script:runValueName -ErrorAction SilentlyContinue
    }
  } catch {
    $autoStartCheck.IsChecked = -not $Enabled
    [Windows.MessageBox]::Show("无法修改开机启动设置：$($_.Exception.Message)", "设置失败", "OK", "Warning") | Out-Null
  }
}

function Update-Buttons([bool]$Running, [bool]$Owned) {
  $signature = "$Running`0$Owned"
  if ($signature -ne $script:lastButtonSignature) {
    $script:lastButtonSignature = $signature
    $startButton.IsEnabled = -not $Running
    $stopButton.IsEnabled = $Running -and $Owned
    $restartButton.IsEnabled = $Running -and $Owned
    $portBox.IsEnabled = -not $Running
    $sonnetAliasBox.IsEnabled = -not $Running
    $sonnetTargetBox.IsEnabled = -not $Running
    $opusAliasBox.IsEnabled = -not $Running
    $opusTargetBox.IsEnabled = -not $Running
    if ($script:trayStartItem) { $script:trayStartItem.Enabled = -not $Running }
    if ($script:trayStopItem) { $script:trayStopItem.Enabled = $Running -and $Owned }
  }
  $newNodeText = if ($script:nodePath) {
    "Node.js $(if ($script:nodeVersion) { $script:nodeVersion } else { '已检测' }) · 已就绪"
  } else { "Node.js 将在启动时自动检测" }
  if ($nodeText.Text -ne $newNodeText) { $nodeText.Text = $newNodeText }
}

function Start-Proxy {
  if ($script:ownedProcess -and -not $script:ownedProcess.HasExited) { return }
  if (Test-ProxyHealth) {
    $script:externalProxy = $true
    Set-Status Success "代理已运行" "检测到端口上的外部代理；管理器不会强制接管。"
    Update-Buttons $true $false
    return
  }
  $port = Get-ConfiguredPort
  if (-not $port) { [Windows.MessageBox]::Show("端口无效。", "无法启动", "OK", "Warning") | Out-Null; return }
  if (-not $apiKeyBox.Password) { [Windows.MessageBox]::Show("请先输入 DeepSeek API Key。", "缺少 API Key", "OK", "Warning") | Out-Null; return }
  if (-not (Test-Path -LiteralPath $script:proxyScript -PathType Leaf)) { [Windows.MessageBox]::Show("找不到代理核心：`n$($script:proxyScript)", "无法启动", "OK", "Error") | Out-Null; return }
  $models = Get-ModelMapping
  if (-not $models) { return }

  $script:nodePath = Find-NodeExecutable
  if (-not $script:nodePath) { [Windows.MessageBox]::Show("未找到 Node.js 20 或更高版本。", "缺少 Node.js", "OK", "Error") | Out-Null; return }
  $version = (& $script:nodePath --version 2>$null).Trim()
  $major = 0
  if (-not [int]::TryParse(($version.TrimStart('v').Split('.')[0]), [ref]$major) -or $major -lt 20) { [Windows.MessageBox]::Show("需要 Node.js 20 或更高版本，当前为 $version。", "版本过低", "OK", "Error") | Out-Null; return }
  $script:nodeVersion = $version
  if (-not (Save-Settings $true)) { return }

  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $script:nodePath
  $info.Arguments = '"' + $script:proxyScript.Replace('"', '\"') + '"'
  $info.WorkingDirectory = $script:appDirectory
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.EnvironmentVariables["DEEPSEEK_API_KEY"] = $apiKeyBox.Password
  $info.EnvironmentVariables["DEEPSEEK_BASE_URL"] = "https://api.deepseek.com/anthropic"
  $modelMap = @{}
  $modelMap[$models.OpusAlias] = $models.OpusTarget
  $modelMap[$models.SonnetAlias] = $models.SonnetTarget
  $info.EnvironmentVariables["MODEL_MAP_JSON"] = ($modelMap | ConvertTo-Json -Compress)
  $info.EnvironmentVariables["PORT"] = [string]$port
  $info.EnvironmentVariables["HOST"] = "127.0.0.1"
  $info.EnvironmentVariables["LOG_FILE"] = $script:logPath
  $info.EnvironmentVariables["LOG_MAX_BYTES"] = "1048576"
  $info.EnvironmentVariables["LOG_BACKUPS"] = "3"
  $info.EnvironmentVariables["MAX_BODY_BYTES"] = "26214400"
  $info.EnvironmentVariables["UPSTREAM_TIMEOUT_MS"] = "120000"
  $info.EnvironmentVariables["CORS_ORIGIN"] = ""
  $info.EnvironmentVariables["PROXY_API_KEY"] = $script:gatewayApiKey

  try {
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    [void]$process.Start()
    $script:ownedProcess = $process
    $script:externalProxy = $false
    Set-Status Starting "正在启动" "代理进程已启动，正在等待健康检查…"
    Update-Buttons $true $true
  } catch {
    $script:ownedProcess = $null
    Set-Status Error "启动失败" $_.Exception.Message
    [Windows.MessageBox]::Show($_.Exception.Message, "无法启动", "OK", "Error") | Out-Null
  }
}

function Stop-Proxy([string]$Reason = "manual_stop") {
  if (-not $script:ownedProcess -or $script:ownedProcess.HasExited) {
    if ($script:externalProxy) { Set-Status Success "代理已运行" "该代理不是由本管理器启动，请关闭原 PowerShell 窗口。" }
    else { Set-Status Stopped "代理已停止" "可以安全修改端口或 API Key。" }
    return
  }
  $process = $script:ownedProcess
  $stopped = $false
  try {
    try {
      $command = @{ command = "shutdown"; reason = $Reason } | ConvertTo-Json -Compress
      $process.StandardInput.WriteLine($command)
      $process.StandardInput.Flush()
      $stopped = $process.WaitForExit(2800) -or $process.HasExited
    } catch { $stopped = $false }
    if (-not $stopped) {
      $process.Kill()
      $stopped = $process.WaitForExit(1000) -or $process.HasExited
    }
    if (-not $stopped) { throw "代理进程未能在 3 秒内退出。" }
  } catch {
    Set-Status Error "停止失败" $_.Exception.Message
    return
  } finally {
    if ($stopped) {
      $process.Dispose()
      if ($script:ownedProcess -eq $process) { $script:ownedProcess = $null }
    }
  }
  $script:externalProxy = $false
  Set-Status Stopped "代理已停止" "本地端口已释放。"
  Update-Buttons $false $false
}

function Refresh-Health {
  $owned = $script:ownedProcess -and -not $script:ownedProcess.HasExited
  if ($script:ownedProcess -and $script:ownedProcess.HasExited) {
    $script:ownedProcess.Dispose(); $script:ownedProcess = $null
    Set-Status Error "代理意外退出" "请查看日志了解详细原因，然后重新启动。"
    Update-Buttons $false $false
    return
  }
  if (Test-ProxyHealth) {
    $script:externalProxy = -not $owned
    Set-Status Success "代理已运行" "http://127.0.0.1:$($portBox.Text) · $(if ($owned) { '由本管理器启动' } else { '外部进程' })"
    Update-Buttons $true $owned
  } elseif (-not $owned) {
    $script:externalProxy = $false
    Set-Status Stopped "代理未运行" "输入 API Key 后即可一键启动。"
    Update-Buttons $false $false
  }
}

function Clear-Log {
  try {
    [IO.File]::WriteAllText($script:logPath, "", (New-Object Text.UTF8Encoding($false)))
    $script:lastLogText = ""
    if ($script:logBox) { $script:logBox.Text = "日志已清空。" }
  } catch {
    [Windows.MessageBox]::Show($_.Exception.Message, "清理失败") | Out-Null
  }
}

function Show-LogWindow {
  if ($script:logWindow) {
    $script:logWindow.Show()
    $script:logWindow.WindowState = "Normal"
    [void]$script:logWindow.Activate()
    Refresh-Log
    $logTimer.Start()
    return
  }

  $logXamlPath = Join-Path $script:appDirectory "LogWindow.xaml"
  if (-not (Test-Path -LiteralPath $logXamlPath -PathType Leaf)) {
    [Windows.MessageBox]::Show("找不到日志窗口资源：`n$logXamlPath", "无法打开日志", "OK", "Error") | Out-Null
    return
  }

  $root = [Windows.Markup.XamlReader]::Parse((Get-Content -LiteralPath $logXamlPath -Raw))
  $script:logWindow = New-Object Windows.Window
  $script:logWindow.Title = "DeepSeek 代理运行日志"
  $script:logWindow.Width = 860
  $script:logWindow.Height = 560
  $script:logWindow.MinWidth = 640
  $script:logWindow.MinHeight = 400
  $script:logWindow.WindowStartupLocation = "CenterOwner"
  $script:logWindow.Owner = $window
  $script:logWindow.Background = [Windows.Media.BrushConverter]::new().ConvertFromString("#111827")
  $script:logWindow.FontFamily = New-Object Windows.Media.FontFamily("Microsoft YaHei UI")
  $script:logWindow.Icon = $window.Icon
  $script:logWindow.Content = $root
  $script:logBox = $root.FindName("LogBox")
  $root.FindName("ClearLogButton").add_Click({ Clear-Log })
  $root.FindName("OpenLogFolderButton").add_Click({ Start-Process -FilePath $script:appDirectory })
  $script:logWindow.add_Closed({ $logTimer.Stop(); $script:logWindow = $null; $script:logBox = $null; $script:lastLogText = "" })
  $script:lastLogText = ""
  Refresh-Log
  $logTimer.Start()
  $script:logWindow.Show()
}

function Refresh-Log {
  if (-not $script:logBox) { return }
  try {
    if (-not (Test-Path -LiteralPath $script:logPath -PathType Leaf)) { if (-not $script:lastLogText) { $script:logBox.Text = "暂无日志。启动代理后，这里会显示最近的运行记录。" }; return }
    $lines = @(Get-Content -LiteralPath $script:logPath -Tail 160 -ErrorAction Stop)
    $display = ($lines | ForEach-Object {
      if ($_ -match '^(\d{4}-\d{2}-\d{2}T[^ ]+) (.*)$') {
        try { ([DateTime]$matches[1]).ToLocalTime().ToString("HH:mm:ss") + " " + $matches[2] } catch { $_ }
      } else { $_ }
    }) -join [Environment]::NewLine
    if ($display -ne $script:lastLogText) { $script:lastLogText = $display; $script:logBox.Text = $display; $script:logBox.ScrollToEnd() }
  } catch { }
}

Load-Settings
Update-ConfigurationPreview

$script:tray = New-Object Windows.Forms.NotifyIcon
if (Test-Path -LiteralPath $iconPath -PathType Leaf) {
  try { $script:applicationIcon = New-Object Drawing.Icon -ArgumentList $iconPath } catch { $script:applicationIcon = $null }
}
$script:tray.Icon = if ($script:applicationIcon) { $script:applicationIcon } else { [Drawing.SystemIcons]::Application }
$script:tray.Text = "DeepSeek 代理管理器"
$script:tray.Visible = $true
$menu = [ClaudeDeepSeekProxyManager.TrayMenuTheme]::CreateMenu()
$showItem = [ClaudeDeepSeekProxyManager.TrayMenuTheme]::CreateItem(
  "打开管理器",
  [ClaudeDeepSeekProxyManager.TrayMenuGlyph]::Open,
  [Drawing.Color]::FromArgb(82, 121, 232),
  $true
)
$script:trayStartItem = [ClaudeDeepSeekProxyManager.TrayMenuTheme]::CreateItem(
  "启动代理",
  [ClaudeDeepSeekProxyManager.TrayMenuGlyph]::Start,
  [Drawing.Color]::FromArgb(38, 166, 106),
  $false
)
$script:trayStopItem = [ClaudeDeepSeekProxyManager.TrayMenuTheme]::CreateItem(
  "停止代理",
  [ClaudeDeepSeekProxyManager.TrayMenuGlyph]::Stop,
  [Drawing.Color]::FromArgb(226, 153, 51),
  $false
)
$exitItem = [ClaudeDeepSeekProxyManager.TrayMenuTheme]::CreateItem(
  "退出",
  [ClaudeDeepSeekProxyManager.TrayMenuGlyph]::Exit,
  [Drawing.Color]::FromArgb(224, 82, 94),
  $false
)
[void]$menu.Items.Add($showItem)
[void]$menu.Items.Add([ClaudeDeepSeekProxyManager.TrayMenuTheme]::CreateSeparator())
[void]$menu.Items.Add($script:trayStartItem)
[void]$menu.Items.Add($script:trayStopItem)
[void]$menu.Items.Add([ClaudeDeepSeekProxyManager.TrayMenuTheme]::CreateSeparator())
[void]$menu.Items.Add($exitItem)
$script:tray.ContextMenuStrip = $menu

$showWindow = { $window.Show(); $window.WindowState = "Normal"; Update-PollingCadence; [void]$window.Activate() }
$showItem.add_Click($showWindow)
$script:tray.add_DoubleClick($showWindow)
$script:trayStartItem.add_Click({ Start-Proxy })
$script:trayStopItem.add_Click({ Stop-Proxy })
$exitItem.add_Click({ $script:exiting = $true; $window.Close() })

$saveKeyButton.add_Click({ if (Save-Settings $true) { Set-Status Success "设置已安全保存" "API Key 已加密，模型映射也已保存。" } })
$startButton.add_Click({ Start-Proxy })
$stopButton.add_Click({ Stop-Proxy })
$restartButton.add_Click({ if ($script:externalProxy) { [Windows.MessageBox]::Show("当前代理不是由本管理器启动，无法安全重启。", "无法接管", "OK", "Information") | Out-Null } else { Stop-Proxy -Reason "restart"; Start-Sleep -Milliseconds 300; Start-Proxy } })
$testButton.add_Click({
  $healthy = Test-ProxyHealth
  $modelsAvailable = $healthy -and (Test-ProxyModels)
  if ($modelsAvailable) {
    Set-Status Success "连接正常" "本地健康检查和模型列表均可访问。"
    [Windows.MessageBox]::Show("本地代理连接正常，模型列表读取成功。", "测试成功", "OK", "Information") | Out-Null
  } else {
    $detail = if ($healthy) { "健康检查正常，但模型列表读取失败。" } else { "无法访问本地代理，请确认代理已经启动。" }
    Set-Status Error "连接失败" $detail
    [Windows.MessageBox]::Show($detail, "测试失败", "OK", "Warning") | Out-Null
  }
})
$openLogButton.add_Click({ Show-LogWindow })
$copyEndpointButton.add_Click({
  $port = Get-ConfiguredPort
  if (-not $port) { [Windows.MessageBox]::Show("端口必须是 1 到 65535 之间的整数。", "端口无效", "OK", "Warning") | Out-Null; return }
  try {
    [Windows.Clipboard]::SetText("http://127.0.0.1:$port")
    Set-Status Success "地址已复制" "本地 Gateway 地址已复制到剪贴板。"
  } catch { [Windows.MessageBox]::Show("无法复制地址：$($_.Exception.Message)", "复制失败", "OK", "Warning") | Out-Null }
})
$copyGatewayKeyButton.add_Click({ Copy-GatewayKey })
$manageGatewayKeyButton.add_Click({ Show-GatewayKeyManager })
$openFolderButton.add_Click({ Start-Process -FilePath $script:appDirectory })
$portBox.add_TextChanged({ Update-ConfigurationPreview })
$autoStartCheck.add_Click({ [void](Save-Settings $false); Set-WindowsAutoStart ($autoStartCheck.IsChecked -eq $true) })
$minimizeCheck.add_Click({ [void](Save-Settings $false) })

$healthTimer = New-Object Windows.Threading.DispatcherTimer
$healthTimer.Interval = [TimeSpan]::FromSeconds(10)
$healthTimer.add_Tick({ Refresh-Health })
$logTimer = New-Object Windows.Threading.DispatcherTimer
$logTimer.Interval = [TimeSpan]::FromSeconds(2)
$logTimer.add_Tick({ Refresh-Log })

$window.add_StateChanged({ Update-PollingCadence })
$window.add_Loaded({ Update-PollingCadence; Refresh-Health; $healthTimer.Start(); if ($AutoStart) { $window.Hide(); Update-PollingCadence; if (-not (Test-ProxyHealth)) { Start-Proxy } } })
$window.add_Closing({ param($sender, $eventArgs)
  if (-not $script:exiting -and $minimizeCheck.IsChecked -eq $true) { $eventArgs.Cancel = $true; $window.Hide(); if ($script:logWindow) { $script:logWindow.Hide() }; $logTimer.Stop(); Update-PollingCadence; $script:tray.ShowBalloonTip(1200, "DeepSeek 代理管理器", "程序仍在系统托盘中运行。", "Info"); return }
  if ($script:logWindow) { $script:logWindow.Close() }
  $healthTimer.Stop(); $logTimer.Stop(); Stop-Proxy -Reason "manager_exit"; $script:tray.Visible = $false; $script:tray.Dispose()
  if ($menu) { $menu.Dispose() }
  if ($script:applicationIcon) { $script:applicationIcon.Dispose(); $script:applicationIcon = $null }
})

$app = New-Object Windows.Application
$app.ShutdownMode = "OnExplicitShutdown"
try { [void]$app.Run($window) } finally {
  if ($script:ownedProcess -and -not $script:ownedProcess.HasExited) { Stop-Proxy -Reason "manager_exit" }
  $script:tray.Dispose()
  if ($menu) { $menu.Dispose() }
  if ($script:applicationIcon) { $script:applicationIcon.Dispose(); $script:applicationIcon = $null }
  $singleInstance.ReleaseMutex(); $singleInstance.Dispose()
}
