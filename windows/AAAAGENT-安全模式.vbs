' AAAAGENT Desktop Pet - SAFE MODE launcher
'
' Use this when the normal launcher fails. It forces software-friendly
' Chromium flags that work around broken/virtual display drivers:
'   --no-sandbox        skip the Chromium sandbox
'   --disable-gpu       do not use GPU acceleration
'   --disable-gpu-compositing
'
' Like the normal launcher, the project path is DERIVED from this script's
' own folder so the file stays pure ASCII and immune to codepage problems.

Option Explicit

Dim shell, fso, here, root, nodeExe, rc, nodeDir
Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.BuildPath(here, "code\desktop-pet")

If Not fso.FolderExists(root) Then
  MsgBox "Project folder not found:" & vbCrLf & vbCrLf & root, 16, "AAAAGENT"
  WScript.Quit 1
End If

nodeExe = FindNode(shell, fso)
If nodeExe = "" Then
  MsgBox "Node.js was not found on this computer." & vbCrLf & vbCrLf & _
         "Install Node.js LTS from https://nodejs.org/", 16, "AAAAGENT"
  WScript.Quit 1
End If

nodeDir = fso.GetParentFolderName(nodeExe)
shell.Environment("PROCESS")("PATH") = nodeDir & ";" & shell.ExpandEnvironmentStrings("%PATH%")
shell.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = ""

If Not fso.FileExists(fso.BuildPath(root, "node_modules\electron\dist\electron.exe")) Then
  MsgBox "Dependencies are not installed yet." & vbCrLf & vbCrLf & _
         "Run this first inside the project:" & vbCrLf & _
         "    npm.cmd ci", 16, "AAAAGENT"
  WScript.Quit 1
End If

' Build first (safe, no GUI), then launch with compatibility flags.
shell.CurrentDirectory = root

Dim cmd
cmd = "cmd.exe /k npm.cmd run build && npm.cmd run build:desktop && " & _
      """node_modules\electron\dist\electron.exe"" --no-sandbox --disable-gpu --disable-gpu-compositing " & _
      """desktop\electron\main.mjs"" --root ""desktop"" --backend ""dist\app\preview-backend.js"" " & _
      "--node """ & nodeExe & """ --preview"

rc = shell.Run(cmd, 1, True)

If rc <> 0 And rc <> -1073741510 Then
  MsgBox "Safe mode also exited with code " & rc & "." & vbCrLf & vbCrLf & _
         "Please run the diagnostic:" & vbCrLf & _
         "    windows\??????.cmd" & vbCrLf & vbCrLf & _
         "and send the window contents.", 48, "AAAAGENT"
End If


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
