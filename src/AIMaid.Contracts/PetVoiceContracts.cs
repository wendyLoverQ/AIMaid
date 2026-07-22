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
    int DeletedFiles);

public sealed record GetPetVoiceMenuStateQuery;
public sealed record CyclePetVoiceIntimacyCommand;
