namespace AIMaid.Contracts.Characters;

public sealed record CharacterDto(
    string RoleId,
    string Name,
    string VoiceName,
    string RoleTitle,
    string CardPath,
    string SourceCardJson,
    string TemplateCardJson,
    string PreferredVoiceId,
    string ValidationStatus,
    bool IsEnabled,
    DateTimeOffset UpdatedAt,
    string CardSummary = "",
    string CardSchemaVersion = "",
    string TemplateCardSourceHash = "",
    string TemplateCardGenerationStatus = "",
    string TemplateCardGenerationMessage = "",
    DateTimeOffset? TemplateCardGeneratedAt = null,
    DateTimeOffset? TemplateCardLastAttemptAt = null,
    int TemplateCardIterationCount = 0,
    string ValidationMessage = "",
    DateTimeOffset? LastValidatedAt = null,
    string AvatarPath = "");

public sealed record VoiceAssetDto(string VoiceId, string DisplayName, string VoiceFolderPath, bool IsEnabled, DateTimeOffset UpdatedAt);
public sealed record RoleVoiceDto(string RoleId, string VoiceId, string Style, bool IsDefault, bool IsEnabled, DateTimeOffset UpdatedAt);
public sealed record ListVoiceAssetsQuery : IQuery<IReadOnlyList<VoiceAssetDto>>;
public sealed record AddVoiceAssetCommand(string BaseName, string DisplayName, string Style, string SourceFolderPath) : ICommand<OperationResult<VoiceAssetDto>>;
public sealed record ImportCharacterAvatarCommand(string SourcePath) : ICommand<OperationResult<string>>;
public sealed record ListRoleVoicesQuery(string RoleId) : IQuery<IReadOnlyList<RoleVoiceDto>>;
public sealed record SetRoleVoicesCommand(string RoleId, IReadOnlyList<RoleVoiceDto> Voices) : ICommand<OperationResult>;
public sealed record CharacterObjectBindingDto(string TargetType, string TargetKey, string RoleId, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);
public sealed record GetCharacterObjectBindingQuery(string TargetKey) : IQuery<CharacterObjectBindingDto?>;
public sealed record ListCharacterObjectBindingsQuery(string RoleId) : IQuery<IReadOnlyList<CharacterObjectBindingDto>>;
public sealed record BindCharacterObjectCommand(string TargetKey, string RoleId) : ICommand<OperationResult<CharacterObjectBindingDto>>;
public sealed record UnbindCharacterObjectCommand(string TargetKey) : ICommand<OperationResult>;
public sealed record ApplyCharacterObjectBindingCommand(string TargetKey) : ICommand<OperationResult>;

public sealed record GenerateTemplateCardCommand(string RoleId, bool ContinueIteration) : ICommand<OperationResult<CharacterDto>>;

public sealed record ListCharactersQuery(bool EnabledOnly = true) : IQuery<IReadOnlyList<CharacterDto>>;
public sealed record GetCharacterQuery(string RoleId) : IQuery<CharacterDto?>;
public sealed record UpdateCharacterCommand(CharacterDto Character) : ICommand<OperationResult>;
public sealed record DeleteCharacterCommand(string RoleId) : ICommand<OperationResult>;
public sealed record SetCurrentCharacterCommand(string RoleId) : ICommand<OperationResult>;
public sealed record PresentCharacterCommand(
    string RoleId,
    string Action,
    string Mood,
    IReadOnlyDictionary<string, string>? Parameters = null) : ICommand<OperationResult>;

public sealed record CharacterChangedEvent(
    string EventId,
    DateTimeOffset OccurredAt,
    string RoleId,
    string ChangeType) : IBusinessEvent;
