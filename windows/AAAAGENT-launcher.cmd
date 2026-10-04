@echo off
setlocal
cd /d "%~dp0code\desktop-pet"
if errorlevel 1 goto NODIR

set "ELECTRON_RUN_AS_NODE="
set "EL=node_modules\electron\dist\electron.exe"
set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

echo ==========================================
echo    AAAAGENT desktop pet
echo ==========================================
echo.

if not exist "%EL%" goto NODEP
if not exist "%NODE%" goto NONODE

if not exist "dist\app\preview-backend.js" call :BUILD
if not exist "desktop\build\renderer.js"   call :BUILD

echo Starting... (keep this window open; closing it stops the pet)
echo.

"%EL%" --no-sandbox --disable-gpu --disable-gpu-compositing "desktop\electron\main.mjs" --root "desktop" --backend "dist\app\preview-backend.js" --node "%NODE%" --preview

set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto DONE
if "%RC%"=="-1073741510" goto DONE

echo.
echo ==========================================
echo    AAAAGENT exited with code %RC%
echo ==========================================
echo.
echo For details run:  test-all.cmd
echo.
pause
goto DONE

:BUILD
echo Building (first run only)...
call npm.cmd run build
call npm.cmd run build:desktop
goto :eof

:NODIR
echo [ERROR] Project folder not found:
echo     %~dp0code\desktop-pet
goto ENDPAUSE

:NODEP
echo [ERROR] Dependencies missing. Run first:
echo     npm.cmd ci
goto ENDPAUSE

:NONODE
echo [ERROR] Node.js not found. Install from https://nodejs.org/
goto ENDPAUSE

:ENDPAUSE
echo.
pause

:DONE
exit /b 0