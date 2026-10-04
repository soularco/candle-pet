' AAAAGENT Desktop Pet launcher
'
' Starts the pet directly with the compatibility flags that are known to work
' on this machine:
'     --no-sandbox --disable-gpu --disable-gpu-compositing
'
' Those flags are needed because Chromium cannot start its sandbox when the
' process is elevated or when a virtual display driver (Sunlogin / Oray IDD) is
' present. Running the build is skipped when the build output already exists,
' which makes startup much faster.
'
' The project path is DERIVED from this script's own folder, so this file stays
' pure ASCII and is immune to codepage problems. Keep it ASCII-only.

Option Explicit

Dim shell, fso, here, root, nodeExe, nodeDir, rc, answer, warn, needBuild
Dim ELQ, NQ, MAIN, BACK, FLAGS

Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.BuildPath(here, "code\desktop-pet")

If Not fso.FolderExists(root) Then
  MsgBox "Project folder not found:" & vbCrLf & vbCrLf & root & vbCrLf & vbCrLf & _
         "Keep this launcher inside the project's windows folder.", 16, "AAAAGENT"
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

ELQ   = Chr(34) & "node_modules\electron\dist\electron.exe" & Chr(34)
NQ    = Chr(34) & nodeExe & Chr(34)
MAIN  = "desktop\electron\main.mjs"
BACK  = "dist\app\preview-backend.js"
FLAGS = "--no-sandbox --disable-gpu --disable-gpu-compositing"

If Not fso.FileExists(fso.BuildPath(root, "node_modules\electron\dist\electron.exe")) Then
  answer = MsgBox("Dependencies are not installed yet." & vbCrLf & vbCrLf & _
                  "Install them now? Needs internet access and may take a few minutes.", _
                  33, "AAAAGENT - first run")
  If answer <> 1 Then WScript.Quit 0
  shell.CurrentDirectory = root
  If shell.Run("cmd.exe /c npm.cmd ci", 1, True) <> 0 Then
    MsgBox "Dependency installation failed. Check your network connection.", 16, "AAAAGENT"
    WScript.Quit 1
  End If
End If

warn = ""
If Not fso.FileExists(fso.BuildPath(root, "desktop\assets\local-model\pet.model3.json")) Then
  warn = warn & "- Live2D model missing; no character will appear." & vbCrLf
End If
If Not fso.FileExists(fso.BuildPath(root, "desktop\vendor\cubism\Core\live2dcubismcore.min.js")) Then
  warn = warn & "- Cubism SDK missing; rendering will fail." & vbCrLf
End If
If warn <> "" Then
  If MsgBox("Some resources are missing:" & vbCrLf & vbCrLf & warn & vbCrLf & _
            "Continue anyway?", 49, "AAAAGENT") <> 1 Then WScript.Quit 0
End If

shell.CurrentDirectory = root

rem ---- build only when the build output is missing ----
needBuild = False
If Not fso.FileExists(fso.BuildPath(root, BACK)) Then needBuild = True
If Not fso.FileExists(fso.BuildPath(root, "desktop\build\renderer.js")) Then needBuild = True

If needBuild Then
  rc = shell.Run("cmd.exe /c npm.cmd run build && npm.cmd run build:desktop", 0, True)
  If rc <> 0 Then
    MsgBox "Build failed (code " & rc & ")." & vbCrLf & vbCrLf & _
           "Open a command prompt in:" & vbCrLf & root & vbCrLf & vbCrLf & _
           "and run:  npm.cmd run build", 16, "AAAAGENT"
    WScript.Quit 1
  End If
End If

rem ---- launch the pet ----
rc = shell.Run("cmd.exe /c " & ELQ & " " & FLAGS & " " & MAIN & " --root desktop --backend " & BACK & _
               " --node " & NQ & " --preview", 0, True)
If rc = 0 Or rc = -1073741510 Then WScript.Quit 0

rem ---- fallback: try without the compatibility flags ----
rc = shell.Run("cmd.exe /c " & ELQ & " " & MAIN & " --root desktop --backend " & BACK & _
               " --node " & NQ & " --preview", 0, True)
If rc = 0 Or rc = -1073741510 Then WScript.Quit 0

MsgBox "AAAAGENT could not start (code " & rc & ")." & vbCrLf & vbCrLf & _
       "Please run this file and send a screenshot of the window:" & vbCrLf & _
       root & "\test-all.cmd", 48, "AAAAGENT"


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