import React from 'react';
import { Box, Inline, Lozenge, Stack, Text } from '@forge/react';

/**
 * Jira issue panel — Phase 1 placeholder.
 * Renders the three verdict states with Atlassian tokens only; the full seven-block
 * layout (criteria checklist, ADR guardrails, dependency impact, audit log, sync
 * preview) lands in Phase 2 per docs/DESIGN.md §3.
 */
const IssuePanel = (): React.ReactElement => {
  return (
    <Box padding="space.200">
      <Stack space="space.150">
        <Inline space="space.100" alignBlock="center">
          <Text weight="semibold">SpecGuard Status</Text>
          <Lozenge appearance="default">Unverified</Lozenge>
        </Inline>
        <Text size="small" color="color.text.subtlest">
          No verification recorded for this issue yet.
        </Text>
        <Text size="small">
          Run specguard_get_context from your coding agent before starting work, then
          specguard_verify_implementation when the change is ready.
        </Text>
      </Stack>
    </Box>
  );
};

export default IssuePanel;
