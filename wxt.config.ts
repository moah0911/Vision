import { defineConfig } from 'wxt';

export default defineConfig({
  modules: [],
  manifest: {
    name: 'Vision Privacy Agent',
    description:
      'On-device vision agent: local ViT reads screen, redacts PII locally, sends only sanitized context to server.',
    version: '0.1.0',
    permissions: ['activeTab', 'storage', 'offscreen', 'scripting'],
    host_permissions: ['<all_urls>'],
    web_accessible_resources: [
      {
        resources: ['wasm/*', 'models/*', 'offscreen.html'],
        matches: ['<all_urls>'],
      },
    ],
    // Required for ONNX WASM threading in MV3
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    action: {
      default_title: 'Vision Privacy Agent',
      default_popup: 'popup.html',
    },
    icons: {
      128: 'icon/128.png',
    },
  },
  // WASM externalized: transformers.js loads ORT wasm from CDN at runtime, not bundled
  vite: () => ({
    build: {
      target: 'esnext',
      chunkSizeWarningLimit: 1500,
    },
    optimizeDeps: {
      exclude: ['@huggingface/transformers', 'onnxruntime-web'],
    },
    worker: {
      format: 'es',
    },
  }),
});
