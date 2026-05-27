# Claude DeepSeek model proxy

Local Anthropic-compatible proxy for Claude Desktop 3P mode. It keeps Claude-facing model IDs while sending real DeepSeek model IDs upstream.

| Claude-facing model ID | DeepSeek-facing model ID |
| --- | --- |
| `claude-opus-4-5` | `deepseek-v4-pro` |
| `claude-sonnet-4-5` | `deepseek-v4-flash` |

## Recommended Local Setup

Run one local proxy window:

```powershell
cd C:\Users\luoyongwei\Documents\deepseek

.\start-proxy.ps1 `
  -ApiKey "sk-your-deepseek-key" `
  -ProxyApiKey "your-local-proxy-key" `
  -AllowLocalhostNoAuth
```

Expected startup line:

```text
INFO listening http://127.0.0.1:3210
```

`-AllowLocalhostNoAuth` is needed because Claude Desktop Code may call the local gateway without forwarding the Gateway API key. Use this only for local `127.0.0.1` access.

## Claude Desktop Profile

If Claude recreates an empty `Default` 3P profile, open Developer / 3P once, then patch the current applied profile:

```powershell
.\install-claude-desktop-local-profile.ps1 -ProxyApiKey "your-local-proxy-key" -PatchAppliedProfile
```

The profile should point to:

```text
Gateway base URL: http://127.0.0.1:3210
Gateway auth scheme: bearer
Models: claude-opus-4-5, claude-sonnet-4-5
```

If Claude keeps recreating the `Default` profile, run the watcher while opening Developer / 3P:

```powershell
.\watch-claude-local-profile.ps1 -ProxyApiKey "your-local-proxy-key"
```

## Checks

Models without auth, local only:

```powershell
Invoke-RestMethod http://127.0.0.1:3210/v1/models |
  ConvertTo-Json -Depth 5
```

Token count endpoint used by Claude Desktop Code:

```powershell
$body = @{
  model = "claude-sonnet-4-5"
  messages = @(@{ role = "user"; content = "hello" })
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:3210/v1/messages/count_tokens `
  -ContentType "application/json" `
  -Body $body |
  ConvertTo-Json -Depth 5
```

Successful runtime logs look like:

```text
count_tokens_local
model_rewrite {"rewrite":"claude-sonnet-4-5 -> deepseek-v4-flash"}
upstream_response {"status":200,"path":"/v1/messages",...}
```

## Notes

- Do not use Cloudflare in `-AllowLocalhostNoAuth` mode.
- Removed Cloudflare and local HTTPS experiment files are backed up in `backups\pre-remove-cloudflared-*.zip` and `backups\pre-remove-https-experiment-*.zip`.
- Experimental response transforms exist for debugging only: `TRANSFORM_RESPONSES=true`, `FORCE_UPSTREAM_NON_STREAM=true`.
