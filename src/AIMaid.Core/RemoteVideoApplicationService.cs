using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using AIMaid.Contracts.Domains;

namespace AIMaid.Core;

public sealed partial class RemoteVideoApplicationService
{
    private const string DirectStreamSelectorPrefix = "aimaid-live:";
    private const string ItemDomain = "remote_video_item";
    private const string DownloadDomain = "remote_video_download";
    private const string PlayDomain = "remote_video_play";
    private const string SettingsDomain = "remote_video_settings";
    private const string SiteDomain = "remote_site";
    private const string SiteSecretDomain = "remote_site_secret";
    private readonly IDomainDocumentStore store;
    private readonly ISettingsStore settingsStore;
    private readonly ISecretProtector secrets;
    private readonly IRemoteVideoPlatform platform;
    private readonly ApplicationPaths paths;
    private readonly ConcurrentDictionary<string, CancellationTokenSource> activeDownloads = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, RemoteVideoDownloadDto> liveDownloads = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, RemoteVideoResolvedItemDto> resolvedItems = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim downloadSlotGate = new(1, 1);
    private int runningDownloadCount;
    private string lastOperation = "none";
    private string lastStatus = "idle";
    private string lastMessage = "尚未执行远程视频操作。";

    public RemoteVideoApplicationService(
        IDomainDocumentStore store, ISettingsStore settingsStore, ISecretProtector secrets,
        IRemoteVideoPlatform platform, ApplicationPaths paths)
    {
        this.store = store;
        this.settingsStore = settingsStore;
        this.secrets = secrets;
        this.platform = platform;
        this.paths = paths;
    }

    public async Task<RemoteVideoResolveResultDto> ResolveAsync(string input, CancellationToken cancellationToken = default)
    {
        var links = SplitLinks(input);
        if (links.Count == 0) throw new ArgumentException("请输入要解析的远程视频链接。", nameof(input));
        var settings = await GetSettingsAsync(cancellationToken);
        var downloadStatuses = (await ListDownloadsAsync(cancellationToken))
            .GroupBy(x => x.ItemId, StringComparer.Ordinal)
            .ToDictionary(x => x.Key, x => x.OrderByDescending(y => y.CreatedAt).First().Status, StringComparer.Ordinal);
        var resolved = new List<RemoteVideoResolvedItemDto>();
        var summaries = new List<string>();
        foreach (var link in links)
        {
            var site = await MatchSiteAsync(link, cancellationToken);
            if (IsSpecializedLiveUrl(link))
            {
                var liveItem = await ResolveSpecializedLiveAsync(link, site, cancellationToken);
                liveItem = liveItem with
                {
                    DownloadStatus = downloadStatuses.TryGetValue(liveItem.ItemId, out var liveStatus) ? liveStatus : "None"
                };
                resolvedItems[liveItem.ItemId] = liveItem;
                await store.UpsertAsync(ItemDomain, liveItem.ItemId, JsonSerializer.Serialize(liveItem), DateTimeOffset.Now, cancellationToken);
                resolved.Add(liveItem);
                summaries.Add($"{HostLabel(link)}：1 项直播");
                continue;
            }
            if (IsSpecializedCreatorUrl(link))
            {
                var creatorItems = await ResolveSpecializedCreatorAsync(link, site, cancellationToken);
                foreach (var creatorItem in creatorItems)
                {
                    var item = creatorItem with
                    {
                        DownloadStatus = downloadStatuses.TryGetValue(creatorItem.ItemId, out var creatorStatus)
                            ? creatorStatus
                            : "None"
                    };
                    resolvedItems[item.ItemId] = item;
                    await store.UpsertAsync(ItemDomain, item.ItemId, JsonSerializer.Serialize(item), DateTimeOffset.Now, cancellationToken);
                    resolved.Add(item);
                }
                summaries.Add($"{HostLabel(link)}：{creatorItems.Count} 项博主作品");
                continue;
            }
            var arguments = new List<string>
            {
                "--no-config", "-J", "--skip-download", "--no-warnings", "--color", "never",
                "--flat-playlist", "--playlist-items", "1:20", link
            };
            using var resolveTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            resolveTimeout.CancelAfter(TimeSpan.FromSeconds(45));
            RemoteToolExecutionResult result;
            try
            {
                result = await RunYtDlpAsync(settings, site, arguments, resolveTimeout.Token);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                const string timeoutMessage = "解析超过 45 秒，已停止外部解析进程。请检查网络、站点配置或 yt-dlp 后重试。";
                SetDiagnostic("resolve", "failed", timeoutMessage);
                throw new RemoteVideoOperationException(timeoutMessage);
            }
            if (result.ExitCode != 0)
                throw new RemoteVideoOperationException(SanitizeExternalMessage(result.StandardError, "yt-dlp 解析失败。"));
            using var document = JsonDocument.Parse(result.StandardOutput);
            var parsed = ParseResolvedItems(document.RootElement, link, site?.SiteName ?? string.Empty);
            var hydration = await HydratePlaylistItemsAsync(parsed, settings, site, cancellationToken);
            parsed = hydration.Items;
            foreach (var parsedItem in parsed)
            {
                var item = parsedItem with
                {
                    DownloadStatus = downloadStatuses.TryGetValue(parsedItem.ItemId, out var status) ? status : "None"
                };
                resolvedItems[item.ItemId] = item;
                await store.UpsertAsync(ItemDomain, item.ItemId, JsonSerializer.Serialize(item), DateTimeOffset.Now, cancellationToken);
                resolved.Add(item);
            }
            var hydrationText = hydration.FailedCount > 0
                ? $"，另有 {hydration.FailedCount} 项源站已不可访问并已剔除"
                : string.Empty;
            summaries.Add($"{HostLabel(link)}：{parsed.Count} 项{hydrationText}");
        }
        SetDiagnostic("resolve", "succeeded", $"已解析 {resolved.Count} 项（{string.Join("；", summaries)}）。");
        return new RemoteVideoResolveResultDto(resolved, lastMessage);
    }

    public async Task<IReadOnlyList<RemoteVideoFormatDto>> GetFormatsAsync(string itemId, CancellationToken cancellationToken = default)
        => (await GetItemAsync(itemId, cancellationToken)).Formats;

    public async Task<RemoteVideoThumbnailDto> GetThumbnailAsync(string itemId, CancellationToken cancellationToken = default)
    {
        var item = await GetItemAsync(itemId, cancellationToken);
        return await GetThumbnailByUrlAsync(item.ThumbnailUrl, item.OriginalUrl, cancellationToken);
    }

    public async Task<RemoteVideoThumbnailDto> GetDownloadThumbnailAsync(
        string taskId, CancellationToken cancellationToken = default)
    {
        var task = (await ListDownloadsAsync(cancellationToken)).FirstOrDefault(x => x.TaskId == taskId)
            ?? throw new KeyNotFoundException("下载记录不存在。");
        return await GetThumbnailByUrlAsync(task.ThumbnailUrl, task.OriginalUrl, cancellationToken);
    }

    public async Task<RemoteVideoThumbnailDto> GetPlayThumbnailAsync(
        string historyId, CancellationToken cancellationToken = default)
    {
        var json = await store.GetAsync(PlayDomain, historyId, cancellationToken)
            ?? throw new KeyNotFoundException("播放记录不存在。");
        var history = Deserialize<RemoteVideoPlayHistoryDto>(json);
        return await GetThumbnailByUrlAsync(history.ThumbnailUrl, history.OriginalUrl, cancellationToken);
    }

