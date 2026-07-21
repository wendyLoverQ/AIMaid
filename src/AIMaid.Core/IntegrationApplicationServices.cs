using AIMaid.Contracts;
using AIMaid.Contracts.Integrations;
using AIMaid.Contracts.Tasks;

namespace AIMaid.Core;

public sealed class ComfyUiApplicationService : ICommandHandler<GenerateImageCommand, OperationResult<string>>
{
    private readonly IComfyUiClient client;
    public ComfyUiApplicationService(IComfyUiClient client) => this.client = client;

    public async Task<OperationResult<string>> HandleAsync(GenerateImageCommand command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.WorkflowJson))
            return OperationResult<string>.Failure("comfyui.workflow_empty", "ComfyUI workflow 不能为空。");
        var promptId = await client.QueueWorkflowAsync(command.WorkflowJson, command.Inputs, cancellationToken);
        // TODO(UI): UI 订阅对应任务事件展示队列、生成进度、预览图和失败详情。
        return OperationResult<string>.Success(promptId);
    }
}

public sealed class SpeechApplicationService :
    ICommandHandler<SpeakTextCommand, OperationResult<string>>,
    ICommandHandler<TranscribeAudioCommand, OperationResult<string>>
{
    private readonly ITtsClient tts;
    private readonly IAsrClient asr;
    private readonly IEventPublisher events;
    public SpeechApplicationService(ITtsClient tts, IAsrClient asr, IEventPublisher events)
    {
        this.tts = tts;
        this.asr = asr;
        this.events = events;
    }

    public async Task<OperationResult<string>> HandleAsync(SpeakTextCommand command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.Text))
            return OperationResult<string>.Failure("tts.text_empty", "合成文本不能为空。");
        var requestId = $"tts_{Guid.NewGuid():N}";
        var path = await tts.SynthesizeAsync(command.Text, command.VoiceId, command.Style, cancellationToken);
        await events.PublishAsync(new Contracts.Domains.TtsAudioReadyEvent(
            EventIdentity.NewId(), DateTimeOffset.Now, requestId, path, command.Text,
            command.VoiceId ?? string.Empty, command.Style), cancellationToken);
        // TODO(UI): Electron 维护播放队列，并用音频开始/结束状态同步 Live2D 口型；核心不负责播放器。
        return OperationResult<string>.Success(path);
    }

    public async Task<OperationResult<string>> HandleAsync(TranscribeAudioCommand command, CancellationToken cancellationToken = default)
        => !File.Exists(command.AudioPath)
            ? OperationResult<string>.Failure("asr.file_missing", "音频文件不存在。")
            : OperationResult<string>.Success(await asr.TranscribeAsync(command.AudioPath, cancellationToken));
}

public sealed class FileApplicationService :
    ICommandHandler<MoveFileCommand, OperationResult>,
    ICommandHandler<DeleteFileCommand, OperationResult>
{
    private readonly IFileManager files;
    public FileApplicationService(IFileManager files) => this.files = files;

    public async Task<OperationResult> HandleAsync(MoveFileCommand command, CancellationToken cancellationToken = default)
    {
        // TODO(UI): SourcePath/DestinationPath 由 UI 的文件选择器提供；覆盖已有文件前 UI 必须明确确认。
        await files.MoveAsync(command.SourcePath, command.DestinationPath, command.Overwrite, cancellationToken);
        return OperationResult.Success();
    }

    public async Task<OperationResult> HandleAsync(DeleteFileCommand command, CancellationToken cancellationToken = default)
    {
        // TODO(UI): 删除属于破坏性操作，UI 必须展示精确路径并取得用户确认后才能发送此 Command。
        await files.DeleteAsync(command.Path, cancellationToken);
        return OperationResult.Success();
    }
}

