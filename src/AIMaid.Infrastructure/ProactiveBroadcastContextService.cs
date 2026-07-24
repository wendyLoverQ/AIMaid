using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using AIMaid.Contracts;
using AIMaid.Contracts.Domains;
using AIMaid.Core;
using Microsoft.Data.Sqlite;

namespace AIMaid.Infrastructure;

public sealed class ProactiveBroadcastContextService : IProactiveBroadcastContextService, IDisposable
{
    private const int MaxSelectedCandidates = 3;
    private const int DefaultMinScore = 60;
    private const int DuplicatePenalty = 35;
    private const double MessageSimilarityThreshold = 0.72;
    private const double SnapshotSimilarityThreshold = 0.72;
    private const string IgnoredMessageRegex = @"[，。！？、,.!?\s]+";
    private static readonly string[] IgnoredMessageWords = ["主人", "我", "你", "呀", "哦", "呢", "啦"];
    private static readonly HashSet<string> LowValueSourceKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "active_window", "current_image", "current_web_page", "media_status", "game_status"
    };
    private static readonly string[] LowValueSnapshotKeywords = ["没有", "未超过"];
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        PropertyNameCaseInsensitive = true
    };
    private readonly IDomainDocumentStore store;
    private readonly ISettingsStore settings;
    private readonly Action<string, Exception?> log;
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(4) };
    private readonly SemaphoreSlim logGate = new(1, 1);

    public ProactiveBroadcastContextService(
        IDomainDocumentStore store,
        ISettingsStore settings,
        Action<string, Exception?>? log = null)
    {
        this.store = store;
        this.settings = settings;
        this.log = log ?? ((_, _) => { });
    }

    public async Task InitializeDefaultsAsync(CancellationToken cancellationToken = default)
    {
        foreach (var source in DefaultSources())
        {
            if (await store.GetAsync("proactive_source", source.SourceKey, cancellationToken) is null)
                await SaveAsync(source, cancellationToken);
        }
    }

    public async Task<IReadOnlyList<ProactiveSourceDto>> ListAsync(CancellationToken cancellationToken = default)
    {
        var result = new List<ProactiveSourceDto>();
        foreach (var json in await store.ListAsync("proactive_source", cancellationToken))
        {
            var source = Deserialize<ProactiveSourceDto>(json);
            var status = GetSourceStatus(source);
            result.Add(source with
            {
                IsConfigured = status.Configured,
                IsImplemented = true,
                StatusText = !source.Enabled ? "关闭" : status.Configured ? "可用" : status.Status
            });
        }
        return result.OrderByDescending(source => source.Priority).ThenBy(source => source.SourceKey).ToArray();
    }

    public async Task<OperationResult<ProactiveSourceDto>> UpdateAsync(
        string sourceKey,
        bool? enabled,
        int? cooldownMinutes,
        CancellationToken cancellationToken = default)
    {
        var source = await GetAsync(sourceKey, cancellationToken);
        if (source is null)
            return OperationResult<ProactiveSourceDto>.Failure("proactive.source_not_found", "主动数据源不存在。");
        var updated = source with
        {
            Enabled = enabled ?? source.Enabled,
            CooldownMinutes = cooldownMinutes.HasValue ? Math.Max(1, cooldownMinutes.Value) : source.CooldownMinutes,
            UpdatedAt = DateTimeOffset.Now
        };
        await SaveAsync(updated, cancellationToken);
        return OperationResult<ProactiveSourceDto>.Success(updated);
    }

    public Task<ProactiveBroadcastContext> CollectDueAsync(
        ActivitySnapshot desktop,
        string currentImage,
        string currentRoleId,
        CancellationToken cancellationToken = default)
        => CollectAsync(null, desktop, currentImage, currentRoleId, false, cancellationToken);

    public Task<ProactiveBroadcastContext> CollectSingleAsync(
        string sourceKey,
        ActivitySnapshot desktop,
        string currentImage,
        string currentRoleId,
        CancellationToken cancellationToken = default)
        => CollectAsync(sourceKey, desktop, currentImage, currentRoleId, true, cancellationToken);

    private async Task<ProactiveBroadcastContext> CollectAsync(
        string? singleSourceKey,
        ActivitySnapshot desktop,
        string currentImage,
        string currentRoleId,
        bool manualTest,
        CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.Now;
        var sources = (await ListAsync(cancellationToken))
            .Where(source => manualTest
                ? source.SourceKey.Equals(singleSourceKey, StringComparison.OrdinalIgnoreCase)
                : source.Enabled)
            .ToList();
        var candidates = new List<ProactiveBroadcastCandidate>();
        foreach (var source in sources)
        {
            if (!source.IsConfigured || !source.IsImplemented) continue;
            if (!manualTest && (IsInCooldown(source, now) || !IsCollectionDue(source, now))) continue;
            var snapshot = await BuildSnapshotAsync(source, desktop, currentImage, currentRoleId, now, cancellationToken);
            var collected = source with { LastCollectedAt = now, UpdatedAt = now };
            if (string.IsNullOrWhiteSpace(snapshot))
            {
                await SaveAsync(collected, cancellationToken);
                continue;
            }
            var candidate = BuildCandidate(collected, collected.LastSnapshot, snapshot, now, manualTest, manualTest);
            collected = collected with
            {
                LastSnapshot = snapshot,
                LastSnapshotHash = candidate.SnapshotHash,
                LastScore = candidate.Score,
                LastSelectReason = candidate.Reason
            };
            await SaveAsync(collected, cancellationToken);
            if (manualTest || candidate.Changed &&
                candidate.Score >= Math.Max(1, source.MinScore > 0 ? source.MinScore : DefaultMinScore))
                candidates.Add(candidate);
        }
        var selected = candidates
            .OrderByDescending(candidate => candidate.ChangeScore)
            .ThenByDescending(candidate => candidate.Score)
            .ThenByDescending(candidate => candidate.Priority)
            .Take(MaxSelectedCandidates)
            .ToArray();
        var recent = (await ListAsync(cancellationToken))
            .Where(source => !string.IsNullOrWhiteSpace(source.LastBroadcastMessage))
            .OrderByDescending(source => source.LastBroadcastAt ?? DateTimeOffset.MinValue)
            .Take(5)
            .Select(source => source.LastBroadcastMessage)
            .ToArray();
        return new ProactiveBroadcastContext(selected, recent);
    }

    public async Task<bool> TryMarkBroadcastResultAsync(
        string sourceKeys,
        string message,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(sourceKeys) || string.IsNullOrWhiteSpace(message)) return true;
        var keys = sourceKeys.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var sources = (await ListAsync(cancellationToken)).Where(source => keys.Contains(source.SourceKey)).ToArray();
        var normalized = NormalizeMessage(message);
        var hash = HashText(normalized);
        if (IsDuplicate(sources, normalized, hash)) return false;
        var now = DateTimeOffset.Now;
        foreach (var source in sources)
            await SaveAsync(source with
            {
                LastBroadcastAt = now,
                LastBroadcastMessage = message,
                LastBroadcastMessageHash = hash,
                UpdatedAt = now
            }, cancellationToken);
        return true;
    }

    public async Task<bool> IsDuplicateBroadcastAsync(
        string sourceKeys,
        string message,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(sourceKeys) || string.IsNullOrWhiteSpace(message)) return false;
        var keys = sourceKeys.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var sources = (await ListAsync(cancellationToken)).Where(source => keys.Contains(source.SourceKey)).ToArray();
        var normalized = NormalizeMessage(message);
        return IsDuplicate(sources, normalized, HashText(normalized));
    }

    private static bool IsDuplicate(
        IReadOnlyList<ProactiveSourceDto> sources,
        string normalized,
        string hash)
        => sources.Any(source =>
            source.LastBroadcastMessageHash.Equals(hash, StringComparison.OrdinalIgnoreCase) ||
            IsSimilar(normalized, NormalizeMessage(source.LastBroadcastMessage), MessageSimilarityThreshold));

    public async Task<string> CreateTriggerLogAsync(
        string eventId,
        string eventType,
        string eventSource,
        string roleId,
        string roleDisplayName,
        string voiceId,
        string aiProvider,
        ActivitySnapshot desktop,
        ProactiveBroadcastContext context,
        IReadOnlyDictionary<string, string> payload,
        string reason,
        CancellationToken cancellationToken = default)
    {
        await CleanupExpiredTriggerLogsAsync(cancellationToken);
        await logGate.WaitAsync(cancellationToken);
        try
        {
            var id = eventId;
            var now = DateTimeOffset.Now;
            var document = new ProactiveTriggerLogDocument(
                id, now, eventId, eventType, eventSource, roleId, roleDisplayName, voiceId, 0,
                aiProvider, desktop.ProcessName, desktop.WindowTitle, desktop.Scene,
                context.SelectedSourceKeys, JsonSerializer.Serialize(context.Candidates, JsonOptions),
                JsonSerializer.Serialize(payload, JsonOptions), false, false, string.Empty, string.Empty,
                string.Empty, "pending", reason, now);
            await store.UpsertAsync("proactive_audit", id, JsonSerializer.Serialize(document, JsonOptions), now, cancellationToken);
            return id;
        }
        finally
        {
            logGate.Release();
        }
    }

    public async Task CompleteTriggerLogAsync(
        string triggerLogId,
        bool responded,
        bool spoke,
        string message,
        string voiceTrigger,
        string audioPath,
        string result,
        CancellationToken cancellationToken = default)
    {
        var json = await store.GetAsync("proactive_audit", triggerLogId, cancellationToken);
        if (json is null) return;
        var document = Deserialize<ProactiveTriggerLogDocument>(json) with
        {
            Responded = responded,
            Spoke = spoke,
            Message = message,
            VoiceTrigger = voiceTrigger,
            AudioPath = audioPath,
            Result = result,
            UpdatedAt = DateTimeOffset.Now
        };
        await store.UpsertAsync("proactive_audit", triggerLogId, JsonSerializer.Serialize(document, JsonOptions), document.UpdatedAt, cancellationToken);
    }

    private async Task CleanupExpiredTriggerLogsAsync(CancellationToken cancellationToken)
    {
        var today = DateTimeOffset.Now.Date;
        foreach (var id in await store.ListIdsAsync("proactive_audit", cancellationToken))
        {
            var json = await store.GetAsync("proactive_audit", id, cancellationToken);
            if (json is null) continue;
            var document = Deserialize<ProactiveTriggerLogDocument>(json);
            if (document.TriggeredAt < today) await store.DeleteAsync("proactive_audit", id, cancellationToken);
        }
    }

    private async Task<string> BuildSnapshotAsync(
        ProactiveSourceDto source,
        ActivitySnapshot desktop,
        string currentImage,
        string currentRoleId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var parameters = ParseParameters(source.ParameterJson);
        return source.SourceKey switch
        {
            "active_window" => BuildActiveWindowSnapshot(desktop, parameters),
            "current_web_page" => BuildCurrentWebPageSnapshot(desktop, parameters),
            "desktop_idle" => BuildIdleSnapshot(desktop, parameters),
            "time_checkpoint" => $"系统时间：{now:yyyy-MM-dd HH:mm}，星期{ChineseDay(now.DayOfWeek)}，时段：{TimePeriod(now.Hour)}",
            "weather" => await BuildWeatherSnapshotAsync(parameters, cancellationToken),
            "timer_records" => await BuildTimerRecordsSnapshotAsync(source, parameters, now, cancellationToken),
            "reminders" => await BuildRemindersSnapshotAsync(source, parameters, now, cancellationToken),
            "recent_conversation_summary" => await BuildRecentDocumentsSnapshotAsync("ai_conversation", source.MaxItems, "最近在线问答摘要（输入框）", cancellationToken),
            "role_config" => await BuildRoleSnapshotAsync(currentRoleId, cancellationToken),
            "system_status" => await BuildSystemStatusSnapshotAsync(parameters, cancellationToken),
            "clipboard" => await BuildClipboardSnapshotAsync(parameters, cancellationToken),
            "media_status" => desktop.Scene == "video"
                ? $"系统媒体：Playing；{desktop.WindowTitle}；应用：{desktop.ProcessName}"
                : "当前没有系统媒体会话",
            "game_status" => desktop.Scene is "gaming" or "game"
                ? $"当前游戏状态：{desktop.WindowTitle}（{desktop.ProcessName}），全屏：{(desktop.IsFullscreen ? "是" : "否")}"
                : $"当前不是游戏场景；前台：{desktop.ProcessName}/{desktop.WindowTitle}",
            "git_status" => await BuildGitStatusSnapshotAsync(parameters, cancellationToken),
            "recent_errors" => BuildRecentErrorsSnapshot(parameters),
            "voice_trigger_history" => await BuildRecentDocumentsSnapshotAsync("voice_trigger_log", source.MaxItems, "最近语音", cancellationToken),
            "current_image" => string.IsNullOrWhiteSpace(currentImage) ? string.Empty : $"当前图库文件夹：{currentImage}",
            "browser_history" => await BuildBrowserHistorySnapshotAsync(source, parameters, now, cancellationToken),
            _ => string.Empty
        };
    }

    private static string BuildActiveWindowSnapshot(ActivitySnapshot desktop, IReadOnlyDictionary<string, JsonElement> parameters)
    {
        var parts = new List<string> { $"场景：{desktop.Scene}" };
        if (GetBool(parameters, "includeProcess", true) && !string.IsNullOrWhiteSpace(desktop.ProcessName)) parts.Add($"进程：{desktop.ProcessName}");
        if (GetBool(parameters, "includeTitle", true) && !string.IsNullOrWhiteSpace(desktop.WindowTitle)) parts.Add($"窗口：{desktop.WindowTitle}");
        return string.Join("；", parts);
    }

    private static string BuildCurrentWebPageSnapshot(ActivitySnapshot desktop, IReadOnlyDictionary<string, JsonElement> parameters)
    {
        var browsers = GetStringArray(parameters, "browserProcesses");
        if (browsers.Count == 0) browsers = ["chrome", "msedge", "firefox", "brave", "opera"];
        if (!browsers.Any(browser => desktop.ProcessName.Contains(browser, StringComparison.OrdinalIgnoreCase)))
            return "当前前台窗口不是浏览器";
        var max = Math.Clamp(GetInt(parameters, "maxTitleLength", 120), 20, 300);
        return string.IsNullOrWhiteSpace(desktop.WindowTitle) ? "浏览器当前网页标题为空" : $"浏览器当前页：{Trim(desktop.WindowTitle, max)}";
    }

    private static string BuildIdleSnapshot(ActivitySnapshot desktop, IReadOnlyDictionary<string, JsonElement> parameters)
    {
        var threshold = GetInt(parameters, "idleThresholdSeconds", 900);
        var seconds = (int)desktop.UserIdleTime.TotalSeconds;
        return seconds >= threshold
            ? $"用户空闲 {seconds} 秒，超过阈值 {threshold} 秒"
            : $"用户空闲 {seconds} 秒，未超过阈值 {threshold} 秒";
    }

    private async Task<string> BuildWeatherSnapshotAsync(IReadOnlyDictionary<string, JsonElement> parameters, CancellationToken cancellationToken)
    {
        var weather = GetObject(parameters, "weather") ?? parameters;
        var url = GetString(weather, "apiUrl", string.Empty);
        var city = GetString(weather, "city", string.Empty);
        if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(city)) return "天气未配置：需要 city 和 apiUrl";
        try
        {
            var response = await http.GetStringAsync(url.Replace("{city}", Uri.EscapeDataString(city), StringComparison.OrdinalIgnoreCase), cancellationToken);
            return "天气：" + Trim(response, 300);
        }
        catch (Exception exception) when (exception is HttpRequestException or OperationCanceledException)
        {
            return $"天气读取失败：{exception.Message}";
        }
    }

    private async Task<string> BuildTimerRecordsSnapshotAsync(
        ProactiveSourceDto source,
        IReadOnlyDictionary<string, JsonElement> parameters,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var since = now.AddHours(-Math.Max(1, GetInt(parameters, "lookbackHours", 24)));
        var records = (await LoadJsonDocumentsAsync("timer_record", cancellationToken))
            .Where(document => ReadDate(document, "SavedAt") >= since)
            .OrderByDescending(document => ReadDate(document, "SavedAt"))
            .Take(Math.Clamp(source.MaxItems, 1, 20)).ToArray();
        if (records.Length == 0) return "最近没有计时记录";
        var totalMinutes = records.Sum(document => ReadInt(document, "DurationSeconds")) / 60;
        return $"最近 {records.Length} 条计时记录，累计约 {totalMinutes} 分钟；最近一次：{ReadString(records[0], "DisplayText")}，{ReadString(records[0], "Status")}";
    }

    private async Task<string> BuildRemindersSnapshotAsync(
        ProactiveSourceDto source,
        IReadOnlyDictionary<string, JsonElement> parameters,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var until = now.AddMinutes(Math.Max(1, GetInt(parameters, "lookaheadMinutes", 120)));
        var reminders = (await store.ListAsync("reminder", cancellationToken))
            .Select(Deserialize<ReminderDto>)
            .Where(reminder => reminder.Enabled && (reminder.NextDueAt ?? reminder.DueAt) >= now && (reminder.NextDueAt ?? reminder.DueAt) <= until)
            .OrderBy(reminder => reminder.NextDueAt ?? reminder.DueAt)
            .Take(Math.Clamp(source.MaxItems, 1, 20)).ToArray();
        return reminders.Length == 0
            ? "近期没有待触发提醒"
            : "近期提醒：" + string.Join("；", reminders.Select(reminder => $"{(reminder.NextDueAt ?? reminder.DueAt):HH:mm} {reminder.Title}"));
    }

    private async Task<string> BuildRecentDocumentsSnapshotAsync(string domain, int maxItems, string prefix, CancellationToken cancellationToken)
    {
        var documents = (await LoadJsonDocumentsAsync(domain, cancellationToken)).Take(Math.Clamp(maxItems, 1, 20)).ToArray();
        return documents.Length == 0 ? prefix.Replace("最近", "最近没有", StringComparison.Ordinal) : prefix + "：" + string.Join("；", documents.Select(document => Trim(document.GetRawText(), 120)));
    }

    private async Task<string> BuildRoleSnapshotAsync(string roleId, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(roleId)) return "当前角色未识别";
        var json = await store.GetAsync("voice_role", roleId, cancellationToken);
        return json is null ? $"角色配置未找到：{roleId}" : "角色：" + Trim(json, 240);
    }

    private async Task<string> BuildSystemStatusSnapshotAsync(IReadOnlyDictionary<string, JsonElement> parameters, CancellationToken cancellationToken)
    {
        var process = Process.GetCurrentProcess();
        var drives = string.Join("；", DriveInfo.GetDrives().Where(drive => drive.IsReady).Take(4)
            .Select(drive => $"{drive.Name.TrimEnd('\\')} 可用 {drive.AvailableFreeSpace / 1024 / 1024 / 1024}GB"));
        var urls = GetStringArray(parameters, "healthUrls");
        var health = urls.Count == 0
            ? "未配置健康检查 URL"
            : "健康检查：" + string.Join("；", await Task.WhenAll(urls.Select(url => CheckHealthAsync(url, cancellationToken))));
        return $"采样时间：{DateTimeOffset.Now:HH:mm:ss}；CPU 核心：{Environment.ProcessorCount}；进程内存：{process.WorkingSet64 / 1024 / 1024} MB；磁盘：{drives}；{health}";
    }

    private async Task<string> CheckHealthAsync(string url, CancellationToken cancellationToken)
    {
        try
        {
            using var response = await http.GetAsync(url, cancellationToken);
            return $"{url}={(int)response.StatusCode}";
        }
        catch (Exception exception) when (exception is HttpRequestException or OperationCanceledException)
        {
            return $"{url}=失败({exception.Message})";
        }
    }

    private async Task<string> BuildClipboardSnapshotAsync(IReadOnlyDictionary<string, JsonElement> parameters, CancellationToken cancellationToken)
    {
        if (!GetBool(parameters, "enabled", false)) return "剪贴板读取未开启";
        try
        {
            using var process = Process.Start(new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -Command Get-Clipboard -Raw")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            }) ?? throw new InvalidOperationException("无法启动剪贴板读取进程。");
            var output = await process.StandardOutput.ReadToEndAsync(cancellationToken);
            await process.WaitForExitAsync(cancellationToken);
            return string.IsNullOrWhiteSpace(output)
                ? "剪贴板没有可用文本/图片/文件"
                : "剪贴板文本：" + Trim(output, Math.Clamp(GetInt(parameters, "maxChars", 120), 20, 5000));
        }
        catch (Exception exception) when (exception is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return $"剪贴板读取失败：{exception.Message}";
        }
    }

    private static async Task<string> BuildGitStatusSnapshotAsync(IReadOnlyDictionary<string, JsonElement> parameters, CancellationToken cancellationToken)
    {
        var directory = Environment.ExpandEnvironmentVariables(GetString(parameters, "directory", AppContext.BaseDirectory));
        if (!Directory.Exists(directory)) return $"Git 目录不存在：{directory}";
        try
        {
            using var process = Process.Start(new ProcessStartInfo("git", "status --short --branch")
            {
                WorkingDirectory = directory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            }) ?? throw new InvalidOperationException("无法启动 git。");
            var output = await process.StandardOutput.ReadToEndAsync(cancellationToken);
            var error = await process.StandardError.ReadToEndAsync(cancellationToken);
            await process.WaitForExitAsync(cancellationToken);
            var text = string.IsNullOrWhiteSpace(output) ? error : output;
            return string.IsNullOrWhiteSpace(text) ? "Git 状态为空" : "Git 状态：" + Trim(text, 300);
        }
        catch (Exception exception) when (exception is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return $"Git 状态读取失败：{exception.Message}";
        }
    }

    private string BuildRecentErrorsSnapshot(IReadOnlyDictionary<string, JsonElement> parameters)
    {
        var folders = GetStringArray(parameters, "folders").Select(Environment.ExpandEnvironmentVariables).Where(Directory.Exists).ToList();
        if (folders.Count == 0) folders.Add(Path.Combine(AppContext.BaseDirectory, "logs"));
        var lines = new List<string>();
        foreach (var folder in folders.Where(Directory.Exists))
        foreach (var file in Directory.EnumerateFiles(folder, "*.log", SearchOption.TopDirectoryOnly).OrderByDescending(File.GetLastWriteTime).Take(3))
        {
            try
            {
                lines.AddRange(File.ReadLines(file).Reverse().Where(line =>
                    line.Contains("[ERR]", StringComparison.OrdinalIgnoreCase) ||
                    line.Contains("exception", StringComparison.OrdinalIgnoreCase) ||
                    line.Contains("failed", StringComparison.OrdinalIgnoreCase)).Take(3));
            }
            catch (IOException exception)
            {
                log($"Failed to read proactive error source: file={file}", exception);
            }
        }
        return lines.Count == 0 ? "最近没有明显报错日志" : "最近报错：" + string.Join("；", lines.Take(5).Select(line => Trim(line, 120)));
    }

    private async Task<string> BuildBrowserHistorySnapshotAsync(
        ProactiveSourceDto source,
        IReadOnlyDictionary<string, JsonElement> parameters,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var paths = GetStringArray(parameters, "paths").Select(Environment.ExpandEnvironmentVariables).Where(File.Exists).ToArray();
        if (paths.Length == 0) return "浏览记录未配置或路径不存在";
        var since = now.AddMinutes(-Math.Max(1, GetInt(parameters, "lookbackMinutes", 120)));
        var entries = new List<(DateTimeOffset Time, string Title, string Url)>();
        foreach (var path in paths)
            entries.AddRange(await ReadChromiumHistoryAsync(path, since, Math.Clamp(source.MaxItems, 1, 20), cancellationToken));
        entries = entries.OrderByDescending(entry => entry.Time).Take(Math.Clamp(source.MaxItems, 1, 20)).ToList();
        return entries.Count == 0
            ? $"浏览记录采样：{now:HH:mm:ss}，未读到可用记录"
            : $"浏览记录采样：{now:HH:mm:ss}；最近浏览：" + string.Join("；", entries.Select(entry => $"{entry.Time:HH:mm} {Trim(string.IsNullOrWhiteSpace(entry.Title) ? entry.Url : entry.Title, 60)}"));
    }

    private async Task<IReadOnlyList<(DateTimeOffset Time, string Title, string Url)>> ReadChromiumHistoryAsync(
        string historyPath,
        DateTimeOffset since,
        int limit,
        CancellationToken cancellationToken)
    {
        var temporary = Path.Combine(Path.GetTempPath(), $"aimaid_history_{Guid.NewGuid():N}.db");
        try
        {
            File.Copy(historyPath, temporary, overwrite: true);
            await using var connection = new SqliteConnection($"Data Source={temporary};Mode=ReadOnly");
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT title,url,last_visit_time FROM urls WHERE last_visit_time >= $since ORDER BY last_visit_time DESC LIMIT $limit";
            command.Parameters.AddWithValue("$since", (since.UtcDateTime - new DateTime(1601, 1, 1, 0, 0, 0, DateTimeKind.Utc)).Ticks / 10);
            command.Parameters.AddWithValue("$limit", limit);
            var result = new List<(DateTimeOffset, string, string)>();
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                var time = new DateTime(1601, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddTicks(reader.GetInt64(2) * 10);
                result.Add((new DateTimeOffset(time).ToLocalTime(), reader.IsDBNull(0) ? string.Empty : reader.GetString(0), reader.IsDBNull(1) ? string.Empty : reader.GetString(1)));
            }
            return result;
        }
        catch (Exception exception) when (exception is IOException or SqliteException)
        {
            log($"Failed to read Chromium history: path={historyPath}", exception);
            return [];
        }
        finally
        {
            try
            {
                if (File.Exists(temporary)) File.Delete(temporary);
            }
            catch (IOException exception)
            {
                log($"Failed to delete temporary Chromium history: path={temporary}", exception);
            }
        }
    }

    private static ProactiveBroadcastCandidate BuildCandidate(
        ProactiveSourceDto source,
        string previousSnapshot,
        string snapshot,
        DateTimeOffset now,
        bool ignoreCooldown,
        bool forceChanged)
    {
        var normalized = NormalizeSnapshot(snapshot);
        var hash = HashText(normalized);
        if (!ignoreCooldown && IsInCooldown(source, now))
            return new(source.SourceKey, source.DisplayName, source.Priority, -999, 0, false, hash, "播报冷却中", snapshot);
        var previousHash = string.IsNullOrWhiteSpace(source.LastSnapshotHash)
            ? HashText(NormalizeSnapshot(previousSnapshot))
            : source.LastSnapshotHash;
        var changed = forceChanged || !previousHash.Equals(hash, StringComparison.OrdinalIgnoreCase);
        var changeScore = changed ? CalculateChangeScore(previousSnapshot, snapshot) : 0;
        if (forceChanged && changeScore <= 0) changeScore = 100;
        var duplicatePenalty = IsSimilar(normalized, NormalizeSnapshot(source.LastBroadcastMessage), SnapshotSimilarityThreshold) ? DuplicatePenalty : 0;
        var lowValuePenalty = LowValueSourceKeys.Contains(source.SourceKey) && !changed ? 25 :
            LowValueSnapshotKeywords.Any(keyword => snapshot.Contains(keyword, StringComparison.OrdinalIgnoreCase)) ? 20 : 0;
        var priorityBoost = Math.Clamp(source.Priority / 10, 0, 10);
        var score = Math.Clamp(changeScore + priorityBoost - duplicatePenalty - lowValuePenalty, 0, 100);
        var threshold = Math.Max(1, source.MinScore > 0 ? source.MinScore : DefaultMinScore);
        var prefix = forceChanged ? "立即测试，忽略冷却和自动阈值；" : string.Empty;
        return new(source.SourceKey, source.DisplayName, source.Priority, score, changeScore, changed, hash,
            $"{prefix}变化分{changeScore}，优先级加成{priorityBoost}，重复扣{duplicatePenalty}，低价值扣{lowValuePenalty}，阈值{threshold}", snapshot);
    }

    private static int CalculateChangeScore(string previousSnapshot, string currentSnapshot)
    {
        var previous = NormalizeSnapshot(previousSnapshot);
        var current = NormalizeSnapshot(currentSnapshot);
        if (string.IsNullOrWhiteSpace(current)) return 0;
        if (string.IsNullOrWhiteSpace(previous)) return 100;
        if (previous.Equals(current, StringComparison.OrdinalIgnoreCase)) return 0;
        var similarity = CalculateTokenSimilarity(previous, current);
        return (int)Math.Clamp(Math.Round((1 - similarity) * 100), 1, 100);
    }

    private static bool IsCollectionDue(ProactiveSourceDto source, DateTimeOffset now)
        => source.LastCollectedAt is null || now - source.LastCollectedAt >= TimeSpan.FromMinutes(Math.Max(1, source.FrequencyMinutes));
    private static bool IsInCooldown(ProactiveSourceDto source, DateTimeOffset now)
        => source.LastBroadcastAt is not null && now - source.LastBroadcastAt < TimeSpan.FromMinutes(Math.Max(1, source.CooldownMinutes));
    private static string NormalizeSnapshot(string value) => Regex.Replace(value.ToLowerInvariant(), @"\s+", " ").Trim();
    private static string NormalizeMessage(string value)
    {
        var normalized = Regex.Replace(value.ToLowerInvariant(), IgnoredMessageRegex, string.Empty);
        foreach (var word in IgnoredMessageWords)
            normalized = normalized.Replace(word, string.Empty, StringComparison.OrdinalIgnoreCase);
        return normalized.Trim();
    }
    private static string HashText(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    private static bool IsSimilar(string left, string right, double threshold)
    {
        if (string.IsNullOrWhiteSpace(left) || string.IsNullOrWhiteSpace(right)) return false;
        if (left.Contains(right, StringComparison.OrdinalIgnoreCase) || right.Contains(left, StringComparison.OrdinalIgnoreCase))
            return Math.Min(left.Length, right.Length) >= 12;
        var a = Tokenize(left);
        var b = Tokenize(right);
        return a.Count > 0 && b.Count > 0 && a.Intersect(b).Count() / (double)Math.Max(a.Count, b.Count) >= Math.Clamp(threshold, 0.1, 1);
    }
    private static double CalculateTokenSimilarity(string left, string right)
    {
        var a = Tokenize(left);
        var b = Tokenize(right);
        if (a.Count == 0 || b.Count == 0) return 0;
        var union = a.Union(b).Count();
        return union == 0 ? 0 : a.Intersect(b).Count() / (double)union;
    }
    private static HashSet<string> Tokenize(string value)
    {
        var normalized = Regex.Replace(value, @"\s+", string.Empty).ToLowerInvariant();
        var result = Regex.Matches(normalized, @"[\p{L}\p{N}]{2,}").Select(match => match.Value).ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (normalized.Any(character => character is >= '\u4e00' and <= '\u9fff'))
            for (var index = 0; index < normalized.Length - 1; index++) result.Add(normalized.Substring(index, 2));
        return result;
    }

    private async Task<ProactiveSourceDto?> GetAsync(string sourceKey, CancellationToken cancellationToken)
    {
        var json = await store.GetAsync("proactive_source", sourceKey, cancellationToken);
        return json is null ? null : Deserialize<ProactiveSourceDto>(json);
    }
    private Task SaveAsync(ProactiveSourceDto source, CancellationToken cancellationToken)
        => store.UpsertAsync("proactive_source", source.SourceKey, JsonSerializer.Serialize(source, JsonOptions), source.UpdatedAt, cancellationToken);
    private async Task<IReadOnlyList<JsonElement>> LoadJsonDocumentsAsync(string domain, CancellationToken cancellationToken)
    {
        var result = new List<JsonElement>();
        foreach (var json in await store.ListAsync(domain, cancellationToken))
        {
            using var document = JsonDocument.Parse(json);
            result.Add(document.RootElement.Clone());
        }
        return result;
    }
    private static T Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json, JsonOptions) ?? throw new InvalidDataException($"{typeof(T).Name} JSON 无效。");
    private IReadOnlyDictionary<string, JsonElement> ParseParameters(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
            return document.RootElement.ValueKind == JsonValueKind.Object
                ? document.RootElement.EnumerateObject().ToDictionary(property => property.Name, property => property.Value.Clone(), StringComparer.OrdinalIgnoreCase)
                : new Dictionary<string, JsonElement>(StringComparer.OrdinalIgnoreCase);
        }
        catch (JsonException exception)
        {
            log("Invalid proactive source ParameterJson; treating the source as unconfigured.", exception);
            return new Dictionary<string, JsonElement>(StringComparer.OrdinalIgnoreCase);
        }
    }
    private (bool Configured, string Status) GetSourceStatus(ProactiveSourceDto source)
    {
        var parameters = ParseParameters(source.ParameterJson);
        return source.SourceKey switch
        {
            "weather" => (!string.IsNullOrWhiteSpace(GetString(parameters, "city", string.Empty)) && !string.IsNullOrWhiteSpace(GetString(parameters, "apiUrl", string.Empty)), "未配置"),
            "browser_history" => (GetStringArray(parameters, "paths").Select(Environment.ExpandEnvironmentVariables).Any(File.Exists), "配置异常"),
            "clipboard" => (GetBool(parameters, "enabled", false), "未开启"),
            "git_status" => (Directory.Exists(Environment.ExpandEnvironmentVariables(GetString(parameters, "directory", string.Empty))), "配置异常"),
            "recent_errors" => (GetStringArray(parameters, "folders").Select(Environment.ExpandEnvironmentVariables).Any(Directory.Exists), "配置异常"),
            "system_status" => (GetStringArray(parameters, "healthUrls").Count > 0, "未配置"),
            _ => (true, "可用")
        };
    }
    private static int GetInt(IReadOnlyDictionary<string, JsonElement> values, string name, int fallback) => values.TryGetValue(name, out var value) && value.TryGetInt32(out var parsed) ? parsed : fallback;
    private static bool GetBool(IReadOnlyDictionary<string, JsonElement> values, string name, bool fallback) => values.TryGetValue(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False ? value.GetBoolean() : fallback;
    private static string GetString(IReadOnlyDictionary<string, JsonElement> values, string name, string fallback) => values.TryGetValue(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? fallback : fallback;
    private static IReadOnlyDictionary<string, JsonElement>? GetObject(IReadOnlyDictionary<string, JsonElement> values, string name) => values.TryGetValue(name, out var value) && value.ValueKind == JsonValueKind.Object ? value.EnumerateObject().ToDictionary(property => property.Name, property => property.Value.Clone(), StringComparer.OrdinalIgnoreCase) : null;
    private static IReadOnlyList<string> GetStringArray(IReadOnlyDictionary<string, JsonElement> values, string name) => values.TryGetValue(name, out var value) && value.ValueKind == JsonValueKind.Array ? value.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.String).Select(item => item.GetString() ?? string.Empty).Where(item => item.Length > 0).ToArray() : [];
    private static string ReadString(JsonElement value, string property) => value.TryGetProperty(property, out var item) && item.ValueKind == JsonValueKind.String ? item.GetString() ?? string.Empty : string.Empty;
    private static int ReadInt(JsonElement value, string property) => value.TryGetProperty(property, out var item) && item.TryGetInt32(out var parsed) ? parsed : 0;
    private static DateTimeOffset ReadDate(JsonElement value, string property) => value.TryGetProperty(property, out var item) && item.TryGetDateTimeOffset(out var parsed) ? parsed : DateTimeOffset.MinValue;
    private static string Trim(string value, int max) { var text = value.Replace('\r', ' ').Replace('\n', ' ').Trim(); return text.Length <= max ? text : text[..max] + "..."; }
    private static string ChineseDay(DayOfWeek day) => day switch { DayOfWeek.Monday => "一", DayOfWeek.Tuesday => "二", DayOfWeek.Wednesday => "三", DayOfWeek.Thursday => "四", DayOfWeek.Friday => "五", DayOfWeek.Saturday => "六", _ => "日" };
    private static string TimePeriod(int hour) => hour switch { >= 5 and < 11 => "上午", >= 11 and < 14 => "中午", >= 14 and < 18 => "下午", >= 18 and < 23 => "晚上", _ => "深夜" };
    private static long ParseAuditId(string id) => long.TryParse(id.Replace("legacy_proactive_audit_", string.Empty, StringComparison.Ordinal), NumberStyles.None, CultureInfo.InvariantCulture, out var value) ? value : 0;

    private static IReadOnlyList<ProactiveSourceDto> DefaultSources()
    {
        var now = DateTimeOffset.Now;
        return
        [
            Source("time_checkpoint", "时间/整点", true, 60, 60, 1, "{}", 65, 75, now),
            Source("weather", "天气", false, 60, 60, 1, "{\"city\":\"\",\"apiUrl\":\"\"}", 70, 75, now),
            Source("browser_history", "浏览记录", false, 30, 30, 8, "{\"paths\":[\"%LOCALAPPDATA%\\\\Google\\\\Chrome\\\\User Data\\\\Default\\\\History\",\"%LOCALAPPDATA%\\\\Microsoft\\\\Edge\\\\User Data\\\\Default\\\\History\"],\"lookbackMinutes\":120}", 50, 65, now),
            Source("current_web_page", "Chrome 当前网页", true, 10, 10, 1, "{}", 45, 75, now),
            Source("active_window", "当前窗口", true, 5, 5, 1, "{\"includeTitle\":true,\"includeProcess\":true}", 30, 70, now),
            Source("desktop_idle", "桌面空闲", true, 10, 10, 1, "{\"idleThresholdSeconds\":900}", 80, 75, now),
            Source("recent_conversation_summary", "最近对话摘要", true, 10, 10, 3, "{}", 85, 75, now),
            Source("role_config", "角色配置", true, 30, 30, 1, "{}", 82, 75, now),
            Source("system_status", "系统状态", true, 15, 15, 1, "{\"healthUrls\":[\"http://127.0.0.1:8765/health\",\"http://localhost:11434/api/tags\"]}", 55, 80, now),
            Source("timer_records", "计时记录", true, 60, 60, 5, "{\"lookbackHours\":24}", 60, 70, now),
            Source("reminders", "提醒事项", true, 10, 10, 5, "{\"lookaheadMinutes\":120}", 100, 70, now),
            Source("clipboard", "剪贴板内容", false, 5, 10, 1, "{\"enabled\":false,\"maxChars\":120}", 35, 85, now),
            Source("media_status", "当前音乐/视频", true, 10, 10, 1, "{}", 40, 80, now),
            Source("game_status", "游戏状态", true, 5, 10, 1, "{}", 48, 75, now),
            Source("git_status", "Git 状态", true, 10, 15, 1, "{\"directory\":\"C:\\\\Users\\\\49213\\\\Desktop\\\\A\\\\codex\\\\AI_maid\"}", 68, 70, now),
            Source("recent_errors", "最近报错", true, 5, 10, 5, "{\"folders\":[\"C:\\\\Users\\\\49213\\\\Desktop\\\\A\\\\codex\\\\AI_maid\\\\logs\"],\"lookbackMinutes\":120}", 90, 70, now),
            Source("voice_trigger_history", "语音触发记录", true, 30, 30, 5, "{\"lookbackMinutes\":180}", 40, 75, now),
            Source("current_image", "当前图库文件夹", true, 30, 30, 1, "{}", 20, 80, now)
        ];
    }
    private static ProactiveSourceDto Source(string key, string name, bool enabled, int frequency, int cooldown, int maxItems, string parameters, int priority, int minScore, DateTimeOffset now)
        => new(key, name, enabled, priority, frequency, cooldown, maxItems, parameters, minScore, null, string.Empty, string.Empty, 0, string.Empty, null, string.Empty, string.Empty, now);

    public void Dispose()
    {
        http.Dispose();
        logGate.Dispose();
    }

    private sealed record ProactiveTriggerLogDocument(
        string AuditId,
        DateTimeOffset TriggeredAt,
        string EventId,
        string EventType,
        string EventSource,
        string RoleId,
        string RoleDisplayName,
        string VoiceId,
        int IntimacyLevel,
        string AiProvider,
        string ProcessName,
        string WindowTitle,
        string Scene,
        string SelectedSourceKeys,
        string CandidatesJson,
        string PayloadJson,
        bool Responded,
        bool Spoke,
        string Message,
        string VoiceTrigger,
        string AudioPath,
        string Result,
        string Reason,
        DateTimeOffset UpdatedAt);
}
