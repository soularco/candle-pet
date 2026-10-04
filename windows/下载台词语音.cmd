@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js LTS from https://nodejs.org/
  pause
  exit /b 1
)
echo Downloading the ambient lines with the cloud voice...
echo Cached clips are reused, so re-running this only fills in what is missing.
echo.
node "%~dp0prefetch-speech.mjs" %*
echo.
pause
