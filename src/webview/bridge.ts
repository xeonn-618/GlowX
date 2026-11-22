import type { UxpToWebViewMessage, WebViewToUxpMessage } from "@shared/protocol";

// Augment the global Window type for the uxpHost injected by UXP runtime.
declare global {
  interface Window {
    uxpHost?: {
      postMessage: (message: unknown) => void;
    };
  }
}

/**
 * Send a typed message from the WebView to the UXP host.
 * No-ops gracefully when running outside of UXP (e.g., in browser dev mode).
 */
export function sendToUxp(message: WebViewToUxpMessage): void {
  if (window.uxpHost) {
    window.uxpHost.postMessage(message);
  } else {
    console.warn("[GlowX bridge] window.uxpHost not available – running outside UXP?", message);
  }
}

/**
 * Subscribe to messages sent from the UXP host to the WebView.
 * Returns an unsubscribe function for use in React cleanup.
 */
export function onUxpMessage(
  handler: (message: UxpToWebViewMessage) => void
): () => void {
  const listener = (event: MessageEvent) => {
    // UXP may deliver via event.data or the non-standard event.message property.
    const payload = (
      (event as unknown as { message?: UxpToWebViewMessage }).message ??
      event.data
    ) as UxpToWebViewMessage;

    if (payload && typeof payload === "object" && "type" in payload) {
      handler(payload);
    }
  };

  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
