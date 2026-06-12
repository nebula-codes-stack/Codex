@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org/ and run this again.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm is required. It normally ships with Node.js.
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b %errorlevel%
)

if not defined HOST set HOST=127.0.0.1
if not defined PORT set PORT=3000
if not defined TERMINAL_CWD set TERMINAL_CWD=%CD%
set APP_URL=http://%HOST%:%PORT%
set LOGIN_URL=%APP_URL%/login

if not "%NO_OPEN%"=="1" start "" "%LOGIN_URL%"

echo Starting Nova Terminal at %LOGIN_URL%
echo Terminal sessions will open in: %TERMINAL_CWD%
call npm run dev
