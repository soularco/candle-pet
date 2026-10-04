@echo off
setlocal
cd /d "%~dp0"
set "EL=node_modules\electron\dist\electron.exe"
set "NODE=%ProgramFiles%\nodejs\node.exe"
set /a N=0

taskkill /f /im electron.exe >nul 2>&1

echo ==========================================
echo   AAAAGENT - trying 4 launch strategies
echo ==========================================
echo.

call :TRY "A  normal"
call :TRY "B  no-sandbox + disable-gpu"      "--no-sandbox --disable-gpu"
call :TRY "C  B + profile on D:"             "--no-sandbox --disable-gpu" local
call :TRY "D  C + compositing off"           "--no-sandbox --disable-gpu --disable-gpu-compositing" local

echo.
echo ==========================================
echo   ALL 4 STRATEGIES FAILED
echo ==========================================
echo   Please screenshot this whole window.
goto END

:TRY
set /a N+=1
set "NAME=%~1"
set "FLAGS=%~2"
set "LOCALP=%~3"
set "LOG=%~dp0try-%N%.log"
if exist "%LOG%" del "%LOG%" >nul 2>&1

echo ---- Strategy %NAME% ----
if /i "%LOCALP%"=="local" (
  set "APPDATA=%~dp0petdata"
  if not exist "%~dp0petdata" mkdir "%~dp0petdata"
  echo      profile: %~dp0petdata
) else (
  set "APPDATA=%USERPROFILE%\AppData\Roaming"
)

start "" /b "%EL%" %FLAGS% desktop\electron\main.mjs --root desktop --backend dist\app\preview-backend.js --node "%NODE%" --preview > "%LOG%" 2>&1
ping -n 14 127.0.0.1 >nul

tasklist /fi "imagename eq electron.exe" 2>nul | find /i "electron.exe" >nul
if not errorlevel 1 (
  echo.
  echo      *** SUCCESS ***  the pet is running now.
  echo      Close the pet window when you are done.
  goto END
)

echo      result: exited
if exist "%LOG%" (
  echo      --- output ---
  type "%LOG%"
)
echo.
taskkill /f /im electron.exe >nul 2>&1
ping -n 2 127.0.0.1 >nul
goto :eof

:END
echo.
echo ==========================================
echo   DONE
echo ==========================================
echo.
pause