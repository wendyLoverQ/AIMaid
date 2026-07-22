using System.Diagnostics;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using AIMaid.Contracts.Domains;
using AIMaid.Core;

namespace AIMaid.Platform.Windows;

public sealed class ScriptAgentExecutor : IAgentCapabilityExecutor
{
    public string ExecutorType => "script";

    public async Task<AgentExecutionResult> ExecuteAsync(AgentCapabilityDto capability, string argsJson, CancellationToken cancellationToken = default)
    {
        using var configDocument = JsonDocument.Parse(capability.ConfigJson);
        using var argsDocument = JsonDocument.Parse(argsJson);
        using var schemaDocument = JsonDocument.Parse(capability.ArgsSchemaJson);
        var config = configDocument.RootElement;
        var args = argsDocument.RootElement;
        var scriptPath = ReadString(config, "scriptPath");
        if (scriptPath.Length == 0) return Failed("脚本路径未配置。");
        scriptPath = Environment.ExpandEnvironmentVariables(scriptPath);
        if (!Path.IsPathFullyQualified(scriptPath) || !File.Exists(scriptPath)) return Failed($"脚本不存在：{scriptPath}");
        var shellType = ReadString(config, "shellType", "exe");
        var startInfo = new ProcessStartInfo
        {
            FileName = shellType.Equals("powershell", StringComparison.OrdinalIgnoreCase) ? "powershell.exe" : scriptPath,
            WorkingDirectory = ResolveWorkingDirectory(scriptPath, ReadString(config, "workingDir")),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        if (shellType.Equals("bat", StringComparison.OrdinalIgnoreCase))
        {
            startInfo.FileName = "cmd.exe";
            startInfo.ArgumentList.Add("/d");
            startInfo.ArgumentList.Add("/s");
            startInfo.ArgumentList.Add("/c");
            startInfo.ArgumentList.Add(scriptPath);
        }
        foreach (var argument in ExpandArguments(config, args, schemaDocument.RootElement, scriptPath)) startInfo.ArgumentList.Add(argument);
        var timeoutSeconds = ReadInt(config, "timeoutSeconds", 60, 1, 3600);
        try
        {
            using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("Process.Start returned null");
            var outputTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
            var errorTask = process.StandardError.ReadToEndAsync(cancellationToken);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));
            try { await process.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                try { process.Kill(true); } catch (InvalidOperationException) { }
                return new AgentExecutionResult(-1, await outputTask, "脚本执行超时。");
            }
            var output = await outputTask;
            var error = await errorTask;
            return new AgentExecutionResult(process.ExitCode, output, process.ExitCode == 0 ? string.Empty : (error.Length == 0 ? $"脚本退出码 {process.ExitCode}。" : error));
        }
        catch (Exception exception) when (exception is not OperationCanceledException) { return Failed($"脚本执行异常：{exception.Message}"); }
    }

    private static IEnumerable<string> ExpandArguments(JsonElement config, JsonElement args, JsonElement schema, string scriptPath)
    {
        if (!config.TryGetProperty("argsSegments", out var segments) || segments.ValueKind != JsonValueKind.Array) yield break;
        foreach (var segment in segments.EnumerateArray())
        {
            if (segment.ValueKind != JsonValueKind.String) continue;
            var value = segment.GetString() ?? string.Empty;
            if (value == "{scriptPath}") { yield return scriptPath; continue; }
            if (!value.StartsWith("{{", StringComparison.Ordinal) || !value.EndsWith("}}", StringComparison.Ordinal)) { yield return value; continue; }
            var name = value[2..^2];
            if (!args.TryGetProperty(name, out var argument)) continue;
            if (IsSwitch(schema, name))
            {
                if (argument.ValueKind == JsonValueKind.True) yield return $"-{ReadSwitchName(schema, name)}";
                continue;
            }
            if (argument.ValueKind is JsonValueKind.String or JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False)
                yield return argument.ValueKind == JsonValueKind.String ? argument.GetString() ?? string.Empty : argument.ToString();
        }
    }

    private static bool IsSwitch(JsonElement schema, string name) => TryPropertySchema(schema, name, out var property) && property.TryGetProperty("style", out var style) && style.GetString() == "switch";
    private static string ReadSwitchName(JsonElement schema, string name) => TryPropertySchema(schema, name, out var property) && property.TryGetProperty("switchName", out var value) ? value.GetString() ?? name : name;
    private static bool TryPropertySchema(JsonElement schema, string name, out JsonElement value)
    {
        value = default;
        return schema.ValueKind == JsonValueKind.Object && schema.TryGetProperty("properties", out var properties) && properties.TryGetProperty(name, out value);
    }
    private static string ResolveWorkingDirectory(string scriptPath, string configured)
    {
        if (configured.Length == 0) return Path.GetDirectoryName(scriptPath)!;
        configured = Environment.ExpandEnvironmentVariables(configured);
        if (!Path.IsPathFullyQualified(configured) || !Directory.Exists(configured)) throw new DirectoryNotFoundException($"脚本工作目录不存在：{configured}");
        return Path.GetFullPath(configured);
    }
    private static AgentExecutionResult Failed(string error) => new(null, string.Empty, error);
    private static string ReadString(JsonElement value, string name, string fallback = "") => value.TryGetProperty(name, out var item) && item.ValueKind == JsonValueKind.String ? item.GetString() ?? fallback : fallback;
    private static int ReadInt(JsonElement value, string name, int fallback, int minimum, int maximum) => value.TryGetProperty(name, out var item) && item.TryGetInt32(out var parsed) ? Math.Clamp(parsed, minimum, maximum) : fallback;
}

