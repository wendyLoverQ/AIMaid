using System.Diagnostics;
using System.Text.Json;
using AIMaid.Contracts.Domains;
using AIMaid.Core;

namespace AIMaid.Platform.Windows;

public sealed record YtDlpOptions(string ExecutablePath);

public sealed class YtDlpRemoteMediaResolver : IRemoteMediaResolver
{
    private readonly string executablePath;

    public YtDlpRemoteMediaResolver(YtDlpOptions options)
    {
        executablePath = Path.GetFullPath(Environment.ExpandEnvironmentVariables(options.ExecutablePath));
    }

    public async Task<string> ResolveAsync(string url, RemoteSiteDto? site, CancellationToken cancellationToken = default)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
            throw new ArgumentException("远程媒体地址必须是 HTTP 或 HTTPS。", nameof(url));
        if (!File.Exists(executablePath)) throw new FileNotFoundException("yt-dlp 不存在，请通过设置页配置。", executablePath);
        var startInfo = CreateStartInfo();
        startInfo.ArgumentList.Add("--no-playlist");
        startInfo.ArgumentList.Add("--no-warnings");
        startInfo.ArgumentList.Add("-f");
        startInfo.ArgumentList.Add(string.IsNullOrWhiteSpace(site?.QualityPreference) ? "best" : site.QualityPreference);
        startInfo.ArgumentList.Add("-g");
        startInfo.ArgumentList.Add(uri.AbsoluteUri);
        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("yt-dlp 启动失败。");
        var outputTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var errorTask = process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken);
        var output = (await outputTask).Trim();
        var error = (await errorTask).Trim();
        if (process.ExitCode != 0) throw new InvalidOperationException(string.IsNullOrWhiteSpace(error) ? $"yt-dlp 退出码 {process.ExitCode}。" : error);
        return output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()
            ?? throw new InvalidDataException("yt-dlp 未返回媒体地址。");
    }

    private ProcessStartInfo CreateStartInfo() => new()
    {
        FileName = executablePath,
        WorkingDirectory = Path.GetDirectoryName(executablePath)!,
        UseShellExecute = false,
        CreateNoWindow = true,
        RedirectStandardOutput = true,
        RedirectStandardError = true
    };
}

public sealed class ExternalProgramAgentExecutor : IAgentCapabilityExecutor
{
    public string ExecutorType => "external_program";

    public async Task<AgentExecutionResult> ExecuteAsync(AgentCapabilityDto capability, string argsJson, CancellationToken cancellationToken = default)
    {
        var config = JsonSerializer.Deserialize<ExternalProgramConfig>(capability.ConfigJson)
            ?? throw new InvalidDataException("Agent 外部程序配置无效。");
        var executable = Path.GetFullPath(Environment.ExpandEnvironmentVariables(config.ExecutablePath));
        if (!File.Exists(executable)) throw new FileNotFoundException("Agent 外部程序不存在。", executable);
        var arguments = JsonSerializer.Deserialize<string[]>(argsJson)
            ?? throw new InvalidDataException("Agent 参数必须是 JSON 字符串数组。");
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            WorkingDirectory = string.IsNullOrWhiteSpace(config.WorkingDirectory)
                ? Path.GetDirectoryName(executable)!
                : Path.GetFullPath(Environment.ExpandEnvironmentVariables(config.WorkingDirectory)),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        foreach (var argument in arguments) startInfo.ArgumentList.Add(argument);
        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("Agent 外部程序启动失败。");
        var outputTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var errorTask = process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken);
        return new AgentExecutionResult(process.ExitCode, await outputTask, await errorTask);
    }

    private sealed record ExternalProgramConfig(string ExecutablePath, string? WorkingDirectory);
}
