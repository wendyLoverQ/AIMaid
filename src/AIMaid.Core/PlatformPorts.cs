namespace AIMaid.Core;

public sealed record ActivitySnapshot(
    string ProcessName,
    string WindowTitle,
    string Scene,
    TimeSpan UserIdleTime,
    bool IsFullscreen);

public interface IActivityProbe
{
    Task<ActivitySnapshot> CaptureAsync(CancellationToken cancellationToken = default);
}

public interface IExternalProgramController
{
    Task<int> LaunchAsync(string executablePath, IReadOnlyList<string> arguments, string? workingDirectory, CancellationToken cancellationToken = default);
    Task<bool> IsRunningAsync(string processName, CancellationToken cancellationToken = default);
}

public interface IGlobalHotkeyRegistrar
{
    // TODO(UI): Electron 壳决定热键与页面动作的映射；核心业务只接收稳定动作 ID。
    Task RegisterAsync(string actionId, string gesture, CancellationToken cancellationToken = default);
    Task UnregisterAsync(string actionId, CancellationToken cancellationToken = default);
}

public interface IUserNotificationSink
{
    // TODO(UI): Windows 通知、macOS 通知或 Electron 通知由平台壳实现，核心不决定视觉样式。
    Task NotifyAsync(string title, string message, CancellationToken cancellationToken = default);
}