public sealed class ProcessQueryAgentExecutor : IAgentCapabilityExecutor
{
    public string ExecutorType => "process_query";
    public Task<AgentExecutionResult> ExecuteAsync(AgentCapabilityDto capability, string argsJson, CancellationToken cancellationToken = default)
    {
        using var document = JsonDocument.Parse(capability.ConfigJson);
        if (!document.RootElement.TryGetProperty("processNames", out var names) || names.ValueKind != JsonValueKind.Array) return Task.FromResult(new AgentExecutionResult(null, "", "未配置进程名称。"));
        var output = new StringBuilder();
        foreach (var item in names.EnumerateArray())
        {
            cancellationToken.ThrowIfCancellationRequested();
            var name = item.GetString();
            if (string.IsNullOrWhiteSpace(name)) continue;
            var processes = Process.GetProcessesByName(name);
            output.AppendLine($"{name}: {processes.Length} 个进程");
            foreach (var process in processes) process.Dispose();
        }
        return Task.FromResult(new AgentExecutionResult(0, output.ToString().Trim(), string.Empty));
    }
}

public sealed class ProcessKillAgentExecutor : IAgentCapabilityExecutor
{
    public string ExecutorType => "process_kill";
    public Task<AgentExecutionResult> ExecuteAsync(AgentCapabilityDto capability, string argsJson, CancellationToken cancellationToken = default)
    {
        using var document = JsonDocument.Parse(argsJson);
        var args = document.RootElement;
        var processId = 0;
        var hasId = args.TryGetProperty("processId", out var idElement) && idElement.TryGetInt32(out processId) && processId > 0;
        var name = args.TryGetProperty("processName", out var nameElement) && nameElement.ValueKind == JsonValueKind.String ? nameElement.GetString()?.Trim() : null;
        var hasName = !string.IsNullOrWhiteSpace(name);
        if (hasId == hasName) return Task.FromResult(new AgentExecutionResult(null, "", "必须且只能提供 processId 或 processName 其中一个目标。"));
        List<Process> targets = hasId ? [Process.GetProcessById(processId)] : Process.GetProcessesByName(Path.GetFileNameWithoutExtension(name!)).ToList();
        try
        {
            if (targets.Count == 0) return Task.FromResult(new AgentExecutionResult(null, "", "未找到目标进程。"));
            if (targets.Any(process => process.Id == Environment.ProcessId)) return Task.FromResult(new AgentExecutionResult(null, "", "拒绝结束女仆助手自身进程。"));
            var entireTree = !args.TryGetProperty("entireProcessTree", out var tree) || tree.ValueKind != JsonValueKind.False;
            var killed = new List<string>();
            foreach (var process in targets)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var label = $"{process.ProcessName} (PID {process.Id})";
                process.Kill(entireTree);
                if (!process.WaitForExit(5000)) return Task.FromResult(new AgentExecutionResult(null, string.Join(", ", killed), $"等待 {label} 退出超时。"));
                killed.Add(label);
            }
            return Task.FromResult(new AgentExecutionResult(0, $"已结束：{string.Join(", ", killed)}", string.Empty));
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
        { return Task.FromResult(new AgentExecutionResult(null, "", exception.Message)); }
        finally { foreach (var process in targets) process.Dispose(); }
    }
}

