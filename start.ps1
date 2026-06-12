$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RootDir

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is required. Install it from https://nodejs.org/ and run this again."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error "npm is required. It normally ships with Node.js."
}

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing dependencies..."
  npm install
}

if (-not $env:HOST) { $env:HOST = "127.0.0.1" }
if (-not $env:PORT) { $env:PORT = "3000" }
if (-not $env:TERMINAL_CWD) { $env:TERMINAL_CWD = $RootDir }

$AppUrl = "http://$($env:HOST):$($env:PORT)"
$LoginUrl = "$AppUrl/login"

if ($env:NO_OPEN -ne "1") {
  Start-Job -ScriptBlock {
    param($Url)
    Start-Sleep -Seconds 2
    Start-Process $Url
  } -ArgumentList $LoginUrl | Out-Null
}

Write-Host "Starting Nova Terminal at $LoginUrl"
Write-Host "Terminal sessions will open in: $env:TERMINAL_CWD"
npm run dev
