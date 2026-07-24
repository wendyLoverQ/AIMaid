using System.Text.Json;
using AIMaid.Contracts.Domains;
using AIMaid.Contracts.Music;
using AIMaid.Core;

namespace AIMaid.CoreHost.Runtime;

public sealed class InternalServiceAgentExecutor(
    ReminderApplicationService reminders,
    SettingsBackedSpeechClient speech,
    MusicApplicationService music) : IAgentCapabilityExecutor
{
    public string ExecutorType => "internal_service";

    public async Task<AgentExecutionResult> ExecuteAsync(AgentCapabilityDto capability, string argsJson, CancellationToken cancellationToken = default)
    {
        using var configDocument = JsonDocument.Parse(capability.ConfigJson);
        using var argsDocument = JsonDocument.Parse(argsJson);
        var operation = configDocument.RootElement.TryGetProperty("operation", out var value) ? value.GetString() : null;
        return operation switch
        {
            "restart_tts" => await RestartTtsAsync(cancellationToken),
            "create_reminder" => await CreateReminderAsync(argsDocument.RootElement, cancellationToken),
            "search_and_play_music" => await SearchAndPlayMusicAsync(argsDocument.RootElement, cancellationToken),
            _ => new AgentExecutionResult(null, string.Empty, $"未支持的内部服务操作：{operation}")
        };
    }

    private async Task<AgentExecutionResult> RestartTtsAsync(CancellationToken cancellationToken)
    {
        try
        {
            await speech.EnsureReadyAsync(cancellationToken);
            return new AgentExecutionResult(0, "TTS 服务已启动", string.Empty);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        { return new AgentExecutionResult(null, string.Empty, exception.Message); }
    }

    private async Task<AgentExecutionResult> CreateReminderAsync(JsonElement args, CancellationToken cancellationToken)
    {
        if (!args.TryGetProperty("timeText", out var time) || time.ValueKind != JsonValueKind.String)
            return new AgentExecutionResult(null, "缺少 timeText 参数", "缺少 timeText 参数");
        if (!args.TryGetProperty("content", out var text) || text.ValueKind != JsonValueKind.String)
            return new AgentExecutionResult(null, "缺少 content 参数", "缺少 content 参数");
        var timeText = time.GetString() ?? string.Empty;
        var content = text.GetString() ?? string.Empty;
        var repeat = args.TryGetProperty("repeat", out var repeatValue) ? repeatValue.GetString() ?? "none" : "none";
        if (string.IsNullOrWhiteSpace(timeText) || string.IsNullOrWhiteSpace(content))
            return new AgentExecutionResult(null, "提醒时间或内容不能为空", "timeText 或 content 为空");
        if (!TryParseNaturalTime(timeText, out var dueAt))
            return new AgentExecutionResult(null, $"无法解析时间：{timeText}（请使用\"30分钟后\"等格式）", $"natural time parse failed: {timeText}");
        var result = await reminders.HandleAsync(new SaveReminderCommand(null, content, $"提醒：{content}", dueAt, repeat, true, true), cancellationToken);
        return result.Succeeded && result.Value is not null
            ? new AgentExecutionResult(0, $"已创建提醒：{content}，时间：{dueAt:yyyy-MM-dd HH:mm}", string.Empty)
            : new AgentExecutionResult(null, string.Empty, result.ErrorMessage ?? "提醒创建失败。");
    }

    private async Task<AgentExecutionResult> SearchAndPlayMusicAsync(JsonElement args, CancellationToken cancellationToken)
    {
        MusicSearchItemDto[] songs;
        if (args.TryGetProperty("songs", out var songsValue))
        {
            if (songsValue.ValueKind != JsonValueKind.Array || songsValue.GetArrayLength() is < 1 or > 20)
                return new AgentExecutionResult(null, string.Empty, "songs 必须是包含 1 到 20 首歌曲的列表");
            var items = new List<MusicSearchItemDto>();
            foreach (var item in songsValue.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object ||
                    !item.TryGetProperty("songName", out var songNameValue) || songNameValue.ValueKind != JsonValueKind.String ||
                    !item.TryGetProperty("singerName", out var singerNameValue) || singerNameValue.ValueKind != JsonValueKind.String ||
                    string.IsNullOrWhiteSpace(songNameValue.GetString()) || string.IsNullOrWhiteSpace(singerNameValue.GetString()))
                    return new AgentExecutionResult(null, string.Empty, "songs 中每一项都必须包含非空的 songName 和 singerName");
                items.Add(new MusicSearchItemDto(songNameValue.GetString()!, singerNameValue.GetString()!));
            }
            songs = items.ToArray();
        }
        else
        {
            if (!args.TryGetProperty("songName", out var songNameValue) || songNameValue.ValueKind != JsonValueKind.String ||
                string.IsNullOrWhiteSpace(songNameValue.GetString()))
                return new AgentExecutionResult(null, string.Empty, "缺少 songName 参数");
            var singerName = args.TryGetProperty("singerName", out var singerNameValue) && singerNameValue.ValueKind == JsonValueKind.String
                ? singerNameValue.GetString() ?? string.Empty
                : string.Empty;
            songs = [new MusicSearchItemDto(songNameValue.GetString()!, singerName)];
        }
        var result = await music.SearchAndPlayAsync(songs, cancellationToken);
        if (!result.Succeeded || result.Value is null)
            return new AgentExecutionResult(null, string.Empty, result.ErrorMessage ?? "播放失败");
        var prefix = songs.Length > 1 ? $"正在按顺序播放歌单（{songs.Length} 首）" : "正在播放";
        return new AgentExecutionResult(0, $"{prefix}：{result.Value.Title} - {result.Value.Singer}", string.Empty);
    }

    private static bool TryParseNaturalTime(string value, out DateTimeOffset dueAt)
    {
        dueAt = DateTimeOffset.Now;
        var text = value.Trim().Replace(" ", string.Empty, StringComparison.Ordinal);
        foreach (var (suffix, add) in new (string Suffix, Func<int, DateTimeOffset> Add)[]
        {
            ("分钟后", amount => DateTimeOffset.Now.AddMinutes(amount)),
            ("小时后", amount => DateTimeOffset.Now.AddHours(amount)),
            ("天后", amount => DateTimeOffset.Now.AddDays(amount))
        })
        {
            if (!text.EndsWith(suffix, StringComparison.Ordinal) || !int.TryParse(text[..^suffix.Length], out var amount)) continue;
            dueAt = add(amount);
            return true;
        }
        return false;
    }
}
