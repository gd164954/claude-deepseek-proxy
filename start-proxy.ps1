param(
  [string]$ApiKey = $env:DEEPSEEK_API_KEY,
  [string]$ProxyApiKey = $env:PROXY_API_KEY,
  [int]$Port = 3210,
  [string]$BaseUrl = "https://api.deepseek.com/anthropic",
  [string]$HostName = "127.0.0.1",
  [string]$NodePath = "",
  [string]$LogFile = ".\proxy.log",
  [switch]$AllowLocalhostNoAuth
)

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  throw "Missing DeepSeek API key. Run: .\start-proxy.ps1 -ApiKey sk-your-deepseek-key"
}

$env:DEEPSEEK_API_KEY = $ApiKey
$env:DEEPSEEK_BASE_URL = $BaseUrl
$env:PORT = [string]$Port
$env:HOST = $HostName
$env:LOG_FILE = $LogFile
$env:ALLOW_LOCALHOST_NO_AUTH = if ($AllowLocalhostNoAuth) { "true" } else { $null }
if (-not [string]::IsNullOrWhiteSpace($ProxyApiKey)) {
  $env:PROXY_API_KEY = $ProxyApiKey
}

function Find-NodeExe {
  param([string]$RequestedPath)

  if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
    if (Test-Path -LiteralPath $RequestedPath) {
      return (Resolve-Path -LiteralPath $RequestedPath).Path
    }
    throw "NodePath does not exist: $RequestedPath"
  }

  $candidates = @(
    "$env:LOCALAPPDATA\OpenAI\Codex\bin\node.exe",
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }

  $fromPath = Get-Command node -ErrorAction SilentlyContinue
  if ($fromPath) {
    return $fromPath.Source
  }

  throw "Cannot find node.exe. Install Node.js from https://nodejs.org, or run with -NodePath C:\path\to\node.exe"
}

$nodeExe = Find-NodeExe -RequestedPath $NodePath
Write-Host "Using Node: $nodeExe"
if ($AllowLocalhostNoAuth) {
  Write-Host "Localhost auth bypass enabled. Do not expose this proxy through Cloudflare in this mode."
}
& $nodeExe .\claude-deepseek-proxy.mjs
