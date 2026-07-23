namespace AIMaid.Contracts.PetVoice;

public sealed record PetVoiceMenuStateDto(
    string RoleId,
    string RoleName,
    int IntimacyLevel,
    string IntimacyLabel,
    IReadOnlyList<int> AvailableLevels);

public sealed record PetVoiceCacheClearResultDto(
    string RoleId,
    int IntimacyLevel,
    int DeletedEntries,
    int DeletedFiles,
    int DeletedGenerations,
    int GeneratedEntries,
    bool Ready,
    string GenerationId,
    string Message)
{
    public PetVoiceCacheClearResultDto(string roleId, int intimacyLevel, int deletedEntries, int deletedFiles,
        int generatedEntries, bool ready, string message)
        : this(roleId, intimacyLevel, deletedEntries, deletedFiles, 0, generatedEntries, ready, "", message) { }
}

public sealed record PetVoiceCacheEnsureResultDto(
    string GenerationId,
    string RoleId,
    int IntimacyLevel,
    string CacheKey,
    string ContextHash,
    int TotalEntries,
    int GeneratedEntries,
    bool Ready,
    DateTimeOffset PeriodStartAt,
    DateTimeOffset PeriodEndAt,
    string NextCacheKey,
    bool NextReady,
    string State,
    string Message)
{
    public PetVoiceCacheEnsureResultDto(string roleId, int intimacyLevel, string cacheKey, int totalEntries,
        int generatedEntries, bool ready, string message)
        : this("", roleId, intimacyLevel, cacheKey, "", totalEntries, generatedEntries, ready,
            DateTimeOffset.MinValue, DateTimeOffset.MinValue, "", false, ready ? "ready" : "pending", message) { }
}

public sealed record PetVoicePlaybackDto(
    bool Matched,
    string GenerationId,
    string ContextHash,
    string TriggerId,
    string Category,
    string BodyPart,
    string Text,
    string AudioPath,
    string VoiceId,
    string Reason)
{
    public PetVoicePlaybackDto(bool matched, string triggerId, string bodyPart, string text, string audioPath,
        string voiceId, string reason)
        : this(matched, "", "", triggerId, "", bodyPart, text, audioPath, voiceId, reason) { }
}

public sealed record GetPetVoiceMenuStateQuery;
public sealed record CyclePetVoiceIntimacyCommand;
public sealed record EnsurePetVoiceCacheCommand(bool IncludeNextPeriod = true);
public sealed record PlayPetVoiceCommand(string TriggerId, string BodyPart, string Source = "pet.click",
    string HitAreaName = "", double? NormalizedX = null, double? NormalizedY = null);
public sealed record ReportPetVoicePlaybackCommand(
    string TriggerId,
    string BodyPart,
    string Text,
    string AudioPath,
    bool Played,
    string Reason,
    string Source = "pet.click",
    string GenerationId = "",
    string ContextHash = "",
    string Category = "",
    string HitAreaName = "",
    double? NormalizedX = null,
    double? NormalizedY = null);
