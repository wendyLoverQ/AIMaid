using System.Text.Json;
using AIMaid.Contracts;
using AIMaid.Contracts.Music;

namespace AIMaid.Core;

public sealed class MusicApplicationService : IDisposable
{
    private readonly HttpClient httpClient = new();
    private readonly IEventPublisher events;
    private readonly ISettingsStore settings;
    private readonly object stateGate = new();
    private MusicPlaybackStateDto state = new(string.Empty, string.Empty, string.Empty, false);

    public MusicApplicationService(IEventPublisher events, ISettingsStore settings)
    {
        this.events = events;
        this.settings = settings;
    }

    public MusicPlaybackStateDto Current()
    {
        lock (stateGate) return state;
    }

    public async Task<OperationResult<MusicPlaybackStateDto>> SearchAndPlayAsync(
        string songName,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(songName))
            return OperationResult<MusicPlaybackStateDto>.Failure("music.song_name_empty", "歌曲名不能为空");
        var audioSettings = await settings.GetManyAsync(["master_audio_muted", "master_audio_volume"], cancellationToken);
        var values = audioSettings.ToDictionary(item => item.Key, item => item.Value, StringComparer.OrdinalIgnoreCase);
        var muted = values.TryGetValue("master_audio_muted", out var mutedText) && bool.TryParse(mutedText, out var parsedMuted) && parsedMuted;
        var volume = values.TryGetValue("master_audio_volume", out var volumeText) && int.TryParse(volumeText, out var parsedVolume)
            ? Math.Clamp(parsedVolume, 0, 100)
            : 100;
        if (muted || volume <= 0)
            return OperationResult<MusicPlaybackStateDto>.Failure("music.muted", "当前已静音，未播放音乐");

