namespace AIMaid.Contracts.Music;

public sealed record MusicPlaybackStateDto(
    string Url,
    string Title,
    string Singer,
    bool IsPlaying,
    bool IsPaused);

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
