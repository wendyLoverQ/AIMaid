using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using AIMaid.Core;

namespace AIMaid.Platform.Windows;

public sealed class WindowsActivityProbe : IActivityProbe
{
    public Task<ActivitySnapshot> CaptureAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var window = GetForegroundWindow();
        var title = GetWindowTitle(window);
        _ = GetWindowThreadProcessId(window, out var processId);
        var processName = "unknown";
        try
        {
            processName = processId == 0 ? "unknown" : Process.GetProcessById((int)processId).ProcessName;
        }
        catch (ArgumentException)
        {
            processName = "unknown";
        }

        return Task.FromResult(new ActivitySnapshot(
            processName,
            title,
            DetectScene(processName, title),
            GetUserIdleTime(),
            IsFullscreenWindow(window)));
    }

    private static string DetectScene(string processName, string title)
    {
        var text = $"{processName} {title}".ToLowerInvariant();
        if (ContainsAny(text, "devenv", "rider", "idea", "code", "visual studio", "github", "terminal", "powershell"))
            return "coding";
        if (ContainsAny(text, "steam", "unity", "genshin", "game", "valorant", "league"))
            return "gaming";
        if (ContainsAny(text, "potplayer", "vlc", "bilibili", "youtube", "netflix", "video"))
            return "video";
        if (ContainsAny(text, "chrome", "edge", "firefox", "browser"))
            return "browsing";
        return "unknown";
    }

    private static bool ContainsAny(string text, params string[] values)
        => values.Any(value => text.Contains(value, StringComparison.OrdinalIgnoreCase));

    private static string GetWindowTitle(nint window)
    {
        var length = GetWindowTextLength(window);
        if (length <= 0) return string.Empty;
        var builder = new StringBuilder(length + 1);
        _ = GetWindowText(window, builder, builder.Capacity);
        return builder.ToString();
    }

    private static TimeSpan GetUserIdleTime()
    {
        var info = new LastInputInfo { CbSize = (uint)Marshal.SizeOf<LastInputInfo>() };
        return GetLastInputInfo(ref info)
            ? TimeSpan.FromMilliseconds(Math.Max(0, Environment.TickCount64 - info.DwTime))
            : TimeSpan.Zero;
    }

    private static bool IsFullscreenWindow(nint window)
    {
        if (window == nint.Zero || !GetWindowRect(window, out var rectangle)) return false;
        var monitor = MonitorFromWindow(window, 2);
        if (monitor == nint.Zero) return false;
        var info = new MonitorInfo { CbSize = (uint)Marshal.SizeOf<MonitorInfo>() };
        if (!GetMonitorInfo(monitor, ref info)) return false;
        return rectangle.Left <= info.RcMonitor.Left &&
               rectangle.Top <= info.RcMonitor.Top &&
               rectangle.Right >= info.RcMonitor.Right &&
               rectangle.Bottom >= info.RcMonitor.Bottom;
    }

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(nint window, StringBuilder text, int count);
    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(nint window);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(nint window, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LastInputInfo info);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(nint window, out Rectangle rectangle);
    [DllImport("user32.dll")]
    private static extern nint MonitorFromWindow(nint window, uint flags);
    [DllImport("user32.dll")]
    private static extern bool GetMonitorInfo(nint monitor, ref MonitorInfo info);

    [StructLayout(LayoutKind.Sequential)]
    private struct LastInputInfo { public uint CbSize; public uint DwTime; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Rectangle { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public uint CbSize;
        public Rectangle RcMonitor;
        public Rectangle RcWork;
        public uint DwFlags;
    }
}
