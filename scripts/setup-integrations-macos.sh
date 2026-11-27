#!/usr/bin/env bash
# Richtet die Integrationen auf macOS ein: Submodules, job-search-mcp in einer nativen Python-3.12-Venv,
# Camoufox-Browser, privaten MCP-Zustand und den versionierten Startvertrag (runtimeTarget "darwin").
# Externe Portale bleiben gesperrt (ALLOW_EXTERNAL_PORTALS=0), bis sie in der Oberfläche freigegeben werden.
#
# Aufruf:  npm run setup:integrations:mac
# Optionen: SKIP_BROWSER_FETCH=1  überspringt den Camoufox-Download (nur für Tests).
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
mcp_root="$project_root/integrations/job-search-mcp"
assistant_root="$project_root/integrations/bewerbungs-schreib-assistent"
runtime_root="$project_root/.local-data"
state_root="$runtime_root/mcp-state"
profile_root="$runtime_root/profiles"
launch_spec="$runtime_root/job-search-mcp-launch.json"
venv_root="$mcp_root/.venv"
venv_python="$venv_root/bin/python"
mcp_executable="$venv_root/bin/job-search-mcp"

step() { printf '\n==> %s\n' "$1"; }
die() { printf 'Fehler: %s\n' "$1" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "Dieses Skript ist für macOS. Unter Windows: npm run setup:integrations"

step "Submodules initialisieren"
git -C "$project_root" submodule update --init --recursive
[[ -f "$mcp_root/pyproject.toml" ]] || die "Das job-search-mcp-Submodule ist nicht initialisiert."

step "Python-3.12-Venv für job-search-mcp anlegen"
if [[ ! -x "$venv_python" ]]; then
  if command -v uv >/dev/null 2>&1; then
    # uv lädt bei Bedarf eine passende Python-Version herunter.
    uv venv --python 3.12 "$venv_root"
  elif command -v python3.12 >/dev/null 2>&1; then
    python3.12 -m venv "$venv_root"
  else
    die "Python 3.12 fehlt. Entweder uv installieren (brew install uv) oder python@3.12 (brew install python@3.12)."
  fi
fi

step "job-search-mcp installieren"
if command -v uv >/dev/null 2>&1; then
  uv pip install --python "$venv_python" -e "$mcp_root"
else
  "$venv_python" -m ensurepip --upgrade >/dev/null
  "$venv_python" -m pip --disable-pip-version-check install --no-input -e "$mcp_root"
fi
[[ -x "$mcp_executable" ]] || die "Das job-search-mcp-Executable wurde nicht installiert."

if [[ "${SKIP_BROWSER_FETCH:-0}" != "1" ]]; then
  step "Camoufox-Browser laden"
  "$venv_python" -m camoufox fetch
fi

step "Privaten Laufzeitordner und Beispielprofile vorbereiten"
mkdir -p "$state_root" "$profile_root"
chmod 700 "$runtime_root" "$state_root"
[[ -f "$profile_root/candidate-profile.yaml" ]] || cp "$assistant_root/candidate-profile.example.yaml" "$profile_root/candidate-profile.yaml"
[[ -f "$profile_root/style-profile.yaml" ]] || cp "$assistant_root/style-profile.example.yaml" "$profile_root/style-profile.yaml"

step "Startvertrag schreiben und offline prüfen"
temporary_spec="$launch_spec.tmp"
node -e '
  const [command, state, target] = process.argv.slice(1);
  const spec = { contractVersion: "1.0", executionIsolation: "trusted-host", runtimeTarget: "darwin",
    command, args: [], env: { ALLOW_EXTERNAL_PORTALS: "0", JOB_MCP_STATE_DIR: state } };
  require("node:fs").writeFileSync(target, JSON.stringify(spec, null, 2) + "\n", { mode: 0o600 });
' "$mcp_executable" "$state_root" "$temporary_spec"
npm --prefix "$project_root/server" run job-mcp:smoke -- --launch-contract "$temporary_spec"
mv -f "$temporary_spec" "$launch_spec"

printf '\nIntegrationen sind installiert. Startvertrag: %s\n' "$launch_spec"
printf 'Der MCP wurde direkt als trusted-host-stdio getestet; ALLOW_EXTERNAL_PORTALS bleibt 0.\n'
printf 'Danach in der App unter „Quellen & MCP“ die Runtime „Nativ (macOS)“ wählen und Portale bewusst freigeben.\n'
