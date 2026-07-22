namespace AIMaid.Contracts.Status;

public sealed record SystemResourceSnapshotDto(
    double CpuPercent,
    double? GpuPercent,
    double WorkingSetMb,
    double ManagedMemoryMb);

public sealed record NetworkProbeDto(string Name, long? LatencyMs, bool Success);

public sealed record TtsRuntimeStatusDto(
    bool Online,
    int PendingSynthesisCount,
    int PendingPlaybackCount,
    double LastLatencyMs);

public sealed record StatusRoleStateDto(
    string RoleId,
    string RoleName,
    string VoiceName,
    int IntimacyLevel,
    string IntimacyLabel,
    int VoiceCacheTotal,
    int VoiceCacheCompleted,
    bool HasMaidState,
    string MaidMoodText,
    int MaidFavorability,
    string MaidCompanionshipText,
    int MaidInteractionCount,
    string MaidLastInteractionText);

public sealed record ServerCapacityMetricDto(long UsedBytes, long TotalBytes);
public sealed record ServerMonitorSummaryDto(
    ServerCapacityMetricDto? Memory,
    ServerCapacityMetricDto? Disk,
    ServerCapacityMetricDto? Traffic);
public sealed record ServerHealthSnapshotDto(bool TencentCloud, bool Aws);
public sealed record ServerSummarySnapshotDto(ServerMonitorSummaryDto? TencentCloud, ServerMonitorSummaryDto? Aws);

public sealed record CodexQuotaWindowDto(string Label, double RemainingPercent, string ResetsAt);
public sealed record CodexQuotaSnapshotDto(
    bool LoggedIn,
    string Account,
    string Plan,
    string UpdatedAt,
    CodexQuotaWindowDto? Primary,
    CodexQuotaWindowDto? Secondary,
    string? Credits,
    string? Error);
public sealed record LlmLatencySnapshotDto(int? ChatLatencyMs, int? CacheLatencyMs, int? ProactiveLatencyMs);

public sealed record StatusRuntimeSnapshotDto(
    SystemResourceSnapshotDto Resources,
    IReadOnlyList<NetworkProbeDto> Network);
