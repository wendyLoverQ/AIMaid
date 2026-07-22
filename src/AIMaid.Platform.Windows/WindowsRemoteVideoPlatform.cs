using System.Diagnostics;
using AIMaid.Core;

namespace AIMaid.Platform.Windows;

public sealed class WindowsRemoteVideoPlatform : IRemoteVideoPlatform
{
    public async Task<RemoteToolExecutionResult> RunToolAsync(
        string executablePath, IReadOnlyList<string> arguments,
        Action<string>? standardErrorLine = null, CancellationToken cancellationToken = default)
    {
        var executable = ResolveExecutable(executablePath);
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            WorkingDirectory = Path.GetDirectoryName(executable)!,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        foreach (var argument in arguments) startInfo.ArgumentList.Add(argument);
        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("外部视频工具启动失败。");
        try
        {
            var outputTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
            var errors = new List<string>();
            while (await process.StandardError.ReadLineAsync(cancellationToken) is { } line)
            {
                errors.Add(line);
                standardErrorLine?.Invoke(line);
            }
            await process.WaitForExitAsync(cancellationToken);
            return new RemoteToolExecutionResult(process.ExitCode, await outputTask, string.Join(Environment.NewLine, errors));
        }
        catch (OperationCanceledException)
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { }
            throw;
        }
    }

    public Task<int> LaunchMediaAsync(string executablePath, RemoteMediaLaunchRequest request, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(request.Source)) throw new ArgumentException("媒体地址不能为空。", nameof(request));
        var executable = ResolveExecutable(executablePath);
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            WorkingDirectory = Path.GetDirectoryName(executable)!,
            UseShellExecute = false
        };
        startInfo.ArgumentList.Add("/current");
        startInfo.ArgumentList.Add(request.Source);
        if (!string.IsNullOrWhiteSpace(request.AudioSource)) startInfo.ArgumentList.Add($"/aud={request.AudioSource}");
        if (!string.IsNullOrWhiteSpace(request.UserAgent)) startInfo.ArgumentList.Add($"/user_agent={request.UserAgent}");
        if (!string.IsNullOrWhiteSpace(request.Referer)) startInfo.ArgumentList.Add($"/referer={request.Referer}");
        if (!string.IsNullOrWhiteSpace(request.Title)) startInfo.ArgumentList.Add($"/title={request.Title}");
        var process = Process.Start(startInfo) ?? throw new InvalidOperationException("PotPlayer 启动失败。");
        return Task.FromResult(process.Id);
    }

    private static string ResolveExecutable(string executablePath)
    {
        var expanded = Environment.ExpandEnvironmentVariables(executablePath);
        if (!Path.IsPathFullyQualified(expanded)) throw new ArgumentException("工具路径必须是绝对路径。", nameof(executablePath));
        var fullPath = Path.GetFullPath(expanded);
        if (!File.Exists(fullPath)) throw new FileNotFoundException("外部视频工具不存在。", fullPath);
        return fullPath;
    }
}
