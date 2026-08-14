param(
    [string]$RuntimeTarget = '',
    [string]$Distribution = '',
    [switch]$SkipBrowserFetch
)

$ErrorActionPreference = 'Stop'

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments, [string]$Description)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description ist mit Exitcode $LASTEXITCODE fehlgeschlagen."
    }
}

function Invoke-CheckedCapture {
    param([string]$Command, [string[]]$Arguments, [string]$Description)
    $output = & $Command @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $detail = (($output | Select-Object -Last 4) -join ' ').Trim()
        throw "$Description ist mit Exitcode $exitCode fehlgeschlagen: $detail"
    }
    return (($output | Out-String).Trim())
}

function Convert-ToWslPath {
    param([string]$WslCommand, [string]$WslDistribution, [string]$WindowsPath)
    # wsl.exe consumes backslashes while constructing Linux argv. Forward
    # slashes retain the Windows drive and make wslpath deterministic.
    $portableWindowsPath = $WindowsPath.Replace('\', '/')
    $mapped = Invoke-CheckedCapture $WslCommand @('-d', $WslDistribution, '--', 'wslpath', '-a', '-u', $portableWindowsPath) "WSL-Pfadabbildung fuer $WindowsPath"
    if ($mapped -notmatch '^/[^\x00\r\n]+$') {
        throw "Die sichere Windows-zu-WSL-Pfadabbildung ist fuer $WindowsPath fehlgeschlagen."
    }
    return $mapped
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$integrationRoot = Join-Path $projectRoot 'integrations'
$mcpRoot = Join-Path $integrationRoot 'job-search-mcp'
$serverRoot = Join-Path $projectRoot 'server'
$runtimeRoot = Join-Path $projectRoot '.local-data'
$profileRoot = Join-Path $runtimeRoot 'profiles'
$stateRoot = Join-Path $runtimeRoot 'mcp-state'
$launchSpecPath = Join-Path $runtimeRoot 'job-search-mcp-launch.json'

if (-not $RuntimeTarget) {
    $RuntimeTarget = if ($env:JOB_MCP_RUNTIME_TARGET) { $env:JOB_MCP_RUNTIME_TARGET } else { 'wsl' }
}
if ($RuntimeTarget -notin @('wsl', 'windows', 'auto')) {
    throw 'RuntimeTarget beziehungsweise JOB_MCP_RUNTIME_TARGET muss wsl, windows oder auto sein.'
}
if (-not $Distribution) {
    $Distribution = if ($env:JOB_MCP_WSL_DISTRIBUTION) { $env:JOB_MCP_WSL_DISTRIBUTION } else { 'Ubuntu' }
}
if ($Distribution -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
    throw 'JOB_MCP_WSL_DISTRIBUTION enthaelt einen ungueltigen Distributionsnamen.'
}

Invoke-Checked 'git' @('-C', $projectRoot, 'submodule', 'update', '--init', '--recursive') 'Submodule-Initialisierung'
if (-not (Test-Path -LiteralPath (Join-Path $mcpRoot 'pyproject.toml'))) {
    throw 'Das job-search-mcp-Submodule ist nicht initialisiert.'
}
# The WSL venv is deliberately private runtime state. Keep that local rule in
# Git metadata so setup never needs a tracked change in the upstream submodule.
$mcpExcludePath = Invoke-CheckedCapture 'git' @('-C', $mcpRoot, 'rev-parse', '--git-path', 'info/exclude') 'Lokaler Submodule-Exclude-Pfad'
if (-not [System.IO.Path]::IsPathRooted($mcpExcludePath)) {
    $mcpExcludePath = Join-Path $mcpRoot $mcpExcludePath
}
$mcpExcludePath = [System.IO.Path]::GetFullPath($mcpExcludePath)
$excludeRule = '/.venv-wsl/'
$excludeContent = if (Test-Path -LiteralPath $mcpExcludePath) { [System.IO.File]::ReadAllText($mcpExcludePath) } else { '' }
if (($excludeContent -split "`r?`n") -notcontains $excludeRule) {
    $separator = if ($excludeContent -and -not $excludeContent.EndsWith("`n")) { [Environment]::NewLine } else { '' }
    [System.IO.File]::AppendAllText(
        $mcpExcludePath, "$separator$excludeRule$([Environment]::NewLine)",
        (New-Object System.Text.UTF8Encoding($false))
    )
}
New-Item -ItemType Directory -Path $runtimeRoot, $stateRoot -Force | Out-Null

$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
$wslPythonReady = $false
if ($wsl -and $RuntimeTarget -ne 'windows') {
    try {
        $pythonVersion = Invoke-CheckedCapture $wsl.Source @('-d', $Distribution, '--', 'python3.12', '--version') "Python-3.12-Probe in WSL $Distribution"
        $wslPythonReady = $pythonVersion -match '^Python 3\.12(?:\.|$)'
    } catch {
        if ($RuntimeTarget -eq 'wsl') { throw }
    }
}

$launchSpec = $null
if ($wslPythonReady) {
    $wslMcpRoot = Convert-ToWslPath $wsl.Source $Distribution $mcpRoot
    $wslRuntimeRoot = Convert-ToWslPath $wsl.Source $Distribution $runtimeRoot
    $wslVenvRoot = "$wslMcpRoot/.venv-wsl"
    $wslVenvPython = "$wslVenvRoot/bin/python"
    $wslMcpExecutable = "$wslVenvRoot/bin/job-search-mcp"

    & $wsl.Source -d $Distribution -- test -x $wslVenvPython
    if ($LASTEXITCODE -ne 0) {
        Invoke-Checked $wsl.Source @('-d', $Distribution, '--', 'python3.12', '-m', 'venv', $wslVenvRoot) 'WSL-Python-Venv'
    } else {
        Invoke-Checked $wsl.Source @(
            '-d', $Distribution, '--', $wslVenvPython, '-c',
            'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 2)'
        ) 'Python-Version der vorhandenen WSL-Venv'
    }
    Invoke-Checked $wsl.Source @(
        '-d', $Distribution, '--', $wslVenvPython, '-m', 'pip',
        '--disable-pip-version-check', 'install', '--no-input', '-e', $wslMcpRoot
    ) 'Installation des job-search-mcp in der WSL-Venv'
    if (-not $SkipBrowserFetch) {
        Invoke-Checked $wsl.Source @('-d', $Distribution, '--', $wslVenvPython, '-m', 'camoufox', 'fetch') 'Camoufox-Browserinstallation'
    }
    Invoke-Checked $wsl.Source @('-d', $Distribution, '--', 'test', '-x', $wslMcpExecutable) 'job-search-mcp-Executable-Probe'

    $launchSpec = [ordered]@{
        contractVersion = '1.0'
        executionIsolation = 'trusted-host'
        runtimeTarget = 'wsl'
        distribution = $Distribution
        command = $wsl.Source
        args = @('-d', $Distribution, '--', $wslMcpExecutable)
        env = [ordered]@{
            ALLOW_EXTERNAL_PORTALS = '0'
            JOB_MCP_STATE_DIR = "$wslRuntimeRoot/mcp-state"
            WSLENV = 'ALLOW_EXTERNAL_PORTALS:JOB_MCP_STATE_DIR'
        }
    }
} else {
    if ($RuntimeTarget -eq 'wsl') {
        throw "WSL2 mit Python 3.12 ist in der Distribution $Distribution nicht verfuegbar."
    }
    $nativePython = Get-Command python3.12 -ErrorAction SilentlyContinue
    if (-not $nativePython) {
        throw 'Weder die angeforderte WSL-Python-3.12-Runtime noch natives python3.12 wurde gefunden.'
    }
    $venvRoot = Join-Path $mcpRoot '.venv'
    $venvPython = Join-Path $venvRoot 'Scripts\python.exe'
    $mcpExecutable = Join-Path $venvRoot 'Scripts\job-search-mcp.exe'
    if (-not (Test-Path -LiteralPath $venvPython)) {
        Invoke-Checked $nativePython.Source @('-m', 'venv', $venvRoot) 'Native Python-Venv'
    }
    Invoke-Checked $venvPython @(
        '-m', 'pip', '--disable-pip-version-check', 'install', '--no-input', '-e', $mcpRoot
    ) 'Installation des job-search-mcp in der nativen Venv'
    if (-not $SkipBrowserFetch) {
        Invoke-Checked $venvPython @('-m', 'camoufox', 'fetch') 'Camoufox-Browserinstallation'
    }
    if (-not (Test-Path -LiteralPath $mcpExecutable -PathType Leaf)) {
        throw 'Das native job-search-mcp-Executable wurde nicht installiert.'
    }
    $launchSpec = [ordered]@{
        contractVersion = '1.0'
        executionIsolation = 'trusted-host'
        runtimeTarget = 'windows'
        command = $mcpExecutable
        args = @()
        env = [ordered]@{
            ALLOW_EXTERNAL_PORTALS = '0'
            JOB_MCP_STATE_DIR = $stateRoot
        }
    }
}

$json = ($launchSpec | ConvertTo-Json -Depth 6) + [Environment]::NewLine
$temporaryLaunchSpec = "$launchSpecPath.tmp"
[System.IO.File]::WriteAllText($temporaryLaunchSpec, $json, (New-Object System.Text.UTF8Encoding($false)))

New-Item -ItemType Directory -Path $profileRoot -Force | Out-Null
$candidateTarget = Join-Path $profileRoot 'candidate-profile.yaml'
$styleTarget = Join-Path $profileRoot 'style-profile.yaml'
if (-not (Test-Path -LiteralPath $candidateTarget)) {
    Copy-Item -LiteralPath (Join-Path $integrationRoot 'bewerbungs-schreib-assistent\candidate-profile.example.yaml') -Destination $candidateTarget
}
if (-not (Test-Path -LiteralPath $styleTarget)) {
    Copy-Item -LiteralPath (Join-Path $integrationRoot 'bewerbungs-schreib-assistent\style-profile.example.yaml') -Destination $styleTarget
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { throw 'npm.cmd wurde fuer den obligatorischen Offline-MCP-Smoke nicht gefunden.' }
Invoke-Checked $npm.Source @(
    '--prefix', $serverRoot, 'run', 'job-mcp:smoke', '--', '--launch-contract', $temporaryLaunchSpec
) 'Offline-stdio-MCP-Smoke'
Move-Item -LiteralPath $temporaryLaunchSpec -Destination $launchSpecPath -Force

Write-Host "Integrationen sind installiert. Der private Startvertrag liegt unter $launchSpecPath."
Write-Host 'Der MCP wurde direkt als trusted-host-stdio ohne Sandbox getestet; ALLOW_EXTERNAL_PORTALS bleibt 0.'
Write-Host 'Waehle erst danach bewusst stdio-MCP. StepStone-Zugriff und sichtbarer Login bleiben eigene bestaetigte Schritte in der Oberflaeche.'
