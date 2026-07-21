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
    DateTimeOffset? LastValidatedAt = null);

public sealed record ListCharactersQuery(bool EnabledOnly = true) : IQuery<IReadOnlyList<CharacterDto>>;
public sealed record GetCharacterQuery(string RoleId) : IQuery<CharacterDto?>;
public sealed record UpdateCharacterCommand(CharacterDto Character) : ICommand<OperationResult>;
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
