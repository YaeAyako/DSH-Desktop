@echo off
setlocal
cd /d "%~dp0"

rem First run: install dependencies if missing.
if not exist "node_modules\electron\dist\electron.exe" (
  echo [DSH Desktop] First run: installing dependencies, please wait...
  call npm install
  if errorlevel 1 (
    echo.
    echo [DSH Desktop] npm install failed. Please check your network and Node.js installation.
    echo Node.js is required: https://nodejs.org/
    pause
    exit /b 1
  )
)

echo [DSH Desktop] Starting DeepSeek Harness...
call npm start
if errorlevel 1 (
  echo.
  echo [DSH Desktop] App exited with an error. See the log for details.
  pause
)
