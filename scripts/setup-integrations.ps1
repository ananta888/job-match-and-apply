$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$integrationRoot = Join-Path $projectRoot 'integrations'
git -C $projectRoot submodule update --init --recursive

$python = Get-Command python3.12 -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Warning 'Python 3.12 wurde nicht gefunden. Submodules wurden initialisiert, der echte MCP ist aber noch nicht installiert.'
    Write-Host 'Installiere Python 3.12 und führe danach npm run setup:integrations erneut aus.'
    exit 0
}

$mcpRoot = Join-Path $integrationRoot 'job-search-mcp'
$venvPython = Join-Path $mcpRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
    & $python.Source -m venv (Join-Path $mcpRoot '.venv')
}
& $venvPython -m pip install -e $mcpRoot
& $venvPython -m camoufox fetch

$profileRoot = Join-Path $projectRoot '.local-data\profiles'
New-Item -ItemType Directory -Path $profileRoot -Force | Out-Null
$candidateTarget = Join-Path $profileRoot 'candidate-profile.yaml'
$styleTarget = Join-Path $profileRoot 'style-profile.yaml'
if (-not (Test-Path -LiteralPath $candidateTarget)) {
    Copy-Item -LiteralPath (Join-Path $integrationRoot 'bewerbungs-schreib-assistent\candidate-profile.example.yaml') -Destination $candidateTarget
}
if (-not (Test-Path -LiteralPath $styleTarget)) {
    Copy-Item -LiteralPath (Join-Path $integrationRoot 'bewerbungs-schreib-assistent\style-profile.example.yaml') -Destination $styleTarget
}

Write-Host 'Integrationen sind bereit. Stelle in der UI Quellen & MCP > Modus auf stdio.'
