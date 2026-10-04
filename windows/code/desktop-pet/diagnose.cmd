@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo   AAAAGENT electron test
echo ==========================================
echo.

set "EL=node_modules\electron\dist\electron.exe"
set "NODE=%ProgramFiles%\nodejs\node.exe"
set "MAIN=desktop\electron\main.mjs"
set "BACK=dist\app\preview-backend.js"

if not exist "%EL%" (
  echo [ERROR] electron.exe missing. Run: npm.cmd ci
  goto END
)

echo [A] NORMAL mode -- any error appears below
echo ------------------------------------------
"%EL%" --enable-logging=stderr "%MAIN%" --root desktop --backend "%BACK%" --node "%NODE%" --preview
echo.
echo     exit code = %ERRORLEVEL%
echo.

echo [B] SAFE mode --no-sandbox --disable-gpu
echo ------------------------------------------
"%EL%" --no-sandbox --disable-gpu --enable-logging=stderr "%MAIN%" --root desktop --backend "%BACK%" --node "%NODE%" --preview
echo.
echo     exit code = %ERRORLEVEL%
echo.

:END
echo.
echo ==========================================
echo   DONE -- please screenshot this window
echo ==========================================
echo.
pause