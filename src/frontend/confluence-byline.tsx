import React from 'react';
import { Inline, Lozenge, Text } from '@forge/react';

/**
 * Confluence ADR byline — Phase 1 placeholder.
 * Full chip (governed issue count + drift status + expanded table) lands in Phase 2
 * per docs/DESIGN.md §4.
 */
const ConfluenceByline = (): React.ReactElement => {
  return (
    <Inline space="space.050" alignBlock="center">
      <Text size="small" weight="medium">
        SpecGuard
      </Text>
      <Lozenge appearance="default">not linked</Lozenge>
    </Inline>
  );
};

export default ConfluenceByline;
