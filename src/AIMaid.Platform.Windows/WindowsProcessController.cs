using System.Diagnostics;
using AIMaid.Core;

namespace AIMaid.Platform.Windows;

public sealed class WindowsProcessController : IExternalProgramController
{
    public Task<int> LaunchAsync(string executablePath, IReadOnlyList<string> arguments, string? workingDirectory, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var fullPath = Path.GetFullPath(Environment.ExpandEnvironmentVariables(executablePath));
        if (!File.Exists(fullPath)) throw new FileNotFoundException("外部程序不存在。", fullPath);
        var startInfo = new ProcessStartInfo
        {
            FileName = fullPath,
            WorkingDirectory = string.IsNullOrWhiteSpace(workingDirectory) ? Path.GetDirectoryName(fullPath)! : Path.GetFullPath(workingDirectory),
            UseShellExecute = false
        };
        foreach (var argument in arguments) startInfo.ArgumentList.Add(argument);
        var process = Process.Start(startInfo) ?? throw new InvalidOperationException("外部程序启动失败。");
        return Task.FromResult(process.Id);
    }

    public Task<bool> IsRunningAsync(string processName, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var normalized = Path.GetFileNameWithoutExtension(processName);
        return Task.FromResult(Process.GetProcessesByName(normalized).Length > 0);
    }
}

public sealed record PotPlayerOptions(string ExecutablePath, string? WorkingDirectory = null);

public sealed class PotPlayerMediaController : IExternalMediaController
{
    private readonly WindowsProcessController processes;
    private readonly PotPlayerOptions options;
    public PotPlayerMediaController(WindowsProcessController processes, PotPlayerOptions options)
    {
        this.processes = processes;
        this.options = options;
    }

    public Task<int> LaunchAsync(string mediaPathOrUrl, string? subtitlePath, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(mediaPathOrUrl)) throw new ArgumentException("媒体路径或地址不能为空。", nameof(mediaPathOrUrl));
        var arguments = new List<string> { mediaPathOrUrl };
        if (!string.IsNullOrWhiteSpace(subtitlePath)) arguments.Add($"/sub={Path.GetFullPath(subtitlePath)}");
        return processes.LaunchAsync(options.ExecutablePath, arguments, options.WorkingDirectory, cancellationToken);
    }
}
