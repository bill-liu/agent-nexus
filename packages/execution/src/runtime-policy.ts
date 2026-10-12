export interface ExactActionPermission { exactActionDigests: readonly string[]; }
export interface RuntimePolicy { intent: 'discussion' | 'work'; layers: { user: ExactActionPermission; project: ExactActionPermission; bot: ExactActionPermission; task: ExactActionPermission; node: ExactActionPermission }; }
export function evaluateRuntimePolicy(request: { action: string; parameters: unknown }, policy: RuntimePolicy): { allowed: boolean; reason: string } {
  if (!policy || (policy.intent !== 'work' && policy.intent !== 'discussion') || !policy.layers || !request || typeof request.action !== 'string') return { allowed: false, reason: 'INVALID_POLICY' };
  if (policy.intent === 'discussion' && request.action !== 'resource.read') return { allowed: false, reason: 'DISCUSSION_READ_ONLY' };
  let digest: string;
  try { digest = canonicalDigest(request); } catch { return { allowed: false, reason: 'INVALID_ACTION' }; }
  for (const scope of ['user', 'project', 'bot', 'task', 'node'] as const) {
    const permission = policy.layers[scope];
    if (!permission || !Array.isArray(permission.exactActionDigests) || !permission.exactActionDigests.includes(digest)) return { allowed: false, reason: `DENIED_${scope.toUpperCase()}` };
  }
  return { allowed: true, reason: 'EXACT_ACTION_INTERSECTION' };
}
import { canonicalDigest } from '../../core/src/approvals.js';
