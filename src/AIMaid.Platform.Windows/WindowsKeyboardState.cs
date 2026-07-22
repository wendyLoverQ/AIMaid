using System.Runtime.InteropServices;

namespace AIMaid.Platform.Windows;

public static class WindowsKeyboardState
{
    public static async Task WaitForReleaseAsync(IReadOnlyCollection<int> virtualKeys, CancellationToken cancellationToken)
    {
        if (virtualKeys.Count == 0)
            throw new ArgumentException("At least one virtual key is required.", nameof(virtualKeys));
        if (virtualKeys.Any(key => key is < 1 or > 255))
            throw new ArgumentOutOfRangeException(nameof(virtualKeys));

        while (virtualKeys.All(IsPressed))
            await Task.Delay(8, cancellationToken);
    }

    private static bool IsPressed(int virtualKey) => (GetAsyncKeyState(virtualKey) & 0x8000) != 0;

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int virtualKey);
}
