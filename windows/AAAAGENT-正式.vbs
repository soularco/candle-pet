' AAAAGENT desktop pet - formal mode, no console window at all
'
' AAAAGENT-launcher-formal.cmd runs "npm.cmd start", which keeps the pet
' attached to a cmd window: closing that window kills the backend and the pet,
' leaving a character that cannot chat. Launching Electron directly from this
' script avoids the console entirely, so the pet keeps running until it is quit
' from inside the app (menu, Alt+F4, or the 退出 button).
'
' This mirrors what tools/../app/trial-launcher does: same entry point, same
' backend, same environment variables. The only difference is that the runtime
' fingerprint check happens inside the backend instead of before the spawn, so
' a fingerprint mismatch surfaces as a connection failure rather than a message.
'
' The project path is DERIVED from this script's own folder, so this file stays
' pure ASCII and is immune to codepage problems. Keep it ASCII-only.

Option Explicit

Dim shell, fso, here, root, nodeExe, nodeDir, desktop, backend, config, activation, command

Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.BuildPath(here, "code\desktop-pet")

If Not fso.FolderExists(root) Then
  MsgBox "Project folder not found:" & vbCrLf & vbCrLf & root & vbCrLf & vbCrLf & _
         "Keep this launcher inside the project's windows folder.", 16, "AAAAGENT"
  WScript.Quit 1
End If

config     = fso.BuildPath(here, ".local\model-evaluation\trial\user-trial\config.json")
activation = fso.BuildPath(here, ".local\model-evaluation\trial\user-trial\activation.json")
If Not fso.FileExists(config) Or Not fso.FileExists(activation) Then
  MsgBox "AAAAGENT is not configured yet." & vbCrLf & vbCrLf & _
         "Run this first, inside code\desktop-pet:" & vbCrLf & _
         "    npm.cmd run configure-local", 48, "AAAAGENT"
  WScript.Quit 1
End If

Dim electron
electron = fso.BuildPath(root, "node_modules\electron\dist\electron.exe")
If Not fso.FileExists(electron) Then
  MsgBox "Electron is not installed yet." & vbCrLf & vbCrLf & _
         "Run this first, inside code\desktop-pet:" & vbCrLf & _
         "    npm.cmd ci", 48, "AAAAGENT"
  WScript.Quit 1
End If

nodeExe = FindNode(shell, fso)
If nodeExe = "" Then
  MsgBox "Node.js was not found." & vbCrLf & vbCrLf & _
         "Install Node.js LTS from https://nodejs.org/ and run this again.", 16, "AAAAGENT"
  WScript.Quit 1
End If

nodeDir = fso.GetParentFolderName(nodeExe)
shell.Environment("PROCESS")("PATH") = nodeDir & ";" & shell.ExpandEnvironmentStrings("%PATH%")
shell.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = ""
shell.Environment("PROCESS")("PET_TRIAL_CONFIG") = config
shell.Environment("PROCESS")("PET_TRIAL_ACTIVATION") = activation

desktop = fso.BuildPath(root, "desktop")
backend = fso.BuildPath(root, "dist\app\trial-backend.js")

Dim q
q = Chr(34)
command = q & electron & q & " " & _
          q & fso.BuildPath(desktop, "electron\main.mjs") & q & " " & _
          "--root " & q & desktop & q & " " & _
          "--backend " & q & backend & q & " " & _
          "--node " & q & nodeExe & q & " " & _
          "--no-sandbox --disable-gpu --disable-gpu-compositing"

shell.CurrentDirectory = root
' No console is created for a GUI executable, so nothing can be closed to kill
' the pet. Do not wait: the pet outlives this script.
shell.Run command, 1, False


Function FindNode(sh, fs)
  Dim c, i, p, parts, j
  FindNode = ""
  c = Array( _
    sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe", _
    sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\nodejs\node.exe", _
    sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe", _
    sh.ExpandEnvironmentStrings("%SystemDrive%") & "\nodejs\node.exe" )
  For i = 0 To UBound(c)
    If fs.FileExists(c(i)) Then
      FindNode = c(i)
      Exit Function
    End If
  Next
  p = sh.ExpandEnvironmentStrings("%PATH%")
  parts = Split(p, ";")
  For j = 0 To UBound(parts)
    If Len(Trim(parts(j))) > 0 Then
      If fs.FileExists(Trim(parts(j)) & "\node.exe") Then
        FindNode = Trim(parts(j)) & "\node.exe"
        Exit Function
      End If
    End If
  Next
End Function
