@echo off
cd /d "D:\aaa\AAAAGENT\windows\code\desktop-pet"
set "PET_TRIAL_CONFIG=D:\aaa\AAAAGENT\windows\.local\model-evaluation\trial\user-trial\config.json"
set "PET_TRIAL_ACTIVATION=D:\aaa\AAAAGENT\windows\.local\model-evaluation\trial\user-trial\activation.json"
set "ELECTRON_RUN_AS_NODE="
"node_modules\electron\dist\electron.exe" "desktop\electron\main.mjs" --root "desktop" --backend "dist\app\trial-backend.js" --node "C:\Program Files\nodejs\node.exe" --no-sandbox --disable-gpu --disable-gpu-compositing --remote-debugging-port=9222 > "D:\aaa\AAAAGENT\_o.log" 2> "D:\aaa\AAAAGENT\_e.log"
