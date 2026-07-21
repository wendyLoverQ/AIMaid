namespace AIMaid.Contracts.Tasks;

public enum BackgroundTaskState
{
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled
}

public sealed record BackgroundTaskDto(
    string TaskId,
    string TaskType,
    BackgroundTaskState State,
    double Progress,
    string Message,
    string ResultJson,
    string Error,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

public sealed record GetTaskStatusQuery(string TaskId) : IQuery<BackgroundTaskDto?>;
public sealed record ListTasksQuery(string? TaskType = null, int Limit = 100) : IQuery<IReadOnlyList<BackgroundTaskDto>>;
public sealed record CancelTaskCommand(string TaskId) : ICommand<OperationResult>;

public sealed record TaskProgressEvent(
    string EventId,
    DateTimeOffset OccurredAt,
    string TaskId,
    string TaskType,
    double Progress,
    string Message) : IBusinessEvent;

public sealed record TaskCompletedEvent(
    string EventId,
    DateTimeOffset OccurredAt,
    string TaskId,
    string TaskType,
    string ResultJson) : IBusinessEvent;

public sealed record TaskFailedEvent(
    string EventId,
    DateTimeOffset OccurredAt,
    string TaskId,
    string TaskType,
    string Error) : IBusinessEvent;
