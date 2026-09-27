/**
 * Typed message protocol.
 *
 * Every extension message goes through here. Previously the codebase hand-rolled
 * `chrome.runtime.sendMessage({ type: 'X', ... } as any)` at roughly twenty call sites and
 * matched on `msg.type` in three listeners, which meant no message shape was ever checked and
 * a listener that returned `true` for a type it did not handle left its port open forever.
 *
 * Registering one handler per message name makes that class of bug structurally impossible:
 * a listener can only claim the message it declares.
 *
 * Return types are declared WITHOUT `Promise<>`. The library wraps a handler's return in
 * MaybePromise<Promise<T>> itself, so writing Promise<T> here double-wraps it and callers end
 * up awaiting a promise of a promise.
 */
import { defineExtensionMessaging } from '@webext-core/messaging';
import type { AgentResponse, SanitizedContext } from '../vision/types';

/** Result of running one agent action in the page. */
export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface CaptureResult {
  dataUrl: string | null;
  error?: string;
}

export interface Entity {
  entity: string;
  word: string;
  score: number;
  start: number;
  end: number;
}

export interface Detection {
  label: string;
  score: number;
  box: { xmin: number; ymin: number; xmax: number; ymax: number };
}

/**
 * Uniform result for fallible messages.
 *
 * A union of `{ok:true}` and `{ok:false,error}` makes `result.error` inaccessible to consumers
 * without a narrowing guard, so every fallible message returns this shape instead.
 */
export interface Result<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface QuantSelection extends Result {
  mode?: string;
  /** Dtype actually used per backend; the requested mode is not always honoured. */
  effective?: { requested: string; webgpu: string; wasm: string };
}

export interface ScanFailure {
  ok: false;
  error: string;
}

export interface ProtocolMap {
  // ---- popup / content -> background -------------------------------------
  ensureOffscreen(data: void): { ok: boolean };
  captureScreenshot(data: void): CaptureResult;
  /** Ask the agent server for the next action. Only sanitized data is sent. */
  agentStep(data: { context: SanitizedContext }): AgentResponse;
  /**
   * Background-orchestrated scan. Survives the popup closing on blur, and reports progress
   * through chrome.storage so a reopened popup can pick it up.
   */
  startScan(data: { tabId: number; task?: string; includeScreenshot?: boolean }): SanitizedContext | ScanFailure;

  // ---- content -> background -> offscreen ---------------------------------
  scanText(data: { text: string }): Result<Entity[]>;
  scanImage(data: { imageUrl: string }): Result<Detection[]>;

  // ---- background -> offscreen -------------------------------------------
  offscreenScanText(data: { text: string }): Result<Entity[]>;
  offscreenScanImage(data: { imageUrl: string }): Result<Detection[]>;
  offscreenPreload(data: void): Result;
  offscreenDispose(data: void): Result & { freed: boolean };
  offscreenSetQuant(data: { mode: string }): QuantSelection;
  offscreenStorageEstimate(data: void): Result<{
    quota?: number;
    usage?: number;
    usageDetails?: Record<string, number>;
  }>;
  /** Offscreen document announces itself on load. */
  offscreenReady(data: void): { ok: boolean };

  // ---- popup / background -> content script -------------------------------
  getSanitizedContext(data: { task?: string; includeScreenshot?: boolean }): SanitizedContext;
  executeAction(data: { action: AgentResponse['action'] }): ActionResult;
  clearMasks(data: void): { ok: boolean };
  ping(data: void): { ok: boolean; url: string };
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
