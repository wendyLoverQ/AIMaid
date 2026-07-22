using AIMaid.Contracts;
using AIMaid.Contracts.Characters;
using AIMaid.Contracts.Chat;
using AIMaid.Contracts.Settings;
using AIMaid.Contracts.Tasks;
using AIMaid.Contracts.Domains;

namespace AIMaid.Core;

public interface IEventPublisher
{
    event EventHandler<IBusinessEvent>? EventPublished;
    ValueTask PublishAsync(IBusinessEvent businessEvent, CancellationToken cancellationToken = default);
}

public interface IChatStore
{
    Task<long> AppendAsync(ChatMessageDto message, CancellationToken cancellationToken = default);
    Task UpdateMetadataAsync(long messageId, string metadataJson, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<ChatMessageDto>> LoadRecentAsync(string conversationId, int limit, CancellationToken cancellationToken = default);
    Task DeleteConversationAsync(string conversationId, CancellationToken cancellationToken = default);
    Task DeleteByCharacterAsync(string characterId, CancellationToken cancellationToken = default);
}

public interface IChatSearchStore
{
    Task<IReadOnlyList<ChatMessageDto>> SearchUserMessagesAsync(string keyword, int limit, CancellationToken cancellationToken = default);
}

public interface ISettingsStore
{
    Task<SettingDto?> GetAsync(string key, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<SettingDto>> GetManyAsync(IReadOnlyList<string>? keys, CancellationToken cancellationToken = default);
    Task SetManyAsync(IReadOnlyDictionary<string, string> values, CancellationToken cancellationToken = default);
}

public interface ICharacterStore
{
    Task<CharacterDto?> GetAsync(string roleId, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<CharacterDto>> ListAsync(bool enabledOnly, CancellationToken cancellationToken = default);
    Task UpsertAsync(CharacterDto character, CancellationToken cancellationToken = default);
    Task DeleteAsync(string roleId, CancellationToken cancellationToken = default);
}

public interface IBackgroundTaskStore
{
    Task<BackgroundTaskDto?> GetAsync(string taskId, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<BackgroundTaskDto>> ListAsync(string? taskType, int limit, CancellationToken cancellationToken = default);
    Task UpsertAsync(BackgroundTaskDto task, CancellationToken cancellationToken = default);
}

public sealed record AiChatRequest(
    string ConversationId,
    string Content,
    string CharacterId,
    string ModelName,
    IReadOnlyList<ChatMessageDto> History,
    string SourceKey = "",
    IReadOnlyDictionary<string, string>? TemplateValues = null,
    bool RequireJsonResponse = false,
    double? Temperature = null,
    int? MaxTokens = null,
    bool StreamResponse = true);

public interface IAiProviderClient
{
    IAsyncEnumerable<string> StreamChatAsync(AiChatRequest request, CancellationToken cancellationToken = default);
}

public interface IComfyUiClient
{
    Task<string> QueueWorkflowAsync(string workflowJson, IReadOnlyDictionary<string, string> inputs, CancellationToken cancellationToken = default);
}

public interface IDownloadClient
{
    Task<string> DownloadAsync(string operationId, string url, string targetDirectory, string? fileName, IProgress<(double Progress, string Message)> progress, CancellationToken cancellationToken = default);
}

public interface ITtsClient
{
    Task<string> SynthesizeAsync(string text, string? voiceId, string style, CancellationToken cancellationToken = default);
}

public interface IAsrClient
{
    Task<string> TranscribeAsync(
        string audioPath,
        string? characterId,
        string? sessionId,
        string language,
        string requestId,
        CancellationToken cancellationToken = default);
}

public interface IFileManager
{
    Task MoveAsync(string sourcePath, string destinationPath, bool overwrite, CancellationToken cancellationToken = default);
    Task DeleteAsync(string path, CancellationToken cancellationToken = default);
}

public interface IExternalMediaController
{
    Task<int> LaunchAsync(string mediaPathOrUrl, string? subtitlePath, CancellationToken cancellationToken = default);
}

public interface IVaultArchivePlatform
{
    Task CreateEncrypted7zAsync(string jsonContent, string outputPath, string password, CancellationToken cancellationToken = default);
}

public interface IDomainDocumentStore
{
    Task<string?> GetAsync(string domain, string id, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<string>> ListAsync(string domain, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<string>> ListIdsAsync(string domain, CancellationToken cancellationToken = default);
    Task UpsertAsync(string domain, string id, string json, DateTimeOffset updatedAt, CancellationToken cancellationToken = default);
    Task DeleteAsync(string domain, string id, CancellationToken cancellationToken = default);
}

public sealed record AgentExecutionResult(int? ExitCode, string Output, string Error);
public interface IAgentCapabilityExecutor
{
    string ExecutorType { get; }
    Task<AgentExecutionResult> ExecuteAsync(AgentCapabilityDto capability, string argsJson, CancellationToken cancellationToken = default);
}

public sealed record LlmCallAuditRecord(
    string ConversationId,
    string Source,
    string Provider,
    string Model,
    string Endpoint,
    string RequestUrl,
    int ResponseStatusCode,
    string ResponseId,
    string ResponseText,
    string Error,
    long DurationMs,
    int PromptTokens,
    int CompletionTokens,
    int TotalTokens,
    DateTimeOffset CreatedAt,
    DateTimeOffset? CompletedAt = null);

public interface ILlmCallAuditStore
{
    Task WriteAsync(LlmCallAuditRecord record, CancellationToken cancellationToken = default);
}

public interface ISecretProtector
{
    string Protect(string plaintext);
    string Unprotect(string protectedValue);
}

public interface IRemoteMediaResolver
{
    Task<string> ResolveAsync(string url, RemoteSiteDto? site, CancellationToken cancellationToken = default);
}

public sealed record RemoteToolExecutionResult(int ExitCode, string StandardOutput, string StandardError);
public sealed record RemoteMediaLaunchRequest(
    string Source, string? AudioSource = null, string? Title = null,
    string? UserAgent = null, string? Referer = null);
public interface IRemoteVideoPlatform
{
    Task<RemoteToolExecutionResult> RunToolAsync(
        string executablePath, IReadOnlyList<string> arguments,
        Action<string>? standardErrorLine = null, CancellationToken cancellationToken = default);
    Task<int> LaunchMediaAsync(string executablePath, RemoteMediaLaunchRequest request, CancellationToken cancellationToken = default);
}
