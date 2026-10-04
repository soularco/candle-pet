// AAAAGENT desktop pet launcher.
//
// Why this exists: the previous entry points were a .cmd file (which keeps a
// black console window attached to the pet, and closing it killed the backend)
// and a .vbs file (no console, but no icon, no shortcut-friendly identity, and
// it still paid npm's process-launch overhead). This is a real WinExe: no
// console window at all, its own icon, and it starts the pet by going straight
// to the official entry point instead of hopping through npm.
//
// It resolves the project from its own location, so a shortcut placed anywhere
// still finds the right folder.

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

static class Program
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, string commandLine, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SetCurrentProcessExplicitAppUserModelID(string id);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint DETACHED_PROCESS = 0x00000008;

    [STAThread]
    static int Main(string[] args)
    {
        try { SetCurrentProcessExplicitAppUserModelID("AAAAGENT.DesktopPet"); } catch { }

        string here = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        string root = FindProject(here);
        if (root == null)
        {
            MessageBox.Show(
                "找不到 AAAAGENT 项目文件夹。\r\n\r\n" +
                "请把这个 exe 放在项目目录里（与 windows 文件夹同级），\r\n" +
                "或者放在它的上一级目录。\r\n\r\n" +
                "Looked from:\r\n" + here,
                "AAAAGENT", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        string activation = Path.Combine(root, @"windows\.local\model-evaluation\trial\user-trial\activation.json");
        if (!File.Exists(activation))
        {
            MessageBox.Show(
                "AAAAGENT 还没有完成正式配置。\r\n\r\n" +
                "请先在下面的目录里运行一次：\r\n" +
                "    npm.cmd run configure-local\r\n\r\n" + root,
                "AAAAGENT", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }

        string node = FindNode();
        if (node == null)
        {
            MessageBox.Show(
                "没有找到 Node.js。\r\n\r\n" +
                "请从 https://nodejs.org/ 安装 Node.js LTS 后重试。",
                "AAAAGENT", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        string entry = Path.Combine(root, @"windows\code\desktop-pet\dist\app\trial-launcher.js");
        Log("root=" + root);
        Log("entry=" + entry + " exists=" + File.Exists(entry));
        if (!File.Exists(entry))
        {
            MessageBox.Show(
                "缺少构建产物：\r\n" + entry + "\r\n\r\n" +
                "请先在项目目录里运行：\r\n    npm.cmd run build",
                "AAAAGENT", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }

        // The pet must outlive this launcher, and it must never own a console.
        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION pi;

        string commandLine = Quote(node) + " " + Quote(entry);
        string cwd = Path.Combine(root, @"windows\code\desktop-pet");
        if (!Directory.Exists(cwd)) cwd = root;
        Log("node=" + node);
        Log("cwd=" + cwd);
        Log("cmd=" + commandLine);

        // CREATE_NO_WINDOW hides the child console; DETACHED_PROCESS is not used
        // because Electron still wants a normal (invisible) console allocation.
        bool ok = CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, false,
            CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref si, out pi);
        if (!ok)
        {
            int error = Marshal.GetLastWin32Error();
            Log("CreateProcess failed: " + error);
            MessageBox.Show("启动失败（错误码 " + error + "）。\r\n\r\n" + commandLine,
                "AAAAGENT", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        Log("spawned pid=" + pi.dwProcessId);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        return 0;
    }

    /// <summary>Diagnostics next to the exe; harmless when it cannot be written.</summary>
    static void Log(string message)
    {
        try
        {
            string path = Path.Combine(Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location), "AAAAGENT-launch.log");
            File.AppendAllText(path, DateTime.Now.ToString("HH:mm:ss.fff") + "  " + message + "\r\n", Encoding.UTF8);
        }
        catch { }
    }

    /// <summary>Walks up a few levels looking for the folder that owns windows\code\desktop-pet.</summary>
    static string FindProject(string start)
    {
        string dir = start;
        for (int depth = 0; depth < 4 && dir != null; depth++)
        {
            if (Directory.Exists(Path.Combine(dir, @"windows\code\desktop-pet"))) return dir;
            DirectoryInfo parent = Directory.GetParent(dir);
            dir = parent == null ? null : parent.FullName;
        }
        // Also accept being placed inside windows\ itself.
        if (Directory.Exists(Path.Combine(start, @"code\desktop-pet")))
        {
            DirectoryInfo parent = Directory.GetParent(start);
            if (parent != null) return parent.FullName;
        }
        return null;
    }

    static string FindNode()
    {
        string[] candidates =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"nodejs\node.exe"),
            Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "", @"Programs\nodejs\node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), @".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"),
            @"C:\nodejs\node.exe",
        };
        foreach (string candidate in candidates)
            if (!string.IsNullOrEmpty(candidate) && File.Exists(candidate)) return candidate;

        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string part in path.Split(';'))
        {
            string trimmed = part.Trim();
            if (trimmed.Length == 0) continue;
            try { string full = Path.Combine(trimmed, "node.exe"); if (File.Exists(full)) return full; }
            catch { }
        }
        return null;
    }

    static string Quote(string value) { return value.IndexOf(' ') >= 0 ? "\"" + value + "\"" : value; }
}
