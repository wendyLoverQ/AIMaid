# Preload bridge

这里维护 renderer 可访问的最小白名单 API。禁止直接暴露 Node.js、任意文件系统或任意进程执行；
高风险调用必须保留 C# Contracts 中的授权语义。
