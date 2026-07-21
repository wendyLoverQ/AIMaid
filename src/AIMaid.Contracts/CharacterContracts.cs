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
    DateTimeOffset UpdatedAt);

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
