[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('schema', 'snapshot')]
    [string]$Mode,
    [string]$DatabasePath,
    [switch]$Check,
    [switch]$FullIntegrityCheck
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$project = Join-Path $repoRoot 'tools\AIMaid.DatabaseReport\AIMaid.DatabaseReport.csproj'
$arguments = @('run', '--project', $project, '--no-restore', '--', $Mode)
if ($DatabasePath) { $arguments += @('-DatabasePath', $DatabasePath) }
if ($Check) { $arguments += '-Check' }
if ($FullIntegrityCheck) { $arguments += '-FullIntegrityCheck' }

& dotnet @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
