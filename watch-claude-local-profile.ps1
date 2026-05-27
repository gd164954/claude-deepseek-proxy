param(
  [string]$ProxyApiKey = $env:PROXY_API_KEY,
  [string]$GatewayBaseUrl = "http://127.0.0.1:3210",
  [string]$Claude3pDir = "$env:LOCALAPPDATA\Claude-3p",
  [int]$Seconds = 300
)

if ([string]::IsNullOrWhiteSpace($ProxyApiKey)) {
  throw "Missing proxy API key. Example: .\watch-claude-local-profile.ps1 -ProxyApiKey your-local-proxy-key"
}

$configLibraryDir = Join-Path $Claude3pDir "configLibrary"
$metaPath = Join-Path $configLibraryDir "_meta.json"

function New-LocalGatewayProfile {
  param(
    [string]$Url,
    [string]$Key
  )

  [ordered]@{
    coworkEgressAllowedHosts = @("*")
    disableDeploymentModeChooser = $true
    inferenceProvider = "gateway"
    inferenceCredentialKind = "static"
    inferenceGatewayBaseUrl = $Url
    inferenceGatewayApiKey = $Key
    inferenceGatewayAuthScheme = "bearer"
    inferenceModels = @(
      [ordered]@{
        name = "claude-opus-4-5"
        supports1m = $true
      },
      [ordered]@{
        name = "claude-sonnet-4-5"
        supports1m = $true
      }
    )
  }
}

function Repair-AppliedProfile {
  if (-not (Test-Path -LiteralPath $metaPath)) {
    return $false
  }

  $meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace($meta.appliedId)) {
    return $false
  }

  $profilePath = Join-Path $configLibraryDir "$($meta.appliedId).json"
  $shouldWrite = $true

  if (Test-Path -LiteralPath $profilePath) {
    try {
      $profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
      $shouldWrite =
        $profile.inferenceProvider -ne "gateway" -or
        $profile.inferenceGatewayBaseUrl -ne $GatewayBaseUrl -or
        $profile.inferenceGatewayApiKey -ne $ProxyApiKey
    } catch {
      $shouldWrite = $true
    }
  }

  if ($shouldWrite) {
    New-LocalGatewayProfile -Url $GatewayBaseUrl -Key $ProxyApiKey |
      ConvertTo-Json -Depth 20 |
      Set-Content -LiteralPath $profilePath -Encoding UTF8

    Write-Host "$(Get-Date -Format 'HH:mm:ss') patched applied profile $($meta.appliedId) -> $GatewayBaseUrl"
  }

  return $shouldWrite
}

New-Item -ItemType Directory -Force -Path $configLibraryDir | Out-Null
Write-Host "Watching Claude profile for $Seconds seconds..."
Write-Host "Gateway: $GatewayBaseUrl"
Write-Host "Open Claude Developer / 3P setup now. This script will patch the current Default profile when Claude recreates it."

$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
  Repair-AppliedProfile | Out-Null
  Start-Sleep -Seconds 1
}

Write-Host "Done watching."
