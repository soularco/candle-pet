@echo off
setlocal
cd /d "%~dp0code\desktop-pet"
if errorlevel 1 goto NODIR

set "ELECTRON_RUN_AS_NODE="
set "CFG=..\..\.local\model-evaluation\trial\user-trial"
set "LOCK=..\..\.local\model-evaluation\backend.lock"

echo ==========================================
echo    AAAAGENT  -  formal mode
echo ==========================================
echo.

if not exist "dist\app\trial-launcher.js" goto NOBUILD
if not exist "%CFG%\activation.json" goto NOCONFIG

rem ---- clear a stale backend lock left by a crashed run ----
if exist "%LOCK%" (
  node -e "const fs=require('fs');const p=process.argv[1];try{const j=JSON.parse(fs.readFileSync(p,'utf8'));let alive=false;try{process.kill(j.pid,0);alive=true}catch(e){};if(alive){console.log('  backend lock is held by a live process - not touching it')}else{fs.unlinkSync(p);console.log('  removed a stale backend lock')}}catch(e){}" "%LOCK%"
)

echo Starting... keep this window open.
echo Closing this window stops the pet.
echo.
call npm.cmd start
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto DONE
if "%RC%"=="-1073741510" goto DONE

echo.
echo ==========================================
echo    AAAAGENT exited with code %RC%
echo ==========================================
echo.
echo Try the diagnostic:  test-all.cmd
echo.
pause
goto DONE

:NODIR
echo [ERROR] Project folder not found.
goto ENDPAUSE
:NOBUILD
echo [ERROR] Not built yet. Run:  npm.cmd run build:windows
goto ENDPAUSE
:NOCONFIG
echo [ERROR] Not configured yet. First run:  npm.cmd run configure-local
goto ENDPAUSE
:ENDPAUSE
echo.
pause
:DONE
exit /b 0