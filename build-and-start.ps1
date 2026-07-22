[CmdletBinding()]
param(
    [string[]]$LaunchArguments = @()
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$desktopRoot = Join-Path $projectRoot 'apps\desktop'
$executable = Join-Path $desktopRoot 'release\win-unpacked\AIMaid.exe'

function Invoke-CheckedStep {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Action
    )

    Write-Host "`n==> $Name" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Name 失败，退出码：$LASTEXITCODE"
    }
}

if (-not (Test-Path -LiteralPath $desktopRoot -PathType Container)) {
    throw "未找到 Electron 项目目录：$desktopRoot"
}

Push-Location $desktopRoot
try {
    Invoke-CheckedStep '停止已运行的 AIMaid' { node scripts/kill-packaged-app.mjs }
    Invoke-CheckedStep '发布 AIMaid CoreHost' { node scripts/publish-core.mjs }
    Invoke-CheckedStep '执行全局 UI 门禁' { npm run ui:gate }
    Invoke-CheckedStep '构建 Electron' { npx electron-vite build }
    Invoke-CheckedStep '增量更新本地发布目录' { node scripts/merge-local-package.mjs }

    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw "发布完成后未找到 EXE：$executable"
    }

    Write-Host "`n==> 启动 AIMaid" -ForegroundColor Cyan
    if ($LaunchArguments.Count -eq 0) {
        Start-Process -FilePath $executable -WorkingDirectory (Split-Path -Parent $executable)
    }
    else {
        Start-Process -FilePath $executable -WorkingDirectory (Split-Path -Parent $executable) -ArgumentList $LaunchArguments
    }
    Write-Host "`n构建并启动完成：$executable" -ForegroundColor Green
}
finally {
    Pop-Location
}
