using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AIMaid.Core;

/// <summary>Canonicalizes JSON stored or embedded by AIMaid without changing ordinary text fields.</summary>
public static class JsonTextCanonicalizer
{
    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, JsonConfig.Persistence);

    public static string NormalizeObject(string json, string fieldName, bool decodeLiteralUnicodeEscapes = false)
    {
        var node = ParseRequired(json, fieldName);
        if (node is not JsonObject)
            throw new InvalidDataException($"{fieldName} 必须是 JSON 对象。");
        if (decodeLiteralUnicodeEscapes) DecodeStrings(node, fieldName);
        return node.ToJsonString(JsonConfig.Persistence);
    }

    public static string NormalizeObjectOrArray(string json, string fieldName, bool decodeLiteralUnicodeEscapes = false)
    {
        var node = ParseRequired(json, fieldName);
        if (node is not JsonObject and not JsonArray)
            throw new InvalidDataException($"{fieldName} 必须是 JSON 对象或数组。");
        if (decodeLiteralUnicodeEscapes) DecodeStrings(node, fieldName);
        return node.ToJsonString(JsonConfig.Persistence);
    }

    public static string NormalizeOptionalObjectOrArray(string? json, string fieldName, bool decodeLiteralUnicodeEscapes = false)
        => string.IsNullOrWhiteSpace(json) ? string.Empty : NormalizeObjectOrArray(json, fieldName, decodeLiteralUnicodeEscapes);

    public static string NormalizeGeneratedObject(string raw, string fieldName)
    {
        if (raw is null) throw new InvalidDataException($"{fieldName} 不能为空。");
        var json = StripFence(raw);
        var node = ParseRequired(json, fieldName);
        if (node is not JsonObject)
            throw new InvalidDataException($"{fieldName} 必须是 JSON 对象。");
        DecodeStrings(node, fieldName);
        return node.ToJsonString(JsonConfig.Persistence);
    }

    private static JsonNode ParseRequired(string json, string fieldName)
    {
        if (string.IsNullOrWhiteSpace(json)) throw new InvalidDataException($"{fieldName} 不能为空。");
        try { return JsonNode.Parse(json) ?? throw new InvalidDataException($"{fieldName} 不能为空。"); }
        catch (JsonException exception) { throw new InvalidDataException($"{fieldName} 不是有效 JSON。", exception); }
    }

    private static string StripFence(string value)
    {
        var trimmed = value.Trim();
        if (!trimmed.StartsWith("```", StringComparison.Ordinal)) return trimmed;
        var firstNewline = trimmed.IndexOf('\n');
        if (firstNewline < 0 || !trimmed.EndsWith("```", StringComparison.Ordinal))
            throw new InvalidDataException("结构化 JSON Markdown fence 不完整。");
        var language = trimmed[3..firstNewline].Trim();
        if (language.Length != 0 && !language.Equals("json", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("结构化响应 fence 必须标识为 JSON。");
        return trimmed[(firstNewline + 1)..^3].Trim();
    }

    private static void DecodeStrings(JsonNode node, string fieldName)
    {
        if (node is JsonObject obj)
        {
            foreach (var property in obj.ToList())
            {
                if (property.Value is JsonObject or JsonArray)
                    DecodeStrings(property.Value, fieldName);
                else if (property.Value is not null)
                    obj[property.Key] = DecodeNode(property.Value, fieldName);
            }
            return;
        }
        if (node is JsonArray array)
        {
            for (var i = 0; i < array.Count; i++)
            {
                if (array[i] is JsonObject or JsonArray)
                    DecodeStrings(array[i]!, fieldName);
                else if (array[i] is not null)
                    array[i] = DecodeNode(array[i]!, fieldName);
            }
        }
    }

    private static JsonNode DecodeNode(JsonNode node, string fieldName)
    {
        if (node is JsonValue value && value.TryGetValue<string>(out var text))
            return JsonValue.Create(DecodeLiteralUnicodeEscapes(text, fieldName))!;
        return node;
    }

    private static string DecodeLiteralUnicodeEscapes(string value, string fieldName)
    {
        var builder = new StringBuilder(value.Length);
        for (var index = 0; index < value.Length; index++)
        {
            if (value[index] != '\\' || index + 1 >= value.Length || value[index + 1] != 'u') { builder.Append(value[index]); continue; }
            if (index + 5 >= value.Length || !TryCodeUnit(value.AsSpan(index + 2, 4), out var codeUnit))
                throw new InvalidDataException($"{fieldName} 包含残缺的 Unicode 转义。");
            index += 5;
            if (char.IsHighSurrogate((char)codeUnit))
            {
                if (index + 6 >= value.Length || value[index + 1] != '\\' || value[index + 2] != 'u' ||
                    !TryCodeUnit(value.AsSpan(index + 3, 4), out var low) || !char.IsLowSurrogate((char)low))
                    throw new InvalidDataException($"{fieldName} 包含无效的 Unicode 代理项。");
                builder.Append(char.ConvertFromUtf32(char.ConvertToUtf32((char)codeUnit, (char)low)));
                index += 6;
            }
            else if (char.IsLowSurrogate((char)codeUnit))
                throw new InvalidDataException($"{fieldName} 包含无效的 Unicode 代理项。");
            else builder.Append((char)codeUnit);
        }
        return builder.ToString();
    }

    private static bool TryCodeUnit(ReadOnlySpan<char> value, out ushort codeUnit)
        => ushort.TryParse(value, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out codeUnit);
}
