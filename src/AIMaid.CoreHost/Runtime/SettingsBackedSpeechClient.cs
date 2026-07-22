using AIMaid.Core;
using AIMaid.Infrastructure;
using AIMaid.Contracts.Status;
using AIMaid.Contracts.Characters;
using System.Diagnostics;
using System.Text.Json;

namespace AIMaid.CoreHost.Runtime;

public sealed class SettingsBackedSpeechClient : ITtsClient, IAsrClient, IDisposable
{
    private const string Prefix = "user_config:";
    private static readonly Uri DefaultEndpoint = new("http://127.0.0.1:8765");
    private static readonly Uri DefaultAsrEndpoint = new("http://35.78.120.126");
    private readonly ISettingsStore settings;
    private readonly IDomainDocumentStore documents;
    private readonly ApplicationPaths paths;
    private readonly HttpClient httpClient = new();
    private readonly SemaphoreSlim readinessGate = new(1, 1);
    private int pendingSynthesis;
    private int pendingPlayback;
    private long lastLatencyMilliseconds;

    public SettingsBackedSpeechClient(ISettingsStore settings, IDomainDocumentStore documents, ApplicationPaths paths)
    {
        this.settings = settings;
        this.documents = documents;
        this.paths = paths;
    }

    public async Task<string> SynthesizeAsync(
        string text,
        string? voiceId,
        string style,
        CancellationToken cancellationToken = default)
    {
        var configuration = await LoadConfigurationAsync(cancellationToken);
        if (!configuration.Enabled)
            throw new InvalidOperationException("TTS 已在系统设置中关闭。");

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(configuration.RequestTimeoutSeconds));
        await EnsureReadyAsync(timeout.Token);
        var client = new SpeechHttpClient(httpClient, SpeechServiceOptions.From(paths, configuration.Endpoint));
        var stopwatch = Stopwatch.StartNew();
        Interlocked.Increment(ref pendingSynthesis);
        try
        {
            var effectiveVoiceId = FirstNonEmpty(voiceId, configuration.DefaultVoiceId);
            var asset = await ResolveVoiceAssetAsync(effectiveVoiceId, style, timeout.Token);
            string path;
            if (asset is null)
            {
                path = await client.SynthesizeAsync(text, effectiveVoiceId, style, timeout.Token);
            }
            else
            {
                var metaPath = Path.Combine(asset.VoiceFolderPath, "meta.json");
                var promptPath = Path.Combine(asset.VoiceFolderPath, "prompt.txt");
                var promptWavPath = Path.Combine(asset.VoiceFolderPath, "prompt.wav");
                foreach (var required in new[] { metaPath, promptPath, promptWavPath })
                    if (!File.Exists(required)) throw new InvalidDataException($"音色“{asset.VoiceId}”缺少必要文件：{Path.GetFileName(required)}");
                using (JsonDocument.Parse(await File.ReadAllTextAsync(metaPath, timeout.Token))) { }
                var promptText = (await File.ReadAllTextAsync(promptPath, timeout.Token)).Trim();
                if (promptText.Length == 0) throw new InvalidDataException($"音色“{asset.VoiceId}”的 prompt.txt 不能为空。");
                path = await client.SynthesizeWithPromptAsync(text, promptText, promptWavPath, style, timeout.Token);
            }
            Interlocked.Exchange(ref lastLatencyMilliseconds, stopwatch.ElapsedMilliseconds);
            return path;
        }
        finally { Interlocked.Decrement(ref pendingSynthesis); }
    }

    public async Task<string> TranscribeAsync(
        string audioPath,
        string? characterId,
        string? sessionId,
        string language,
        string requestId,
        CancellationToken cancellationToken = default)
    {
        var configuration = await LoadAsrConfigurationAsync(cancellationToken);
        if (!configuration.Enabled)
            throw new InvalidOperationException("AIProvider 语音识别已在系统设置中关闭。");

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(configuration.RequestTimeoutSeconds));
        var client = new SpeechHttpClient(httpClient, SpeechServiceOptions.From(paths, configuration.Endpoint));
        return await client.TranscribeAsync(audioPath, characterId, sessionId, language, requestId, timeout.Token);
    }

    public void Dispose()
    {
        readinessGate.Dispose();
        httpClient.Dispose();
    }

    public void SetPlaybackActive(bool active) => Interlocked.Exchange(ref pendingPlayback, active ? 1 : 0);

    public async Task<TtsRuntimeStatusDto> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        var configuration = await LoadConfigurationAsync(cancellationToken);
        if (!configuration.Enabled)
            return Snapshot(false);
        var healthEndpoint = new Uri(configuration.Endpoint.ToString().TrimEnd('/') + "/health", UriKind.Absolute);
        var online = false;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(3));
            using var response = await httpClient.GetAsync(healthEndpoint, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (response.IsSuccessStatusCode)
            {
                await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
                using var json = await JsonDocument.ParseAsync(stream, cancellationToken: timeout.Token);
                online = json.RootElement.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True;
            }
        }
        catch (Exception exception) when (exception is HttpRequestException or OperationCanceledException or JsonException)
        {
            online = false;
        }
        return Snapshot(online);
    }

    public async Task EnsureReadyAsync(CancellationToken cancellationToken = default)
    {
        await readinessGate.WaitAsync(cancellationToken);
        try
        {
            var configuration = await LoadConfigurationAsync(cancellationToken);
            if (!configuration.Enabled) throw new InvalidOperationException("TTS 已在系统设置中关闭。");
            if ((await GetStatusAsync(cancellationToken)).Online) return;
            var scriptPath = Environment.ExpandEnvironmentVariables(configuration.StartScriptPath);
            if (!Path.IsPathFullyQualified(scriptPath) || !File.Exists(scriptPath))
                throw new FileNotFoundException("系统设置中的 TTS 启动脚本不存在。", scriptPath);
            var workingDirectory = Environment.ExpandEnvironmentVariables(configuration.WorkingDirectory);
            if (string.IsNullOrWhiteSpace(workingDirectory)) workingDirectory = Path.GetDirectoryName(scriptPath)!;
            if (!Path.IsPathFullyQualified(workingDirectory) || !Directory.Exists(workingDirectory))
                throw new DirectoryNotFoundException($"系统设置中的 TTS 工作目录不存在：{workingDirectory}");
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = Path.GetFullPath(scriptPath),
                WorkingDirectory = Path.GetFullPath(workingDirectory),
                UseShellExecute = true,
                WindowStyle = ProcessWindowStyle.Hidden
            }) ?? throw new InvalidOperationException("TTS 启动脚本未能启动。");
            var deadline = DateTimeOffset.UtcNow.AddSeconds(configuration.StartupTimeoutSeconds);
            while (DateTimeOffset.UtcNow < deadline)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
                if ((await GetStatusAsync(cancellationToken)).Online) return;
            }
            throw new TimeoutException($"TTS 服务在 {configuration.StartupTimeoutSeconds} 秒内未就绪。");
        }
        finally
        {
            readinessGate.Release();
        }
    }

    private TtsRuntimeStatusDto Snapshot(bool online) => new(
        online,
        Volatile.Read(ref pendingSynthesis),
        Volatile.Read(ref pendingPlayback),
        Interlocked.Read(ref lastLatencyMilliseconds));

    private async Task<Configuration> LoadConfigurationAsync(CancellationToken cancellationToken)
    {
        var keys = new[]
        {
            Prefix + "App:Tts:Enabled",
            Prefix + "App:Tts:Endpoint",
            Prefix + "App:Tts:VoiceId",
            Prefix + "App:Tts:RequestTimeoutSeconds",
            Prefix + "App:Tts:StartScriptPath",
            Prefix + "App:Tts:WorkingDirectory",
            Prefix + "App:Tts:StartupTimeoutSeconds"
        };
        var values = (await settings.GetManyAsync(keys, cancellationToken))
            .ToDictionary(item => item.Key, item => item.Value, StringComparer.Ordinal);

        var enabled = !values.TryGetValue(keys[0], out var enabledText) ||
                      !bool.TryParse(enabledText, out var parsedEnabled) || parsedEnabled;
        var endpointText = Environment.GetEnvironmentVariable("AIMAID_TTS_ENDPOINT");
        if (string.IsNullOrWhiteSpace(endpointText)) values.TryGetValue(keys[1], out endpointText);
        var endpoint = string.IsNullOrWhiteSpace(endpointText) ? DefaultEndpoint : ParseEndpoint(endpointText);
        values.TryGetValue(keys[2], out var defaultVoiceId);
        var requestTimeoutSeconds = values.TryGetValue(keys[3], out var timeoutText) && int.TryParse(timeoutText, out var parsedTimeout)
            ? Math.Clamp(parsedTimeout, 5, 600)
            : 90;
        values.TryGetValue(keys[4], out var startScriptPath);
        values.TryGetValue(keys[5], out var workingDirectory);
        var startupTimeoutSeconds = values.TryGetValue(keys[6], out var startupText) && int.TryParse(startupText, out var parsedStartup)
            ? Math.Clamp(parsedStartup, 5, 600)
            : 120;
        return new Configuration(enabled, endpoint, defaultVoiceId, requestTimeoutSeconds, startScriptPath ?? string.Empty, workingDirectory ?? string.Empty, startupTimeoutSeconds);
    }

    private async Task<AsrConfiguration> LoadAsrConfigurationAsync(CancellationToken cancellationToken)
    {
        var keys = new[]
        {
            Prefix + "App:Asr:Enabled",
            Prefix + "App:Asr:Endpoint",
            Prefix + "App:Asr:RequestTimeoutSeconds"
        };
        var values = (await settings.GetManyAsync(keys, cancellationToken))
            .ToDictionary(item => item.Key, item => item.Value, StringComparer.Ordinal);
        var enabled = !values.TryGetValue(keys[0], out var enabledText) ||
                      !bool.TryParse(enabledText, out var parsedEnabled) || parsedEnabled;
        var endpointText = Environment.GetEnvironmentVariable("AIMAID_ASR_ENDPOINT");
        if (string.IsNullOrWhiteSpace(endpointText)) values.TryGetValue(keys[1], out endpointText);
        var endpoint = string.IsNullOrWhiteSpace(endpointText) ? DefaultAsrEndpoint : ParseEndpoint(endpointText);
        var requestTimeoutSeconds = values.TryGetValue(keys[2], out var timeoutText) && int.TryParse(timeoutText, out var parsedTimeout)
            ? Math.Clamp(parsedTimeout, 5, 600)
            : 120;
        return new AsrConfiguration(enabled, endpoint, requestTimeoutSeconds);
    }

    private static Uri ParseEndpoint(string endpoint)
    {
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            throw new InvalidOperationException("系统设置中的 TTS 服务地址无效。");
        return uri;
    }

    private static string? FirstNonEmpty(string? first, string? second)
        => !string.IsNullOrWhiteSpace(first) ? first : !string.IsNullOrWhiteSpace(second) ? second : null;

    private async Task<VoiceAssetDto?> ResolveVoiceAssetAsync(string? voiceId, string style, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(voiceId)) return null;
        var normalizedStyle = style.Trim().ToLowerInvariant() is "soft" or "lively" or "close" ? style.Trim().ToLowerInvariant() : "normal";
        var baseId = voiceId.EndsWith("_normal", StringComparison.OrdinalIgnoreCase) ? voiceId[..^"_normal".Length] : voiceId;
        var candidates = new[] { $"{baseId}_{normalizedStyle}", voiceId, $"{baseId}_normal" }.Distinct(StringComparer.OrdinalIgnoreCase);
        foreach (var candidate in candidates)
        {
            var json = await documents.GetAsync("voice_asset", candidate, cancellationToken);
            if (json is null) continue;
            return JsonSerializer.Deserialize<VoiceAssetDto>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                   ?? throw new InvalidDataException($"音色“{candidate}”元数据无效。");
        }
        return null;
    }

    private sealed record Configuration(bool Enabled, Uri Endpoint, string? DefaultVoiceId, int RequestTimeoutSeconds, string StartScriptPath, string WorkingDirectory, int StartupTimeoutSeconds);
    private sealed record AsrConfiguration(bool Enabled, Uri Endpoint, int RequestTimeoutSeconds);
}
