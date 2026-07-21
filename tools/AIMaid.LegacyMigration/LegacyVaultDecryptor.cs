using System.Security.Cryptography;
using System.Text;

namespace AIMaid.LegacyMigration;

internal sealed class LegacyVaultDecryptor
{
    private readonly string key;
    public LegacyVaultDecryptor(string key) => this.key = string.IsNullOrWhiteSpace(key)
        ? throw new ArgumentException("旧保险库密钥不能为空。", nameof(key)) : key;

    public string Decrypt(string? protectedValue)
    {
        if (string.IsNullOrWhiteSpace(protectedValue)) return string.Empty;
        var parts = protectedValue.Split(':');
        if (parts.Length != 5 || parts[0] != "v1") throw new CryptographicException("旧保险库密文格式无效。");
        var salt = Convert.FromBase64String(parts[1]);
        var nonce = Convert.FromBase64String(parts[2]);
        var tag = Convert.FromBase64String(parts[3]);
        var cipher = Convert.FromBase64String(parts[4]);
        var clear = new byte[cipher.Length];
        using var derive = new Rfc2898DeriveBytes(key, salt, 100_000, HashAlgorithmName.SHA256);
        using var aes = new AesGcm(derive.GetBytes(32), 16);
        aes.Decrypt(nonce, cipher, tag, clear);
        try { return Encoding.UTF8.GetString(clear); }
        finally { CryptographicOperations.ZeroMemory(clear); }
    }
}
