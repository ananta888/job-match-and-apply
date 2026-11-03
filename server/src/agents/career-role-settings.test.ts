import {describe, expect, it} from 'vitest';
import {freezeCareerRoles} from './career-role-settings.js';
describe('frozen career roles', () => {
  it('restores the Lab fast stages and high finalizer while respecting explicit overrides', () => {
    expect(freezeCareerRoles({providerId: 'openrouter', model: 'synthetic/model'})).toMatchObject({
      evidence: {reasoning: 'off', model: 'synthetic/model'}, finalizer: {reasoning: 'high', model: 'synthetic/model'}
    });
    const input = {providerId: 'openrouter', roleSettings: {finalizer: {model: 'synthetic/final', reasoning: 'low' as const}}};
    const frozen = freezeCareerRoles(input);
    input.roleSettings.finalizer.model = 'synthetic/changed';
    expect(frozen.finalizer).toEqual({model: 'synthetic/final', reasoning: 'low'});
  });
});
