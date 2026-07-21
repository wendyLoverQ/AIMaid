using System.Security.Cryptography;
using System.Text;
using AIMaid.Core;

namespace AIMaid.Infrastructure;

public sealed class AesGcmSecretProtector : ISecretProtector
{
    private const byte PayloadVersion = 1;
    private readonly byte[] key;

    public AesGcmSecretProtector(SecretProtectionOptions options)
    {
        if (string.IsNullOrWhiteSpace(options.KeyBase64))
            throw new ArgumentException("保险库加密密钥必须由运行壳注入。", nameof(options));
        try { key = Convert.FromBase64String(options.KeyBase64); }
        catch (FormatException ex) { throw new ArgumentException("保险库加密密钥不是有效 Base64。", nameof(options), ex); }
        if (key.Length is not (16 or 24 or 32))
            throw new ArgumentException("保险库加密密钥解码后必须为 16、24 或 32 字节。", nameof(options));
    }

    public string Protect(string plaintext)
    {
        ArgumentNullException.ThrowIfNull(plaintext);
        var nonce = RandomNumberGenerator.GetBytes(12);
        var tag = new byte[16];
        var clear = Encoding.UTF8.GetBytes(plaintext);
        var cipher = new byte[clear.Length];
        using var aes = new AesGcm(key, tag.Length);
        aes.Encrypt(nonce, clear, cipher, tag);
        var payload = new byte[1 + nonce.Length + tag.Length + cipher.Length];
        payload[0] = PayloadVersion;
        nonce.CopyTo(payload, 1);
        tag.CopyTo(payload, 13);
        cipher.CopyTo(payload, 29);
        CryptographicOperations.ZeroMemory(clear);
        return Convert.ToBase64String(payload);
    }

    public string Unprotect(string protectedValue)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(protectedValue);
        var payload = Convert.FromBase64String(protectedValue);
        if (payload.Length < 29 || payload[0] != PayloadVersion)
            throw new CryptographicException("保险库密文格式或版本无效。");
        var clear = new byte[payload.Length - 29];
        using var aes = new AesGcm(key, 16);
        aes.Decrypt(payload.AsSpan(1, 12), payload.AsSpan(29), payload.AsSpan(13, 16), clear);
        try { return Encoding.UTF8.GetString(clear); }
        finally { CryptographicOperations.ZeroMemory(clear); }
    }
}
