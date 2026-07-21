using AIMaid.Contracts;
using AIMaid.Contracts.Tasks;

namespace AIMaid.Core;

public sealed class TaskApplicationService :
    IQueryHandler<GetTaskStatusQuery, BackgroundTaskDto?>,
    IQueryHandler<ListTasksQuery, IReadOnlyList<BackgroundTaskDto>>,
    ICommandHandler<CancelTaskCommand, OperationResult>
{
    private readonly IBackgroundTaskStore store;
    private readonly Dictionary<string, CancellationTokenSource> activeTasks = new(StringComparer.Ordinal);
    private readonly object syncRoot = new();

    public TaskApplicationService(IBackgroundTaskStore store) => this.store = store;

    public Task<BackgroundTaskDto?> HandleAsync(GetTaskStatusQuery query, CancellationToken cancellationToken = default)
        => store.GetAsync(query.TaskId, cancellationToken);

    public Task<IReadOnlyList<BackgroundTaskDto>> HandleAsync(ListTasksQuery query, CancellationToken cancellationToken = default)
        => store.ListAsync(query.TaskType, Math.Clamp(query.Limit, 1, 500), cancellationToken);

    public async Task<OperationResult> HandleAsync(CancelTaskCommand command, CancellationToken cancellationToken = default)
    {
        CancellationTokenSource? source;
        lock (syncRoot) activeTasks.TryGetValue(command.TaskId, out source);
        if (source is null) return OperationResult.Failure("task.not_running", "任务不存在或已经结束。");
        await source.CancelAsync();
        // TODO(UI): 取消按钮应进入“正在取消”状态，等待 task.completed/task.failed 最终事件，不能立即假装完成。
        return OperationResult.Success();
    }

    public CancellationToken Register(string taskId, CancellationToken parent)
    {
        var source = CancellationTokenSource.CreateLinkedTokenSource(parent);
        lock (syncRoot)
        {
            if (!activeTasks.TryAdd(taskId, source))
            {
                source.Dispose();
                throw new InvalidOperationException($"任务已注册：{taskId}");
            }
        }
        return source.Token;
    }

    public void Complete(string taskId)
    {
        CancellationTokenSource? source = null;
        lock (syncRoot)
        {
            if (activeTasks.Remove(taskId, out var removed)) source = removed;
        }
        source?.Dispose();
    }
}
