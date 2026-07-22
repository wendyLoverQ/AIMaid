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

    public static PetWindowBounds MapClientRectangle(
        string windowHandle,
        double x,
        double y,
        double width,
        double height,
        double viewportWidth,
        double viewportHeight)
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("PET coordinate mapping requires Windows.");
        if (!double.IsFinite(x) || !double.IsFinite(y) || !double.IsFinite(width) || !double.IsFinite(height) ||
            !double.IsFinite(viewportWidth) || !double.IsFinite(viewportHeight) ||
            width <= 0 || height <= 0 || viewportWidth <= 0 || viewportHeight <= 0)
            throw new ArgumentOutOfRangeException(nameof(width), "PET client rectangle values must be finite and positive.");

        var rawHandle = ulong.Parse(windowHandle, NumberStyles.None, CultureInfo.InvariantCulture);
        var handle = unchecked((nint)rawHandle);
        if (handle == 0)
            throw new ArgumentOutOfRangeException(nameof(windowHandle));

        var previousDpiContext = SetThreadDpiAwarenessContext(PerMonitorAwareV2);
        try
        {
            if (!GetClientRect(handle, out var clientRect))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetClientRect failed for the PET window.");

            var clientWidth = clientRect.Right - clientRect.Left;
            var clientHeight = clientRect.Bottom - clientRect.Top;
            if (clientWidth <= 0 || clientHeight <= 0)
                throw new InvalidOperationException("Windows returned an invalid PET client rectangle.");

            var mapped = new NativeRect(
                ScaleEdge(x, viewportWidth, clientWidth),
                ScaleEdge(y, viewportHeight, clientHeight),
                ScaleEdge(x + width, viewportWidth, clientWidth),
                ScaleEdge(y + height, viewportHeight, clientHeight));

            SetLastError(0);
            var offset = MapWindowPoints(handle, 0, ref mapped, 2);
            var error = Marshal.GetLastWin32Error();
            if (offset == 0 && error != 0)
                throw new Win32Exception(error, "MapWindowPoints failed for the PET rectangle.");

            return new PetWindowBounds(mapped.Left, mapped.Top, mapped.Right - mapped.Left, mapped.Bottom - mapped.Top);
        }
        finally
        {
            if (previousDpiContext != 0)
                SetThreadDpiAwarenessContext(previousDpiContext);
        }
    }

    private static int ScaleEdge(double value, double viewportSize, int clientSize)
        => checked((int)Math.Round(value * clientSize / viewportSize, MidpointRounding.AwayFromZero));

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    private static extern nint SetThreadDpiAwarenessContext(nint dpiContext);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(nint window, nint insertAfter, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetClientRect(nint window, out NativeRect rectangle);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int MapWindowPoints(nint fromWindow, nint toWindow, ref NativeRect points, uint pointCount);

    [DllImport("kernel32.dll")]
    private static extern void SetLastError(uint errorCode);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect(int left, int top, int right, int bottom)
    {
        public int Left = left;
        public int Top = top;
        public int Right = right;
        public int Bottom = bottom;
    }
}

public sealed record PetWindowBounds(int X, int Y, int Width, int Height);
