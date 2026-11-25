/**
 * Render-error boundary for the UI Kit surfaces.
 *
 * A thrown render error would otherwise leave an empty panel with no explanation.
 * The fallback names the surface, shows the error message, and remounts the tree on
 * Retry — so a transient data shape never leaves a permanently blank panel.
 */
import React from 'react';
import { Box, Button, Inline, SectionMessage, Stack, Text } from '@forge/react';

interface PanelBoundaryProps {
  /** Human-readable surface name, e.g. "status panel". */
  surface: string;
  children: React.ReactNode;
}

interface PanelBoundaryState {
  error: Error | null;
  attempt: number;
}

export class PanelBoundary extends React.Component<PanelBoundaryProps, PanelBoundaryState> {
  state: PanelBoundaryState = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<PanelBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // Surfaces in forge logs so a render failure is diagnosable without the browser.
    console.error(`SpecGuard ${this.props.surface} failed to render.`, error);
  }

  private retry = (): void => {
    this.setState((current) => ({ error: null, attempt: current.attempt + 1 }));
  };

  render(): React.ReactElement {
    const { error, attempt } = this.state;

    if (error) {
      return (
        <Box padding="space.100">
          <SectionMessage
            appearance="error"
            title={`SpecGuard ${this.props.surface} could not render`}
          >
            <Stack space="space.100">
              <Text size="small">
                {error.message.length > 0 ? error.message : 'Unknown render error.'}
              </Text>
              <Text size="small" color="color.text.subtlest">
                Retry to rebuild the panel. If this repeats, check forge logs for this issue key.
              </Text>
              <Inline>
                <Button appearance="primary" onClick={this.retry}>
                  Retry
                </Button>
              </Inline>
            </Stack>
          </SectionMessage>
        </Box>
      );
    }

    return <Box key={attempt}>{this.props.children}</Box>;
  }
}

export default PanelBoundary;
