using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using AIMaid.Contracts;
using AIMaid.Contracts.Domains;
using Microsoft.VisualBasic.FileIO;

namespace AIMaid.Core;

public sealed class VideoLibraryApplicationService
{
    private const string VideoDomain = "video";
    private const string AlbumDomain = "video_album";
    private const string TagDomain = "video_tag";
    private const int MpegTsPacketSize = 188;
    private static readonly string[] VideoExtensions = [".mp4", ".mkv", ".mov", ".avi", ".wmv", ".flv", ".webm", ".m4v", ".ts", ".m2ts"];
    private readonly IDomainDocumentStore store;
    private readonly ISettingsStore settings;
    private readonly IExternalProgramController programs;
    private readonly ApplicationPaths paths;

    public VideoLibraryApplicationService(IDomainDocumentStore store, ISettingsStore settings, IExternalProgramController programs, ApplicationPaths paths)
    {
        this.store = store;
        this.settings = settings;
        this.programs = programs;
        this.paths = paths;
    }

    public async Task<VideoLibrarySnapshotDto> HandleAsync(ListVideosQuery query, CancellationToken cancellationToken = default)
    {
        var items = (await ListAsync<VideoItemDto>(VideoDomain, cancellationToken))
            .Where(IsVisibleLibraryVideo)
            .Where(item => !query.FavoritesOnly || item.IsFavorite)
            .OrderByDescending(item => item.CreatedAt)
            .ThenBy(item => DisplayName(item), StringComparer.CurrentCultureIgnoreCase)
            .ToArray();
        var albums = (await ListAlbumsAsync(cancellationToken))
            .OrderBy(album => album.SortOrder).ThenBy(album => album.Name, StringComparer.CurrentCultureIgnoreCase).ToArray();
        var definitions = await ListAsync<VideoTagDefinitionDocument>(TagDomain, cancellationToken);
        var tags = items.SelectMany(item => NormalizeTags(item.Tags)).Concat(definitions.Select(item => item.Name))
            .Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(tag => tag, StringComparer.CurrentCultureIgnoreCase).ToArray();
        return new VideoLibrarySnapshotDto(items, albums, tags);
    }

    public async Task<OperationResult<VideoItemDto>> HandleAsync(ImportVideoFileCommand command, CancellationToken cancellationToken = default)
    {
        string fullPath;
        try { fullPath = Path.GetFullPath(command.FilePath); }
        catch { return OperationResult<VideoItemDto>.Failure("video.invalid_path", "请选择支持的视频文件。"); }
        if (!File.Exists(fullPath) || !IsVideoFile(fullPath))
            return OperationResult<VideoItemDto>.Failure("video.unsupported_file", "请选择支持的视频文件。");
        if (!await AlbumExistsAsync(command.AlbumId, cancellationToken))
            return OperationResult<VideoItemDto>.Failure("video.album_not_found", "目标专辑不存在。");

        var existing = (await ListAsync<VideoItemDto>(VideoDomain, cancellationToken))
            .FirstOrDefault(item => PathsEqual(item.FilePath, fullPath));
        if (existing is not null)
        {
            if (!string.IsNullOrWhiteSpace(command.AlbumId) && existing.AlbumId != command.AlbumId)
            {
                existing = existing with { AlbumId = command.AlbumId, UpdatedAt = DateTimeOffset.Now };
                await SaveVideoAsync(existing, cancellationToken);
            }
            return OperationResult<VideoItemDto>.Success(existing);
        }

        var info = new FileInfo(fullPath);
        var now = DateTimeOffset.Now;
        var item = new VideoItemDto(
            Guid.NewGuid().ToString("N"), "LocalFile", Path.GetFileNameWithoutExtension(fullPath), fullPath, string.Empty,
            string.Empty, string.Empty, string.Empty, false, now, now, command.AlbumId,
            await ProbeDurationAsync(fullPath, cancellationToken), 0, false, info.Length, null, string.Empty);
        await SaveVideoAsync(item, cancellationToken);
        return OperationResult<VideoItemDto>.Success(item);
    }

