namespace AIMaid.Contracts;

public interface ICommand<out TResult>;
public interface IQuery<out TResult>;
public interface IBusinessEvent
{
    string EventId { get; }
    DateTimeOffset OccurredAt { get; }
}

public interface ICommandHandler<in TCommand, TResult> where TCommand : ICommand<TResult>
{
    Task<TResult> HandleAsync(TCommand command, CancellationToken cancellationToken = default);
}

public interface IQueryHandler<in TQuery, TResult> where TQuery : IQuery<TResult>
{
    Task<TResult> HandleAsync(TQuery query, CancellationToken cancellationToken = default);
}

public sealed record OperationResult(bool Succeeded, string? ErrorCode = null, string? ErrorMessage = null)
{
    public static OperationResult Success() => new(true);
    public static OperationResult Failure(string code, string message) => new(false, code, message);
}

public sealed record OperationResult<T>(bool Succeeded, T? Value, string? ErrorCode = null, string? ErrorMessage = null)
{
    public static OperationResult<T> Success(T value) => new(true, value);
    public static OperationResult<T> Failure(string code, string message) => new(false, default, code, message);
}