public sealed class TcpCheckAgentExecutor : IAgentCapabilityExecutor
{
    public string ExecutorType => "tcp_check";
    public async Task<AgentExecutionResult> ExecuteAsync(AgentCapabilityDto capability, string argsJson, CancellationToken cancellationToken = default)
    {
        using var document = JsonDocument.Parse(capability.ConfigJson);
        var config = document.RootElement;
        var host = config.TryGetProperty("host", out var hostElement) ? hostElement.GetString() ?? "127.0.0.1" : "127.0.0.1";
        var port = config.TryGetProperty("port", out var portElement) && portElement.TryGetInt32(out var configuredPort) ? configuredPort : 8765;
        var timeoutMs = config.TryGetProperty("timeoutMs", out var timeoutElement) && timeoutElement.TryGetInt32(out var configuredTimeout) ? configuredTimeout : 1000;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Math.Clamp(timeoutMs, 100, 30_000));
            using var client = new TcpClient();
            await client.ConnectAsync(host, port, timeout.Token);
            return new AgentExecutionResult(0, $"{host}:{port} 可达", string.Empty);
        }
        catch (Exception exception) when (exception is SocketException or OperationCanceledException)
        { return new AgentExecutionResult(null, "", $"{host}:{port} 不可达：{exception.Message}"); }
    }
}

public sealed class HttpApiAgentExecutor : IAgentCapabilityExecutor, IDisposable
{
    private readonly HttpClient client = new();
    public string ExecutorType => "http_api";
    public void Dispose() => client.Dispose();
    public async Task<AgentExecutionResult> ExecuteAsync(AgentCapabilityDto capability, string argsJson, CancellationToken cancellationToken = default)
    {
        using var configDocument = JsonDocument.Parse(capability.ConfigJson);
        using var argsDocument = JsonDocument.Parse(argsJson);
        var config = configDocument.RootElement;
        var template = config.TryGetProperty("urlTemplate", out var urlElement) ? urlElement.GetString() ?? "" : "";
        foreach (var property in argsDocument.RootElement.EnumerateObject()) template = template.Replace($"{{{property.Name}}}", Uri.EscapeDataString(property.Value.ToString()), StringComparison.Ordinal);
        if (!Uri.TryCreate(template, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")) return new AgentExecutionResult(null, "", "HTTP API URL 无效。");
        using var request = new HttpRequestMessage(new HttpMethod(config.TryGetProperty("method", out var method) ? method.GetString() ?? "GET" : "GET"), uri);
        if (config.TryGetProperty("headers", out var headers) && headers.ValueKind == JsonValueKind.Object)
            foreach (var header in headers.EnumerateObject()) request.Headers.TryAddWithoutValidation(header.Name, header.Value.ToString());
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(config.TryGetProperty("timeoutSeconds", out var timeoutValue) && timeoutValue.TryGetInt32(out var seconds) ? Math.Clamp(seconds, 1, 120) : 15));
        try
        {
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseContentRead, timeout.Token);
            var body = await response.Content.ReadAsStringAsync(timeout.Token);
            return response.IsSuccessStatusCode ? new AgentExecutionResult((int)response.StatusCode, body, string.Empty) : new AgentExecutionResult((int)response.StatusCode, body, $"HTTP 请求失败：{(int)response.StatusCode}");
        }
        catch (Exception exception) when (exception is HttpRequestException or OperationCanceledException)
        { return new AgentExecutionResult(null, "", $"HTTP 请求异常：{exception.Message}"); }
    }
}
