using AIMaid.Contracts;

namespace AIMaid.Core;

public sealed class InProcessEventPublisher : IEventPublisher
{
    public event EventHandler<IBusinessEvent>? EventPublished;

    public ValueTask PublishAsync(IBusinessEvent businessEvent, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        EventPublished?.Invoke(this, businessEvent);
        return ValueTask.CompletedTask;
    }
}

public static class EventIdentity
{
    public static string NewId() => $"evt_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid():N}"[..38];
}
