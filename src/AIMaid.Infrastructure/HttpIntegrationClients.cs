using System.Diagnostics;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using AIMaid.Core;

namespace AIMaid.Infrastructure;

public sealed class AiProviderRequestException(
    System.Net.HttpStatusCode? statusCode,
    string message,
    Exception? innerException = null) : HttpRequestException(message, innerException, statusCode);

public sealed class AiProviderHttpClient : IAiProviderClient
{
    private static readonly JsonSerializerOptions AuditJsonOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false
    };

    private readonly HttpClient httpClient;
    private readonly AiProviderOptions options;
    private readonly ILlmCallAuditStore auditStore;

    public AiProviderHttpClient(HttpClient httpClient, AiProviderOptions options, ILlmCallAuditStore auditStore)
    {
        this.httpClient = httpClient;
        this.options = options;
        this.auditStore = auditStore;
    }

    public async IAsyncEnumerable<string> StreamChatAsync(AiChatRequest request, [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var stopwatch = Stopwatch.StartNew();
        var responseText = new StringBuilder();
        int statusCode = 0;
        string responseId = string.Empty;
        string? errorText = null;
        int promptTokens = 0;
        int completionTokens = 0;
        int totalTokens = 0;
        var source = request.SourceKey.Length > 0 ? request.SourceKey : "chat_reply";
        var endpoint = options.Endpoint.ToString();
        var model = string.IsNullOrWhiteSpace(request.ModelName) ? options.Model : request.ModelName;

        var messages = request.History.Select(x => new { role = x.Role, content = x.Content }).ToArray();
        var systemPrompt = request.History.FirstOrDefault(x => x.Role == "system")?.Content ?? string.Empty;
        var userPrompt = request.History.LastOrDefault(x => x.Role == "user")?.Content ?? string.Empty;
        var payload = new Dictionary<string, object?>
        {
            ["model"] = model,
            ["messages"] = messages,
            ["stream"] = request.StreamResponse
        };
        if (!string.IsNullOrWhiteSpace(options.ReasoningEffort))
            payload["reasoning_effort"] = options.ReasoningEffort;
        if (request.RequireJsonResponse)
            payload["response_format"] = new { type = "json_object" };
        if (request.Temperature is not null) payload["temperature"] = request.Temperature.Value;
        if (request.MaxTokens is not null) payload["max_tokens"] = request.MaxTokens.Value;
        var requestJson = JsonSerializer.Serialize(payload, AuditJsonOptions);

        // 1. 发起请求前先插入记录
        var auditId = await auditStore.InsertAsync(new LlmCallAuditRecord(
            ConversationId: request.ConversationId,
            Source: source,
            Provider: options.Model,
            Model: model,
            Endpoint: endpoint,
            RequestUrl: endpoint,
            SystemPrompt: systemPrompt,
            UserPrompt: userPrompt,
            RequestJson: requestJson,
            ResponseStatusCode: 0,
            ResponseId: string.Empty,
            ResponseText: string.Empty,
            Error: string.Empty,
            DurationMs: 0,
            PromptTokens: 0,
            CompletionTokens: 0,
            TotalTokens: 0,
            CreatedAt: DateTimeOffset.Now), cancellationToken);

        using var httpRequest = new HttpRequestMessage(HttpMethod.Post, options.Endpoint)
        {
            Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json")
        };
        if (!string.IsNullOrWhiteSpace(options.ApiKey)) httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.ApiKey);

        var collected = new List<string>();
        try
        {
            HttpResponseMessage response;
            try
            {
                response = await httpClient.SendAsync(httpRequest, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            }
            catch (HttpRequestException exception)
            {
                errorText = $"LLM 上游连接失败：{SanitizeErrorText(exception.Message)}";
                statusCode = (int)(exception.StatusCode ?? 0);
                throw new AiProviderRequestException(exception.StatusCode, errorText, exception);
            }

            using (response)
            {
                statusCode = (int)response.StatusCode;
                responseId = response.Headers.TryGetValues("x-request-id", out var requestIds)
                    ? requestIds.FirstOrDefault() ?? string.Empty : string.Empty;

                if (!response.IsSuccessStatusCode)
                {
                    var body = await response.Content.ReadAsStringAsync(cancellationToken);
                    errorText = $"LLM 上游返回 HTTP {statusCode} ({response.ReasonPhrase ?? "Unknown"})：{DescribeErrorBody(body)}";
                    throw new AiProviderRequestException(response.StatusCode, errorText);
                }

                if (!request.StreamResponse)
                {
                    var raw = await response.Content.ReadAsStringAsync(cancellationToken);
                    using var document = JsonDocument.Parse(raw);
                    ExtractUsage(document.RootElement, ref promptTokens, ref completionTokens, ref totalTokens);
                    if (TryReadChatCompletionMessage(document.RootElement, out var content))
                    {
                        responseText.Append(content);
                        collected.Add(content);
                    }
                }
                else
                {
                    await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
                    using var reader = new StreamReader(stream);
                    while (await reader.ReadLineAsync(cancellationToken) is { } line)
                    {
                        if (!line.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) continue;
                        var json = line[5..].Trim();
                        if (json.Length == 0 || json == "[DONE]") continue;
                        using var document = JsonDocument.Parse(json);
                        var root = document.RootElement;
                        ExtractUsage(root, ref promptTokens, ref completionTokens, ref totalTokens);
                        if (TryReadChatCompletionDelta(root, out var delta) || TryReadResponsesDelta(root, out delta))
                        {
                            responseText.Append(delta);
                            collected.Add(delta);
                        }
                    }
                }
            }
        }
        catch (AiProviderRequestException)
        {
            // 2. 异常时更新错误信息
            await UpdateAuditAsync(auditId, statusCode, responseId, responseText.ToString(), errorText ?? string.Empty,
                stopwatch.ElapsedMilliseconds, promptTokens, completionTokens, totalTokens);
            throw;
        }

        // 3. 正常完成时更新数据库
        await UpdateAuditAsync(auditId, statusCode, responseId, responseText.ToString(), errorText ?? string.Empty,
            stopwatch.ElapsedMilliseconds, promptTokens, completionTokens, totalTokens);

        foreach (var delta in collected) yield return delta;
    }

    private async Task UpdateAuditAsync(long auditId, int statusCode, string responseId, string responseText, string error,
        long durationMs, int promptTokens, int completionTokens, int totalTokens)
    {
        try
        {
            await auditStore.UpdateAsync(auditId, new LlmCallAuditCompletion(
                ResponseStatusCode: statusCode,
                ResponseId: responseId,
                ResponseText: responseText,
                Error: error,
                DurationMs: durationMs,
                PromptTokens: promptTokens,
                CompletionTokens: completionTokens,
                TotalTokens: totalTokens,
                CompletedAt: DateTimeOffset.Now));
        }
        catch
        {
            // 审计日志写入失败不影响主流程
        }
    }

    private static string DescribeErrorBody(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return "响应正文为空。";
        try
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            var error = root.TryGetProperty("error", out var errorElement) ? errorElement : root;
            var message = ReadString(error, "message") ?? ReadString(root, "message") ?? ReadString(root, "detail");
            var code = ReadString(error, "code") ?? ReadString(root, "code");
            if (!string.IsNullOrWhiteSpace(message))
                return SanitizeErrorText(string.IsNullOrWhiteSpace(code) ? message : $"{code}: {message}");
        }
        catch (JsonException)
        {
            // Preserve a short, redacted text response for diagnostics.
        }
        return SanitizeErrorText(body);
    }

    private static string? ReadString(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static string SanitizeErrorText(string value)
    {
        var compact = Regex.Replace(value, @"\s+", " ").Trim();
        compact = Regex.Replace(compact,
            @"(?i)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret)\s*[:=]\s*[^\s,;&#]+",
            "$1=[REDACTED]");
        compact = Regex.Replace(compact, @"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+\-/=]+", "$1 [REDACTED]");
        return compact.Length <= 1_200 ? compact : $"{compact[..1_200]}…";
    }

    private static bool TryReadChatCompletionMessage(JsonElement root, out string value)
    {
        value = string.Empty;
        if (!root.TryGetProperty("choices", out var choices) || choices.ValueKind != JsonValueKind.Array || choices.GetArrayLength() == 0) return false;
        var first = choices[0];
        if (!first.TryGetProperty("message", out var message) || !message.TryGetProperty("content", out var content)) return false;
        value = content.GetString() ?? string.Empty;
        return value.Length > 0;
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

    private static void ExtractUsage(JsonElement root, ref int promptTokens, ref int completionTokens, ref int totalTokens)
    {
        if (!root.TryGetProperty("usage", out var usage) && !root.TryGetProperty("usage_metadata", out usage)) return;
        if (usage.TryGetProperty("prompt_tokens", out var pt) && pt.TryGetInt32(out var p)) promptTokens = p;
        if (usage.TryGetProperty("completion_tokens", out var ct) && ct.TryGetInt32(out var c)) completionTokens = c;
        if (usage.TryGetProperty("total_tokens", out var tt) && tt.TryGetInt32(out var t)) totalTokens = t;
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
        var payload = JsonSerializer.Serialize(new Dictionary<string, string>
        {
            ["text"] = text,
            ["voice_id"] = voiceId ?? string.Empty,
            ["style"] = style
        });
        return await SendSynthesisAsync(payload, cancellationToken);
    }

    public Task<string> SynthesizeWithPromptAsync(string text, string promptText, string promptWavPath, string style, CancellationToken cancellationToken = default)
    {
        if (!File.Exists(promptWavPath)) throw new FileNotFoundException("TTS 音色缺少 prompt.wav。", promptWavPath);
        var payload = JsonSerializer.Serialize(new Dictionary<string, string>
        {
            ["text"] = text,
            ["prompt_text"] = promptText,
            ["prompt_wav_path"] = Path.GetFullPath(promptWavPath),
            ["style"] = style
        });
        return SendSynthesisAsync(payload, cancellationToken);
    }

    private async Task<string> SendSynthesisAsync(string payload, CancellationToken cancellationToken)
    {
        using var response = await httpClient.PostAsync(new Uri(options.BaseAddress, "/v1/tts"), new StringContent(payload, Encoding.UTF8, "application/json"), cancellationToken);
        response.EnsureSuccessStatusCode();
        var contentType = response.Content.Headers.ContentType?.MediaType ?? string.Empty;
        if (contentType.Contains("json", StringComparison.OrdinalIgnoreCase))
        {
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            var root = document.RootElement;
            foreach (var propertyName in new[] { "audio_path", "audioPath" })
            {
                if (root.TryGetProperty(propertyName, out var path) && path.ValueKind == JsonValueKind.String &&
                    path.GetString() is { Length: > 0 } localPath && File.Exists(localPath)) return Path.GetFullPath(localPath);
            }
            if (root.TryGetProperty("audio_url", out var urlElement) && urlElement.ValueKind == JsonValueKind.String &&
                urlElement.GetString() is { Length: > 0 } audioUrl)
            {
                var uri = Uri.TryCreate(audioUrl, UriKind.Absolute, out var absolute) ? absolute : new Uri(options.BaseAddress, audioUrl);
                using var audioResponse = await httpClient.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
                audioResponse.EnsureSuccessStatusCode();
                var downloaded = CreateOutputPath();
                await using var audioTarget = File.Create(downloaded);
                await audioResponse.Content.CopyToAsync(audioTarget, cancellationToken);
                return downloaded;
            }
            throw new InvalidDataException("TTS JSON 响应缺少有效 audio_path 或 audio_url。");
        }
        var output = CreateOutputPath();
        await using var target = File.Create(output);
        await response.Content.CopyToAsync(target, cancellationToken);
        return output;
    }

    private string CreateOutputPath() =>
        Path.Combine(Path.GetFullPath(options.OutputDirectory), $"tts_{DateTimeOffset.Now:yyyyMMdd_HHmmssfff}_{Guid.NewGuid():N}.wav");

    public async Task<string> TranscribeAsync(
        string audioPath,
        string? characterId,
        string? sessionId,
        string language,
        string requestId,
        CancellationToken cancellationToken = default)
    {
        await using var stream = File.OpenRead(audioPath);
        using var content = new MultipartFormDataContent();
        using var audio = new StreamContent(stream);
        audio.Headers.ContentType = new MediaTypeHeaderValue(AudioMediaType(audioPath));
        content.Add(audio, "audio", Path.GetFileName(audioPath));
        if (!string.IsNullOrWhiteSpace(characterId)) content.Add(new StringContent(characterId), "characterId");
        if (!string.IsNullOrWhiteSpace(sessionId)) content.Add(new StringContent(sessionId), "sessionId");
        content.Add(new StringContent(language), "language");
        content.Add(new StringContent(requestId), "requestId");
        using var response = await httpClient.PostAsync(new Uri(options.BaseAddress, "/api/asr/transcriptions"), content, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        using var document = JsonDocument.Parse(body);
        var root = document.RootElement;
        if (!response.IsSuccessStatusCode)
        {
            var message = root.ValueKind == JsonValueKind.String
                ? root.GetString()
                : root.ValueKind == JsonValueKind.Object && root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object && error.TryGetProperty("message", out var errorMessage)
                    ? errorMessage.GetString()
                    : null;
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(message) ? $"AIProvider 语音识别失败（HTTP {(int)response.StatusCode}）。" : message);
        }
        if (root.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("AIProvider ASR 响应不是有效对象。");
        if (root.TryGetProperty("success", out var success) && success.ValueKind == JsonValueKind.False)
        {
            var message = root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object && error.TryGetProperty("message", out var errorMessage)
                ? errorMessage.GetString()
                : null;
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(message) ? "AIProvider 语音识别失败。" : message);
        }
        if (!root.TryGetProperty("data", out var data) || !data.TryGetProperty("text", out var text) || text.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("AIProvider ASR 响应缺少 data.text。");
        return text.GetString() ?? string.Empty;
    }

    private static string AudioMediaType(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".wav" => "audio/wav",
        ".mp3" => "audio/mpeg",
        ".m4a" => "audio/mp4",
        ".ogg" => "audio/ogg",
        _ => "audio/webm"
    };
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
