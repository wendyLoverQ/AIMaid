using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using AIMaid.Core;

namespace AIMaid.Infrastructure;

public sealed class AiProviderHttpClient : IAiProviderClient
{
    private readonly HttpClient httpClient;
    private readonly AiProviderOptions options;

    public AiProviderHttpClient(HttpClient httpClient, AiProviderOptions options)
    {
        this.httpClient = httpClient;
        this.options = options;
    }

    public async IAsyncEnumerable<string> StreamChatAsync(AiChatRequest request, [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var messages = request.History.Select(x => new { role = x.Role, content = x.Content }).ToArray();
        using var httpRequest = new HttpRequestMessage(HttpMethod.Post, options.Endpoint)
        {
            Content = new StringContent(JsonSerializer.Serialize(new { model = string.IsNullOrWhiteSpace(request.ModelName) ? options.Model : request.ModelName, messages, stream = true }), Encoding.UTF8, "application/json")
        };
        if (!string.IsNullOrWhiteSpace(options.ApiKey)) httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.ApiKey);
        using var response = await httpClient.SendAsync(httpRequest, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream);
        while (await reader.ReadLineAsync(cancellationToken) is { } line)
        {
            if (!line.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) continue;
            var json = line[5..].Trim();
            if (json.Length == 0 || json == "[DONE]") continue;
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (TryReadChatCompletionDelta(root, out var delta) || TryReadResponsesDelta(root, out delta))
                yield return delta;
        }
    }

    private static bool TryReadChatCompletionDelta(JsonElement root, out string value)
    {
        value = string.Empty;
        if (!root.TryGetProperty("choices", out var choices) || choices.ValueKind != JsonValueKind.Array || choices.GetArrayLength() == 0) return false;
        var first = choices[0];
        if (!first.TryGetProperty("delta", out var delta) || !delta.TryGetProperty("content", out var content)) return false;
        value = content.GetString() ?? string.Empty;
        return value.Length > 0;
    }

    private static bool TryReadResponsesDelta(JsonElement root, out string value)
    {
        value = string.Empty;
        if (!root.TryGetProperty("type", out var type) || type.GetString() != "response.output_text.delta" ||
            !root.TryGetProperty("delta", out var delta)) return false;
        value = delta.GetString() ?? string.Empty;
        return value.Length > 0;
    }
}

public sealed class ComfyUiHttpClient : IComfyUiClient
{
    private readonly HttpClient httpClient;
    private readonly ComfyUiOptions options;
    public ComfyUiHttpClient(HttpClient httpClient, ComfyUiOptions options) { this.httpClient = httpClient; this.options = options; }

    public async Task<string> QueueWorkflowAsync(string workflowJson, IReadOnlyDictionary<string, string> inputs, CancellationToken cancellationToken = default)
    {
        using var workflow = JsonDocument.Parse(workflowJson);
        var payload = JsonSerializer.Serialize(new { prompt = workflow.RootElement, client_id = Guid.NewGuid().ToString("N"), extra_data = new { inputs } });
        using var response = await httpClient.PostAsync(new Uri(options.BaseAddress, "/prompt"), new StringContent(payload, Encoding.UTF8, "application/json"), cancellationToken);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        if (!document.RootElement.TryGetProperty("prompt_id", out var promptId) || string.IsNullOrWhiteSpace(promptId.GetString()))
            throw new InvalidDataException("ComfyUI 响应缺少 prompt_id。");
        return promptId.GetString()!;
    }
}

public sealed class SpeechHttpClient : ITtsClient, IAsrClient
{
    private readonly HttpClient httpClient;
    private readonly SpeechServiceOptions options;
    public SpeechHttpClient(HttpClient httpClient, SpeechServiceOptions options)
    {
        this.httpClient = httpClient;
        this.options = options;
        if (!Path.IsPathFullyQualified(options.OutputDirectory)) throw new ArgumentException("TTS 输出目录必须是绝对路径。", nameof(options));
        Directory.CreateDirectory(Path.GetFullPath(options.OutputDirectory));
    }

    public async Task<string> SynthesizeAsync(string text, string? voiceId, string style, CancellationToken cancellationToken = default)
    {
        var payload = JsonSerializer.Serialize(new { text, voice_id = voiceId ?? string.Empty, style });
        using var response = await httpClient.PostAsync(new Uri(options.BaseAddress, "/v1/tts"), new StringContent(payload, Encoding.UTF8, "application/json"), cancellationToken);
        response.EnsureSuccessStatusCode();
        var contentType = response.Content.Headers.ContentType?.MediaType ?? string.Empty;
        if (contentType.Contains("json", StringComparison.OrdinalIgnoreCase))
        {
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            if (document.RootElement.TryGetProperty("audioPath", out var path) && File.Exists(path.GetString())) return path.GetString()!;
            throw new InvalidDataException("TTS JSON 响应缺少有效 audioPath。");
        }
        var output = Path.Combine(Path.GetFullPath(options.OutputDirectory), $"tts_{DateTimeOffset.Now:yyyyMMdd_HHmmssfff}_{Guid.NewGuid():N}.wav");
        await using var target = File.Create(output);
        await response.Content.CopyToAsync(target, cancellationToken);
        return output;
    }

    public async Task<string> TranscribeAsync(string audioPath, CancellationToken cancellationToken = default)
    {
        await using var stream = File.OpenRead(audioPath);
        using var content = new MultipartFormDataContent();
        content.Add(new StreamContent(stream), "file", Path.GetFileName(audioPath));
        using var response = await httpClient.PostAsync(new Uri(options.BaseAddress, "/v1/asr"), content, cancellationToken);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        if (!document.RootElement.TryGetProperty("text", out var text)) throw new InvalidDataException("ASR 响应缺少 text。");
        return text.GetString() ?? string.Empty;
    }
}

public sealed class HttpDownloadClient : IDownloadClient
{
    private readonly HttpClient httpClient;
    public HttpDownloadClient(HttpClient httpClient) => this.httpClient = httpClient;

    public async Task<string> DownloadAsync(string operationId, string url, string targetDirectory, string? fileName,
        IProgress<(double Progress, string Message)> progress, CancellationToken cancellationToken = default)
    {
        Directory.CreateDirectory(targetDirectory);
        using var response = await httpClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        var resolvedName = string.IsNullOrWhiteSpace(fileName)
            ? Path.GetFileName(Uri.UnescapeDataString(response.RequestMessage?.RequestUri?.AbsolutePath ?? string.Empty))
            : fileName;
        if (string.IsNullOrWhiteSpace(resolvedName)) resolvedName = $"download_{operationId}.bin";
        if (!Path.IsPathFullyQualified(targetDirectory)) throw new ArgumentException("下载目录必须是绝对路径。", nameof(targetDirectory));
        var outputPath = Path.Combine(Path.GetFullPath(targetDirectory), Path.GetFileName(resolvedName));
        var tempPath = outputPath + ".partial";
        var total = response.Content.Headers.ContentLength;
        await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using var target = new FileStream(tempPath, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true);
        var buffer = new byte[81920];
        long received = 0;
        int read;
        while ((read = await source.ReadAsync(buffer, cancellationToken)) > 0)
        {
            await target.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            received += read;
            progress.Report((total > 0 ? (double)received / total.Value : 0, total > 0 ? $"{received}/{total}" : $"{received} bytes"));
        }
        await target.FlushAsync(cancellationToken);
        File.Move(tempPath, outputPath, true);
        return outputPath;
    }
}
