export const CAREER_NODE_IDS = ['evidence', 'author', 'ats', 'style', 'finalizer'] as const;
export type CareerNodeId = typeof CAREER_NODE_IDS[number];
export type CareerReasoning = 'default' | 'off' | 'low' | 'medium' | 'high';
export interface CareerRoleSetting { model?: string; reasoning?: CareerReasoning }
export type CareerRoleSettings = Partial<Record<CareerNodeId, CareerRoleSetting>>;
export function validateCareerSettings(reasoning: unknown, roles: unknown): void {
  const validReasoning = (value: unknown): boolean => value === undefined || (typeof value === 'string' && ['default','off','low','medium','high'].includes(value));
  if (!validReasoning(reasoning)) throw new Error('agent_config_reasoning_invalid');
  if (roles === undefined) return;
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) throw new Error('agent_config_roles_invalid');
  for (const [role, value] of Object.entries(roles)) {
    if (!CAREER_NODE_IDS.includes(role as CareerNodeId) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('agent_config_roles_invalid');
    const item = value as CareerRoleSetting;
    if (Object.keys(item).some(key => !['model','reasoning'].includes(key)) || !validReasoning(item.reasoning)
      || (item.model !== undefined && (typeof item.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/.test(item.model)))) throw new Error('agent_config_roles_invalid');
  }
}
export function freezeCareerRoles(input: {providerId: string; model?: string; reasoning?: CareerReasoning; roleSettings?: CareerRoleSettings}): CareerRoleSettings {
  return Object.fromEntries(CAREER_NODE_IDS.map(role => [role, {
    ...(input.roleSettings?.[role]?.model ?? input.model ? {model: input.roleSettings?.[role]?.model ?? input.model} : {}),
    reasoning: input.roleSettings?.[role]?.reasoning ?? input.reasoning ?? (input.providerId === 'openrouter' ? (role === 'finalizer' ? 'high' : 'off') : 'default')
  }]));
}