    private async Task<RemoteVideoThumbnailDto> GetThumbnailByUrlAsync(
        string thumbnailUrl, string originalUrl, CancellationToken cancellationToken = default)
    {
        if (!Uri.TryCreate(thumbnailUrl, UriKind.Absolute, out var thumbnailUri) || thumbnailUri.Scheme is not ("http" or "https"))
            throw new InvalidDataException("解析结果没有可用的远程封面地址。");
        var site = await MatchSiteAsync(originalUrl, cancellationToken);
        using var handler = new HttpClientHandler { AutomaticDecompression = System.Net.DecompressionMethods.All };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(20) };
        using var request = new HttpRequestMessage(HttpMethod.Get, thumbnailUri);
        request.Headers.UserAgent.TryParseAdd(ReadSiteSetting(site, "userAgent") ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36");
        request.Headers.TryAddWithoutValidation("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8");
        var referer = ReadSiteSetting(site, "referer") ?? originalUrl;
        if (Uri.TryCreate(referer, UriKind.Absolute, out var refererUri)) request.Headers.Referrer = refererUri;
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        var mimeType = response.Content.Headers.ContentType?.MediaType ?? string.Empty;
        if (!mimeType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("远程封面响应不是图片内容。");
        if (response.Content.Headers.ContentLength is > 8 * 1024 * 1024)
            throw new InvalidDataException("远程封面超过 8 MB 安全上限。");
        var bytes = await response.Content.ReadAsByteArrayAsync(cancellationToken);
        if (bytes.Length == 0 || bytes.Length > 8 * 1024 * 1024)
            throw new InvalidDataException("远程封面内容为空或超过 8 MB 安全上限。");
        return new RemoteVideoThumbnailDto(mimeType, Convert.ToBase64String(bytes));
    }

    public async Task<RemoteVideoPlayHistoryDto> PlayAsync(
        string itemId, string? formatSelector, string mode, CancellationToken cancellationToken = default)
    {
        var item = await GetItemAsync(itemId, cancellationToken);
        var settings = await GetSettingsAsync(cancellationToken);
        var selector = ResolveSelector(item, formatSelector, settings.DefaultQualityPreference);
        var site = await MatchSiteAsync(item.OriginalUrl, cancellationToken);
        string source;
        string? audioSource = null;
        var action = mode.Equals("cache", StringComparison.OrdinalIgnoreCase) ? "CachePlay" : "DirectStream";
        if (action == "CachePlay")
        {
            Directory.CreateDirectory(settings.CacheRoot);
            var args = BuildDownloadArguments(item, settings, selector, settings.CacheRoot, cacheOnly: true);
            var startedAtUtc = DateTime.UtcNow;
            var result = await RunYtDlpAsync(settings, site, args, cancellationToken);
            if (result.ExitCode != 0) throw new InvalidOperationException(SanitizeExternalMessage(result.StandardError, "缓存视频失败。"));
            source = ResolveDownloadedFilePath(result.StandardOutput, settings.CacheRoot, item.VideoId, startedAtUtc)
                ?? throw new FileNotFoundException("缓存播放完成后没有找到最终合并文件。");
        }
        else
        {
            if (TryDecodeDirectStreamSelector(selector, out var liveSource))
            {
                source = liveSource;
            }
            else
            {
                var args = new List<string> { "--no-config", "--no-playlist", "--no-warnings", "--color", "never", "-f", selector, "-g", item.OriginalUrl };
                var result = await RunYtDlpAsync(settings, site, args, cancellationToken);
                if (result.ExitCode != 0) throw new InvalidOperationException(SanitizeExternalMessage(result.StandardError, "播放地址解析失败。"));
                var sources = result.StandardOutput.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                source = sources.FirstOrDefault() ?? throw new InvalidDataException("yt-dlp 未返回播放地址。");
                audioSource = sources.Skip(1).FirstOrDefault();
            }
        }
        await platform.LaunchMediaAsync(await ResolvePotPlayerPathAsync(cancellationToken),
            new RemoteMediaLaunchRequest(source, audioSource, item.Title,
                ReadSiteSetting(site, "userAgent"), ReadSiteSetting(site, "referer")), cancellationToken);
        var history = new RemoteVideoPlayHistoryDto(
            NewLegacyId("legacy_remote_play_"), item.ItemId, item.OriginalUrl, item.Title, item.Author,
            item.SiteName, action, action == "CachePlay" ? source : string.Empty, DateTimeOffset.Now, item.ThumbnailUrl);
        await store.UpsertAsync(PlayDomain, history.HistoryId, JsonSerializer.Serialize(history), history.PlayedAt, cancellationToken);
        SetDiagnostic("play", "succeeded", $"已通过 PotPlayer 启动“{item.Title}”。");
        return history;
    }

    public async Task<IReadOnlyList<RemoteVideoDownloadDto>> StartDownloadsAsync(
        IReadOnlyList<string> itemIds, string? formatSelector, CancellationToken cancellationToken = default)
    {
        if (itemIds.Count == 0) throw new ArgumentException("至少选择一个下载项目。", nameof(itemIds));
        var settings = await GetSettingsAsync(cancellationToken);
        var created = new List<RemoteVideoDownloadDto>();
        foreach (var itemId in itemIds.Distinct(StringComparer.Ordinal))
        {
            var item = await GetItemAsync(itemId, cancellationToken);
            var task = new RemoteVideoDownloadDto(
                NewLegacyId("legacy_remote_download_"), item.ItemId, item.OriginalUrl, item.Title, item.Author,
                item.SiteName, string.Empty, ResolveSelector(item, formatSelector, settings.DefaultQualityPreference),
                "Queued", 0, string.Empty, string.Empty, string.Empty, 0, DateTimeOffset.Now, null, null, item.ThumbnailUrl);
            var source = new CancellationTokenSource();
            activeDownloads[task.TaskId] = source;
            liveDownloads[task.TaskId] = task;
            await SaveDownloadAsync(task, cancellationToken);
            created.Add(task);
            _ = RunDownloadAsync(task, item, source);
        }
        SetDiagnostic("download", "queued", $"已加入 {created.Count} 个下载任务。");
        return created;
    }

    public async Task<bool> CancelDownloadAsync(string taskId, CancellationToken cancellationToken = default)
    {
        if (!activeDownloads.TryGetValue(taskId, out var source)) return false;
        source.Cancel();
        if (liveDownloads.TryGetValue(taskId, out var task))
        {
            var cancelled = task with { Status = "Cancelled", FinishedAt = DateTimeOffset.Now };
            liveDownloads[taskId] = cancelled;
            await SaveDownloadAsync(cancelled, cancellationToken);
        }
        SetDiagnostic("download.cancel", "succeeded", "下载任务已取消。");
        return true;
    }

    public async Task<IReadOnlyList<RemoteVideoDownloadDto>> ListDownloadsAsync(CancellationToken cancellationToken = default)
    {
        var persisted = (await store.ListAsync(DownloadDomain, cancellationToken))
            .Select(json => TryDeserialize<RemoteVideoDownloadDto>(json))
            .Where(x => x is not null && !string.IsNullOrEmpty(x.ItemId))
            .Select(x => x!)
            .ToDictionary(x => x.TaskId, StringComparer.Ordinal);
        foreach (var orphan in persisted.Values.Where(x => x.Status is "Queued" or "Running" && !activeDownloads.ContainsKey(x.TaskId)).ToArray())
        {
            var interrupted = orphan with
            {
                Status = "Failed", ErrorMessage = "应用已重启，下载任务已中断。", FinishedAt = DateTimeOffset.Now
            };
            persisted[interrupted.TaskId] = interrupted;
            await SaveDownloadAsync(interrupted, cancellationToken);
        }
        foreach (var pair in liveDownloads) persisted[pair.Key] = pair.Value;
        var records = persisted.Values.OrderByDescending(x => x.CreatedAt).Take(200).ToArray();
        for (var index = 0; index < records.Length; index++)
        {
            if (!string.IsNullOrWhiteSpace(records[index].ThumbnailUrl)) continue;
            var item = await TryGetItemAsync(records[index].ItemId, cancellationToken);
            if (!string.IsNullOrWhiteSpace(item?.ThumbnailUrl))
                records[index] = records[index] with { ThumbnailUrl = item.ThumbnailUrl };
        }
        return records;
    }

    public async Task DeleteDownloadAsync(string taskId, CancellationToken cancellationToken = default)
    {
        var task = (await ListDownloadsAsync(cancellationToken)).FirstOrDefault(x => x.TaskId == taskId);
        if (task is null) return;
        if (task.Status is "Queued" or "Running") throw new InvalidOperationException("下载中的任务不能删除。");
        if (!string.IsNullOrWhiteSpace(task.OutputPath) && File.Exists(task.OutputPath)) File.Delete(Path.GetFullPath(task.OutputPath));
        if (!string.IsNullOrWhiteSpace(task.OutputPath)) await RemoveImportedVideoAsync(task.OutputPath, cancellationToken);
        liveDownloads.TryRemove(taskId, out _);
        await store.DeleteAsync(DownloadDomain, taskId, cancellationToken);
        SetDiagnostic("download.delete", "succeeded", "下载记录及对应本地文件已删除。");
    }

    public async Task<RemoteVideoPlayHistoryDto> PlayDownloadAsync(string taskId, CancellationToken cancellationToken = default)
    {
        var task = (await ListDownloadsAsync(cancellationToken)).FirstOrDefault(x => x.TaskId == taskId)
            ?? throw new KeyNotFoundException("下载记录不存在。");
        if (task.Status != "Completed") throw new InvalidOperationException("只有已完成的下载记录可以播放。");
        if (string.IsNullOrWhiteSpace(task.OutputPath) || !File.Exists(task.OutputPath))
            throw new FileNotFoundException("下载文件不存在或已被移动。", task.OutputPath);
        var settings = await GetSettingsAsync(cancellationToken);
        await platform.LaunchMediaAsync(await ResolvePotPlayerPathAsync(cancellationToken), new RemoteMediaLaunchRequest(task.OutputPath, Title: task.Title), cancellationToken);
        var history = new RemoteVideoPlayHistoryDto(
            NewLegacyId("legacy_remote_play_"), task.ItemId, task.OriginalUrl, task.Title, task.Author,
            task.SiteName, "Downloaded", task.OutputPath, DateTimeOffset.Now, task.ThumbnailUrl);
        await store.UpsertAsync(PlayDomain, history.HistoryId, JsonSerializer.Serialize(history), history.PlayedAt, cancellationToken);
        SetDiagnostic("download.play", "succeeded", $"已播放下载文件“{task.Title}”。");
        return history;
    }

    public async Task<IReadOnlyList<RemoteVideoPlayHistoryDto>> ListPlaysAsync(CancellationToken cancellationToken = default)
        => (await store.ListAsync(PlayDomain, cancellationToken)).Select(Deserialize<RemoteVideoPlayHistoryDto>)
            .OrderByDescending(x => x.PlayedAt).Take(200).ToArray();

    public async Task<RemoteVideoPlayHistoryDto> ReplayAsync(string historyId, CancellationToken cancellationToken = default)
    {
        var json = await store.GetAsync(PlayDomain, historyId, cancellationToken)
            ?? throw new KeyNotFoundException("播放记录不存在。");
        var history = Deserialize<RemoteVideoPlayHistoryDto>(json);
        var settings = await GetSettingsAsync(cancellationToken);
        if (!string.IsNullOrWhiteSpace(history.CachePath) && File.Exists(history.CachePath))
        {
            await platform.LaunchMediaAsync(await ResolvePotPlayerPathAsync(cancellationToken), new RemoteMediaLaunchRequest(history.CachePath, Title: history.Title), cancellationToken);
            var replay = history with { HistoryId = NewLegacyId("legacy_remote_play_"), Action = "Replay", PlayedAt = DateTimeOffset.Now };
            await store.UpsertAsync(PlayDomain, replay.HistoryId, JsonSerializer.Serialize(replay), replay.PlayedAt, cancellationToken);
            return replay;
        }
        if (history.ItemId is null) throw new InvalidOperationException("播放记录没有可重新解析的项目。");
        return await PlayAsync(history.ItemId, null, "direct", cancellationToken);
    }

    public async Task<RemoteVideoSettingsDto> GetSettingsAsync(CancellationToken cancellationToken = default)
    {
        var json = await store.GetAsync(SettingsDomain, "current", cancellationToken);
        var settings = json is null ? DefaultSettings() : Deserialize<RemoteVideoSettingsDto>(json);
        var migrated = NormalizeLegacyDefaultPaths(settings);
        settings = migrated.Settings;
        settings = await AttachRuntimeToolPathsAsync(settings, cancellationToken);
        Directory.CreateDirectory(settings.DownloadRoot);
        Directory.CreateDirectory(settings.CacheRoot);
        if (json is null || migrated.Changed)
            await store.UpsertAsync(SettingsDomain, "current", JsonSerializer.Serialize(settings), settings.UpdatedAt, cancellationToken);
        return settings;
    }

    public async Task<RemoteVideoSettingsDto> SaveSettingsAsync(RemoteVideoSettingsDto settings, CancellationToken cancellationToken = default)
    {
        ValidateSettings(settings);
        Directory.CreateDirectory(settings.DownloadRoot);
        Directory.CreateDirectory(settings.CacheRoot);
        var saved = await AttachRuntimeToolPathsAsync(settings with { UpdatedAt = DateTimeOffset.Now }, cancellationToken);
        await store.UpsertAsync(SettingsDomain, "current", JsonSerializer.Serialize(saved), saved.UpdatedAt, cancellationToken);
        SetDiagnostic("settings.save", "succeeded", "远程视频设置已保存。");
        return saved;
    }

    public async Task<RemoteVideoDiagnosticsDto> GetDiagnosticsAsync(CancellationToken cancellationToken = default)
    {
        var settings = await GetSettingsAsync(cancellationToken);
        var writable = IsDirectoryWritable(settings.DownloadRoot);
        return new RemoteVideoDiagnosticsDto(
            DateTimeOffset.Now, settings.YtDlpPath, File.Exists(settings.YtDlpPath),
            settings.FfmpegPath, File.Exists(settings.FfmpegPath), settings.PotPlayerPath,
            File.Exists(settings.PotPlayerPath), settings.DownloadRoot, writable,
            activeDownloads.Count, lastOperation, lastStatus, lastMessage);
    }

    private async Task RunDownloadAsync(RemoteVideoDownloadDto initial, RemoteVideoResolvedItemDto item, CancellationTokenSource source)
    {
        var entered = false;
        try
        {
            var settings = await GetSettingsAsync(source.Token);
            while (!entered)
            {
                await downloadSlotGate.WaitAsync(source.Token);
                try
                {
                    if (runningDownloadCount < settings.MaxConcurrentDownloads)
                    {
                        runningDownloadCount++;
                        entered = true;
                    }
                }
                finally { downloadSlotGate.Release(); }
                if (!entered) await Task.Delay(150, source.Token);
            }
            var running = initial with { Status = "Running", StartedAt = DateTimeOffset.Now };
            liveDownloads[initial.TaskId] = running;
            await SaveDownloadAsync(running, source.Token);
            Directory.CreateDirectory(settings.DownloadRoot);
            var site = await MatchSiteAsync(item.OriginalUrl, source.Token);
            var args = BuildDownloadArguments(item, settings, initial.Quality, settings.DownloadRoot, cacheOnly: false);
            var startedAtUtc = DateTime.UtcNow;
            var result = await RunYtDlpAsync(settings, site, args, source.Token, line => UpdateProgress(initial.TaskId, line));
            if (result.ExitCode != 0) throw new InvalidOperationException(SanitizeExternalMessage(result.StandardError, "下载失败。"));
            var outputPath = ResolveDownloadedFilePath(
                result.StandardOutput, settings.DownloadRoot, item.VideoId, startedAtUtc)
                ?? throw new FileNotFoundException("yt-dlp 完成后未找到输出文件。");
            var completed = liveDownloads[initial.TaskId] with
            {
                Status = "Completed", Progress = 100, OutputPath = outputPath,
                FileSize = File.Exists(outputPath) ? new FileInfo(outputPath).Length : 0,
                FinishedAt = DateTimeOffset.Now, Speed = string.Empty, Eta = string.Empty
            };
            liveDownloads[initial.TaskId] = completed;
            await SaveDownloadAsync(completed, CancellationToken.None);
            if (settings.AutoImportToVideoLibrary && File.Exists(outputPath))
                await ImportVideoAsync(item, outputPath, CancellationToken.None);
        }
        catch (OperationCanceledException)
        {
            var cancelled = liveDownloads[initial.TaskId] with { Status = "Cancelled", FinishedAt = DateTimeOffset.Now };
            liveDownloads[initial.TaskId] = cancelled;
            await SaveDownloadAsync(cancelled, CancellationToken.None);
        }
        catch (Exception exception)
        {
            var failed = liveDownloads[initial.TaskId] with
            {
                Status = "Failed", ErrorMessage = SanitizeExternalMessage(exception.Message, "下载失败。"),
                FinishedAt = DateTimeOffset.Now
            };
            liveDownloads[initial.TaskId] = failed;
            await SaveDownloadAsync(failed, CancellationToken.None);
            SetDiagnostic("download", "failed", failed.ErrorMessage);
        }
        finally
        {
            if (entered)
            {
                await downloadSlotGate.WaitAsync();
                try { runningDownloadCount--; }
                finally { downloadSlotGate.Release(); }
            }
            activeDownloads.TryRemove(initial.TaskId, out var removed);
            removed?.Dispose();
        }
    }

    private void UpdateProgress(string taskId, string line)
    {
        if (!liveDownloads.TryGetValue(taskId, out var task)) return;
        var match = ProgressRegex().Match(line);
        if (!match.Success) return;
        _ = double.TryParse(match.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var progress);
        liveDownloads[taskId] = task with
        {
            Progress = Math.Clamp(progress, 0, 100),
            Speed = match.Groups[2].Value.Trim(), Eta = match.Groups[3].Value.Trim()
        };
    }

    private async Task<RemoteToolExecutionResult> RunYtDlpAsync(
        RemoteVideoSettingsDto settings, RemoteSiteDto? site, List<string> arguments,
        CancellationToken cancellationToken, Action<string>? errorLine = null)
    {
        string? cookiePath = null;
        try
        {
            cookiePath = await CreateCookieFileAsync(site, settings.CacheRoot, cancellationToken);
            if (cookiePath is not null) arguments.InsertRange(0, ["--cookies", cookiePath]);
            AddSiteArguments(arguments, site);
            var ffmpeg = ResolveTool("ffmpeg.exe", Path.Combine("Tools", "ffmpeg", "bin", "ffmpeg.exe"), Path.Combine("Tools", "ffmpeg.exe"));
            if (File.Exists(ffmpeg)) arguments.InsertRange(0, ["--ffmpeg-location", Path.GetDirectoryName(ffmpeg)!]);
            var ytdlp = ResolveTool("yt-dlp.exe", Path.Combine("Tools", "yt-dlp.exe"));
            return await platform.RunToolAsync(ytdlp, arguments, errorLine, cancellationToken);
        }
        finally
        {
            if (cookiePath is not null) try { File.Delete(cookiePath); } catch { }
        }
    }

    private async Task<RemoteVideoResolvedItemDto> ResolveSpecializedLiveAsync(
        string url,
        RemoteSiteDto? site,
        CancellationToken cancellationToken)
    {
        var siteKey = url.Contains("douyin.com", StringComparison.OrdinalIgnoreCase) ? "douyin" : "xiaohongshu";
        var cookieText = await ReadCookieTextAsync(site, cancellationToken);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(40));
        RemoteLiveCaptureResult capture;
        try
        {
            capture = await platform.CaptureLiveAsync(new RemoteLiveCaptureRequest(
                url,
                siteKey,
                cookieText,
                ReadSiteSetting(site, "userAgent") ?? string.Empty,
                ReadSiteSetting(site, "referer") ?? url), timeout.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new RemoteVideoOperationException("直播页面解析超过 40 秒，未捕获到可播放的签名流。");
        }
        var selector = EncodeDirectStreamSelector(capture.StreamUrl);
        var format = new RemoteVideoFormatDto(
            "live", selector,
            capture.StreamUrl.Contains(".m3u8", StringComparison.OrdinalIgnoreCase) ? "直播流｜HLS" : "直播流｜FLV",
            null, null, null, true, true, null);
        var videoId = string.IsNullOrWhiteSpace(capture.VideoId) ? StableLegacyVideoId(url, string.Empty) : capture.VideoId;
        return new RemoteVideoResolvedItemDto(
            StableLegacyVideoId(url, videoId),
            url,
            string.IsNullOrWhiteSpace(capture.Title) ? $"{site?.SiteName ?? siteKey}直播" : capture.Title,
            capture.Author,
            site?.SiteName ?? (siteKey == "douyin" ? "抖音" : "小红书"),
            videoId,
            0,
            capture.CoverUrl,
            null,
            true,
            "None",
            [format]);
    }

    private async Task<IReadOnlyList<RemoteVideoResolvedItemDto>> ResolveSpecializedCreatorAsync(
        string url,
        RemoteSiteDto? site,
        CancellationToken cancellationToken)
    {
        var siteKey = url.Contains("douyin.com", StringComparison.OrdinalIgnoreCase) ? "douyin" : "xiaohongshu";
        var cookieText = await ReadCookieTextAsync(site, cancellationToken);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(50));
        RemoteCreatorCaptureResult capture;
        try
        {
            capture = await platform.CaptureCreatorAsync(new RemoteCreatorCaptureRequest(
                url,
                siteKey,
                cookieText,
                ReadSiteSetting(site, "userAgent") ?? string.Empty,
                ReadSiteSetting(site, "referer") ?? url), timeout.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new RemoteVideoOperationException("博主主页解析超过 50 秒，未捕获到公开作品列表。");
        }
        if (capture.Items.Count == 0)
            throw new RemoteVideoOperationException("博主主页没有捕获到公开的视频作品，页面可能需要重新登录验证。");
        var siteName = site?.SiteName ?? (siteKey == "douyin" ? "抖音" : "小红书");
        var format = new RemoteVideoFormatDto(
            "auto", "bestvideo*+bestaudio/best", "自动｜最高画质",
            null, null, null, true, true, null);
        return capture.Items.Select(item => new RemoteVideoResolvedItemDto(
            StableLegacyVideoId(item.Url, item.VideoId),
            item.Url,
            string.IsNullOrWhiteSpace(item.Title) ? "未命名视频" : item.Title,
            item.Author,
            siteName,
            item.VideoId,
            item.DurationSeconds,
            item.CoverUrl,
            item.PublishedAtUnix is > 0 ? DateTimeOffset.FromUnixTimeSeconds(item.PublishedAtUnix.Value) : null,
            false,
            "None",
            [format])).ToArray();
    }

    private async Task<string> ReadCookieTextAsync(RemoteSiteDto? site, CancellationToken cancellationToken)
    {
        if (site is null) return string.Empty;
        var protectedValue = await store.GetAsync(SiteSecretDomain, site.SiteId, cancellationToken);
        if (string.IsNullOrWhiteSpace(protectedValue)) return string.Empty;
        var plaintext = secrets.Unprotect(protectedValue);
        return string.IsNullOrWhiteSpace(plaintext)
            ? string.Empty
            : NormalizeCookie(plaintext, site.DomainPattern);
    }

    private async Task<string?> CreateCookieFileAsync(RemoteSiteDto? site, string cacheRoot, CancellationToken cancellationToken)
    {
        if (site is null) return null;
        var protectedValue = await store.GetAsync(SiteSecretDomain, site.SiteId, cancellationToken);
        if (string.IsNullOrWhiteSpace(protectedValue)) return null;
        var plaintext = secrets.Unprotect(protectedValue);
        if (string.IsNullOrWhiteSpace(plaintext)) return null;
        var directory = Path.Combine(cacheRoot, "cookies");
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, $"{Guid.NewGuid():N}.txt");
        var normalized = NormalizeCookie(plaintext, site.DomainPattern);
        await File.WriteAllTextAsync(path, normalized, new UTF8Encoding(false), cancellationToken);
        return path;
    }

