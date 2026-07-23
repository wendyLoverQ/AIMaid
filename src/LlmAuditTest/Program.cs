using System.Diagnostics;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using AIMaid.Core;
using AIMaid.Infrastructure;

var testDbPath = Path.Combine(Path.GetTempPath(), $"llm_audit_test_{Guid.NewGuid():N}.db");
Console.WriteLine($"测试数据库: {testDbPath}");

try
{
    // 1. 创建 store（不调用 InitializeAsync，手动建表）
    var options = new CoreStorageOptions(testDbPath);
    var store = new SqliteCoreStore(options, secretProtector: null);

    // 手动建表（模拟 LegacyRelationalDocumentStore 的建表）
    await using (var conn = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={testDbPath