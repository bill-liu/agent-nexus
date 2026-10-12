import type { Run, ExecutionCommand } from '../../packages/core/src/control.js';
export const prepareFake = (run: Run) => ({contextManifestRef:`fake-context:${run.id}`,resolvedConnectionRef:`fake-connection:${run.id}`});
/** Explicit test policy: only this fake fixture is permitted, no real calls. */
export const authorizeFake = (_command: ExecutionCommand): void => {};
