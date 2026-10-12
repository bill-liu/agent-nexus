export interface HardPermissions { directories: string[]; network: string[]; tools: string[]; accounts: string[]; maxBytes: number; requireApproval: boolean }
export interface RuleVersion { id: string; version: number; source: string; priority: number; permissions?: Partial<HardPermissions>; preferences?: Record<string, string>; required?: boolean }
const sets = ['directories', 'network', 'tools', 'accounts'] as const;
export function effectivePermissions(layers: HardPermissions[]): HardPermissions {
  if (!layers.length) throw new Error('PERMISSION_LAYERS_REQUIRED');
  for (const layer of layers) if (!Number.isSafeInteger(layer.maxBytes) || layer.maxBytes < 0 || sets.some(key => !Array.isArray(layer[key]) || layer[key].some(x => typeof x !== 'string'))) throw new Error('INVALID_PERMISSIONS');
  const output = structuredClone(layers[0]!);
  for (const layer of layers.slice(1)) {
    for (const key of sets) output[key] = output[key].filter(x => layer[key].includes(x));
    output.maxBytes = Math.min(output.maxBytes, layer.maxBytes); output.requireApproval ||= layer.requireApproval;
  }
  return output;
}
export function resolveRules(rules: RuleVersion[], base: HardPermissions): { permissions: HardPermissions; preferences: Record<string, string>; sources: string[] } {
  let permissions = effectivePermissions([base]);
  const chosen = new Map<string, { value: string; rule: RuleVersion }>();
  for (const rule of [...rules].sort((a, b) => a.priority - b.priority)) {
    if (rule.permissions) {
      for (const key of sets) if (rule.permissions[key]?.some(x => !permissions[key].includes(x))) throw new Error(`RULE_CONFLICT: ${rule.source} expands ${key}`);
      if (rule.permissions.maxBytes !== undefined && rule.permissions.maxBytes > permissions.maxBytes) throw new Error(`RULE_CONFLICT: ${rule.source} expands budget`);
      if (permissions.requireApproval && rule.permissions.requireApproval === false) throw new Error(`RULE_CONFLICT: ${rule.source} removes approval`);
      permissions = effectivePermissions([permissions, { ...permissions, ...rule.permissions }]);
    }
    for (const [key, value] of Object.entries(rule.preferences ?? {})) {
      const prior = chosen.get(key);
      if (prior && prior.value !== value && (prior.rule.priority === rule.priority || prior.rule.required || rule.required)) throw new Error(`RULE_CONFLICT: ${prior.rule.source} and ${rule.source}: ${key}`);
      chosen.set(key, { value, rule });
    }
  }
  return { permissions, preferences: Object.fromEntries([...chosen].map(([key, item]) => [key, item.value])), sources: rules.map(x => x.source) };
}
export function preserveUserInstructions(existing: Record<string, string>, generated: string): Record<string, string> {
  if ('AN.instructions.md' in existing && existing['AN.instructions.md'] !== generated) throw new Error('INSTRUCTION_FILE_CONFLICT');
  return { ...existing, 'AN.instructions.md': generated };
}
