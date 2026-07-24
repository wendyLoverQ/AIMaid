using System.Diagnostics;
using AIMaid.Core;

namespace AIMaid.Platform.Windows;

public sealed class WindowsProcessController : IExternalProgramController
{
    public Task<int> LaunchAsync(string executablePath, IReadOnlyList<string> arguments, string? workingDirectory, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var expandedPath = Environment.ExpandEnvironmentVariables(executablePath);
        if (!Path.IsPathFullyQualified(expandedPath)) throw new ArgumentException("外部程序路径必须是绝对路径。", nameof(executablePath));
        var fullPath = Path.GetFullPath(expandedPath);
        if (!File.Exists(fullPath)) throw new FileNotFoundException("外部程序不存在。", fullPath);
        var startInfo = new ProcessStartInfo
        {
            FileName = fullPath,
            WorkingDirectory = ResolveWorkingDirectory(fullPath, workingDirectory),
            UseShellExecute = true
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

    private static string ResolveWorkingDirectory(string executablePath, string? workingDirectory)
    {
        if (string.IsNullOrWhiteSpace(workingDirectory)) return Path.GetDirectoryName(executablePath)!;
        var expanded = Environment.ExpandEnvironmentVariables(workingDirectory);
        if (!Path.IsPathFullyQualified(expanded)) throw new ArgumentException("工作目录必须是绝对路径。", nameof(workingDirectory));
        return Path.GetFullPath(expanded);
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
