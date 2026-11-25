/**
 * Resolves the product context asynchronously for the UI Kit surfaces.
 *
 * `useProductContext()` returns `undefined` until the bridge resolves, so a surface
 * that reads it eagerly renders blank. The surfaces render a spinner until the
 * context arrives; if the runtime never provides one (older extension runtime), a
 * bounded grace period releases the gate so the resolver — which carries its own
 * context — can still drive the panel.
 */
import { useEffect, useState } from 'react';
import { useProductContext } from '@forge/react';
import { readIssueKey, readPageId } from './viewModel';

export interface SurfaceState {
  /** True once the context resolved or the grace period elapsed. */
  ready: boolean;
  /** True when the bridge actually delivered a product context. */
  contextLoaded: boolean;
  siteUrl: string | null;
  cloudId: string | null;
  issueKey: string | null;
  pageId: string | null;
}

const CONTEXT_GRACE_MS = 1500;

export function useSurfaceContext(): SurfaceState {
  const context = useProductContext();
  const [graceElapsed, setGraceElapsed] = useState<boolean>(false);

  useEffect(() => {
    if (context) return undefined;
    const timer = setTimeout(() => setGraceElapsed(true), CONTEXT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [context]);

  return {
    ready: Boolean(context) || graceElapsed,
    contextLoaded: Boolean(context),
    siteUrl: context?.siteUrl ?? null,
    cloudId: context?.cloudId ?? null,
    issueKey: readIssueKey(context),
    pageId: readPageId(context),
  };
}
