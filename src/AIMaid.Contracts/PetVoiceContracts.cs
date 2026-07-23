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
    int GeneratedEntries,
    bool Ready,
    string Message);

public sealed record PetVoiceCacheEnsureResultDto(
    string RoleId,
    int IntimacyLevel,
    string CacheKey,
    int TotalEntries,
    int GeneratedEntries,
    bool Ready,
    string Message);

public sealed record PetVoicePlaybackDto(
    bool Matched,
    string TriggerId,
    string BodyPart,
    string Text,
    string AudioPath,
    string VoiceId,
    string Reason);

public sealed record GetPetVoiceMenuStateQuery;
public sealed record CyclePetVoiceIntimacyCommand;
public sealed record EnsurePetVoiceCacheCommand(bool IncludeNextPeriod = true);
public sealed record PlayPetVoiceCommand(string TriggerId, string BodyPart, string Source = "pet.click");
public sealed record ReportPetVoicePlaybackCommand(
    string TriggerId,
    string BodyPart,
    string Text,
    string AudioPath,
    bool Played,
    string Reason,
    string Source = "pet.click");
