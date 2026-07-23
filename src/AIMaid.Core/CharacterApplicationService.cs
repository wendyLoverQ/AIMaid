using AIMaid.Contracts;
using AIMaid.Contracts.Characters;
using AIMaid.Contracts.Settings;

namespace AIMaid.Core;

public sealed class CharacterApplicationService :
    ICommandHandler<UpdateCharacterCommand, OperationResult>,
    ICommandHandler<DeleteCharacterCommand, OperationResult>,
    ICommandHandler<SetCurrentCharacterCommand, OperationResult>,
    ICommandHandler<PresentCharacterCommand, OperationResult>,
    IQueryHandler<ListCharactersQuery, IReadOnlyList<CharacterDto>>,
    IQueryHandler<GetCharacterQuery, CharacterDto?>
{
    private const string CurrentRoleKey = "voice_current_role_id";
    private readonly ICharacterStore characters;
    private readonly ISettingsStore settings;
    private readonly IEventPublisher events;
    private readonly IDomainDocumentStore documents;
    private readonly IChatStore chatStore;

    public CharacterApplicationService(ICharacterStore characters, ISettingsStore settings, IDomainDocumentStore documents, IChatStore chatStore, IEventPublisher events)
    {
        this.characters = characters;
        this.settings = settings;
        this.documents = documents;
        this.chatStore = chatStore;
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

    public async Task<OperationResult> HandleAsync(DeleteCharacterCommand command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.RoleId))
            return OperationResult.Failure("character.invalid_role", "角色 ID 不能为空。");
        if (await characters.GetAsync(command.RoleId, cancellationToken) is null)
            return OperationResult.Failure("character.not_found", "角色不存在。");
        await characters.DeleteAsync(command.RoleId, cancellationToken);
        await DeleteRoleDocumentsAsync(command.RoleId, cancellationToken);
        await chatStore.DeleteByCharacterAsync(command.RoleId, cancellationToken);
        if (string.Equals((await settings.GetAsync(CurrentRoleKey, cancellationToken))?.Value, command.RoleId, StringComparison.OrdinalIgnoreCase))
            await settings.SetManyAsync(new Dictionary<string, string> { [CurrentRoleKey] = string.Empty }, cancellationToken);
        await events.PublishAsync(new CharacterChangedEvent(EventIdentity.NewId(), DateTimeOffset.Now,
            command.RoleId, "deleted"), cancellationToken);
        return OperationResult.Success();
    }

    private async Task DeleteRoleDocumentsAsync(string roleId, CancellationToken cancellationToken)
    {
        foreach (var domain in new[] { "voice_role_voice", "voice_role_binding", "voice_role", "voice_conversation", "voice_role_audio_cache", "voice_cache_generation" })
        {
            foreach (var id in await documents.ListIdsAsync(domain, cancellationToken))
            {
                var json = await documents.GetAsync(domain, id, cancellationToken);
                if (json is null) continue;
                try
                {
                    using var document = System.Text.Json.JsonDocument.Parse(json);
                    var root = document.RootElement;
                    var matches = (root.TryGetProperty("RoleId", out var role) || root.TryGetProperty("roleId", out role) ||
                                   root.TryGetProperty("VoiceRoleId", out role) || root.TryGetProperty("voiceRoleId", out role)) &&
                                  role.ValueKind == System.Text.Json.JsonValueKind.String &&
                                  string.Equals(role.GetString(), roleId, StringComparison.OrdinalIgnoreCase);
                    if (!matches) continue;
                    if (domain == "voice_conversation" &&
                        (root.TryGetProperty("ConversationId", out var conversation) || root.TryGetProperty("conversationId", out conversation)) &&
                        conversation.ValueKind == System.Text.Json.JsonValueKind.String &&
                        !string.IsNullOrWhiteSpace(conversation.GetString()))
                        await chatStore.DeleteConversationAsync(conversation.GetString()!, cancellationToken);
                    await documents.DeleteAsync(domain, id, cancellationToken);
                }
                catch (System.Text.Json.JsonException) { }
            }
        }
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

    public async Task<OperationResult> HandleAsync(PresentCharacterCommand command, CancellationToken cancellationToken = default)
    {
        if (await characters.GetAsync(command.RoleId, cancellationToken) is null)
            return OperationResult.Failure("character.not_found", "角色不存在。");
        if (string.IsNullOrWhiteSpace(command.Action))
            return OperationResult.Failure("character.action_empty", "角色动作不能为空。");
        await events.PublishAsync(new Contracts.Domains.CharacterPresentationEvent(
            EventIdentity.NewId(), DateTimeOffset.Now, command.RoleId, command.Action, command.Mood,
            command.Parameters ?? new Dictionary<string, string>()), cancellationToken);
        // TODO(UI): Electron renderer 直接消费该事件驱动 Live2D；C# 不创建渲染窗口，也不经过 Named Pipe。
        return OperationResult.Success();
    }
}
