using AIMaid.Contracts;
using AIMaid.Contracts.Characters;
using AIMaid.Contracts.Settings;

namespace AIMaid.Core;

public sealed class CharacterApplicationService :
    ICommandHandler<UpdateCharacterCommand, OperationResult>,
    ICommandHandler<SetCurrentCharacterCommand, OperationResult>,
    IQueryHandler<ListCharactersQuery, IReadOnlyList<CharacterDto>>,
    IQueryHandler<GetCharacterQuery, CharacterDto?>
{
    private const string CurrentRoleKey = "voice_current_role_id";
    private readonly ICharacterStore characters;
    private readonly ISettingsStore settings;
    private readonly IEventPublisher events;

    public CharacterApplicationService(ICharacterStore characters, ISettingsStore settings, IEventPublisher events)
    {
        this.characters = characters;
        this.settings = settings;
        this.events = events;
    }

    public Task<IReadOnlyList<CharacterDto>> HandleAsync(ListCharactersQuery query, CancellationToken cancellationToken = default)
        => characters.ListAsync(query.EnabledOnly, cancellationToken);

    public Task<CharacterDto?> HandleAsync(GetCharacterQuery query, CancellationToken cancellationToken = default)
        => characters.GetAsync(query.RoleId, cancellationToken);

    public async Task<OperationResult> HandleAsync(UpdateCharacterCommand command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.Character.RoleId))
            return OperationResult.Failure("character.invalid_role", "角色 ID 不能为空。");
        await characters.UpsertAsync(command.Character with { UpdatedAt = DateTimeOffset.Now }, cancellationToken);
        await events.PublishAsync(new CharacterChangedEvent(EventIdentity.NewId(), DateTimeOffset.Now,
            command.Character.RoleId, "updated"), cancellationToken);
        return OperationResult.Success();
    }

    public async Task<OperationResult> HandleAsync(SetCurrentCharacterCommand command, CancellationToken cancellationToken = default)
    {
        if (await characters.GetAsync(command.RoleId, cancellationToken) is null)
            return OperationResult.Failure("character.not_found", "角色不存在。");
        await settings.SetManyAsync(new Dictionary<string, string> { [CurrentRoleKey] = command.RoleId }, cancellationToken);
        await events.PublishAsync(new CharacterChangedEvent(EventIdentity.NewId(), DateTimeOffset.Now, command.RoleId, "selected"), cancellationToken);
        // TODO(UI): 角色切换成功后由 UI 决定是否切换立绘、Live2D 模型和语音预览。
        return OperationResult.Success();
    }
}
