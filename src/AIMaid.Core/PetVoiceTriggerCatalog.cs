namespace AIMaid.Core;

/// <summary>The sole, versioned source of cacheable desktop-pet voice slots.</summary>
public static class PetVoiceTriggerCatalog
{
    public const string Version = "pet_voice_trigger_catalog_v2";
    public const string BodyPartRecognitionVersion = "live2d_hit_area_v1";

    public static readonly IReadOnlyList<PetVoiceTriggerPlan> Plans =
    [
        new("startup.welcome", "startup", "default", "soft"),
        new("click", "click", "head", "close"), new("click", "click", "hair", "close"),
        new("click", "click", "face", "close"), new("click", "click", "chest", "close"),
        new("click", "click", "body", "lively"), new("click", "click", "hand", "lively"),
        new("click", "click", "leg", "lively"), new("click", "click", "foot", "lively")
    ];

    public static bool Contains(string triggerId, string bodyPart) => Plans.Any(x =>
        x.TriggerId.Equals(triggerId, StringComparison.OrdinalIgnoreCase) &&
        x.BodyPart.Equals(bodyPart, StringComparison.OrdinalIgnoreCase));

    public static string Key(string triggerId, string bodyPart) =>
        bodyPart.Equals("default", StringComparison.OrdinalIgnoreCase) ? triggerId : $"{triggerId}|{bodyPart}";
}

public sealed record PetVoiceTriggerPlan(string TriggerId, string Category, string BodyPart, string SuggestedStyle)
{
    public string Key => PetVoiceTriggerCatalog.Key(TriggerId, BodyPart);
}
