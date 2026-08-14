$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$integrationRoot = Join-Path $projectRoot 'integrations'
$mcpRoot = Join-Path $integrationRoot 'job-search-mcp'
$runtimeRoot = Join-Path $projectRoot '.local-data'
$profileRoot = Join-Path $runtimeRoot 'profiles'
$launchSpecPath = Join-Path $runtimeRoot 'job-search-mcp-launch.json'
$distribution = if ($env:JOB_MCP_WSL_DISTRIBUTION) { $env:JOB_MCP_WSL_DISTRIBUTION } else { 'Ubuntu' }
if ($distribution -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
    throw 'JOB_MCP_WSL_DISTRIBUTION enthaelt einen ungueltigen Distributionsnamen.'
}

git -C $projectRoot submodule update --init --recursive
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

$launchSpec = $null
$nativePython = Get-Command python3.12 -ErrorAction SilentlyContinue
if ($nativePython) {
    $venvPython = Join-Path $mcpRoot '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $venvPython)) {
        & $nativePython.Source -m venv (Join-Path $mcpRoot '.venv')
    }
    & $venvPython -m pip install -e $mcpRoot
    & $venvPython -m camoufox fetch
    $launchSpec = [ordered]@{
        contractVersion = '1.0'
        executionIsolation = 'trusted-host'
        runtimeTarget = 'windows'
        command = (Join-Path $mcpRoot '.venv\Scripts\job-search-mcp.exe')
        args = @()
        env = [ordered]@{
            ALLOW_EXTERNAL_PORTALS = '0'
            JOB_MCP_STATE_DIR = (Join-Path $runtimeRoot 'mcp-state')
        }
    }
} else {
    $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if (-not $wsl) {
        throw 'Weder natives Python 3.12 noch WSL2 wurde gefunden. Die MCP-Integration wurde nicht installiert.'
    }
    & $wsl.Source -d $distribution -- python3.12 --version | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Python 3.12 ist in der WSL-Distribution $distribution nicht verfuegbar."
    }
    $wslMcpRoot = (& $wsl.Source -d $distribution -- wslpath -a -u ($mcpRoot -replace '\\', '\\')).Trim()
    $wslRuntimeRoot = (& $wsl.Source -d $distribution -- wslpath -a -u ($runtimeRoot -replace '\\', '\\')).Trim()
    if (-not $wslMcpRoot.StartsWith('/') -or -not $wslRuntimeRoot.StartsWith('/')) {
        throw 'Die sichere Windows-zu-WSL-Pfadabbildung ist fehlgeschlagen.'
    }
    $wslVenvPython = "$wslMcpRoot/.venv-wsl/bin/python"
    $wslMcpExecutable = "$wslMcpRoot/.venv-wsl/bin/job-search-mcp"
    & $wsl.Source -d $distribution -- python3.12 -m venv "$wslMcpRoot/.venv-wsl"
    & $wsl.Source -d $distribution -- $wslVenvPython -m pip install -e $wslMcpRoot
    & $wsl.Source -d $distribution -- $wslVenvPython -m camoufox fetch
    $launchSpec = [ordered]@{
        contractVersion = '1.0'
        executionIsolation = 'trusted-host'
        runtimeTarget = 'wsl'
        distribution = $distribution
        command = $wsl.Source
        args = @(
            '-d', $distribution, '--', 'env',
            'ALLOW_EXTERNAL_PORTALS=0',
            "JOB_MCP_STATE_DIR=$wslRuntimeRoot/mcp-state",
            $wslMcpExecutable
        )
        env = [ordered]@{}
    }
}

$launchSpec | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $launchSpecPath -Encoding utf8

New-Item -ItemType Directory -Path $profileRoot -Force | Out-Null
$candidateTarget = Join-Path $profileRoot 'candidate-profile.yaml'
$styleTarget = Join-Path $profileRoot 'style-profile.yaml'
if (-not (Test-Path -LiteralPath $candidateTarget)) {
    Copy-Item -LiteralPath (Join-Path $integrationRoot 'bewerbungs-schreib-assistent\candidate-profile.example.yaml') -Destination $candidateTarget
}
if (-not (Test-Path -LiteralPath $styleTarget)) {
    Copy-Item -LiteralPath (Join-Path $integrationRoot 'bewerbungs-schreib-assistent\style-profile.example.yaml') -Destination $styleTarget
}

Write-Host "Integrationen sind installiert. Der sichere MCP-Startvertrag liegt lokal unter $launchSpecPath."
Write-Host 'Uebernimm command, args und env in Quellen & MCP und aktiviere danach bewusst den stdio-Modus.'
