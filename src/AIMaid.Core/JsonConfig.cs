using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Unicode;

namespace AIMaid.Core;

/// <summary>
/// 集中管理的 JSON 序列化选项，避免各处随意 new JsonSerializerOptions。
/// </summary>
public static class JsonConfig
{
    /// <summary>HTTP 请求/响应和协议消息使用的 Web 风格选项（camelCase）。</summary>
    public static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false
    };

    /// <summary>审计日志/请求体记录使用的选项，保留非 ASCII 字符可读性。</summary>
    public static readonly JsonSerializerOptions Audit = new(JsonSerializerDefaults.Web)
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false
    };

    /// <summary>数据库持久化使用的选项。与 Web 相同，但可以独立调优。</summary>
    public static readonly JsonSerializerOptions Persistence = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false
    };

    /// <summary>开发日志使用，保留中文可读（仅用于日志展示，不用于网络传输）。</summary>
    public static readonly JsonSerializerOptions Readable = new(JsonSerializerDefaults.Web)
    {
        Encoder = JavaScriptEncoder.Create(UnicodeRanges.All),
        WriteIndented = true
    };
}
