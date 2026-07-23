using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AIMaid.Platform.Windows;

internal static class WindowsRemoteCreatorCapture
{
    public static Task<Core.RemoteCreatorCaptureResult> CaptureAsync(
        Core.RemoteCreatorCaptureRequest request,
        CancellationToken cancellationToken)
    {
        var completion = new TaskCompletionSource<Core.RemoteCreatorCaptureResult>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() => RunCapture(request, completion, cancellationToken))
        {
            IsBackground = true,
            Name = $"AIMaid-{request.SiteKey}-creator-capture"
        };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        return completion.Task;
    }

    private static void RunCapture(
        Core.RemoteCreatorCaptureRequest request,
        TaskCompletionSource<Core.RemoteCreatorCaptureResult> completion,
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
        var responses = new ConcurrentBag<string>();
        var responseSignal = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cancellation = cancellationToken.Register(() =>
        {
            try
            {
                if (form.IsHandleCreated) form.BeginInvoke(form.Close);
            }
            catch (InvalidOperationException) { }
        });

        form.Shown += async (_, _) =>
        {
            try
            {
                var profilePath = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "@aimaid", "desktop", "cache", "remote-creator-browser", request.SiteKey);
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
                    if (!IsCreatorResponse(eventArgs.Request.Uri, request.SiteKey) ||
                        eventArgs.Response.StatusCode is < 200 or >= 400)
                        return;
                    try
                    {
                        await using var stream = await eventArgs.Response.GetContentAsync();
                        if (stream is null) return;
                        using var reader = new StreamReader(stream);
                        var body = await reader.ReadToEndAsync();
                        if (body.Length is 0 or > 12 * 1024 * 1024) return;
                        responses.Add(body);
                        responseSignal.TrySetResult(true);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException) { }
                };
                core.Navigate(request.Url);
                var firstResponse = await Task.WhenAny(
                    responseSignal.Task,
                    Task.Delay(TimeSpan.FromSeconds(25), cancellationToken));
                if (firstResponse != responseSignal.Task)
                    throw new TimeoutException("博主主页加载完成，但没有捕获到公开作品接口。");

                for (var page = 0; page < 3; page++)
                {
                    await core.ExecuteScriptAsync(
                        "window.scrollTo(0, Math.max(document.body.scrollHeight, 2400));");
                    await Task.Delay(TimeSpan.FromSeconds(1.5), cancellationToken);
                }
                await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
                var result = ParseCapture(request, responses.ToArray());
                if (result.Items.Count == 0)
                    throw new InvalidDataException("博主主页没有捕获到公开的视频作品。");
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
        };
        form.FormClosed += (_, _) =>
        {
            if (cancellationToken.IsCancellationRequested)
                completion.TrySetCanceled(cancellationToken);
            else if (!completion.Task.IsCompleted)
                completion.TrySetException(new InvalidOperationException("博主主页解析窗口在返回结果前关闭。"));
        };
        Application.Run(form);
    }

    private static Core.RemoteCreatorCaptureResult ParseCapture(
        Core.RemoteCreatorCaptureRequest request,
        IReadOnlyList<string> responses)
    {
        var items = new Dictionary<string, Core.RemoteCreatorCaptureItem>(StringComparer.Ordinal);
        var hasMore = false;
        foreach (var body in responses)
        {
            try
            {
                using var document = JsonDocument.Parse(body);
                hasMore |= FindBoolean(document.RootElement, "has_more", "hasMore");
                foreach (var entry in FindArrays(document.RootElement,
                             request.SiteKey == "douyin" ? "aweme_list" : "notes", "note_list"))
                {
                    if (entry.ValueKind != JsonValueKind.Object) continue;
                    var item = request.SiteKey == "douyin"
                        ? MapDouyin(entry)
                        : MapXiaohongshu(entry);
                    if (item is not null) items.TryAdd(item.VideoId, item);
                }
            }
            catch (JsonException) { }
        }
        return new Core.RemoteCreatorCaptureResult(items.Values.Take(60).ToArray(), hasMore);
    }

    private static Core.RemoteCreatorCaptureItem? MapDouyin(JsonElement item)
    {
        var id = ReadString(item, "aweme_id", ReadString(item, "group_id"));
        if (string.IsNullOrWhiteSpace(id)) return null;
        var video = ReadObject(item, "video");
        var author = ReadObject(item, "author");
        var cover = ReadImageUrl(ReadObject(video, "cover")) ??
                    ReadImageUrl(ReadObject(video, "origin_cover")) ??
                    ReadImageUrl(ReadObject(item, "video_control")) ?? string.Empty;
        var duration = ReadInt(item, "duration");
        if (duration <= 0) duration = ReadInt(video, "duration");
        return new Core.RemoteCreatorCaptureItem(
            id,
            $"https://www.douyin.com/video/{id}",
            ReadString(item, "desc", "未命名视频"),
            ReadString(author, "nickname"),
            cover,
            duration > 1000 ? duration / 1000 : duration,
            ReadLong(item, "create_time"));
    }

    private static Core.RemoteCreatorCaptureItem? MapXiaohongshu(JsonElement item)
    {
        var nested = ReadObject(item, "note_card");
        var note = nested.ValueKind == JsonValueKind.Object ? nested : item;
        var id = ReadString(note, "note_id", ReadString(note, "id", ReadString(item, "id")));
        var type = ReadString(note, "type", ReadString(item, "type"));
        var video = ReadObject(note, "video");
        if (string.IsNullOrWhiteSpace(id) ||
            (!type.Contains("video", StringComparison.OrdinalIgnoreCase) &&
             video.ValueKind != JsonValueKind.Object))
            return null;
        var author = ReadObject(note, "user");
        var cover = ReadImageUrl(ReadObject(note, "cover")) ??
                    ReadImageUrl(ReadObject(note, "image_list")) ?? string.Empty;
        return new Core.RemoteCreatorCaptureItem(
            id,
            $"https://www.xiaohongshu.com/explore/{id}",
            ReadString(note, "display_title", ReadString(note, "title", "未命名视频")),
            ReadString(author, "nickname", ReadString(note, "nickname")),
            cover,
            ReadInt(video, "duration"),
            ReadLong(note, "time"));
    }

    private static bool IsCreatorResponse(string url, string siteKey)
        => siteKey == "douyin"
            ? url.Contains("/aweme/post", StringComparison.OrdinalIgnoreCase)
            : url.Contains("user_posted", StringComparison.OrdinalIgnoreCase) ||
              url.Contains("/user/notes", StringComparison.OrdinalIgnoreCase);

    private static void ApplyCookies(CoreWebView2CookieManager manager, string cookieText)
    {
        cookieText = Regex.Replace(cookieText, @"\\+(?:r\\+)?n", "\n", RegexOptions.CultureInvariant);
        cookieText = Regex.Replace(cookieText, @"\\+t", "\t", RegexOptions.CultureInvariant);
        foreach (var line in cookieText.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
        {
            if (line.StartsWith('#') && !line.StartsWith("#HttpOnly_", StringComparison.OrdinalIgnoreCase)) continue;
            var parts = line.Split('\t');
            if (parts.Length < 7) parts = Regex.Split(line.Trim(), @"\s+", RegexOptions.CultureInvariant);
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

    private static IEnumerable<JsonElement> FindArrays(JsonElement element, params string[] names)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in element.EnumerateObject())
            {
                if (names.Any(name => property.Name.Equals(name, StringComparison.OrdinalIgnoreCase)) &&
                    property.Value.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in property.Value.EnumerateArray()) yield return item;
                }
                foreach (var nested in FindArrays(property.Value, names)) yield return nested;
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
                foreach (var nested in FindArrays(item, names)) yield return nested;
        }
    }

    private static bool FindBoolean(JsonElement element, params string[] names)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in element.EnumerateObject())
            {
                if (names.Any(name => property.Name.Equals(name, StringComparison.OrdinalIgnoreCase)))
                {
                    if (property.Value.ValueKind == JsonValueKind.True) return true;
                    if (property.Value.ValueKind == JsonValueKind.Number &&
                        property.Value.TryGetInt32(out var value) && value != 0) return true;
                }
                if (FindBoolean(property.Value, names)) return true;
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
            foreach (var item in element.EnumerateArray())
                if (FindBoolean(item, names)) return true;
        return false;
    }

    private static JsonElement ReadObject(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object &&
           element.TryGetProperty(name, out var value)
            ? value
            : default;

    private static string ReadString(JsonElement element, string name, string fallback = "")
    {
        if (element.ValueKind != JsonValueKind.Object ||
            !element.TryGetProperty(name, out var value))
            return fallback;
        return value.ValueKind == JsonValueKind.String ? value.GetString() ?? fallback : fallback;
    }

    private static int ReadInt(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object &&
           element.TryGetProperty(name, out var value) &&
           value.TryGetInt32(out var parsed)
            ? parsed
            : 0;

    private static long? ReadLong(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object &&
           element.TryGetProperty(name, out var value) &&
           value.TryGetInt64(out var parsed)
            ? parsed
            : null;

    private static string? ReadImageUrl(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.String)
        {
            var value = element.GetString();
            return Uri.TryCreate(value, UriKind.Absolute, out _) ? value : null;
        }
        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var name in new[] { "url_default", "url_pre", "url", "url_list" })
                if (element.TryGetProperty(name, out var value) &&
                    ReadImageUrl(value) is { } url)
                    return url;
        }
        else if (element.ValueKind == JsonValueKind.Array)
            foreach (var item in element.EnumerateArray())
                if (ReadImageUrl(item) is { } url)
                    return url;
        return null;
    }
}
