import { defineExtensionMessaging } from '@webext-core/messaging';
import type { SanitizedContext, AgentResponse } from '../vision/types';

export interface ProtocolMap {
  scanText(data: { text: string }): Promise<{ entities: Array<{ entity: string; word: string; score: number; start: number; end: number }> }>;
  scanImage(data: { imageUrl: string }): Promise<Array<{ label: string; score: number; box: { xmin: number; ymin: number; xmax: number; ymax: number } }>>;
  ensureOffscreen(): Promise<void>;
  getSanitizedContext(data: { task?: string; includeScreenshot?: boolean }): Promise<SanitizedContext>;
  executeAction(data: { action: AgentResponse['action'] }): Promise<{ ok: boolean; error?: string }>;
  agentStep(data: { context: SanitizedContext }): Promise<AgentResponse>;
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
