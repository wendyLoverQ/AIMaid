namespace AIMaid.Contracts.Settings;

public sealed record SettingDto(string Key, string Value, DateTimeOffset UpdatedAt);
public sealed record GetSettingQuery(string Key) : IQuery<SettingDto?>;
public sealed record GetSettingsQuery(IReadOnlyList<string>? Keys = null) : IQuery<IReadOnlyList<SettingDto>>;
public sealed record SaveSettingCommand(string Key, string Value) : ICommand<OperationResult>;
public sealed record SaveSettingsCommand(IReadOnlyDictionary<string, string> Values) : ICommand<OperationResult>;

public sealed record SettingsChangedEvent(
    string EventId,
    DateTimeOffset OccurredAt,
    IReadOnlyList<string> Keys) : IBusinessEvent;
