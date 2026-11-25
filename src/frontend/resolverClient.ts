/**
 * Typed resolver bridge shared by the UI Kit surfaces.
 */
import { invoke } from '@forge/bridge';

/**
 * Calls a Forge resolver function defined in `src/backend/index.ts`.
 * The Forge runtime returns the handler's value directly for UI Kit resolvers;
 * the bridge types model a metadata envelope, so the result is narrowed here once.
 */
export async function callResolver<T>(functionKey: string, payload?: object): Promise<T> {
  const response = await invoke(functionKey, payload as unknown as Record<string, unknown>);
  return response as unknown as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'SpecGuard could not complete this request. Try again.';
}
