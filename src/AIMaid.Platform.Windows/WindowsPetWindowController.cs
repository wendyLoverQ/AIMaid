using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;

namespace AIMaid.Platform.Windows;

public static class WindowsPetWindowController
{
    private const int SmXVirtualScreen = 76;
    private const int SmYVirtualScreen = 77;
    private const int SmCxVirtualScreen = 78;
    private const int SmCyVirtualScreen = 79;
    private const uint SwpNoZOrder = 0x0004;
    private const uint SwpNoActivate = 0x0010;
    private const uint SwpShowWindow = 0x0040;
    private static readonly nint PerMonitorAwareV2 = new(-4);

    public static PetWindowBounds FitVirtualDesktop(string windowHandle)
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Virtual desktop window fitting requires Windows.");

        var rawHandle = ulong.Parse(windowHandle, NumberStyles.None, CultureInfo.InvariantCulture);
        var handle = unchecked((nint)rawHandle);
        if (handle == 0)
            throw new ArgumentOutOfRangeException(nameof(windowHandle));

        var previousDpiContext = SetThreadDpiAwarenessContext(PerMonitorAwareV2);
        try
        {
            var bounds = new PetWindowBounds(
                GetSystemMetrics(SmXVirtualScreen),
                GetSystemMetrics(SmYVirtualScreen),
                GetSystemMetrics(SmCxVirtualScreen),
                GetSystemMetrics(SmCyVirtualScreen));

            if (bounds.Width <= 0 || bounds.Height <= 0)
                throw new InvalidOperationException("Windows returned an invalid virtual desktop rectangle.");

            if (!SetWindowPos(handle, 0, bounds.X, bounds.Y, bounds.Width, bounds.Height,
                    SwpNoZOrder | SwpNoActivate | SwpShowWindow))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetWindowPos failed for the pet virtual desktop window.");

            return bounds;
        }
        finally
        {
            if (previousDpiContext != 0)
                SetThreadDpiAwarenessContext(previousDpiContext);
        }
    }

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    private static extern nint SetThreadDpiAwarenessContext(nint dpiContext);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(nint window, nint insertAfter, int x, int y, int width, int height, uint flags);
}

public sealed record PetWindowBounds(int X, int Y, int Width, int Height);
