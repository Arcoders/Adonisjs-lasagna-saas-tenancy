# End-to-end runner (PowerShell) — Windows-native variant of e2e.sh.
# Usage: npm run test:e2e:win  (or pwsh ./scripts/e2e.ps1)
#
# Flags:
#   -Keep   Don't tear down infra after the suite

param([switch]$Keep)

$ErrorActionPreference = "Stop"
Set-Location -Path (Join-Path $PSScriptRoot "..")

if (-not (Test-Path ".env")) {
  Write-Host "[e2e] .env missing — copying from .env.example"
  Copy-Item ".env.example" ".env"
}

function Cleanup {
  if ($Keep) {
    Write-Host "[e2e] -Keep was passed; leaving infra running"
    return
  }
  Write-Host "[e2e] tearing down docker compose stack"
  docker compose down -v --remove-orphans 2>$null | Out-Null
}

try {
  Write-Host "[e2e] bringing up postgres + redis + pgadmin"
  docker compose up -d

  Write-Host "[e2e] waiting for postgres to accept connections"
  $deadline = (Get-Date).AddSeconds(60)
  while ($true) {
    docker compose exec -T postgres pg_isready -U app -d lasagna_demo 2>$null | Out-Null
    if ($?) { break }
    if ((Get-Date) -gt $deadline) {
      Write-Error "[e2e] postgres did not become ready in 60s"
      exit 1
    }
    Start-Sleep -Seconds 1
  }

  Write-Host "[e2e] waiting for redis to accept connections"
  $deadline = (Get-Date).AddSeconds(30)
  while ($true) {
    $reply = docker compose exec -T redis redis-cli ping 2>$null
    if ($reply -match "PONG") { break }
    if ((Get-Date) -gt $deadline) {
      Write-Error "[e2e] redis did not become ready in 30s"
      exit 1
    }
    Start-Sleep -Seconds 1
  }

  # MailCatcher is optional — the e2e mail.spec.ts skips gracefully if it
  # isn't reachable, so a probe failure here only emits a warning.
  Write-Host "[e2e] waiting for mailcatcher (optional)"
  $deadline = (Get-Date).AddSeconds(20)
  $mailcatcherReady = $false
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:1080/messages" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
      if ($r.StatusCode -eq 200) { $mailcatcherReady = $true; break }
    } catch {}
    Start-Sleep -Seconds 1
  }
  if (-not $mailcatcherReady) {
    Write-Host "[e2e] mailcatcher not reachable — mail tests will skip"
  }

  Write-Host "[e2e] running backoffice:setup"
  npx tsx ace.ts backoffice:setup
  if ($LASTEXITCODE -ne 0) { throw "backoffice:setup failed" }

  Write-Host "[e2e] running Japa e2e suite"
  npx tsx ace.ts test e2e
  if ($LASTEXITCODE -ne 0) { throw "e2e suite failed" }
}
finally {
  Cleanup
}