    public async Task<OperationResult<VideoImportResultDto>> HandleAsync(ImportVideoFolderCommand command, CancellationToken cancellationToken = default)
    {
        string fullPath;
        try { fullPath = Path.GetFullPath(command.FolderPath); }
        catch { return OperationResult<VideoImportResultDto>.Failure("video.folder_missing", "视频文件夹不存在。"); }
        if (!Directory.Exists(fullPath))
            return OperationResult<VideoImportResultDto>.Failure("video.folder_missing", "视频文件夹不存在。");
        if (!await AlbumExistsAsync(command.AlbumId, cancellationToken))
            return OperationResult<VideoImportResultDto>.Failure("video.album_not_found", "目标专辑不存在。");

        var option = command.Recursive ? System.IO.SearchOption.AllDirectories : System.IO.SearchOption.TopDirectoryOnly;
        var imported = new List<VideoItemDto>();
        foreach (var file in Directory.EnumerateFiles(fullPath, "*.*", option).Where(IsVideoFile))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var before = (await ListAsync<VideoItemDto>(VideoDomain, cancellationToken)).FirstOrDefault(item => PathsEqual(item.FilePath, file));
            var result = await HandleAsync(new ImportVideoFileCommand(file, command.AlbumId), cancellationToken);
            if (!result.Succeeded || result.Value is null)
                return OperationResult<VideoImportResultDto>.Failure(result.ErrorCode ?? "video.import_failed", result.ErrorMessage ?? "视频导入失败。");
            if (before is null || before.AlbumId != result.Value.AlbumId) imported.Add(result.Value);
        }
        return OperationResult<VideoImportResultDto>.Success(new VideoImportResultDto(imported.Count, imported));
    }

    public async Task<OperationResult<VideoImportResultDto>> HandleAsync(RefreshVideoMetadataCommand command, CancellationToken cancellationToken = default)
    {
        if (!TryValidateIds(command.VideoIds, out var ids, out var error)) return OperationResult<VideoImportResultDto>.Failure("video.invalid_ids", error);
        var items = await ListAsync<VideoItemDto>(VideoDomain, cancellationToken);
        var refreshed = new List<VideoItemDto>();
        foreach (var item in items.Where(item => ids.Contains(item.VideoId)))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!string.Equals(item.SourceType, "LocalFile", StringComparison.OrdinalIgnoreCase) || !File.Exists(item.FilePath)) continue;
            var info = new FileInfo(item.FilePath);
            var duration = await ProbeDurationAsync(item.FilePath, cancellationToken);
            var updated = item with
            {
                Title = string.IsNullOrWhiteSpace(item.Title) ? Path.GetFileNameWithoutExtension(item.FilePath) : item.Title,
                DurationSeconds = duration > 0 ? duration : item.DurationSeconds,
                FileSize = info.Length,
                UpdatedAt = DateTimeOffset.Now
            };
            await SaveVideoAsync(updated, cancellationToken);
            refreshed.Add(updated);
        }
        return OperationResult<VideoImportResultDto>.Success(new VideoImportResultDto(refreshed.Count, refreshed));
    }

    public Task<OperationResult> HandleAsync(ToggleVideoFavoriteCommand command, CancellationToken cancellationToken = default)
        => UpdateVideoAsync(command.VideoId, item => item with { IsFavorite = !item.IsFavorite, UpdatedAt = DateTimeOffset.Now }, cancellationToken);

    public Task<OperationResult> HandleAsync(SetVideoDisplayNameCommand command, CancellationToken cancellationToken = default)
    {
        var name = command.DisplayName.Trim();
        return string.IsNullOrWhiteSpace(name)
            ? Task.FromResult(OperationResult.Failure("video.invalid_name", "显示名不能为空。"))
            : UpdateVideoAsync(command.VideoId, item => item with { Title = name, UpdatedAt = DateTimeOffset.Now }, cancellationToken);
    }

    public Task<OperationResult> HandleAsync(SetVideoRemarkCommand command, CancellationToken cancellationToken = default)
        => UpdateVideoAsync(command.VideoId, item => item with { Remark = command.Remark.Trim(), UpdatedAt = DateTimeOffset.Now }, cancellationToken);

    public Task<OperationResult> HandleAsync(UpdateVideoProgressCommand command, CancellationToken cancellationToken = default)
        => UpdateVideoAsync(command.VideoId, item =>
        {
            var position = Math.Max(0, command.PositionSeconds);
            var duration = Math.Max(item.DurationSeconds, Math.Max(0, command.DurationSeconds));
            return item with
            {
                LastPositionSeconds = position,
                DurationSeconds = duration,
                IsCompleted = IsPlaybackCompleted(position, duration),
                LastPlayedAt = DateTimeOffset.Now,
                UpdatedAt = DateTimeOffset.Now
            };
        }, cancellationToken);

    private static bool IsPlaybackCompleted(int positionSeconds, int durationSeconds)
    {
        if (positionSeconds <= 0 || durationSeconds <= 0) return false;
        var completionWindowSeconds = Math.Min(20, Math.Max(2, (int)Math.Ceiling(durationSeconds * 0.05)));
        return durationSeconds - positionSeconds <= completionWindowSeconds;
    }

    public async Task<OperationResult<VideoAlbumDto>> HandleAsync(CreateVideoAlbumCommand command, CancellationToken cancellationToken = default)
    {
        var name = command.Name.Trim();
        if (string.IsNullOrWhiteSpace(name)) return OperationResult<VideoAlbumDto>.Failure("video.album_invalid", "专辑名称不能为空。");
        var albums = await ListAlbumsAsync(cancellationToken);
        var existing = albums.FirstOrDefault(album => album.Name == name);
        if (existing is not null) return OperationResult<VideoAlbumDto>.Success(existing);
        var now = DateTimeOffset.Now;
        var album = new VideoAlbumDto(Guid.NewGuid().ToString("N"), name, command.Description.Trim(), string.Empty,
            (albums.Count == 0 ? 0 : albums.Max(item => item.SortOrder)) + 10, now, now);
        await store.UpsertAsync(AlbumDomain, album.AlbumId, JsonSerializer.Serialize(album), album.UpdatedAt, cancellationToken);
        return OperationResult<VideoAlbumDto>.Success(album);
    }

    public async Task<OperationResult> HandleAsync(RenameVideoAlbumCommand command, CancellationToken cancellationToken = default)
    {
        var name = command.Name.Trim();
        if (string.IsNullOrWhiteSpace(name)) return OperationResult.Failure("video.album_invalid", "专辑名称不能为空。");
        var album = await GetAsync<VideoAlbumDto>(AlbumDomain, command.AlbumId, cancellationToken);
        if (album is null) return OperationResult.Success();
        album = album with { AlbumId = command.AlbumId, Name = name, CoverPath = album.CoverPath ?? string.Empty, UpdatedAt = DateTimeOffset.Now };
        await store.UpsertAsync(AlbumDomain, album.AlbumId, JsonSerializer.Serialize(album), album.UpdatedAt, cancellationToken);
        return OperationResult.Success();
    }

    public async Task<OperationResult> HandleAsync(DeleteVideoAlbumCommand command, CancellationToken cancellationToken = default)
    {
        if (await GetAsync<VideoAlbumDto>(AlbumDomain, command.AlbumId, cancellationToken) is null) return OperationResult.Success();
        foreach (var item in (await ListAsync<VideoItemDto>(VideoDomain, cancellationToken)).Where(item => item.AlbumId == command.AlbumId))
            await SaveVideoAsync(item with { AlbumId = null, UpdatedAt = DateTimeOffset.Now }, cancellationToken);
        await store.DeleteAsync(AlbumDomain, command.AlbumId, cancellationToken);
        return OperationResult.Success();
    }

    public async Task<OperationResult> HandleAsync(MoveVideosToAlbumCommand command, CancellationToken cancellationToken = default)
    {
        if (!TryValidateIds(command.VideoIds, out var ids, out var error)) return OperationResult.Failure("video.invalid_ids", error);
        if (!await AlbumExistsAsync(command.AlbumId, cancellationToken)) return OperationResult.Failure("video.album_not_found", "目标专辑不存在。");
        foreach (var item in (await ListAsync<VideoItemDto>(VideoDomain, cancellationToken)).Where(item => ids.Contains(item.VideoId)))
            await SaveVideoAsync(item with { AlbumId = command.AlbumId, UpdatedAt = DateTimeOffset.Now }, cancellationToken);
        return OperationResult.Success();
    }

    public async Task<OperationResult> HandleAsync(CreateVideoTagCommand command, CancellationToken cancellationToken = default)
    {
        var tag = command.Tag.Trim();
        if (string.IsNullOrWhiteSpace(tag)) return OperationResult.Success();
        var tags = await ListAsync<VideoTagDefinitionDocument>(TagDomain, cancellationToken);
        if (tags.Any(item => item.Name.Equals(tag, StringComparison.OrdinalIgnoreCase))) return OperationResult.Success();
        await store.UpsertAsync(TagDomain, TagId(tag), JsonSerializer.Serialize(new VideoTagDefinitionDocument(tag)), DateTimeOffset.Now, cancellationToken);
        return OperationResult.Success();
    }

    public async Task<OperationResult> HandleAsync(RenameVideoTagCommand command, CancellationToken cancellationToken = default)
    {
        var oldTag = command.OldTag.Trim();
        var newTag = command.NewTag.Trim();
        if (string.IsNullOrWhiteSpace(oldTag) || string.IsNullOrWhiteSpace(newTag) || oldTag.Equals(newTag, StringComparison.OrdinalIgnoreCase)) return OperationResult.Success();
        await HandleAsync(new CreateVideoTagCommand(newTag), cancellationToken);
        foreach (var item in (await ListAsync<VideoItemDto>(VideoDomain, cancellationToken)).Where(item => HasTag(item.Tags, oldTag)))
        {
            var tags = NormalizeTags(item.Tags).Select(tag => tag.Equals(oldTag, StringComparison.OrdinalIgnoreCase) ? newTag : tag)
                .Distinct(StringComparer.OrdinalIgnoreCase);
            await SaveVideoAsync(item with { Tags = string.Join(", ", tags), UpdatedAt = DateTimeOffset.Now }, cancellationToken);
        }
        foreach (var definition in (await ListAsync<VideoTagDefinitionDocument>(TagDomain, cancellationToken)).Where(item => item.Name.Equals(oldTag, StringComparison.OrdinalIgnoreCase)))
            await store.DeleteAsync(TagDomain, TagId(definition.Name), cancellationToken);
        return OperationResult.Success();
    }

    public async Task<OperationResult> HandleAsync(DeleteVideoTagCommand command, CancellationToken cancellationToken = default)
    {
        var tag = command.Tag.Trim();
        if (string.IsNullOrWhiteSpace(tag)) return OperationResult.Success();
        foreach (var item in (await ListAsync<VideoItemDto>(VideoDomain, cancellationToken)).Where(item => HasTag(item.Tags, tag)))
            await SaveVideoAsync(item with { Tags = string.Join(", ", NormalizeTags(item.Tags).Where(value => !value.Equals(tag, StringComparison.OrdinalIgnoreCase))), UpdatedAt = DateTimeOffset.Now }, cancellationToken);
        foreach (var definition in (await ListAsync<VideoTagDefinitionDocument>(TagDomain, cancellationToken)).Where(item => item.Name.Equals(tag, StringComparison.OrdinalIgnoreCase)))
            await store.DeleteAsync(TagDomain, TagId(definition.Name), cancellationToken);
        return OperationResult.Success();
    }

    public async Task<OperationResult> HandleAsync(SetVideoTagsCommand command, CancellationToken cancellationToken = default)
    {
        if (!TryValidateIds(command.VideoIds, out var ids, out var error)) return OperationResult.Failure("video.invalid_ids", error);
        var tags = NormalizeTags(command.Tags);
        foreach (var tag in tags) await HandleAsync(new CreateVideoTagCommand(tag), cancellationToken);
        foreach (var item in (await ListAsync<VideoItemDto>(VideoDomain, cancellationToken)).Where(item => ids.Contains(item.VideoId)))
            await SaveVideoAsync(item with { Tags = string.Join(", ", tags), UpdatedAt = DateTimeOffset.Now }, cancellationToken);
        return OperationResult.Success();
    }

    public async Task<OperationResult> HandleAsync(RemoveVideoRecordsCommand command, CancellationToken cancellationToken = default)
    {
        if (!TryValidateIds(command.VideoIds, out var ids, out var error)) return OperationResult.Failure("video.invalid_ids", error);
        foreach (var id in ids) await store.DeleteAsync(VideoDomain, id, cancellationToken);
        return OperationResult.Success();
    }

    public async Task<OperationResult> HandleAsync(DeleteVideoLocalFilesCommand command, CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsWindows()) return OperationResult.Failure("video.recycle_bin_unavailable", "当前系统不支持将视频移入回收站。");
        if (!TryValidateIds(command.VideoIds, out var ids, out var error)) return OperationResult.Failure("video.invalid_ids", error);
        var selected = (await ListAsync<VideoItemDto>(VideoDomain, cancellationToken)).Where(item => ids.Contains(item.VideoId)).ToArray();
        try
        {
            foreach (var item in selected)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!string.IsNullOrWhiteSpace(item.FilePath) && File.Exists(item.FilePath))
                    FileSystem.DeleteFile(item.FilePath, UIOption.OnlyErrorDialogs, RecycleOption.SendToRecycleBin);
                await store.DeleteAsync(VideoDomain, item.VideoId, cancellationToken);
            }
            return OperationResult.Success();
        }
        catch (Exception exception)
        {
            return OperationResult.Failure("video.recycle_failed", $"视频文件移入回收站失败：{exception.Message}");
        }
    }

    public Task<VideoDependencyStatusDto> HandleAsync(GetVideoDependenciesQuery query, CancellationToken cancellationToken = default)
    {
        var bridge = ResolveTool("PotPlayerBridge.exe", Path.Combine("Tools", "PotPlayerBridge.exe"));
        var potPlayer = ResolveTool("PotPlayerMini64.exe", Path.Combine("Tools", "PotPlayerMini64.exe"));
        var playlist = Path.Combine(paths.CacheRoot, "PotPlayerBridge", "current.m3u8");
        var ffmpeg = ResolveTool("ffmpeg.exe", Path.Combine("Tools", "ffmpeg", "bin", "ffmpeg.exe"), Path.Combine("Tools", "ffmpeg.exe"));
        var ffprobe = ResolveTool("ffprobe.exe", Path.Combine("Tools", "ffmpeg", "bin", "ffprobe.exe"), Path.Combine("Tools", "ffprobe.exe"));
        var ytdlp = ResolveTool("yt-dlp.exe", Path.Combine("Tools", "yt-dlp.exe"));
        return Task.FromResult(new VideoDependencyStatusDto(bridge, File.Exists(bridge), potPlayer, File.Exists(potPlayer), playlist, File.Exists(playlist),
            ffmpeg, File.Exists(ffmpeg), ffprobe, File.Exists(ffprobe), ytdlp, File.Exists(ytdlp)));
    }

    public async Task<OperationResult<int>> HandleAsync(PlayVideosCommand command, CancellationToken cancellationToken = default)
    {
        if (!TryValidateIds(command.VideoIds, out var ids, out var error))
            return OperationResult<int>.Failure("video.invalid_ids", error);
        if (string.IsNullOrWhiteSpace(command.StartVideoId) || !ids.Contains(command.StartVideoId, StringComparer.OrdinalIgnoreCase))
            return OperationResult<int>.Failure("video.invalid_start", "点击的视频不在当前播放队列中。");

        var allItems = await ListAsync<VideoItemDto>(VideoDomain, cancellationToken);
        var byId = allItems.ToDictionary(item => item.VideoId, StringComparer.OrdinalIgnoreCase);
        var queue = ids.Where(byId.ContainsKey).Select(id => byId[id]).Where(HasPlayableLocation).ToList();
        var clicked = queue.FirstOrDefault(item => item.VideoId.Equals(command.StartVideoId, StringComparison.OrdinalIgnoreCase));
        if (clicked is null)
            return OperationResult<int>.Failure("video.not_playable", "点击的视频不存在或没有可播放地址。");

        var enabled = await ReadSettingAsync("user_config:PotPlayerBridge:Enabled", "True", cancellationToken);
        if (!bool.TryParse(enabled, out var isEnabled) || !isEnabled)
            return OperationResult<int>.Failure("video.potplayer_disabled", "PotPlayer 播放已在设置中关闭。");
        var configuredExecutable = Environment.ExpandEnvironmentVariables(await ReadSettingAsync(
            "user_config:PotPlayerBridge:PotPlayerExePath", @"F:\软件\pot\PotPlayer\PotPlayerMini64.exe", cancellationToken));
        var executable = File.Exists(configuredExecutable) ? Path.GetFullPath(configuredExecutable) : ResolveTool("PotPlayerMini64.exe", Path.Combine("Tools", "PotPlayerMini64.exe"));
        if (!File.Exists(executable))
            return OperationResult<int>.Failure("video.potplayer_missing", "未找到 PotPlayer，请先在设置中配置 PotPlayer 路径。");

        var maxText = await ReadSettingAsync("user_config:PotPlayerBridge:MaxPlaylistItems", "1000", cancellationToken);
        var maxItems = int.TryParse(maxText, out var parsedMax) ? Math.Clamp(parsedMax, 1, 1000) : 1000;
        queue = queue.OrderBy(item => item.VideoId.Equals(clicked.VideoId, StringComparison.OrdinalIgnoreCase) ? 0 : 1).Take(maxItems).ToList();
        var playlistDirectory = Environment.ExpandEnvironmentVariables(await ReadSettingAsync(
            "user_config:PotPlayerBridge:PlaylistDirectory", @"%LocalAppData%\AI_Maid\PotPlayerBridge", cancellationToken));
        Directory.CreateDirectory(playlistDirectory);
        var configuredName = await ReadSettingAsync("user_config:PotPlayerBridge:CurrentPlaylistFileName", "current.m3u8", cancellationToken);
        var playlistName = Path.ChangeExtension(Path.GetFileName(configuredName), ".m3u8");
        var playlistPath = Path.Combine(playlistDirectory, playlistName);
        var useBomText = await ReadSettingAsync("user_config:PotPlayerBridge:UseM3u8Bom", "True", cancellationToken);
        var useBom = bool.TryParse(useBomText, out var parsedBom) && parsedBom;
        var content = "#EXTM3U" + Environment.NewLine + string.Join(Environment.NewLine, queue.Select(PlayableLocation)) + Environment.NewLine;
        var tempPath = playlistPath + ".tmp";
        await File.WriteAllTextAsync(tempPath, content, new UTF8Encoding(useBom), cancellationToken);
        File.Move(tempPath, playlistPath, true);

        var arguments = new List<string> { "/current", playlistPath };
        if (!string.IsNullOrWhiteSpace(clicked.SubtitlePath) && File.Exists(clicked.SubtitlePath))
            arguments.Add("/sub=" + Path.GetFullPath(clicked.SubtitlePath));
        try
        {
            var processId = await programs.LaunchAsync(executable, arguments, Path.GetDirectoryName(executable), cancellationToken);
            await SaveVideoAsync(clicked with { LastPlayedAt = DateTimeOffset.Now, UpdatedAt = DateTimeOffset.Now }, cancellationToken);
            return OperationResult<int>.Success(processId);
        }
        catch (Exception exception) when (exception is IOException or InvalidOperationException or ArgumentException)
        {
            return OperationResult<int>.Failure("video.potplayer_launch_failed", $"PotPlayer 启动失败：{exception.Message}");
        }
    }

    private async Task<OperationResult> UpdateVideoAsync(string videoId, Func<VideoItemDto, VideoItemDto> update, CancellationToken cancellationToken)
    {
        var item = await GetAsync<VideoItemDto>(VideoDomain, videoId, cancellationToken);
        if (item is null) return OperationResult.Success();
        await SaveVideoAsync(update(item), cancellationToken);
        return OperationResult.Success();
    }

    private Task SaveVideoAsync(VideoItemDto item, CancellationToken cancellationToken)
        => store.UpsertAsync(VideoDomain, item.VideoId, JsonSerializer.Serialize(item), item.UpdatedAt, cancellationToken);

    private async Task<string> ReadSettingAsync(string key, string fallback, CancellationToken cancellationToken)
        => (await settings.GetAsync(key, cancellationToken))?.Value ?? SettingsApplicationService.DefaultSetting(key)?.Value ?? fallback;

    private static bool HasPlayableLocation(VideoItemDto item)
        => !string.IsNullOrWhiteSpace(item.FilePath) && File.Exists(item.FilePath)
           || Uri.TryCreate(item.OriginalUrl, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https";

    private static string PlayableLocation(VideoItemDto item)
        => !string.IsNullOrWhiteSpace(item.FilePath) && File.Exists(item.FilePath) ? Path.GetFullPath(item.FilePath) : item.OriginalUrl;

    private async Task<bool> AlbumExistsAsync(string? albumId, CancellationToken cancellationToken)
        => string.IsNullOrWhiteSpace(albumId) || await store.GetAsync(AlbumDomain, albumId, cancellationToken) is not null;

    private async Task<T?> GetAsync<T>(string domain, string id, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(id)) return default;
        var json = await store.GetAsync(domain, id, cancellationToken);
        return json is null ? default : Deserialize<T>(json);
    }

    private async Task<IReadOnlyList<T>> ListAsync<T>(string domain, CancellationToken cancellationToken)
        => (await store.ListAsync(domain, cancellationToken)).Select(Deserialize<T>).ToArray();

    private async Task<IReadOnlyList<VideoAlbumDto>> ListAlbumsAsync(CancellationToken cancellationToken)
    {
        var ids = await store.ListIdsAsync(AlbumDomain, cancellationToken);
        var documents = await store.ListAsync(AlbumDomain, cancellationToken);
        if (ids.Count != documents.Count) throw new InvalidDataException("视频专辑索引与文档数量不一致。");
        return documents.Select((json, index) =>
        {
            var album = Deserialize<VideoAlbumDto>(json);
            return album with { AlbumId = string.IsNullOrWhiteSpace(album.AlbumId) ? ids[index] : album.AlbumId, CoverPath = album.CoverPath ?? string.Empty };
        }).ToArray();
    }

    private static T Deserialize<T>(string json)
        => JsonSerializer.Deserialize<T>(json) ?? throw new InvalidDataException($"{typeof(T).Name} JSON 无效。");

    private async Task<int> ProbeDurationAsync(string filePath, CancellationToken cancellationToken)
    {
        var ffprobe = ResolveTool("ffprobe.exe", Path.Combine("Tools", "ffmpeg", "bin", "ffprobe.exe"), Path.Combine("Tools", "ffprobe.exe"));
        if (!File.Exists(ffprobe)) return 0;
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = ffprobe,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            }
        };
        process.StartInfo.ArgumentList.Add("-v");
        process.StartInfo.ArgumentList.Add("error");
        process.StartInfo.ArgumentList.Add("-show_entries");
        process.StartInfo.ArgumentList.Add("format=duration");
        process.StartInfo.ArgumentList.Add("-of");
        process.StartInfo.ArgumentList.Add("default=noprint_wrappers=1:nokey=1");
        process.StartInfo.ArgumentList.Add(filePath);
        try
        {
            process.Start();
            var output = await process.StandardOutput.ReadToEndAsync(cancellationToken);
            await process.WaitForExitAsync(cancellationToken);
            return process.ExitCode == 0 && double.TryParse(output.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds)
                ? Math.Max(0, (int)Math.Round(seconds)) : 0;
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited) process.Kill(true);
            throw;
        }
        catch { return 0; }
    }

    private string ResolveTool(string executableName, params string[] relativeCandidates)
    {
        foreach (var relative in relativeCandidates)
        {
            var candidate = Path.GetFullPath(Path.Combine(paths.ResourceRoot, relative));
            if (File.Exists(candidate)) return candidate;
        }
        foreach (var root in (Environment.GetEnvironmentVariable("PATH") ?? string.Empty).Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(root.Trim(), executableName);
            if (File.Exists(candidate)) return Path.GetFullPath(candidate);
        }
        return Path.GetFullPath(Path.Combine(paths.ResourceRoot, relativeCandidates.FirstOrDefault() ?? executableName));
    }

    private static bool TryValidateIds(IReadOnlyList<string> source, out HashSet<string> ids, out string error)
    {
        ids = source.Where(id => !string.IsNullOrWhiteSpace(id)).ToHashSet(StringComparer.Ordinal);
        error = ids.Count is < 1 or > 1000 ? "视频 ID 数量必须在 1 到 1000 之间。" : string.Empty;
        return error.Length == 0;
    }

    private static IReadOnlyList<string> NormalizeTags(string tags)
        => tags.Replace('，', ',').Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(tag => !string.IsNullOrWhiteSpace(tag)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    private static bool HasTag(string tags, string tag) => NormalizeTags(tags).Contains(tag.Trim(), StringComparer.OrdinalIgnoreCase);
    private static string TagId(string tag) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(tag.ToUpperInvariant()))).ToLowerInvariant();
    private static bool PathsEqual(string left, string right) => !string.IsNullOrWhiteSpace(left) && Path.GetFullPath(left).Equals(Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);
    private static string DisplayName(VideoItemDto item) => string.IsNullOrWhiteSpace(item.Title) ? Path.GetFileName(item.FilePath) : item.Title;
    private static bool IsVisibleLibraryVideo(VideoItemDto item) => !item.SourceType.Equals("LocalFile", StringComparison.OrdinalIgnoreCase) ||
        string.IsNullOrWhiteSpace(item.FilePath) || VideoExtensions.Contains(Path.GetExtension(item.FilePath).ToLowerInvariant());
    private static bool IsVideoFile(string path)
    {
        var extension = Path.GetExtension(path).ToLowerInvariant();
        return VideoExtensions.Contains(extension) && (extension != ".ts" || LooksLikeMpegTransportStream(path));
    }
    private static bool LooksLikeMpegTransportStream(string path)
    {
        try
        {
            if (Path.GetFileName(path).EndsWith(".d.ts", StringComparison.OrdinalIgnoreCase)) return false;
            using var stream = File.OpenRead(path);
            return stream.Length >= MpegTsPacketSize * 3 && stream.ReadByte() == 0x47 && ReadByteAt(stream, MpegTsPacketSize) == 0x47 && ReadByteAt(stream, MpegTsPacketSize * 2) == 0x47;
        }
        catch { return false; }
    }
    private static int ReadByteAt(FileStream stream, long offset) { stream.Seek(offset, SeekOrigin.Begin); return stream.ReadByte(); }
    private sealed record VideoTagDefinitionDocument(string Name);
}
