using System.Text.Json;
using System.Text.Json.Serialization;

namespace AIMaid.CoreHost.Protocol;

public static class ProtocolConstants
{
    public const string Version = "1.0";
}

public static class ProtocolRequestRegistry
{
    public static readonly string[] InternalRequests = ["system.handshake"];
    public static readonly string[] ControlRequests = ["system.cancel", "system.shutdown"];
    public static readonly string[] PublicRequests =
    [
        "system.health", "system.window.fit_virtual_desktop", "system.window.center_on_client_rect", "system.stream", "settings.get", "settings.save", "chat.history", "chat.send", "chat.update_metadata", "tts.speak", "asr.transcribe",
        "reminder.list", "reminder.save", "reminder.delete", "reminder.set_enabled", "reminder.set_allow_tts", "reminder.process_due",
        "character.list", "character.set_current", "character.save", "character.delete", "character.voice_assets", "character.voice_asset.add", "character.avatar.import", "character.voices", "character.voices.set", "character.binding.get", "character.binding.set", "character.binding.clear", "character.template.generate",
        "agent.capabilities.list", "agent.capability.save", "agent.execute", "agent.decide",
        "pet.voice_menu.get", "pet.voice_intimacy.cycle", "pet.voice_cache.clear", "pet.voice_cache.ensure", "pet.voice.play", "pet.voice.playback.report", "music.current", "music.search_and_play", "music.toggle_pause", "music.stop", "market.symbols", "market.snapshot", "market.chart_snapshot", "market.list", "market.record", "status.resources", "status.network", "status.role", "status.tts", "status.llm_latencies", "status.server.health", "status.server.summary", "status.codex_quota", "tts.playback.set",
        "notebook.list", "notebook.save", "notebook.delete", "video.list", "video.import_file", "video.import_folder", "video.refresh_metadata",
        "video.toggle_favorite", "video.set_display_name", "video.set_remark", "video.update_progress",
        "video.album.create", "video.album.rename", "video.album.delete", "video.album.move",
        "video.tag.create", "video.tag.rename", "video.tag.delete", "video.tag.set",
        "video.remove_records", "video.delete_local_files", "video.play", "video.dependencies",
        "subtitle.list", "subtitle.import", "subtitle.import_folder", "subtitle.delete",
        "vault.list", "vault.get", "vault.secret.reveal", "vault.save", "vault.delete", "vault.history.list", "vault.history.restore", "vault.export",
        "voice_conversation.list", "voice_conversation.save", "voice_conversation.delete",
        "script.list", "script.save", "script.run",
        "timer_record.list", "timer_record.save", "timer_record.delete",
        "remote_site.list", "remote_site.get", "remote_site.save", "remote_site.delete",
        "remote_video.resolve", "remote_video.thumbnail", "remote_video.formats", "remote_video.play",
        "remote_video.download.start", "remote_video.download.cancel", "remote_video.download.list", "remote_video.download.delete", "remote_video.download.play",
        "remote_video.play.list", "remote_video.play.replay",
        "remote_video.settings.get", "remote_video.settings.save", "remote_video.diagnostics",
        "crypto_provider.get", "crypto_provider.save", "crypto_provider.check",
        "appearance.get", "appearance.save", "disturbance_settings.get", "disturbance_settings.save",
        "model.list", "model.save", "model.add", "business_model.list", "business_model.save", "source_prompt.list", "source_prompt.save"
    ];

    public static readonly IReadOnlySet<string> AllRequests = new HashSet<string>(
        InternalRequests.Concat(ControlRequests).Concat(PublicRequests), StringComparer.Ordinal);

    // Capabilities retain the previously advertised control requests for backward compatibility.
    public static readonly string[] Capabilities = PublicRequests.Concat(ControlRequests).ToArray();

    public static bool IsRegistered(string requestType) => AllRequests.Contains(requestType);
}

public sealed record ProtocolRequest(
    string ProtocolVersion,
    string Id,
    string Kind,
    string Type,
    DateTimeOffset Timestamp,
    JsonElement Payload);

public sealed record ProtocolError(string Code, string Message, IReadOnlyDictionary<string, object?> Details);

public sealed record ProtocolResponse(
    string ProtocolVersion,
    string Id,
    string Kind,
    string Type,
    DateTimeOffset Timestamp,
    bool Success,
    object? Payload,
    ProtocolError? Error);

public sealed record ProtocolEvent(
    string ProtocolVersion,
    string Id,
    string Kind,
    string Type,
    DateTimeOffset Timestamp,
    string? CorrelationId,
    long Sequence,
    object? Payload);

[JsonSerializable(typeof(ProtocolRequest))]
[JsonSerializable(typeof(ProtocolResponse))]
[JsonSerializable(typeof(ProtocolEvent))]
internal partial class ProtocolJsonContext : JsonSerializerContext;
