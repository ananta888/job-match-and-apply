/**
 * Server-owned Codex CLI 0.147.0 launch policy.
 *
 * These values are deliberately argv entries rather than environment- or
 * workspace-provided configuration. Codex gives `-c` launch overrides higher
 * precedence than config files, while `--strict-config` rejects unknown keys.
 */
export const CODEX_CONFORMED_VERSION = '0.147.0' as const;

export const CODEX_CONFORMED_VERSION_PATTERN =
  '^(?:codex-cli|codex)\\s+0\\.147\\.0$' as const;

export const CODEX_OFFLINE_CONFIG_OVERRIDES = Object.freeze([
  'sandbox_workspace_write.network_access=false',
  'web_search="disabled"',
] as const);

export const CODEX_OFFLINE_CONFIG_ARGS = Object.freeze([
  '--strict-config',
  '-c', CODEX_OFFLINE_CONFIG_OVERRIDES[0],
  '-c', CODEX_OFFLINE_CONFIG_OVERRIDES[1],
] as const);

export const CODEX_OFFLINE_NETWORK_CONTRACT = Object.freeze({
  networkEnforcement: 'codex-cli-0.147.0-fixed-offline-config-v1',
  networkMechanism: 'server-owned-config-plus-codex-sandbox-policy',
  networkAccessClaim: 'provider-control-plane-only',
  supportedNetworkModes: Object.freeze(['disabled'] as const),
  webSearch: 'disabled',
  sandboxNetworkAccess: false,
} as const);

export function isConformedCodexVersion(version: string | undefined): boolean {
  return typeof version === 'string'
    && version === version.trim()
    && new RegExp(CODEX_CONFORMED_VERSION_PATTERN, 'i').test(version);
}

export function hasFixedCodexOfflineConfig(args: readonly string[]): boolean {
  if (!args.includes('--strict-config')) return false;
  return CODEX_OFFLINE_CONFIG_OVERRIDES.every((override) =>
    args.some((argument, index) => argument === '-c' && args[index + 1] === override));
}
