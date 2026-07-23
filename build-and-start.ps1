[CmdletBinding()]
param(
    [string[]]$LaunchArguments = @(),
    [switch]$FullPackage
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$desktopRoot = Join-Path $projectRoot 'apps\desktop'
$releaseRoot = Join-Path $desktopRoot 'release\win-unpacked'
$executable = Join-Path $releaseRoot 'AIMaid.exe'
$resourcesRoot = Join-Path $releaseRoot 'resources'
$asarPath = Join-Path $resourcesRoot 'app.asar'
$asarBackupPath = Join-Path $resourcesRoot 'app.asar.packaged'
$unpackedAppPath = Join-Path $resourcesRoot 'app'

$logDirectory = Join-Path $projectRoot 'artifacts\local-build'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $logDirectory "build-$timestamp.log"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

function Write-LogLine {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text
    )

    $Text | Tee-Object -FilePath $logPath -Append | Write-Host
}

function Invoke-NativeStep {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [string[]]$Arguments = @()
    )

    Write-Host "`n==> $Name" -ForegroundColor Cyan
    Add-Content -LiteralPath $logPath -Value "`n==> $Name"
    Add-Content -LiteralPath $logPath -Value "COMMAND: $FilePath $($Arguments -join ' ')"

    & $FilePath @Arguments 2>&1 |
        ForEach-Object {
            $line = $_.ToString()
            Add-Content -LiteralPath $logPath -Value $line
            Write-Host $line
        }

    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) {
        $exitCode = 0
    }

    if ($exitCode -ne 0) {
        throw "$Name 失败，退出码：$exitCode"
    }
}

function Test-InitialPackageAvailable {
    if (-not (Test-Path -LiteralPath $releaseRoot -PathType Container)) {
        return $false
    }

    if (Test-Path -LiteralPath $unpackedAppPath -PathType Container) {
        return $true
    }

    return (Test-Path -LiteralPath $asarPath -PathType Leaf) -or
           (Test-Path -LiteralPath $asarBackupPath -PathType Leaf)
}

try {
    Write-LogLine "AIMaid 本地构建开始"
    Write-LogLine "项目目录：$projectRoot"
    Write-LogLine "日志文件：$logPath"

    if (-not (Test-Path -LiteralPath $desktopRoot -PathType Container)) {
        throw "未找到 Electron 项目目录：$desktopRoot。请把 BuildAndStart.cmd 和 build-and-start.ps1 放在 AIMaid 仓库根目录。"
    }

    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) {
        $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    }
    if ($null -eq $nodeCommand) {
        throw '未找到 Node.js。请确认 Node.js 22 已安装并加入 PATH。'
    }

    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $npmCommand) {
        $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
    }
    if ($null -eq $npmCommand) {
        throw '未找到 npm。请确认 npm 已安装并加入 PATH。'
    }

    $npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
    if ($null -eq $npxCommand) {
        $npxCommand = Get-Command npx -ErrorAction SilentlyContinue
    }
    if ($null -eq $npxCommand) {
        throw '未找到 npx。请确认 npm 安装完整。'
    }

    Push-Location $desktopRoot
    try {
        Invoke-NativeStep '检查 Node.js 版本' $nodeCommand.Source @('--version')
        Invoke-NativeStep '检查 npm 版本' $npmCommand.Source @('--version')

        if (-not (Test-Path -LiteralPath (Join-Path $desktopRoot 'node_modules') -PathType Container)) {
            throw "未找到 node_modules：$desktopRoot\node_modules。请先在 apps\desktop 执行 npm install。"
        }

        Invoke-NativeStep '停止已运行的 AIMaid' $nodeCommand.Source @('scripts/kill-packaged-app.mjs')
        Invoke-NativeStep '发布 AIMaid CoreHost' $nodeCommand.Source @('scripts/publish-core.mjs')
        Invoke-NativeStep '执行全局 UI 门禁' $npmCommand.Source @('run', 'ui:gate')
        Invoke-NativeStep '检查 Electron Main TypeScript' $npxCommand.Source @('tsc', '--noEmit', '-p', 'tsconfig.node.json')
        Invoke-NativeStep '检查 Renderer TypeScript' $npxCommand.Source @('tsc', '--noEmit', '-p', 'tsconfig.web.json')
        Invoke-NativeStep '构建 Electron Renderer/Main' $npxCommand.Source @('electron-vite', 'build')

        $canMerge = Test-InitialPackageAvailable
        if ($FullPackage -or -not $canMerge) {
            Write-LogLine '未检测到可用的既有发布目录，执行完整目录打包。'
            Invoke-NativeStep '完整打包 Electron' $npxCommand.Source @('electron-builder', '--dir')
        }
        else {
            Write-LogLine '检测到可用的既有发布目录，执行增量更新。'
            Invoke-NativeStep '增量更新本地发布目录' $nodeCommand.Source @('scripts/merge-local-package.mjs')
        }

        if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
            throw "发布完成后未找到 EXE：$executable"
        }

        $launchStepArguments = @(
            'scripts/launch-packaged-app.mjs',
            $executable,
            (Split-Path -Parent $executable)
        ) + $LaunchArguments
        Invoke-NativeStep '独立启动 AIMaid' $nodeCommand.Source $launchStepArguments

        Write-LogLine "构建并独立启动完成：$executable"
    }
    finally {
        Pop-Location
    }
}
catch {
    $message = $_.Exception.Message
    Add-Content -LiteralPath $logPath -Value "`nFAILED: $message"
    Write-Host "`n构建或启动失败：$message" -ForegroundColor Red
    Write-Host "完整日志：$logPath" -ForegroundColor Yellow
    exit 1
}

Write-Host "`n构建窗口即将关闭，AIMaid 已独立运行。" -ForegroundColor Green
exit 0