    private async Task<RemoteSiteDto?> MatchSiteAsync(string url, CancellationToken cancellationToken)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return null;
        var sites = (await store.ListAsync(SiteDomain, cancellationToken)).Select(Deserialize<RemoteSiteDto>);
        return sites.Where(x => x.IsEnabled).FirstOrDefault(x => HostMatches(uri.Host, x.DomainPattern));
    }

    private async Task<RemoteVideoResolvedItemDto> GetItemAsync(string itemId, CancellationToken cancellationToken)
    {
        if (resolvedItems.TryGetValue(itemId, out var resolved)) return resolved;
        var json = await store.GetAsync(ItemDomain, itemId, cancellationToken)
            ?? throw new KeyNotFoundException("远程视频解析结果不存在或已过期，请重新解析。");
        return Deserialize<RemoteVideoResolvedItemDto>(json);
    }

    private async Task<RemoteVideoResolvedItemDto?> TryGetItemAsync(string itemId, CancellationToken cancellationToken)
    {
        if (resolvedItems.TryGetValue(itemId, out var resolved)) return resolved;
        var json = await store.GetAsync(ItemDomain, itemId, cancellationToken);
        return json is null ? null : TryDeserialize<RemoteVideoResolvedItemDto>(json);
    }

    private async Task SaveDownloadAsync(RemoteVideoDownloadDto task, CancellationToken cancellationToken)
        => await store.UpsertAsync(DownloadDomain, task.TaskId, JsonSerializer.Serialize(task), DateTimeOffset.Now, cancellationToken);

    private async Task ImportVideoAsync(RemoteVideoResolvedItemDto item, string outputPath, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.Now;
        var video = new VideoItemDto(
            ToVideoLibraryId(item), "Remote", item.Title, outputPath, item.OriginalUrl,
            string.Empty, string.Empty, string.Empty, false, now, now,
            DurationSeconds: item.DurationSeconds, FileSize: new FileInfo(outputPath).Length);
        await store.UpsertAsync("video", video.VideoId, JsonSerializer.Serialize(video), now, cancellationToken);
    }

    private static string ToVideoLibraryId(RemoteVideoResolvedItemDto item)
    {
        const string remotePrefix = "legacy_remote_video_";
        if (item.ItemId.StartsWith(remotePrefix, StringComparison.Ordinal) &&
            long.TryParse(item.ItemId[remotePrefix.Length..], NumberStyles.Integer, CultureInfo.InvariantCulture, out var legacyId))
            return $"legacy_video_{legacyId.ToString(CultureInfo.InvariantCulture)}";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(item.OriginalUrl + "\n" + item.VideoId));
        var value = BitConverter.ToInt64(hash, 0);
        if (value >= 0) value = -value - 1;
        return $"legacy_video_{value.ToString(CultureInfo.InvariantCulture)}";
    }

    private async Task RemoveImportedVideoAsync(string outputPath, CancellationToken cancellationToken)
    {
        foreach (var json in await store.ListAsync("video", cancellationToken))
        {
            var video = Deserialize<VideoItemDto>(json);
            if (Path.GetFullPath(video.FilePath).Equals(Path.GetFullPath(outputPath), StringComparison.OrdinalIgnoreCase))
                await store.DeleteAsync("video", video.VideoId, cancellationToken);
        }
    }

    private List<string> BuildDownloadArguments(
        RemoteVideoResolvedItemDto item, RemoteVideoSettingsDto settings, string selector,
        string targetRoot, bool cacheOnly)
    {
        var outputTemplate = cacheOnly
            ? Path.Combine(targetRoot, "%(extractor)s", "%(id)s", "%(title).180B [%(id)s].%(ext)s")
            : Path.Combine(targetRoot, NormalizeOutputTemplate(settings.FileNameTemplate));
        var args = new List<string>
        {
            "--no-config", "--no-playlist", "--newline", "--progress", "--no-warnings", "--color", "never", "-f", selector,
            "--merge-output-format", "mp4", "--print", "after_move:filepath", "-o", outputTemplate
        };
        if (settings.OverwriteExisting) args.Add("--force-overwrites"); else args.Add("--no-overwrites");
        if (settings.DownloadThumbnail && !cacheOnly) args.Add("--write-thumbnail");
        if (settings.DownloadInfoJson && !cacheOnly) args.Add("--write-info-json");
        if (settings.DownloadSubtitles && !cacheOnly) args.AddRange(["--write-subs", "--sub-langs", "all,-live_chat"]);
        args.Add(item.OriginalUrl);
        return args;
    }

    private RemoteVideoSettingsDto DefaultSettings()
    {
        return new RemoteVideoSettingsDto(
            paths.Data("RemoteVideos"), paths.Cache("remote-video"),
            "{site}\\{author}\\{title} [{id}].{ext}", "best",
            true, true, false, true, true, 3,
            ResolveTool("yt-dlp.exe", Path.Combine("Tools", "yt-dlp.exe")),
            ResolveTool("ffmpeg.exe", Path.Combine("Tools", "ffmpeg", "bin", "ffmpeg.exe"), Path.Combine("Tools", "ffmpeg.exe")),
            ResolveTool("PotPlayerMini64.exe", Path.Combine("Tools", "PotPlayerMini64.exe")), DateTimeOffset.Now);
    }

    private (RemoteVideoSettingsDto Settings, bool Changed) NormalizeLegacyDefaultPaths(RemoteVideoSettingsDto settings)
    {
        var downloadRoot = IsLegacyProjectDefault(settings.DownloadRoot, "RemoteVideos")
            ? paths.Data("RemoteVideos")
            : settings.DownloadRoot;
        var cacheRoot = IsLegacyProjectDefault(settings.CacheRoot, "cache", "ytdlp")
            ? paths.Cache("remote-video")
            : settings.CacheRoot;
        var changed = !PathEquals(downloadRoot, settings.DownloadRoot) || !PathEquals(cacheRoot, settings.CacheRoot);
        return changed
            ? (settings with { DownloadRoot = downloadRoot, CacheRoot = cacheRoot, UpdatedAt = DateTimeOffset.Now }, true)
            : (settings, false);
    }

    private async Task<RemoteVideoSettingsDto> AttachRuntimeToolPathsAsync(RemoteVideoSettingsDto settings, CancellationToken cancellationToken)
        => settings with
        {
            YtDlpPath = ResolveTool("yt-dlp.exe", Path.Combine("Tools", "yt-dlp.exe")),
            FfmpegPath = ResolveTool("ffmpeg.exe", Path.Combine("Tools", "ffmpeg", "bin", "ffmpeg.exe"), Path.Combine("Tools", "ffmpeg.exe")),
            PotPlayerPath = await ResolvePotPlayerPathAsync(cancellationToken)
        };

    private async Task<string> ResolvePotPlayerPathAsync(CancellationToken cancellationToken)
    {
        var configured = Environment.ExpandEnvironmentVariables(await ReadSettingAsync(
            "user_config:PotPlayerBridge:PotPlayerExePath", @"F:\软件\pot\PotPlayer\PotPlayerMini64.exe", cancellationToken));
        return File.Exists(configured)
            ? Path.GetFullPath(configured)
            : ResolveTool("PotPlayerMini64.exe", Path.Combine("Tools", "PotPlayerMini64.exe"));
    }

    private async Task<string> ReadSettingAsync(string key, string fallback, CancellationToken cancellationToken)
        => (await settingsStore.GetAsync(key, cancellationToken))?.Value ?? SettingsApplicationService.DefaultSetting(key)?.Value ?? fallback;

    private string ResolveTool(string executableName, params string[] relativeCandidates)
    {
        foreach (var relative in relativeCandidates)
        {
            var candidate = Path.GetFullPath(Path.Combine(paths.ResourceRoot, relative));
            if (File.Exists(candidate)) return candidate;
        }
        foreach (var root in (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
                     .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var candidate = Path.Combine(root.Trim('"'), executableName);
            if (File.Exists(candidate)) return Path.GetFullPath(candidate);
        }
        return Path.GetFullPath(Path.Combine(paths.ResourceRoot, relativeCandidates.FirstOrDefault() ?? executableName));
    }

    private static void ValidateSettings(RemoteVideoSettingsDto settings)
    {
        string[] pathsToValidate = [settings.DownloadRoot, settings.CacheRoot];
        if (pathsToValidate.Any(x => string.IsNullOrWhiteSpace(x) || !Path.IsPathFullyQualified(Environment.ExpandEnvironmentVariables(x))))
            throw new ArgumentException("下载目录、缓存目录和工具路径必须是绝对路径。");
        if (string.IsNullOrWhiteSpace(settings.FileNameTemplate) || settings.FileNameTemplate.Length > 300)
            throw new ArgumentException("下载命名模板不能为空且不能超过 300 个字符。");
        if (settings.MaxConcurrentDownloads is < 1 or > 4) throw new ArgumentException("同时下载数必须在 1 到 4 之间。");
    }

    private static IReadOnlyList<string> SplitLinks(string input)
        => input.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(x => Uri.TryCreate(x, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
            .Select(NormalizeRemoteUrl)
            .Distinct(StringComparer.Ordinal).ToArray();

    private static string NormalizeRemoteUrl(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || !IsXTwitterHost(uri.Host)) return value;
        var match = XStatusVideoRegex().Match(uri.AbsolutePath);
        if (!match.Success) return value;
        var builder = new UriBuilder(uri.Scheme, uri.Host, uri.IsDefaultPort ? -1 : uri.Port,
            $"/{match.Groups[1].Value}/status/{match.Groups[2].Value}");
        return builder.Uri.AbsoluteUri.TrimEnd('/');
    }

    private static bool IsXTwitterHost(string host)
        => host.Equals("x.com", StringComparison.OrdinalIgnoreCase) || host.EndsWith(".x.com", StringComparison.OrdinalIgnoreCase) ||
           host.Equals("twitter.com", StringComparison.OrdinalIgnoreCase) || host.EndsWith(".twitter.com", StringComparison.OrdinalIgnoreCase);

    private static void AddSiteArguments(List<string> arguments, RemoteSiteDto? site)
    {
        if (site is null || string.IsNullOrWhiteSpace(site.SettingsJson)) return;
        try
        {
            using var document = JsonDocument.Parse(site.SettingsJson);
            if (TryReadSetting(document.RootElement, "userAgent", out var userAgent))
                arguments.InsertRange(0, ["--user-agent", userAgent]);
            if (TryReadSetting(document.RootElement, "referer", out var referer))
                arguments.InsertRange(0, ["--referer", referer]);
        }
        catch (JsonException)
        {
            throw new InvalidDataException($"站点“{site.SiteName}”的扩展设置 JSON 无效。");
        }
    }

    private static string? ReadSiteSetting(RemoteSiteDto? site, string name)
    {
        if (site is null || string.IsNullOrWhiteSpace(site.SettingsJson)) return null;
        try
        {
            using var document = JsonDocument.Parse(site.SettingsJson);
            return TryReadSetting(document.RootElement, name, out var value) ? value : null;
        }
        catch (JsonException) { return null; }
    }

    private static bool TryReadSetting(JsonElement element, string name, out string value)
    {
        value = string.Empty;
        if (element.ValueKind != JsonValueKind.Object) return false;
        var property = element.EnumerateObject().FirstOrDefault(x => x.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
        if (property.Value.ValueKind != JsonValueKind.String) return false;
        value = property.Value.GetString()?.Trim() ?? string.Empty;
        return value.Length > 0;
    }

    private static IReadOnlyList<RemoteVideoResolvedItemDto> ParseResolvedItems(JsonElement root, string originalUrl, string siteName)
    {
        var elements = root.TryGetProperty("entries", out var entries) && entries.ValueKind == JsonValueKind.Array
            ? entries.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.Object).ToArray()
            : [root];
        return elements.Select(element => ParseItem(element, originalUrl, siteName)).ToArray();
    }

    private async Task<PlaylistHydrationResult> HydratePlaylistItemsAsync(
        IReadOnlyList<RemoteVideoResolvedItemDto> items,
        RemoteVideoSettingsDto settings,
        RemoteSiteDto? site,
        CancellationToken cancellationToken)
    {
        if (items.Count <= 1 || !items.Any(NeedsMetadataHydration))
            return new PlaylistHydrationResult(items, 0);
        using var gate = new SemaphoreSlim(4, 4);
        var failed = 0;
        var tasks = items.Select(async item =>
        {
            if (!NeedsMetadataHydration(item)) return (RemoteVideoResolvedItemDto?)item;
            await gate.WaitAsync(cancellationToken);
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(TimeSpan.FromSeconds(30));
                var result = await RunYtDlpAsync(settings, site,
                    ["--no-config", "-J", "--skip-download", "--no-playlist", "--no-warnings", "--color", "never", item.OriginalUrl],
                    timeout.Token);
                if (result.ExitCode != 0) throw new InvalidOperationException();
                using var document = JsonDocument.Parse(result.StandardOutput);
                return ParseItem(document.RootElement, item.OriginalUrl, item.SiteName) with
                {
                    ItemId = item.ItemId,
                    DownloadStatus = item.DownloadStatus
                };
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                Interlocked.Increment(ref failed);
                return null;
            }
            finally
            {
                gate.Release();
            }
        }).ToArray();
        return new PlaylistHydrationResult(
            (await Task.WhenAll(tasks)).Where(x => x is not null).Select(x => x!).ToArray(),
            failed);
    }

    private static bool NeedsMetadataHydration(RemoteVideoResolvedItemDto item)
        => string.IsNullOrWhiteSpace(item.ThumbnailUrl) ||
           string.IsNullOrWhiteSpace(item.Author) ||
           item.Title.Equals("未命名视频", StringComparison.Ordinal) ||
           item.DurationSeconds <= 0;

    private static RemoteVideoResolvedItemDto ParseItem(JsonElement element, string fallbackUrl, string siteName)
    {
        var videoId = ReadString(element, "id");
        var originalUrl = ReadString(element, "webpage_url");
        if (string.IsNullOrWhiteSpace(originalUrl)) originalUrl = ReadString(element, "original_url");
        if (string.IsNullOrWhiteSpace(originalUrl))
        {
            var candidate = ReadString(element, "url");
            originalUrl = Uri.TryCreate(candidate, UriKind.Absolute, out _) ? candidate : fallbackUrl;
        }
        var formats = ParseFormats(element);
        var duration = element.TryGetProperty("duration", out var durationElement) && durationElement.TryGetDouble(out var seconds)
            ? Math.Max(0, (int)Math.Round(seconds)) : 0;
        DateTimeOffset? publishedAt = null;
        if (element.TryGetProperty("timestamp", out var timestamp) && timestamp.TryGetInt64(out var unix))
            publishedAt = DateTimeOffset.FromUnixTimeSeconds(unix);
        var liveStatus = ReadString(element, "live_status");
        var itemId = StableLegacyVideoId(originalUrl, videoId);
        return new RemoteVideoResolvedItemDto(
            itemId, originalUrl, ReadString(element, "title", "未命名视频"),
            ReadString(element, "uploader", ReadString(element, "channel")),
            string.IsNullOrWhiteSpace(siteName) ? ReadString(element, "extractor_key", HostLabel(originalUrl)) : siteName,
            videoId, duration, ReadThumbnailUrl(element), publishedAt,
            !string.IsNullOrWhiteSpace(liveStatus) && liveStatus != "not_live", "None", formats);
    }

    private static IReadOnlyList<RemoteVideoFormatDto> ParseFormats(JsonElement element)
    {
        var values = new List<RemoteVideoFormatDto>
        {
            new("auto", "bestvideo*+bestaudio/best", "自动｜最高画质", null, null, null, true, true, null)
        };
        if (!element.TryGetProperty("formats", out var formats) || formats.ValueKind != JsonValueKind.Array) return values;
        foreach (var format in formats.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.Object))
        {
            var id = ReadString(format, "format_id");
            if (string.IsNullOrWhiteSpace(id)) continue;
            var videoCodec = ReadString(format, "vcodec");
            var audioCodec = ReadString(format, "acodec");
            var hasVideo = !string.IsNullOrWhiteSpace(videoCodec) && videoCodec != "none";
            var hasAudio = !string.IsNullOrWhiteSpace(audioCodec) && audioCodec != "none";
            int? width = ReadNullableInt(format, "width");
            int? height = ReadNullableInt(format, "height");
            double? fps = ReadNullableDouble(format, "fps");
            long? size = ReadNullableLong(format, "filesize") ?? ReadNullableLong(format, "filesize_approx");
            var selector = hasVideo && !hasAudio ? $"{id}+bestaudio/best" : id;
            var label = height.HasValue ? $"{height}p{(fps >= 50 ? Math.Round(fps.Value).ToString(CultureInfo.InvariantCulture) : string.Empty)}" : ReadString(format, "format_note", id);
            values.Add(new RemoteVideoFormatDto(id, selector, label, width, height, fps, hasVideo, hasAudio, size));
        }
        return values.Where(x => x.FormatId == "auto" || x.HasVideo).GroupBy(x => x.Selector).Select(x => x.First()).ToArray();
    }

    private static string ResolveSelector(RemoteVideoResolvedItemDto item, string? requested, string fallback)
    {
        if (!string.IsNullOrWhiteSpace(requested))
        {
            var format = item.Formats?.FirstOrDefault(x => x.Selector == requested || x.FormatId == requested);
            if (format is not null) return format.Selector;
            throw new ArgumentException("所选清晰度不属于当前解析结果。", nameof(requested));
        }
        return string.IsNullOrWhiteSpace(fallback) || fallback.Equals("auto", StringComparison.OrdinalIgnoreCase)
            ? "bestvideo*+bestaudio/best" : fallback;
    }

    private static bool IsSpecializedLiveUrl(string url)
        => Uri.TryCreate(url, UriKind.Absolute, out var uri) &&
           (uri.Host.Equals("live.douyin.com", StringComparison.OrdinalIgnoreCase) ||
            (uri.Host.EndsWith("xiaohongshu.com", StringComparison.OrdinalIgnoreCase) &&
             uri.AbsolutePath.Contains("/livestream/", StringComparison.OrdinalIgnoreCase)));

    private static bool IsSpecializedCreatorUrl(string url)
        => Uri.TryCreate(url, UriKind.Absolute, out var uri) &&
           ((uri.Host.EndsWith("douyin.com", StringComparison.OrdinalIgnoreCase) &&
             uri.AbsolutePath.Contains("/user/", StringComparison.OrdinalIgnoreCase)) ||
            (uri.Host.EndsWith("xiaohongshu.com", StringComparison.OrdinalIgnoreCase) &&
             uri.AbsolutePath.Contains("/user/profile/", StringComparison.OrdinalIgnoreCase)));

    private static string EncodeDirectStreamSelector(string streamUrl)
        => DirectStreamSelectorPrefix + Convert.ToBase64String(Encoding.UTF8.GetBytes(streamUrl))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static bool TryDecodeDirectStreamSelector(string selector, out string streamUrl)
    {
        streamUrl = string.Empty;
        if (!selector.StartsWith(DirectStreamSelectorPrefix, StringComparison.Ordinal)) return false;
        var value = selector[DirectStreamSelectorPrefix.Length..].Replace('-', '+').Replace('_', '/');
        value = value.PadRight(value.Length + (4 - value.Length % 4) % 4, '=');
        try
        {
            streamUrl = Encoding.UTF8.GetString(Convert.FromBase64String(value));
            return Uri.TryCreate(streamUrl, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https";
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static string StableLegacyVideoId(string originalUrl, string videoId)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(originalUrl + "\n" + videoId));
        var value = BitConverter.ToInt64(hash, 0);
        if (value >= 0) value = -value - 1;
        return $"legacy_remote_video_{value}";
    }

    private static string NewLegacyId(string prefix)
    {
        var value = BitConverter.ToInt64(Guid.NewGuid().ToByteArray(), 0);
        if (value >= 0) value = -value - 1;
        return prefix + value.ToString(CultureInfo.InvariantCulture);
    }

    private sealed record PlaylistHydrationResult(
        IReadOnlyList<RemoteVideoResolvedItemDto> Items,
        int FailedCount);

    private static string NormalizeOutputTemplate(string template)
        => template.Replace("{site}", "%(extractor)s", StringComparison.OrdinalIgnoreCase)
            .Replace("{author}", "%(uploader,channel,creator|unknown)s", StringComparison.OrdinalIgnoreCase)
            .Replace("{title}", "%(title).180B", StringComparison.OrdinalIgnoreCase)
            .Replace("{id}", "%(id)s", StringComparison.OrdinalIgnoreCase)
            .Replace("{ext}", "%(ext)s", StringComparison.OrdinalIgnoreCase);

    private static string? ResolveDownloadedFilePath(
        string output, string root, string videoId, DateTime startedAtUtc)
    {
        var printedPath = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Trim().Trim('"'))
            .LastOrDefault(File.Exists);
        if (!string.IsNullOrWhiteSpace(printedPath)) return Path.GetFullPath(printedPath);
        if (!Directory.Exists(root)) return null;

        var mediaFiles = Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .Where(IsFinalMediaFile)
            .Select(path => new FileInfo(path))
            .ToList();
        var candidates = mediaFiles
            .Where(file => file.LastWriteTimeUtc >= startedAtUtc.AddSeconds(-2))
            .ToList();
        if (!string.IsNullOrWhiteSpace(videoId))
        {
            var idMatch = candidates
                .Where(file => file.Name.Contains($"[{videoId}]", StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(file => file.LastWriteTimeUtc)
                .FirstOrDefault();
            if (idMatch is not null) return idMatch.FullName;

            var existingIdMatch = mediaFiles
                .Where(file => file.Name.Contains($"[{videoId}]", StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(file => file.LastWriteTimeUtc)
                .FirstOrDefault();
            if (existingIdMatch is not null) return existingIdMatch.FullName;
        }
        return candidates.Count == 1 ? candidates[0].FullName : null;
    }

    private static bool IsFinalMediaFile(string path)
    {
        var extension = Path.GetExtension(path);
        return extension.Equals(".mp4", StringComparison.OrdinalIgnoreCase) ||
               extension.Equals(".mkv", StringComparison.OrdinalIgnoreCase) ||
               extension.Equals(".webm", StringComparison.OrdinalIgnoreCase) ||
               extension.Equals(".mov", StringComparison.OrdinalIgnoreCase) ||
               extension.Equals(".flv", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsLegacyProjectDefault(string value, params string[] relativeSegments)
    {
        if (string.IsNullOrWhiteSpace(value) || !Path.IsPathFullyQualified(value)) return false;
        var fullPath = Path.GetFullPath(Environment.ExpandEnvironmentVariables(value))
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var legacySuffix = Path.Combine(["AI_maid", .. relativeSegments]);
        return fullPath.EndsWith(Path.DirectorySeparatorChar + legacySuffix, StringComparison.OrdinalIgnoreCase);
    }

    private static bool PathEquals(string left, string right)
        => Path.GetFullPath(Environment.ExpandEnvironmentVariables(left))
            .Equals(Path.GetFullPath(Environment.ExpandEnvironmentVariables(right)), StringComparison.OrdinalIgnoreCase);

    private static string ReadThumbnailUrl(JsonElement element)
    {
        var direct = ReadString(element, "thumbnail");
        if (Uri.TryCreate(direct, UriKind.Absolute, out var directUri) && directUri.Scheme is "http" or "https")
            return direct;
        if (!element.TryGetProperty("thumbnails", out var thumbnails) || thumbnails.ValueKind != JsonValueKind.Array)
            return string.Empty;
        return thumbnails.EnumerateArray()
            .Where(x => x.ValueKind == JsonValueKind.Object)
            .Select(x => new
            {
                Url = ReadString(x, "url"),
                Area = (ReadNullableDouble(x, "width") ?? 0) * (ReadNullableDouble(x, "height") ?? 0)
            })
            .Where(x => Uri.TryCreate(x.Url, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
            .OrderByDescending(x => x.Area)
            .Select(x => x.Url)
            .FirstOrDefault() ?? string.Empty;
    }

    private static bool HostMatches(string host, string pattern)
    {
        var normalized = pattern.Trim().TrimStart('*').TrimStart('.');
        return normalized.Length > 0 && (host.Equals(normalized, StringComparison.OrdinalIgnoreCase) || host.EndsWith("." + normalized, StringComparison.OrdinalIgnoreCase));
    }

    private static string NormalizeCookie(string value, string domainPattern)
    {
        value = Regex.Replace(value, @"\\+(?:r\\+)?n", "\n", RegexOptions.CultureInvariant);
        value = Regex.Replace(value, @"\\+t", "\t", RegexOptions.CultureInvariant);
        if (value.Contains("# Netscape HTTP Cookie File", StringComparison.OrdinalIgnoreCase) || value.Contains('\t'))
            return NormalizeNetscapeCookieText(value);
        var domain = "." + domainPattern.Trim().TrimStart('*').TrimStart('.');
        var builder = new StringBuilder("# Netscape HTTP Cookie File" + Environment.NewLine);
        foreach (var part in value.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var separator = part.IndexOf('=');
            if (separator <= 0) continue;
            builder.Append(domain).Append("\tTRUE\t/\tFALSE\t0\t")
                .Append(part[..separator].Trim()).Append('\t').AppendLine(part[(separator + 1)..].Trim());
        }
        return builder.ToString();
    }

    private static string NormalizeNetscapeCookieText(string value)
    {
        var builder = new StringBuilder("# Netscape HTTP Cookie File" + Environment.NewLine);
        foreach (var line in value.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (line.StartsWith('#') && !line.StartsWith("#HttpOnly_", StringComparison.OrdinalIgnoreCase)) continue;
            var fields = line.Split('\t');
            if (fields.Length < 7)
                fields = Regex.Split(line.Trim(), @"\s+", RegexOptions.CultureInvariant);
            if (fields.Length < 7) continue;
            builder.Append(string.Join('\t', fields.Take(6)))
                .Append('\t')
                .AppendLine(string.Join(' ', fields.Skip(6)));
        }
        return builder.ToString();
    }

    private static bool IsDirectoryWritable(string directory)
    {
        try
        {
            Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, $".aimaid-write-{Guid.NewGuid():N}.tmp");
            using (File.Create(path, 1, FileOptions.DeleteOnClose)) { }
            return true;
        }
        catch { return false; }
    }

    private void SetDiagnostic(string operation, string status, string message)
    {
        lastOperation = operation;
        lastStatus = status;
        lastMessage = SanitizeExternalMessage(message, "远程视频操作失败。");
    }

    private static string SanitizeExternalMessage(string value, string fallback)
    {
        if (string.IsNullOrWhiteSpace(value)) return fallback;
        var sanitized = CookieRegex().Replace(value, "$1=<redacted>");
        sanitized = CookiePathRegex().Replace(sanitized, "$1<redacted>");
        sanitized = QueryStringRegex().Replace(sanitized, "$1?<redacted>");
        return sanitized.Length > 1200 ? sanitized[..1200] : sanitized;
    }

    private static string HostLabel(string url)
        => Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.Host : "远程站点";
    private static string ReadString(JsonElement element, string name, string fallback = "")
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? fallback : fallback;
    private static int? ReadNullableInt(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var parsed) ? parsed : null;
    private static long? ReadNullableLong(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var parsed) ? parsed : null;
    private static double? ReadNullableDouble(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var parsed) ? parsed : null;
    private static T Deserialize<T>(string json)
        => JsonSerializer.Deserialize<T>(json) ?? throw new InvalidDataException($"{typeof(T).Name} JSON 无效。");

    [GeneratedRegex(@"(?i)\b(cookie|sessionid|token|authorization)\s*[=:]\s*[^\s;]+")]
    private static partial Regex CookieRegex();
    [GeneratedRegex(@"(?i)(--cookies\s+|cookie file\s+)[^\s\r\n]+")]
    private static partial Regex CookiePathRegex();
    [GeneratedRegex(@"(https?://[^\s?]+)\?[^\s]+", RegexOptions.IgnoreCase)]
    private static partial Regex QueryStringRegex();
    private static T? TryDeserialize<T>(string json) where T : class
    {
        try { return JsonSerializer.Deserialize<T>(json); }
        catch { return null; }
    }

    [GeneratedRegex(@"(?i)(\d{1,3}(?:\.\d+)?)%.*?([\d.]+\s*[KMG]?i?B/s|Unknown]+).*?ETA\s+([\d:]+|Unknown)")]
    private static partial Regex ProgressRegex();
    [GeneratedRegex(@"^/([^/]+)/status/(\d+)(?:/video/\d+)?/?$", RegexOptions.IgnoreCase)]
    private static partial Regex XStatusVideoRegex();
}

public sealed class RemoteVideoOperationException(string message) : Exception(message);
