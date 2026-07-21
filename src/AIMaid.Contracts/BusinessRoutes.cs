namespace AIMaid.Contracts;

public static class BusinessRoutes
{
    public const string ChatSend = "chat.send";
    public const string ChatHistory = "chat.history";
    public const string CharacterList = "character.list";
    public const string CharacterUpdate = "character.update";
    public const string SettingsGet = "settings.get";
    public const string SettingsSave = "settings.save";
    public const string TaskStatus = "task.status";
    public const string ComfyUiGenerate = "comfyui.generate";
    public const string DownloadStart = "download.start";
    public const string TtsSpeak = "tts.speak";
    public const string AsrTranscribe = "asr.transcribe";
    public const string FileMove = "file.move";
    public const string FileDelete = "file.delete";
    public const string MediaLaunch = "media.launch";

    public const string ChatDelta = "chat.delta";
    public const string TaskProgress = "task.progress";
    public const string TaskCompleted = "task.completed";
    public const string DownloadProgress = "download.progress";
    public const string ErrorOccurred = "error.occurred";
}
