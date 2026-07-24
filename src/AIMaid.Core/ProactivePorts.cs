using AIMaid.Contracts;
using AIMaid.Contracts.Domains;

namespace AIMaid.Core;

public sealed record ProactiveBroadcastCandidate(
    string SourceKey,
    string DisplayName,
    int Priority,
    int Score,
    int ChangeScore,
    bool Changed,
    string SnapshotHash,
    string Reason,
    string Snapshot);

public sealed record ProactiveBroadcastContext(
    IReadOnlyList<ProactiveBroadcastCandidate> Candidates,
    IReadOnlyList<string> RecentMessages)
{
    public string SelectedSourceKeys => string.Join(',', Candidates.Select(candidate => candidate.SourceKey));
}

public interface IProactiveBroadcastContextService
{
    Task InitializeDefaultsAsync(CancellationToken cancellationToken = default);
    Task<IReadOnlyList<ProactiveSourceDto>> ListAsync(CancellationToken cancellationToken = default);
    Task<OperationResult<ProactiveSourceDto>> UpdateAsync(
        string sourceKey,
        bool? enabled,
        int? cooldownMinutes,
        CancellationToken cancellationToken = default);
    Task<ProactiveBroadcastContext> CollectDueAsync(
        ActivitySnapshot desktop,
        string currentImage,
        string currentRoleId,
        CancellationToken cancellationToken = default);
    Task<ProactiveBroadcastContext> CollectSingleAsync(
        string sourceKey,
        ActivitySnapshot desktop,
        string currentImage,
        string currentRoleId,
        CancellationToken cancellationToken = default);
    Task<bool> TryMarkBroadcastResultAsync(
        string sourceKeys,
        string message,
        CancellationToken cancellationToken = default);
    Task<bool> IsDuplicateBroadcastAsync(
        string sourceKeys,
        string message,
        CancellationToken cancellationToken = default);
    Task<string> CreateTriggerLogAsync(
        string eventId,
        string eventType,
        string eventSource,
        string roleId,
        string roleDisplayName,
        string voiceId,
        string aiProvider,
        ActivitySnapshot desktop,
        ProactiveBroadcastContext context,
        IReadOnlyDictionary<string, string> payload,
        string reason,
        CancellationToken cancellationToken = default);
    Task CompleteTriggerLogAsync(
        string triggerLogId,
        bool responded,
        bool spoke,
        string message,
        string voiceTrigger,
        string audioPath,
        string result,
        CancellationToken cancellationToken = default);
}
