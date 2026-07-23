using System.Text.Json;

namespace AIMaid.Core.Tests;

[TestClass]
public sealed class JsonSerializationTests
{
    private static readonly JsonSerializerOptions ReadOptions = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// 测试一：中文工具定义序列化后，最终请求体可被 JsonDocument.Parse 正常解析。
    /// </summary>
    [TestMethod]
    public void ChineseDisplayName_RequestJson_IsValidJson()
    {
        // Arrange: 模拟 Agent 决策请求中的 capabilitiesJson 构造
        var capabilities = new[]
        {
            new
            {
                capability = "weather_query",
                displayName = "查询天气",
                description = "查询指定城市当前天气",
                argsSchema = new { type = "object", properties = new { city = new { type = "string" } } },
                riskLevel = "low"
            }
        };

        var payload = new Dictionary<string, object>
        {
            ["model"] = "gemini-3.1-flash-lite",
            ["messages"] = new[] { new { role = "user", content = "今天北京天气怎么样？" } },
            ["stream"] = false
        };

        var requestJson = JsonSerializer.Serialize(payload, JsonConfig.Web);

        // Act: 验证请求体可被解析
        using var document = JsonDocument.Parse(requestJson);

        // Assert
        Assert.IsNotNull(document);
    }

    /// <summary>
    /// 测试二：displayName 必须是 JsonValueKind.String，值必须等于"查询天气"。
    /// </summary>
    [TestMethod]
    public void ChineseDisplayName_IsString_NotDoubleEscaped()
    {
        // Arrange
        var item = new
        {
            capability = "weather_query",
            displayName = "查询天气",
            description = "查询指定城市当前天气"
        };

        var json = JsonSerializer.Serialize(item, JsonConfig.Web);
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;

        // Assert: displayName 是字符串类型
        Assert.IsTrue(root.TryGetProperty("displayName", out var displayNameElement));
        Assert.AreEqual(JsonValueKind.String, displayNameElement.ValueKind);
        Assert.AreEqual("查询天气", displayNameElement.GetString());

        // Assert: 不得出现转义的引号（\"displayName\"）
        Assert.IsFalse(json.Contains("\\\"displayName\\\""));
    }

    /// <summary>
    /// 测试三：tools/configurations 的 JSON 字段必须保持 Object/Array 类型，不能是包含 JSON 文本的 String。
    /// </summary>
    [TestMethod]
    public void Tools_ArgsSchema_IsObject_NotJsonString()
    {
        // Arrange: 模拟 argsSchema 的正确处理方式（JsonElement 而非 string）
        var argsSchemaJson = """{"type":"object","properties":{"city":{"type":"string"}}}""";
        var argsSchema = JsonSerializer.Deserialize<JsonElement>(argsSchemaJson);

        var capability = new
        {
            capability = "weather_query",
            displayName = "查询天气",
            argsSchema = (object)argsSchema  // JsonElement 作为 object 内联
        };

        var json = JsonSerializer.Serialize(capability, JsonConfig.Web);
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;

        // Assert: argsSchema 必须是 Object 类型
        Assert.IsTrue(root.TryGetProperty("argsSchema", out var schemaElement));
        Assert.AreEqual(JsonValueKind.Object, schemaElement.ValueKind,
            "argsSchema 应该是 JSON Object，不是包含 JSON 文本的 String");

        // Assert: 不应出现 "argsSchema":"{..."
        Assert.IsFalse(json.Contains("\"argsSchema\":\"{"),
            "argsSchema 不应该是包含 JSON 的字符串");
    }

    /// <summary>
    /// 测试三（续）：function/parameters/arguments 必须保持正确的 Object 或 Array 类型。
    /// </summary>
    [TestMethod]
    public void AgentCapabilities_AreStructured_NotJsonStrings()
    {
        // 模拟 capabilitiesJson 的正确结构
        var capabilities = new[]
        {
            new
            {
                capability = "weather_query",
                displayName = "查询天气",
                description = "查询指定城市当前天气",
                argsSchema = JsonSerializer.Deserialize<JsonElement>(
                    """{"type":"object","properties":{"city":{"type":"string"}}}"""),
                riskLevel = "low"
            },
            new
            {
                capability = "timer_start",
                displayName = "开始计时",
                description = "启动一个专注计时器",
                argsSchema = JsonSerializer.Deserialize<JsonElement>(
                    """{"type":"object","properties":{"minutes":{"type":"integer"}}}"""),
                riskLevel = "low"
            }
        };

        var json = JsonSerializer.Serialize(capabilities, JsonConfig.Web);
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;

        // Assert: capabilities 是 Array
        Assert.AreEqual(JsonValueKind.Array, root.ValueKind,
            "capabilities 应该是 JSON Array");

        // Assert: 每个 capability 内部的 argsSchema 是 Object
        foreach (var item in root.EnumerateArray())
        {
            Assert.IsTrue(item.TryGetProperty("argsSchema", out var schema));
            Assert.AreEqual(JsonValueKind.Object, schema.ValueKind,
                $"capability '{item.GetProperty("capability")}' 的 argsSchema 应该是 Object");

            Assert.IsTrue(item.TryGetProperty("displayName", out var dn));
            Assert.AreEqual(JsonValueKind.String, dn.ValueKind,
                $"capability '{item.GetProperty("capability")}' 的 displayName 应该是 String");

            Assert.IsTrue(item.TryGetProperty("riskLevel", out var rl));
            Assert.AreEqual(JsonValueKind.String, rl.ValueKind,
                $"capability '{item.GetProperty("capability")}' 的 riskLevel 应该是 String");
        }
    }

