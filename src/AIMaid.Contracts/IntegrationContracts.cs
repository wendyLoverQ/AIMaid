namespace AIMaid.Contracts.Integrations;

public sealed record GenerateImageCommand(string WorkflowJson, IReadOnlyDictionary<string, string> Inputs)
    : ICommand<OperationResult<string>>;

public sealed record StartDownloadCommand(string Url, string? TargetDirectory = null, string? FileName = null)
    : ICommand<OperationResult<string>>;

public sealed record SpeakTextCommand(string Text, string? VoiceId = null, string Style = "normal")
    : ICommand<OperationResult<string>>;

public sealed record TranscribeAudioCommand(
    string AudioPath,
    string CharacterId,
    string? SessionId = null,
    string Language = "zh",
    string? RequestId = null) : ICommand<OperationResult<string>>;

public sealed record MoveFileCommand(string SourcePath, string DestinationPath, bool Overwrite = false)
    : ICommand<OperationResult>;

public sealed record DeleteFileCommand(string Path) : ICommand<OperationResult>;

public sealed record LaunchMediaCommand(string MediaPathOrUrl, string? SubtitlePath = null)
    : ICommand<OperationResult<int>>;

public sealed record ExternalOperationProgressEvent(
    string EventId,
    DateTimeOffset OccurredAt,
    string OperationId,
    string OperationType,
    double Progress,
    string Message) : IBusinessEvent;

public sealed record ErrorOccurredEvent(
    string EventId,
    DateTimeOffset OccurredAt,
    string Source,
    string Code,
    string Message,
    bool IsUserActionRequired) : IBusinessEvent;
