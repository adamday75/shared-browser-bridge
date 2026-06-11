# Windows Chrome CDP + WSL Portproxy Setup

This is the working operator setup used for the 2026-06-11 M14 live proof.

Use this when:
- Chrome remote debugging works on Windows
- the bridge runs from WSL
- WSL cannot reach Windows Chrome CDP directly on loopback

## Why this exists

Two environment realities mattered in the live proof:

1. Chrome remote debugging required a non-default `--user-data-dir`
2. WSL could not reach Windows Chrome on `127.0.0.1:9222`, so Windows had to re-expose CDP through a portproxy path that WSL could reach

## One-time Windows admin setup

### 1) Add a Windows portproxy

Run from **Windows PowerShell as Administrator**:

```powershell
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=9223 connectaddress=127.0.0.1 connectport=9222
```

### 2) Allow inbound TCP 9223 through Windows Firewall

```powershell
netsh advfirewall firewall add rule name="Gary Chrome CDP 9223" dir=in action=allow protocol=TCP localport=9223
```

## Per-session workflow

### 1) Start Chrome with remote debugging from Windows PowerShell

```powershell
Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="C:\temp\gary-linkedin-debug"
```

Why the custom profile:
- current Chrome ignores remote-debugging flags on the default profile in this environment

### 2) Verify Windows CDP locally

```powershell
Invoke-WebRequest http://127.0.0.1:9222/json/version -UseBasicParsing | Select-Object -ExpandProperty Content
```

### 3) Verify the proxied CDP endpoint from WSL

```bash
curl http://172.22.96.1:9223/json/version
```

Expected result:
- JSON containing `Browser`, `Protocol-Version`, and `webSocketDebuggerUrl`

### 4) Start the bridge from WSL

```bash
pkill -f "node src/index.js"
cd /home/adamd/.openclaw/workspace/shared-browser-bridge && CDP_HOST=172.22.96.1 CDP_PORT=9223 node src/index.js
```

Expected log line:

```text
[chrome] attached to existing CDP endpoint at http://172.22.96.1:9223
```

### 5) Run the LinkedIn follow-up proof from a second WSL shell

```bash
cd /home/adamd/.openclaw/workspace/shared-browser-bridge && node scripts/demo-linkedin-followup-brief.mjs --match-url "linkedin.com"
```

## Quick troubleshooting

### Symptom: Windows local CDP check fails
Cause:
- Chrome is still using an old/default instance, or the custom profile launch did not happen cleanly

Try:

```powershell
Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="C:\temp\gary-linkedin-debug"
```

### Symptom: WSL cannot reach `172.22.96.1:9223`
Check:
- portproxy exists
- firewall rule exists
- Windows Chrome is still running on 9222

Useful Windows checks:

```powershell
netstat -ano | findstr 9222
netstat -ano | findstr 9223
```

### Symptom: bridge says `EADDRINUSE 127.0.0.1:7820`
Cause:
- an old bridge process is still running in WSL

Fix:

```bash
pkill -f "node src/index.js"
```

## Cleanup / maintenance

If you ever want to remove the portproxy:

```powershell
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=9223
```

If you want to remove the firewall rule:

```powershell
netsh advfirewall firewall delete rule name="Gary Chrome CDP 9223"
```