        var failures = new List<string>();
        MusicSong? matchedSong = null;
        foreach (var provider in new (string Name, Func<string, CancellationToken, Task<MusicSong?>> Search)[]
                 {
                     ("meting-netease", SearchMetingFirstAsync),
                     ("gdstudio-netease", SearchGdStudioFirstAsync)
                 })
        {
            try
            {
                var song = await provider.Search(songName.Trim(), cancellationToken);
                if (song is null)
                {
                    failures.Add($"{provider.Name}: 未找到歌曲");
                    continue;
                }
                matchedSong ??= song;
                var url = await ResolvePlayableUrlAsync(song.StreamUrl, cancellationToken);
                if (string.IsNullOrWhiteSpace(url))
                {
                    failures.Add($"{provider.Name}: 播放流不可用");
                    continue;
                }

                var playback = new MusicPlaybackStateDto(url, song.Title, song.Singer, true);
                lock (stateGate) state = playback;
                await events.PublishAsync(new MusicPlaybackRequestedEvent(
                    EventIdentity.NewId(), DateTimeOffset.Now, playback), cancellationToken);
                return OperationResult<MusicPlaybackStateDto>.Success(playback);
            }
            catch (Exception exception) when (exception is HttpRequestException or JsonException or TaskCanceledException)
            {
                failures.Add($"{provider.Name}: {exception.Message}");
            }
        }
        return matchedSong is null
            ? OperationResult<MusicPlaybackStateDto>.Failure("music.not_found", $"未找到歌曲：{songName.Trim()}（{string.Join("；", failures)}）")
            : OperationResult<MusicPlaybackStateDto>.Failure("music.play_url_failed", $"获取播放地址失败：{matchedSong.Title}（{string.Join("；", failures)}）");
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        lock (stateGate) state = state with { IsPlaying = false };
        await events.PublishAsync(new MusicPlaybackStoppedEvent(
            EventIdentity.NewId(), DateTimeOffset.Now), cancellationToken);
    }

    private async Task<MusicSong?> SearchMetingFirstAsync(string songName, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get,
            $"https://music.duanjinglin.com/api?server=netease&type=search&id={Uri.EscapeDataString(songName)}");
        request.Headers.TryAddWithoutValidation("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
        using var response = await httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        using var document = JsonDocument.Parse(body);
        if (document.RootElement.ValueKind != JsonValueKind.Array) return null;
        var first = document.RootElement.EnumerateArray().FirstOrDefault();
        if (first.ValueKind != JsonValueKind.Object) return null;
        var streamUrl = ReadString(first, "url");
        var title = ReadString(first, "title", "name");
        var singer = ReadString(first, "author", "artist");
        if (!Uri.TryCreate(streamUrl, UriKind.Absolute, out var parsed)) return null;
        var secureStreamUrl = parsed.Scheme == Uri.UriSchemeHttps
            ? parsed.AbsoluteUri
            : new UriBuilder(parsed) { Scheme = Uri.UriSchemeHttps, Port = -1 }.Uri.AbsoluteUri;
        return new MusicSong(secureStreamUrl, title, singer);
    }

    private async Task<MusicSong?> SearchGdStudioFirstAsync(string songName, CancellationToken cancellationToken)
    {
        using var searchRequest = new HttpRequestMessage(HttpMethod.Get,
            $"https://music-api.gdstudio.xyz/api.php?types=search&source=netease&name={Uri.EscapeDataString(songName)}&count=5&pages=1");
        searchRequest.Headers.TryAddWithoutValidation("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
        using var searchResponse = await httpClient.SendAsync(searchRequest, cancellationToken);
        searchResponse.EnsureSuccessStatusCode();
        using var searchDocument = JsonDocument.Parse(await searchResponse.Content.ReadAsStringAsync(cancellationToken));
        if (searchDocument.RootElement.ValueKind != JsonValueKind.Array) return null;
        var first = searchDocument.RootElement.EnumerateArray().FirstOrDefault();
        if (first.ValueKind != JsonValueKind.Object) return null;
        var id = ReadString(first, "url_id", "id");
        if (id.Length == 0) return null;
        var title = ReadString(first, "name", "title");
        var singer = first.TryGetProperty("artist", out var artists) && artists.ValueKind == JsonValueKind.Array
            ? string.Join(", ", artists.EnumerateArray().Select(item => item.GetString()).Where(item => !string.IsNullOrWhiteSpace(item)))
            : ReadString(first, "author", "artist");

        using var urlRequest = new HttpRequestMessage(HttpMethod.Get,
            $"https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id={Uri.EscapeDataString(id)}&br=320");
        urlRequest.Headers.TryAddWithoutValidation("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
        using var urlResponse = await httpClient.SendAsync(urlRequest, cancellationToken);
        urlResponse.EnsureSuccessStatusCode();
        using var urlDocument = JsonDocument.Parse(await urlResponse.Content.ReadAsStringAsync(cancellationToken));
        var streamUrl = ReadString(urlDocument.RootElement, "url");
        return Uri.TryCreate(streamUrl, UriKind.Absolute, out var parsed) && parsed.Scheme == Uri.UriSchemeHttps
            ? new MusicSong(parsed.AbsoluteUri, title, singer)
            : null;
    }

    private static string ReadString(JsonElement element, params string[] names)
    {
        foreach (var name in names)
            if (element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String &&
                !string.IsNullOrWhiteSpace(value.GetString())) return value.GetString()!;
        return string.Empty;
    }

    private async Task<string?> ResolvePlayableUrlAsync(string streamUrl, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, streamUrl);
        request.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(0, 0);
        request.Headers.TryAddWithoutValidation("Referer", "https://music.163.com/");
        request.Headers.TryAddWithoutValidation("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
        using var response = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode || response.Content.Headers.ContentType?.MediaType?.StartsWith("audio/", StringComparison.OrdinalIgnoreCase) != true)
            return null;
        var totalLength = response.Content.Headers.ContentRange?.Length ?? response.Content.Headers.ContentLength;
        if (totalLength is null or < 1_000_000) return null;
        var finalUrl = response.RequestMessage?.RequestUri;
        return finalUrl?.Scheme == Uri.UriSchemeHttps ? finalUrl.AbsoluteUri : null;
    }

    public void Dispose() => httpClient.Dispose();

    private sealed record MusicSong(string StreamUrl, string Title, string Singer);
}
