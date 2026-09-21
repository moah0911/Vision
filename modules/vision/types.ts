export interface AxNode {
  role: string;
  name: string;
  tag: string;
  bbox: [number, number, number, number];
  value?: string;
  inputType?: string;
  isSensitive?: boolean;
  placeholder?: string;
}

export interface SanitizedContext {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  ax_tree: AxNode[];
  redacted_regions: Array<{ bbox: [number, number, number, number]; type: string; confidence: number }>;
  screenshot_redacted_b64?: string; // data URL jpeg, already masked
  redaction_scheme: string;
  task?: string;
  timestamp: number;
  // Metrics for evaluation panel
  metrics?: {
    extractionMs: number;
    piiDetectionMs: number;
    visionMs?: number;
    redactionMs: number;
  };
}

export interface AgentAction {
  type: 'click' | 'fill' | 'scroll' | 'hover' | 'press' | 'wait' | 'done' | 'say';
  target?: { role?: string; name?: string; bbox?: [number, number, number, number]; selector?: string; text?: string };
  value?: string;
  direction?: 'up' | 'down';
  amount?: number;
  key?: string;
  message?: string;
}

export interface AgentResponse {
  thought: string;
  action: AgentAction;
  alternatives?: AgentAction[];
  requiresConfirmation?: boolean;
}