public sealed class MediaApplicationService : ICommandHandler<LaunchMediaCommand, OperationResult<int>>
{
    private readonly IExternalMediaController controller;
    public MediaApplicationService(IExternalMediaController controller) => this.controller = controller;
    public async Task<OperationResult<int>> HandleAsync(LaunchMediaCommand command, CancellationToken cancellationToken = default)
        => OperationResult<int>.Success(await controller.LaunchAsync(command.MediaPathOrUrl, command.SubtitlePath, cancellationToken));
}

public sealed class DownloadApplicationService : ICommandHandler<StartDownloadCommand, OperationResult<string>>
{
    private readonly IDownloadClient downloader;
    private readonly IBackgroundTaskStore tasks;
    private readonly TaskApplicationService taskRuntime;
    private readonly IEventPublisher events;

    public DownloadApplicationService(IDownloadClient downloader, IBackgroundTaskStore tasks, TaskApplicationService taskRuntime, IEventPublisher events)
    {
        this.downloader = downloader;
        this.tasks = tasks;
        this.taskRuntime = taskRuntime;
        this.events = events;
    }

    public async Task<OperationResult<string>> HandleAsync(StartDownloadCommand command, CancellationToken cancellationToken = default)
    {
        if (!Uri.TryCreate(command.Url, UriKind.Absolute, out _))
            return OperationResult<string>.Failure("download.invalid_url", "下载地址无效。");
        if (string.IsNullOrWhiteSpace(command.TargetDirectory))
            return OperationResult<string>.Failure("download.target_required", "下载目录必须由调用方明确提供。");

        var taskId = $"download_{Guid.NewGuid():N}";
        var now = DateTimeOffset.Now;
        await tasks.UpsertAsync(new BackgroundTaskDto(taskId, "download", BackgroundTaskState.Queued, 0,
            "等待下载", string.Empty, string.Empty, now, now), cancellationToken);
        var taskToken = taskRuntime.Register(taskId, cancellationToken);
        _ = RunAsync(taskId, command, taskToken);
        return OperationResult<string>.Success(taskId);
    }

    private async Task RunAsync(string taskId, StartDownloadCommand command, CancellationToken cancellationToken)
    {
        var createdAt = DateTimeOffset.Now;
        try
        {
            var progress = new Progress<(double Progress, string Message)>(value =>
                _ = ReportProgressAsync(taskId, createdAt, value.Progress, value.Message, CancellationToken.None));
            var path = await downloader.DownloadAsync(taskId, command.Url, command.TargetDirectory!, command.FileName, progress, cancellationToken);
            var completed = new BackgroundTaskDto(taskId, "download", BackgroundTaskState.Completed, 1, "下载完成",
                path, string.Empty, createdAt, DateTimeOffset.Now);
            await tasks.UpsertAsync(completed, CancellationToken.None);
            await events.PublishAsync(new TaskCompletedEvent(EventIdentity.NewId(), DateTimeOffset.Now, taskId, "download", path));
        }
        catch (Exception ex)
        {
            var state = ex is OperationCanceledException ? BackgroundTaskState.Cancelled : BackgroundTaskState.Failed;
            await tasks.UpsertAsync(new BackgroundTaskDto(taskId, "download", state, 0, state.ToString(), string.Empty,
                ex.Message, createdAt, DateTimeOffset.Now), CancellationToken.None);
            await events.PublishAsync(new TaskFailedEvent(EventIdentity.NewId(), DateTimeOffset.Now, taskId, "download", ex.Message));
        }
        finally
        {
            taskRuntime.Complete(taskId);
        }
    }

    private async Task ReportProgressAsync(string taskId, DateTimeOffset createdAt, double progress, string message, CancellationToken cancellationToken)
    {
        var normalized = Math.Clamp(progress, 0, 1);
        await tasks.UpsertAsync(new BackgroundTaskDto(taskId, "download", BackgroundTaskState.Running, normalized,
            message, string.Empty, string.Empty, createdAt, DateTimeOffset.Now), cancellationToken);
        await events.PublishAsync(new TaskProgressEvent(EventIdentity.NewId(), DateTimeOffset.Now, taskId, "download", normalized, message), cancellationToken);
    }
}
