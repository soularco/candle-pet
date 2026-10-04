// AAAAGENT focus reporter.
//
// The pet needs to know whether somebody is in a fullscreen game, a video call
// or a presentation before it decides to start talking. Electron cannot see
// other applications' windows, and asking PowerShell costs about 300 ms per
// call, so this tiny resident helper prints one JSON line every couple of
// seconds instead. It is spawned hidden and killed with the pet.
//
// Output per line:
//   {"title":"...","process":"chrome","pid":1234,"fullscreen":true,
//    "left":0,"top":0,"width":1920,"height":1080}
//
// Usage:  AAAAGENT-focus.exe [--interval <ms>] [--ignore <pid>]

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Focus
{
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfoW(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr hWnd, int index);
    // QueryFullProcessImageNameW works for elevated processes, where
    // Process.GetProcessById would throw an access denied.
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageNameW(IntPtr handle, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    const uint MONITOR_DEFAULTTONEAREST = 2;
    const int GWL_STYLE = -16;
    const int WS_CAPTION = 0x00C00000;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    static int Main(string[] args)
    {
        int interval = 2000;
        int ignorePid = 0;
        for (int i = 0; i < args.Length - 1; i++)
        {
            int parsed;
            if (args[i] == "--interval" && int.TryParse(args[i + 1], out parsed)) interval = Math.Max(300, parsed);
            if (args[i] == "--ignore" && int.TryParse(args[i + 1], out parsed)) ignorePid = parsed;
        }

        Console.OutputEncoding = Encoding.UTF8;
        while (true)
        {
            try { Console.WriteLine(Describe(ignorePid)); }
            catch { /* a transient Win32 failure just skips one sample */ }
            Console.Out.Flush();
            Thread.Sleep(interval);
        }
    }

    static string Describe(int ignorePid)
    {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero || hwnd == GetShellWindow() || !IsWindowVisible(hwnd) || IsIconic(hwnd))
            return "{\"idle\":true}";

        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (ignorePid != 0 && pid == ignorePid) return "{\"self\":true}";

        string title = Title(hwnd);
        string process = ProcessName(pid);

        RECT rect;
        bool hasRect = GetWindowRect(hwnd, out rect);
        bool fullscreen = false;
        if (hasRect)
        {
            IntPtr monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            var info = new MONITORINFO();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (GetMonitorInfoW(monitor, ref info))
            {
                // Covering the monitor is not enough: a merely maximized window does
                // that too, and the pet should still be allowed to speak then. Real
                // fullscreen also drops the caption (games, video, presentations),
                // so require both.
                const int slack = 2;
                bool covers = rect.Left <= info.rcMonitor.Left + slack
                    && rect.Top <= info.rcMonitor.Top + slack
                    && rect.Right >= info.rcMonitor.Right - slack
                    && rect.Bottom >= info.rcMonitor.Bottom - slack;
                bool borderless = (GetWindowLongW(hwnd, GWL_STYLE) & WS_CAPTION) == 0;
                fullscreen = covers && borderless;
            }
        }

        var sb = new StringBuilder(256);
        sb.Append('{');
        sb.Append("\"title\":").Append(Quote(title)).Append(',');
        sb.Append("\"process\":").Append(Quote(process)).Append(',');
        sb.Append("\"pid\":").Append(pid).Append(',');
        sb.Append("\"fullscreen\":").Append(fullscreen ? "true" : "false").Append(',');
        sb.Append("\"left\":").Append(hasRect ? rect.Left : 0).Append(',');
        sb.Append("\"top\":").Append(hasRect ? rect.Top : 0).Append(',');
        sb.Append("\"width\":").Append(hasRect ? Math.Max(0, rect.Right - rect.Left) : 0).Append(',');
        sb.Append("\"height\":").Append(hasRect ? Math.Max(0, rect.Bottom - rect.Top) : 0);
        sb.Append('}');
        return sb.ToString();
    }

    /** Executable base name, without the .exe suffix. Best effort only. */
    static string ProcessName(uint pid)
    {
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle == IntPtr.Zero) return "";
        try
        {
            var buffer = new StringBuilder(1024);
            int size = buffer.Capacity;
            if (!QueryFullProcessImageNameW(handle, 0, buffer, ref size)) return "";
            string full = buffer.ToString(0, size);
            int slash = full.LastIndexOf('\\');
            string name = slash >= 0 ? full.Substring(slash + 1) : full;
            if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 4);
            return name;
        }
        finally { CloseHandle(handle); }
    }

    /** Raw window title, unescaped. Quote() does the JSON escaping exactly once. */
    static string Title(IntPtr hwnd)
    {
        var buffer = new StringBuilder(512);
        int length = GetWindowTextW(hwnd, buffer, buffer.Capacity);
        return length > 0 ? buffer.ToString(0, length) : "";
    }

    static string Quote(string value)
    {
        var sb = new StringBuilder(value.Length + 2);
        sb.Append('"');
        int kept = 0;
        foreach (char c in value)
        {
            // Keep titles short so a pathological one cannot flood the pipe.
            if (kept++ >= 120) break;
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < ' ') sb.Append(' ');
            else sb.Append(c);
        }
        sb.Append('"');
        return sb.ToString();
    }
}
