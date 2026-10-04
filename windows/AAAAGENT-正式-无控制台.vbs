' AAAAGENT desktop pet - formal mode, NO console window
'
' The console launcher (AAAAGENT-launcher-formal.cmd) keeps the pet attached to
' a cmd window: closing that window kills the backend and the pet, which leaves
' the user with a character that cannot chat. This launcher runs the same
' official entry point with the console hidden, so the pet keeps running until
' it is quit from inside the app.
'
' The project path is DERIVED from this script's own folder, so this file stays
' pure ASCII and is immune to codepage problems. Keep it ASCII-only.

Option Explicit

Dim shell, fso, here, root, nodeExe, nodeDir, activation, command
Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.BuildPath(here, "code\desktop-pet")

If Not fso.FolderExists(root) Then
  MsgBox "Project folder not found:" & vbCrLf & vbCrLf & root & vbCrLf & vbCrLf & _
         "Keep this launcher inside the project's windows folder.", 16, "AAAAGENT"
  WScript.Quit 1
End If

activation = fso.BuildPath(here, ".local\model-evaluation\trial\user-trial\activation.json")
If Not fso.FileExists(activation) Then
  MsgBox "AAAAGENT is not configured yet." & vbCrLf & vbCrLf & _
         "Run this first, inside code\desktop-pet:" & vbCrLf & _
         "    npm.cmd run configure-local", 48, "AAAAGENT"
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
' Let the launcher patch pick the Chromium compatibility switches.
shell.Environment("PROCESS")("PET_ELECTRON_FLAGS") = ""

shell.CurrentDirectory = root
' 0 = hidden console, do not wait. The pet outlives this script.
shell.Run "cmd.exe /c npm.cmd start", 0, False


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
