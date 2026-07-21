namespace AIMaid.Contracts.Chat;

public sealed record ChatMessageDto(
    long Id,
    string ConversationId,
    string Role,
    string Content,
    string CharacterId,
    string ModelName,
    string Source,
    string MetadataJson,
    DateTimeOffset CreatedAt);

public sealed record SendChatCommand(
    string Content,
    string? ConversationId = null,
    string? CharacterId = null,
    string? ModelName = null,
    string Source = "normal_chat") : ICommand<OperationResult<ChatCompletionDto>>;

public sealed record StartChatConversationCommand : ICommand<OperationResult<string>>;

public sealed record UpdateChatMessageMetadataCommand(long MessageId, string MetadataJson) : ICommand<OperationResult>;

public sealed record GetChatHistoryQuery(string ConversationId, int Limit = 20)
    : IQuery<IReadOnlyList<ChatMessageDto>>;

public sealed record GetCurrentConversationQuery : IQuery<string?>;

public sealed record ChatCompletionDto(string ConversationId, long MessageId, string Content, string ModelName);

public sealed record ChatDeltaEvent(
    string EventId,
    DateTimeOffset OccurredAt,
    string ConversationId,
    string Delta) : IBusinessEvent;

public sealed record ChatCompletedEvent(
    string EventId,
    DateTimeOffset OccurredAt,
    ChatCompletionDto Completion) : IBusinessEvent;
