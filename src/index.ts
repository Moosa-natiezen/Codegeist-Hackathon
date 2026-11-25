/** Forge function entry point backing the UI Kit resolvers. */
import { createResolver } from './backend/index';

export const handler = createResolver().getDefinitions();