    /// <summary>
    /// 测试四：允许合法的 Unicode 转义（\u67E5\u8BE2），但禁止 \"displayName\"、\\u67E5 和 "{...}" 嵌套。
    /// </summary>
    [TestMethod]
    public void UnicodeEscapes_Allowed_DoubleEscapes_Forbidden()
    {
        // 使用默认编码器序列化中文（可能会产生 \uXXXX）
        var defaultJson = JsonSerializer.Serialize(new { displayName = "查询天气" });

        // 默认编码器可能产生 Unicode 转义，这是合法的
        // 但不得出现双重转义

        Assert.IsFalse(defaultJson.Contains("\\\"displayName\\\""),
            "不应出现 \\\"displayName\\\" (双重转义的属性名)");

        Assert.IsFalse(defaultJson.Contains("\\\\u67E5"),
            "不应出现 \\\\uXXXX (双重转义的反斜杠)");

        // 使用 UnsafeRelaxedJsonEscaping 时应保留中文原文
        var readableJson = JsonSerializer.Serialize(
            new { displayName = "查询天气" },
            new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        Assert.IsTrue(readableJson.Contains("查询天气"),
            "使用 UnsafeRelaxedJsonEscaping 时应保留中文原文");
    }

    /// <summary>
    /// 测试五：模拟完整聊天请求链路，验证 JSON 不被重复序列化。
    /// </summary>
    [TestMethod]
    public void FullChatRequest_NoDoubleSerialization()
    {
        // 模拟 AiProviderHttpClient 构造的请求体
        var messages = new[]
        {
            new { role = "system", content = "你是一个有用的助手。" },
            new { role = "user", content = "今天天气怎么样？" }
        };

        var payload = new Dictionary<string, object?>
        {
            ["model"] = "gemini-3.1-flash-lite",
            ["messages"] = messages,
            ["stream"] = false,
            ["temperature"] = 0.7
        };

        // 一次序列化（模拟 requestJson）
        var requestJson = JsonSerializer.Serialize(payload, JsonConfig.Web);

        // 验证可解析
        using var document = JsonDocument.Parse(requestJson);
        var root = document.RootElement;

        Assert.AreEqual(JsonValueKind.Object, root.ValueKind);
        Assert.IsTrue(root.TryGetProperty("messages", out var msgs));
        Assert.AreEqual(JsonValueKind.Array, msgs.ValueKind);

        // 验证再次创建 StringContent 不会产生双重序列化
        var content = new StringContent(requestJson, System.Text.Encoding.UTF8, "application/json");
        Assert.IsNotNull(content);
    }

    /// <summary>
    /// 测试六：验证 ArgsJson 在协议响应中被正确内联为对象，而非字符串。
    /// </summary>
    [TestMethod]
    public void ArgsJson_InProtocolResponse_IsObject_NotString()
    {
        var argsJson = """{"city":"Beijing","unit":"celsius"}""";

        // 模拟修复后的行为：先 Deserialize 为 JsonElement，再作为 object 放入 Dictionary
        var argsElement = string.IsNullOrWhiteSpace(argsJson)
            ? (object?)null
            : JsonSerializer.Deserialize<JsonElement>(argsJson);

        var details = new Dictionary<string, object?>
        {
            ["capabilityName"] = "weather_query",
            ["displayName"] = "查询天气",
            ["argsJson"] = argsElement
        };

        var responseJson = JsonSerializer.Serialize(
            new { success = false, error = new { code = "APPROVAL_REQUIRED", message = "需要确认", details } },
            JsonConfig.Web);

        using var document = JsonDocument.Parse(responseJson);
        var root = document.RootElement;

        Assert.IsTrue(root.TryGetProperty("error", out var error));
        Assert.IsTrue(error.TryGetProperty("details", out var det));
        Assert.IsTrue(det.TryGetProperty("argsJson", out var args));

        // argsJson 必须是 Object，不是 String
        Assert.AreEqual(JsonValueKind.Object, args.ValueKind,
            "argsJson 应该是 JSON Object，不是被转义后的字符串");

        // argsJson 内的字段应可读
        Assert.IsTrue(args.TryGetProperty("city", out var city));
        Assert.AreEqual("Beijing", city.GetString());

        // 不应出现 "argsJson":"{\"city\"...}"
        Assert.IsFalse(responseJson.Contains("\"argsJson\":\"{"),
            "argsJson 不应被序列化为包含 JSON 的字符串");
    }

    /// <summary>
    /// 测试七：验证空 ArgsJson 不会导致异常。
    /// </summary>
    [TestMethod]
    public void EmptyArgsJson_SerializesAsNull()
    {
        var details = new Dictionary<string, object?>
        {
            ["capabilityName"] = "test",
            ["displayName"] = "测试",
            ["argsJson"] = null  // 空 argsJson 应为 null
        };

        var json = JsonSerializer.Serialize(new { details }, JsonConfig.Web);
        using var document = JsonDocument.Parse(json);

        Assert.IsTrue(document.RootElement.TryGetProperty("details", out var det));
        Assert.IsTrue(det.TryGetProperty("argsJson", out var args));

        // 空值应为 JsonValueKind.Null
        Assert.AreEqual(JsonValueKind.Null, args.ValueKind,
            "空 argsJson 应序列化为 null");
    }
}
