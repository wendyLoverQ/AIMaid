using AIMaid.Contracts;
using AIMaid.Contracts.Settings;

namespace AIMaid.Core;

public sealed class SettingsApplicationService :
    ICommandHandler<SaveSettingCommand, OperationResult>,
    ICommandHandler<SaveSettingsCommand, OperationResult>,
    IQueryHandler<GetSettingQuery, SettingDto?>,
    IQueryHandler<GetSettingsQuery, IReadOnlyList<SettingDto>>
{
    private readonly ISettingsStore store;
    private readonly IEventPublisher events;

    public SettingsApplicationService(ISettingsStore store, IEventPublisher events)
    {
        this.store = store;
        this.events = events;
    }

    public Task<SettingDto?> HandleAsync(GetSettingQuery query, CancellationToken cancellationToken = default)
        => store.GetAsync(query.Key, cancellationToken);

    public Task<IReadOnlyList<SettingDto>> HandleAsync(GetSettingsQuery query, CancellationToken cancellationToken = default)
        => store.GetManyAsync(query.Keys, cancellationToken);

    public Task<OperationResult> HandleAsync(SaveSettingCommand command, CancellationToken cancellationToken = default)
        => SaveAsync(new Dictionary<string, string> { [command.Key] = command.Value }, cancellationToken);

    public Task<OperationResult> HandleAsync(SaveSettingsCommand command, CancellationToken cancellationToken = default)
        => SaveAsync(command.Values, cancellationToken);

    private async Task<OperationResult> SaveAsync(IReadOnlyDictionary<string, string> values, CancellationToken cancellationToken)
    {
        if (values.Count == 0 || values.Keys.Any(string.IsNullOrWhiteSpace))
            return OperationResult.Failure("settings.invalid", "配置键不能为空。");
        await store.SetManyAsync(values, cancellationToken);
        await events.PublishAsync(new SettingsChangedEvent(EventIdentity.NewId(), DateTimeOffset.Now, values.Keys.ToArray()), cancellationToken);
        // TODO(UI): 保存页根据配置元数据展示“立即生效/重启后生效”，并显示明确保存反馈。
        return OperationResult.Success();
    }
}
