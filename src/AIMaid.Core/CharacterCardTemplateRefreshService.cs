namespace AIMaid.Core;

public sealed class CharacterCardTemplateRefreshService : IAsyncDisposable
{
    private static readonly TimeSpan RefreshCheckInterval = TimeSpan.FromMinutes(15);
    private readonly TemplateCardApplicationService templateCards;
    private readonly Action<string, Exception?> log;
    private readonly CancellationTokenSource stopSource = new();
    private Task? loopTask;

    public CharacterCardTemplateRefreshService(
        TemplateCardApplicationService templateCards,
        Action<string, Exception?> log)
    {
        this.templateCards = templateCards;
        this.log = log;
    }

    public Task StartAsync()
    {
        if (loopTask is not null)
            throw new InvalidOperationException("角色模板刷新服务已经启动。");
        loopTask = RunAsync();
        return Task.CompletedTask;
    }

    public async Task StopAsync()
    {
        stopSource.Cancel();
        if (loopTask is not null)
            await loopTask;
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        stopSource.Dispose();
    }

    private async Task RunAsync()
    {
        using var timer = new PeriodicTimer(RefreshCheckInterval);
        while (true)
        {
            await RefreshOnceAsync(stopSource.Token);
            if (!await timer.WaitForNextTickAsync(stopSource.Token))
                return;
        }
    }

    private async Task RefreshOnceAsync(CancellationToken cancellationToken)
    {
        try
        {
            var result = await templateCards.RefreshCurrentRoleAsync(cancellationToken);
            if (!result.Succeeded)
                log(result.ErrorMessage ?? "角色模板自动刷新失败。", null);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            log("角色模板自动刷新执行失败。", exception);
        }
    }
}
