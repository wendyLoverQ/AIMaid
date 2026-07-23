using System.Text;
using System.Text.Json;
using AIMaid.Contracts;
using AIMaid.Contracts.Chat;

namespace AIMaid.Core;

public sealed class ChatApplicationService :
    ICommandHandler<SendChatCommand, OperationResult<ChatCompletionDto>>,
    ICommandHandler<StartChatConversationCommand, OperationResult<string>>,
    ICommandHandler<UpdateChatMessageMetadataCommand, OperationResult>,
    IQueryHandler<GetChatHistoryQuery, IReadOnlyList<ChatMessageDto>>,
    IQueryHandler<GetCurrentConversationQuery, string?>
{
    private const string CurrentConversationKey = "chat_history_current_conversation_id";
    private readonly IChatStore chatStore;
    private readonly ISettingsStore settingsStore;
    private readonly IAiProviderClient aiProvider;
    private readonly IEventPublisher events;

    public ChatApplicationService(IChatStore chatStore, ISettingsStore settingsStore, IAiProviderClient aiProvider, IEventPublisher events)
    {
        this.chatStore = chatStore;
        this.settingsStore = settingsStore;
        this.aiProvider = aiProvider;
        this.events = events;
    }

    public async Task<OperationResult<ChatCompletionDto>> HandleAsync(SendChatCommand command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.Content))
            return OperationResult<ChatCompletionDto>.Failure("chat.empty", "聊天内容不能为空。");

        var conversationId = string.IsNullOrWhiteSpace(command.ConversationId)
            ? await GetOrCreateConversationIdAsync(cancellationToken)
            : command.ConversationId;
        var now = DateTimeOffset.Now;
        var characterId = command.CharacterId ?? string.Empty;
        var modelName = command.ModelName ?? string.Empty;
        await chatStore.AppendAsync(new ChatMessageDto(0, conversationId, "user", command.Content, characterId,
            modelName, command.Source, string.Empty, now), cancellationToken);

        var history = await chatStore.LoadRecentAsync(conversationId, 20, cancellationToken);
        var promptHistory = history
            .Where((message, index) => index != history.Count - 1 ||
                !message.Role.Equals("user", StringComparison.OrdinalIgnoreCase) ||
                !message.Content.Equals(command.Content, StringComparison.Ordinal))
            .ToArray();
        var values = new Dictionary<string, string>
        {
            ["userMessage"] = command.Content,
            ["conversationSummary"] = string.Empty,
            ["recentMessagesJson"] = JsonSerializer.Serialize(
                promptHistory.Select(message => new { role = message.Role, content = message.Content })),
            ["currentImagePath"] = string.Empty,
            ["currentFolderName"] = string.Empty
        };
        var response = new StringBuilder();
        await foreach (var delta in aiProvider.StreamChatAsync(
                           new AiChatRequest(conversationId, command.Content, characterId, modelName, promptHistory,
                               SourceKey: "online_chat", TemplateValues: values, StreamResponse: false), cancellationToken))
        {
            response.Append(delta);
        }

        var finalText = ParseChatMessage(response.ToString());
        if (string.IsNullOrWhiteSpace(finalText))
            return OperationResult<ChatCompletionDto>.Failure("chat.empty_response", "AIProvider 返回了空回复。");

        await events.PublishAsync(new ChatDeltaEvent(EventIdentity.NewId(), DateTimeOffset.Now, conversationId, finalText), cancellationToken);
        var messageId = await chatStore.AppendAsync(new ChatMessageDto(0, conversationId, "assistant", finalText,
            characterId, modelName, command.Source, string.Empty, DateTimeOffset.Now), cancellationToken);
        var completion = new ChatCompletionDto(conversationId, messageId, finalText, modelName);
        await events.PublishAsync(new ChatCompletedEvent(EventIdentity.NewId(), DateTimeOffset.Now, completion), cancellationToken);
        return OperationResult<ChatCompletionDto>.Success(completion);
    }

    public async Task<OperationResult<string>> HandleAsync(StartChatConversationCommand command, CancellationToken cancellationToken = default)
    {
        var id = $"chat_{Guid.NewGuid():N}";
        await settingsStore.SetManyAsync(new Dictionary<string, string> { [CurrentConversationKey] = id }, cancellationToken);
        return OperationResult<string>.Success(id);
    }

    public async Task<OperationResult> HandleAsync(UpdateChatMessageMetadataCommand command, CancellationToken cancellationToken = default)
    {
        if (command.MessageId <= 0) return OperationResult.Failure("chat.invalid_message", "消息 ID 无效。");
        if (!await chatStore.UpdateMetadataAsync(command.MessageId, command.MetadataJson, cancellationToken))
            return OperationResult.Failure("chat.message_not_found", "目标消息不存在。");
        return OperationResult.Success();
    }

    public Task<IReadOnlyList<ChatMessageDto>> HandleAsync(GetChatHistoryQuery query, CancellationToken cancellationToken = default)
        => chatStore.LoadRecentAsync(query.ConversationId, query.Limit <= 0 ? 20 : query.Limit, cancellationToken);

    public async Task<string?> HandleAsync(GetCurrentConversationQuery query, CancellationToken cancellationToken = default)
        => (await settingsStore.GetAsync(CurrentConversationKey, cancellationToken))?.Value;

    private static string ParseChatMessage(string raw)
    {
        using var document = JsonDocument.Parse(raw.Trim());
        if (document.RootElement.ValueKind != JsonValueKind.Object ||
            !document.RootElement.TryGetProperty("message", out var message) ||
            message.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("online_chat 返回内容缺少 message。");
        return message.GetString()?.Trim() ?? string.Empty;
    }

    private async Task<string> GetOrCreateConversationIdAsync(CancellationToken cancellationToken)
    {
        var existing = (await settingsStore.GetAsync(CurrentConversationKey, cancellationToken))?.Value;
        if (!string.IsNullOrWhiteSpace(existing)) return existing;
        var created = await HandleAsync(new StartChatConversationCommand(), cancellationToken);
        return created.Value!;
    }
}
