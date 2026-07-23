namespace AIMaid.Contracts.PetVoice;

public sealed record PetVoiceCacheStatusEvent(
    string EventId, DateTimeOffset OccurredAt,
    string GenerationId, string RoleId, string RoleName, int IntimacyLevel, string IntimacyLabel,
    string CacheKey, string ContextHash, string Phase, int CompletedEntries, int TotalEntries,
    string Message, string ErrorCode, string ErrorMessage, bool IsForeground, DateTimeOffset UpdatedAt) : AIMaid.Contracts.IBusinessEvent;

public sealed record VoiceCacheConfigurationChangedEvent(
    string EventId, DateTimeOffset OccurredAt, string Reason, IReadOnlyList<string> Keys) : AIMaid.Contracts.IBusinessEvent;
