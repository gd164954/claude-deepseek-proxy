param(
  [string]$ApiKey = $env:DEEPSEEK_API_KEY,
  [string]$ProxyApiKey = $env:PROXY_API_KEY,
  [ValidateRange(1, 65535)]
  [int]$Port = 3210,
  [string]$BaseUrl = "https://api.deepseek.com/anthropic",
  [string]$OpusAliasModel = "claude-opus-4-5",
  [string]$OpusTargetModel = "deepseek-v4-pro",
  [string]$SonnetAliasModel = "claude-sonnet-4-5",
  [string]$SonnetTargetModel = "deepseek-v4-flash",
  [string]$HostName = "127.0.0.1",
  [string]$NodePath = "",
  [string]$LogFile = ".\proxy.log",
  [ValidateRange(1, 2147483647)]
  [int]$LogMaxBytes = 1048576,
  [ValidateRange(0, 100)]
  [int]$LogBackups = 3,
  [ValidateRange(1024, 2147483647)]
  [int]$MaxBodyBytes = 26214400,
  [ValidateRange(1000, 2147483647)]
  [int]$UpstreamTimeoutMs = 120000,
  [string]$CorsOrigin = "",
  [switch]$LogCountTokens
)

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  $secureApiKey = Read-Host "DeepSeek API key" -AsSecureString
  $apiKeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureApiKey)
  try {
    $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($apiKeyPointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($apiKeyPointer)
  }
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  throw "Missing DeepSeek API key."
}

if ([string]::IsNullOrWhiteSpace($ProxyApiKey)) {
  $secureProxyApiKey = Read-Host "Gateway API key" -AsSecureString
  $proxyKeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureProxyApiKey)
  try {
    $ProxyApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($proxyKeyPointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($proxyKeyPointer)
  }
}

if ([string]::IsNullOrWhiteSpace($ProxyApiKey)) {
  throw "Missing Gateway API key."
}

$modelIdPattern = '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
if ($OpusAliasModel -notmatch $modelIdPattern) {
  throw "OpusAliasModel is not a valid model ID: $OpusAliasModel"
}
if ($OpusTargetModel -notmatch $modelIdPattern) {
  throw "OpusTargetModel is not a valid model ID: $OpusTargetModel"
}
if ($SonnetAliasModel -notmatch $modelIdPattern) {
  throw "SonnetAliasModel is not a valid model ID: $SonnetAliasModel"
}
if ($SonnetTargetModel -notmatch $modelIdPattern) {
  throw "SonnetTargetModel is not a valid model ID: $SonnetTargetModel"
}
if ($OpusAliasModel -ieq $SonnetAliasModel) {
  throw "OpusAliasModel and SonnetAliasModel must be different."
}

$proxyScriptPath = Join-Path $PSScriptRoot "claude-deepseek-proxy.mjs"
if (-not (Test-Path -LiteralPath $proxyScriptPath -PathType Leaf)) {
  throw "Proxy entry point does not exist: $proxyScriptPath"
}

$resolvedLogFile = if ([IO.Path]::IsPathRooted($LogFile)) {
  $LogFile
} else {
  Join-Path $PSScriptRoot $LogFile
}

$env:DEEPSEEK_API_KEY = $ApiKey
$env:DEEPSEEK_BASE_URL = $BaseUrl
$modelMap = @{}
$modelMap[$OpusAliasModel] = $OpusTargetModel
$modelMap[$SonnetAliasModel] = $SonnetTargetModel
$env:MODEL_MAP_JSON = $modelMap | ConvertTo-Json -Compress
$env:PORT = [string]$Port
$env:HOST = $HostName
$env:LOG_FILE = $resolvedLogFile
$env:LOG_MAX_BYTES = [string]$LogMaxBytes
$env:LOG_BACKUPS = [string]$LogBackups
$env:MAX_BODY_BYTES = [string]$MaxBodyBytes
$env:UPSTREAM_TIMEOUT_MS = [string]$UpstreamTimeoutMs
$env:CORS_ORIGIN = $CorsOrigin
$env:LOG_COUNT_TOKENS = if ($LogCountTokens) { "true" } else { $null }
$env:PROXY_API_KEY = $ProxyApiKey

function Find-NodeExe {
  param([string]$RequestedPath)

  if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
    if (Test-Path -LiteralPath $RequestedPath -PathType Leaf) {
      return (Resolve-Path -LiteralPath $RequestedPath).Path
    }
    throw "NodePath does not exist: $RequestedPath"
  }

  $candidates = @(
    (Join-Path $PSScriptRoot "node.exe"),
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
$nodeVersion = & $nodeExe -p "process.versions.node"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($nodeVersion)) {
  throw "Failed to determine Node.js version from: $nodeExe"
}
$nodeMajorVersion = [int]($nodeVersion.Split(".")[0])
if ($nodeMajorVersion -lt 20) {
  throw "Node.js 20 or newer is required. Found v$nodeVersion at: $nodeExe"
}

Write-Host "Using Node: $nodeExe"
Write-Host "Node version: v$nodeVersion"
Write-Host "Proxy script: $proxyScriptPath"
Write-Host "Log file:     $resolvedLogFile"
Write-Host "Models:       $SonnetAliasModel -> $SonnetTargetModel; $OpusAliasModel -> $OpusTargetModel"
& $nodeExe $proxyScriptPath
