namespace AIMaid.Contracts.Music;

public sealed record MusicSearchItemDto(string SongName, string SingerName);

public sealed record MusicPlaybackStateDto(
    string Url,
    string Title,
    string Singer,
    string Lyrics,
    bool IsPlaying,
    bool IsPaused,
    bool HasNext);

public sealed record MusicPlaybackRequestedEvent(
    string EventId,
    DateTimeOffset OccurredAt,
    MusicPlaybackStateDto Playback) : IBusinessEvent;

public sealed record MusicPlaybackStoppedEvent(
    string EventId,
    DateTimeOffset OccurredAt) : IBusinessEvent;

public sealed record MusicPlaybackStateChangedEvent(
    string EventId,
    DateTimeOffset OccurredAt,
    MusicPlaybackStateDto Playback) : IBusinessEvent;
