using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AIMaid.Platform.Windows;

internal static class WindowsRemoteLiveCapture
{
    private static readonly TimeSpan NavigationTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan ResponseSettleDelay = TimeSpan.FromSeconds(2);

    public static Task<Core.RemoteLiveCaptureResult> CaptureAsync(
        Core.RemoteLiveCaptureRequest request,
        CancellationToken cancellationToken)
    {
        var completion = new TaskCompletionSource<Core.RemoteLiveCaptureResult>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() => RunCapture(request, completion, cancellationToken))
        {
            IsBackground = true,
            Name = $"AIMaid-{request.SiteKey}-live-capture"
        };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        return completion.Task;
    }

    private static void RunCapture(
        Core.RemoteLiveCaptureRequest request,
        TaskCompletionSource<Core.RemoteLiveCaptureResult> completion,
        CancellationToken cancellationToken)
    {
        using var form = new Form
        {
            Width = 1280,
            Height = 900,
            Left = -10000,
            Top = -10000,
            Opacity = 0.01,
            ShowInTaskbar = false,
            FormBorderStyle = FormBorderStyle.None
        };
        using var webView = new WebView2 { Dock = DockStyle.Fill };
        form.Controls.Add(webView);
        var responses = new ConcurrentBag<CapturedResponse>();
        var finishing = 0;
        using var timeout = new System.Windows.Forms.Timer
        {
            Interval = checked((int)NavigationTimeout.TotalMilliseconds)
        };
        using var cancellation = cancellationToken.Register(() =>
        {
            try
            {
                if (form.IsHandleCreated) form.BeginInvoke(form.Close);
            }
            catch (InvalidOperationException) { }
        });

        async Task FinishAsync()
        {
            if (Interlocked.Exchange(ref finishing, 1) != 0) return;
            try
            {
                await Task.Delay(ResponseSettleDelay, cancellationToken);
                var result = ParseCapture(request, responses.ToArray());
                completion.TrySetResult(result);
            }
            catch (Exception ex)
            {
                completion.TrySetException(ex);
            }
            finally
            {
                try { form.Close(); } catch (InvalidOperationException) { }
            }
        }

        form.Shown += async (_, _) =>
        {
            try
            {
                var profilePath = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "@aimaid", "desktop", "cache", "remote-live-browser", request.SiteKey);
                Directory.CreateDirectory(profilePath);
                var environment = await CoreWebView2Environment.CreateAsync(
                    userDataFolder: profilePath,
                    options: new CoreWebView2EnvironmentOptions(language: "zh-CN"));
                await webView.EnsureCoreWebView2Async(environment);
                var core = webView.CoreWebView2;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsPasswordAutosaveEnabled = false;
                core.Settings.IsGeneralAutofillEnabled = false;
                if (!string.IsNullOrWhiteSpace(request.UserAgent))
                    core.Settings.UserAgent = request.UserAgent;
                ApplyCookies(core.CookieManager, request.CookieText);
                core.WebResourceResponseReceived += async (_, eventArgs) =>
                {
                    var uri = eventArgs.Request.Uri;
                    if (!IsRelevantResponse(uri, request.SiteKey)) return;
                    if (IsMediaUrl(uri) && eventArgs.Response.StatusCode is >= 200 and < 400)
                    {
                        responses.Add(new CapturedResponse(uri, string.Empty, true));
                        await FinishAsync();
                        return;
                    }
                    if (eventArgs.Response.StatusCode is < 200 or >= 500) return;
                    try
                    {
                        await using var stream = await eventArgs.Response.GetContentAsync();
                        if (stream is null) return;
                        using var reader = new StreamReader(stream);
                        var body = await reader.ReadToEndAsync();
                        if (body.Length is 0 or > 8 * 1024 * 1024) return;
                        responses.Add(new CapturedResponse(uri, body, false));
                        if (ContainsMediaUrl(body)) await FinishAsync();
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        // A single response can be unavailable after navigation; later responses remain authoritative.
                    }
                };
                core.Navigate(request.Url);
                timeout.Start();
            }
            catch (Exception ex)
            {
                completion.TrySetException(ex);
                form.Close();
            }
        };
        timeout.Tick += async (_, _) =>
        {
            timeout.Stop();
            if (responses.Any(x => x.IsMedia || ContainsMediaUrl(x.Body)))
                await FinishAsync();
            else
            {
                completion.TrySetException(new TimeoutException("直播页面加载完成，但没有捕获到可播放的签名流。直播可能已结束。"));
                form.Close();
            }
        };
        form.FormClosed += (_, _) =>
        {
            if (cancellationToken.IsCancellationRequested)
                completion.TrySetCanceled(cancellationToken);
            else if (!completion.Task.IsCompleted)
                completion.TrySetException(new InvalidOperationException("直播解析窗口在返回结果前关闭。"));
        };
        Application.Run(form);
    }

    private static Core.RemoteLiveCaptureResult ParseCapture(
        Core.RemoteLiveCaptureRequest request,
        IReadOnlyList<CapturedResponse> captured)
    {
        var strings = new List<string>();
        foreach (var response in captured)
        {
            if (response.IsMedia) strings.Add(response.Url);
            if (string.IsNullOrWhiteSpace(response.Body)) continue;
            try
            {
                using var document = JsonDocument.Parse(response.Body);
                CollectStrings(document.RootElement, strings);
            }
            catch (JsonException)
            {
                CollectUrlLikeStrings(response.Body, strings);
            }
        }
        var stream = strings
            .Select(NormalizeStreamUrl)
            .Where(x => !string.IsNullOrWhiteSpace(x) && IsMediaUrl(x))
            .Distinct(StringComparer.Ordinal)
            .OrderByDescending(ScoreStream)
            .FirstOrDefault()
            ?? throw new InvalidDataException("直播响应中没有可播放的 HLS 或 FLV 地址。");
        var metadataResponses = ScopeMetadataResponses(captured, stream);
        var title = FindEmbeddedField(metadataResponses, "title", "room_name", "roomName") ??
                    FindNamedString(metadataResponses, "title", "room_name", "roomName") ??
                    $"{request.SiteKey} 直播";
        var author = FindEmbeddedField(metadataResponses, "nickname", "anchor_name", "user_name") ??
                     FindNamedString(metadataResponses, "nickname", "anchor_name", "user_name") ??
                     string.Empty;
        var cover = FindEmbeddedImage(metadataResponses) ??
                    FindNamedString(metadataResponses, "cover_url", "room_cover", "cover", "coverUrl") ??
                    string.Empty;
        var videoId = Uri.TryCreate(request.Url, UriKind.Absolute, out var uri)
            ? uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries).LastOrDefault() ?? string.Empty
            : string.Empty;
        return new Core.RemoteLiveCaptureResult(stream, title, author, cover, videoId);
    }

    private static IReadOnlyList<CapturedResponse> ScopeMetadataResponses(
        IReadOnlyList<CapturedResponse> captured,
        string stream)
    {
        if (!Uri.TryCreate(stream, UriKind.Absolute, out var streamUri)) return captured;
        var marker = streamUri.AbsolutePath;
        var scoped = captured
            .Where(x => !string.IsNullOrWhiteSpace(x.Body))
            .Select(x =>
            {
                var index = x.Body.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
                if (index < 0) return null;
                var start = Math.Max(0, index - 140_000);
                var length = Math.Min(x.Body.Length - start, index - start + 20_000);
                return new CapturedResponse(x.Url, x.Body.Substring(start, length), false);
            })
            .Where(x => x is not null)
            .Select(x => x!)
            .ToArray();
        return scoped.Length > 0 ? scoped : captured;
    }

    private static void ApplyCookies(CoreWebView2CookieManager manager, string cookieText)
    {
        foreach (var line in cookieText.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
        {
            if (line.StartsWith('#')) continue;
            var parts = line.Split('\t');
            if (parts.Length < 7 || string.IsNullOrWhiteSpace(parts[5])) continue;
            try
            {
                var cookie = manager.CreateCookie(parts[5], parts[6], parts[0].TrimStart('.'), parts[2]);
                cookie.IsSecure = parts[3].Equals("TRUE", StringComparison.OrdinalIgnoreCase);
                if (long.TryParse(parts[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out var expires) && expires > 0)
                    cookie.Expires = DateTimeOffset.FromUnixTimeSeconds(expires).DateTime;
                manager.AddOrUpdateCookie(cookie);
            }
            catch (ArgumentException) { }
        }
    }

    private static bool IsRelevantResponse(string url, string siteKey)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
        if (IsMediaUrl(url)) return true;
        return siteKey.Equals("douyin", StringComparison.OrdinalIgnoreCase)
            ? uri.Host.EndsWith("douyin.com", StringComparison.OrdinalIgnoreCase) ||
              uri.Host.EndsWith("douyinvod.com", StringComparison.OrdinalIgnoreCase) ||
              uri.AbsolutePath.Contains("/webcast/", StringComparison.OrdinalIgnoreCase)
            : uri.Host.EndsWith("xiaohongshu.com", StringComparison.OrdinalIgnoreCase) ||
              uri.Host.EndsWith("xhscdn.com", StringComparison.OrdinalIgnoreCase);
    }

    private static bool ContainsMediaUrl(string value)
        => value.Contains(".m3u8", StringComparison.OrdinalIgnoreCase) ||
           value.Contains(".flv", StringComparison.OrdinalIgnoreCase);

    private static bool IsMediaUrl(string value)
        => Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
           uri.Scheme is "http" or "https" && ContainsMediaUrl(value);

    private static string NormalizeStreamUrl(string value)
    {
        var normalized = value.Replace("\\u0026", "&", StringComparison.OrdinalIgnoreCase)
            .Replace("\\/", "/", StringComparison.Ordinal);
        if (Uri.TryCreate(normalized, UriKind.Absolute, out _)) return normalized;
        foreach (var key in new[] { "flvUrl=", "hlsUrl=", "flv_url=", "hls_url=", "streamUrl=", "stream_url=" })
        {
            var index = normalized.IndexOf(key, StringComparison.OrdinalIgnoreCase);
            if (index < 0) continue;
            var start = index + key.Length;
            var end = normalized.IndexOf('&', start);
            return Uri.UnescapeDataString(end < 0 ? normalized[start..] : normalized[start..end]);
        }
        return normalized;
    }

    private static int ScoreStream(string value)
    {
        var score = value.Contains(".m3u8", StringComparison.OrdinalIgnoreCase) ? 20 : 10;
        if (value.Contains("origin", StringComparison.OrdinalIgnoreCase)) score += 8;
        if (value.Contains("FULL_HD", StringComparison.OrdinalIgnoreCase)) score += 6;
        if (value.Contains("sign=", StringComparison.OrdinalIgnoreCase) ||
            value.Contains("token=", StringComparison.OrdinalIgnoreCase) ||
            value.Contains("secret=", StringComparison.OrdinalIgnoreCase)) score += 100;
        return score;
    }

    private static void CollectStrings(JsonElement element, ICollection<string> values)
    {
        if (element.ValueKind == JsonValueKind.String)
        {
            var value = element.GetString();
            if (!string.IsNullOrWhiteSpace(value)) values.Add(value);
            return;
        }
        if (element.ValueKind == JsonValueKind.Object)
            foreach (var property in element.EnumerateObject()) CollectStrings(property.Value, values);
        else if (element.ValueKind == JsonValueKind.Array)
            foreach (var item in element.EnumerateArray()) CollectStrings(item, values);
    }

    private static void CollectUrlLikeStrings(string body, ICollection<string> values)
    {
        foreach (var part in body.Split('"'))
            if (ContainsMediaUrl(part)) values.Add(part);
    }

    private static string? FindNamedString(IReadOnlyList<CapturedResponse> captured, params string[] names)
    {
        foreach (var response in captured)
        {
            if (string.IsNullOrWhiteSpace(response.Body)) continue;
            try
            {
                using var document = JsonDocument.Parse(response.Body);
                var value = FindNamedString(document.RootElement, names);
                if (!string.IsNullOrWhiteSpace(value)) return value;
            }
            catch (JsonException) { }
        }
        return null;
    }

    private static string? FindNamedString(JsonElement element, IReadOnlyList<string> names)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in element.EnumerateObject())
            {
                if (names.Any(x => property.Name.Equals(x, StringComparison.OrdinalIgnoreCase)) &&
                    property.Value.ValueKind == JsonValueKind.String)
                {
                    var value = property.Value.GetString();
                    if (!string.IsNullOrWhiteSpace(value) && !ContainsMediaUrl(value)) return value;
                }
                var nested = FindNamedString(property.Value, names);
                if (!string.IsNullOrWhiteSpace(nested)) return nested;
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
            foreach (var item in element.EnumerateArray())
            {
                var nested = FindNamedString(item, names);
                if (!string.IsNullOrWhiteSpace(nested)) return nested;
            }
        return null;
    }

    private static string? FindEmbeddedField(IReadOnlyList<CapturedResponse> captured, params string[] names)
    {
        foreach (var response in captured)
        {
            if (string.IsNullOrWhiteSpace(response.Body)) continue;
            var body = RelevantEmbeddedWindow(response.Body);
            foreach (var name in names)
            {
                var matches = Regex.Matches(body,
                    $@"""{Regex.Escape(name)}""\s*:\s*""(?<value>[^""]{{1,500}})""",
                    RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
                for (var index = matches.Count - 1; index >= 0; index--)
                {
                    var value = DecodeEmbeddedJsonString(matches[index].Groups["value"].Value);
                    if (IsUsefulMetadata(value)) return value;
                }
            }
        }
        return null;
    }

    private static string? FindEmbeddedImage(IReadOnlyList<CapturedResponse> captured)
    {
        foreach (var response in captured)
        {
            if (string.IsNullOrWhiteSpace(response.Body)) continue;
            var body = RelevantEmbeddedWindow(response.Body);
            var matches = Regex.Matches(body,
                @"""(?:cover|room_cover|cover_url)""\s*:\s*(?:\{.{0,2500}?""url_list""\s*:\s*\[\s*)?""(?<url>https?://[^""]{1,4000})""",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Singleline);
            if (matches.Count > 0)
                return DecodeEmbeddedJsonString(matches[^1].Groups["url"].Value);
        }
        return null;
    }

    private static string RelevantEmbeddedWindow(string value)
    {
        var body = WebUtility.HtmlDecode(value).Replace("\\\"", "\"", StringComparison.Ordinal);
        var marker = body.LastIndexOf("\"web_stream_url\"", StringComparison.OrdinalIgnoreCase);
        if (marker < 0) marker = body.IndexOf(".m3u8", StringComparison.OrdinalIgnoreCase);
        if (marker < 0) marker = body.IndexOf(".flv", StringComparison.OrdinalIgnoreCase);
        if (marker < 0) return body;
        var start = Math.Max(0, marker - 120_000);
        var length = Math.Min(body.Length - start, marker - start + 20_000);
        return body.Substring(start, length);
    }

    private static bool IsUsefulMetadata(string value)
        => !string.IsNullOrWhiteSpace(value) &&
           value.Length <= 300 &&
           !value.Contains("$undefined", StringComparison.OrdinalIgnoreCase) &&
           !value.StartsWith("http", StringComparison.OrdinalIgnoreCase) &&
           !ContainsMediaUrl(value);

    private static string DecodeEmbeddedJsonString(string value)
    {
        var normalized = value.Replace("\\\"", "\"", StringComparison.Ordinal)
            .Replace("\\/", "/", StringComparison.Ordinal);
        try
        {
            return JsonSerializer.Deserialize<string>($"\"{normalized.Replace("\"", "\\\"", StringComparison.Ordinal)}\"")
                   ?? normalized;
        }
        catch (JsonException)
        {
            return normalized.Replace("\\u0026", "&", StringComparison.OrdinalIgnoreCase);
        }
    }

    private sealed record CapturedResponse(string Url, string Body, bool IsMedia);
}
