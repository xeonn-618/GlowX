import type { UxpToWebViewMessage, WebViewToUxpMessage } from "@shared/protocol";

// Augment the global Window type for the uxpHost injected by UXP runtime.
declare global {
  interface Window {
    uxpHost?: {
      postMessage: (message: unknown) => void;
    };
  }
}

// ── Base64 Encoding & Decoding ────────────────────────────────────────────────
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function uint8ToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    try {
      let binary = "";
      const len = bytes.length;
      const chunkSize = 16384;
      for (let i = 0; i < len; i += chunkSize) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
      }
      return btoa(binary);
    } catch {
      // fallback
    }
  }

  let base64 = "";
  const len = bytes.length;
  const byteRemainder = len % 3;
  const mainLength = len - byteRemainder;

  let a: number, b: number, c: number, d: number;
  let chunk: number;

  for (let i = 0; i < mainLength; i += 3) {
    chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    a = (chunk & 16515072) >> 18;
    b = (chunk & 258048) >> 12;
    c = (chunk & 4032) >> 6;
    d = chunk & 63;
    base64 += B64_CHARS[a] + B64_CHARS[b] + B64_CHARS[c] + B64_CHARS[d];
  }

  if (byteRemainder === 1) {
    chunk = bytes[mainLength];
    a = (chunk & 252) >> 2;
    b = (chunk & 3) << 4;
    base64 += B64_CHARS[a] + B64_CHARS[b] + "==";
  } else if (byteRemainder === 2) {
    chunk = (bytes[mainLength] << 8) | bytes[mainLength + 1];
    a = (chunk & 64512) >> 10;
    b = (chunk & 1008) >> 4;
    c = (chunk & 15) << 2;
    base64 += B64_CHARS[a] + B64_CHARS[b] + B64_CHARS[c] + "=";
  }

  return base64;
}

export function base64ToUint8(base64: string): Uint8Array {
  if (typeof atob === "function") {
    try {
      const binary = atob(base64);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch {
      // fallback
    }
  }

  const lookup = new Uint8Array(256);
  for (let i = 0; i < B64_CHARS.length; i++) {
    lookup[B64_CHARS.charCodeAt(i)] = i;
  }

  let bufferLength = base64.length * 0.75;
  if (base64[base64.length - 1] === "=") {
    bufferLength--;
    if (base64[base64.length - 2] === "=") {
      bufferLength--;
    }
  }

  const bytes = new Uint8Array(bufferLength);
  let p = 0;
  for (let i = 0; i < base64.length; i += 4) {
    const encoded1 = lookup[base64.charCodeAt(i)];
    const encoded2 = lookup[base64.charCodeAt(i + 1)];
    const encoded3 = lookup[base64.charCodeAt(i + 2)];
    const encoded4 = lookup[base64.charCodeAt(i + 3)];

    bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
    if (base64[i + 2] !== "=") {
      bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
    }
    if (base64[i + 3] !== "=") {
      bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
    }
  }

  return bytes;
}

let msgCounter = 0;

/**
 * Send a typed message from the WebView to the UXP host.
 * Encodes pixel buffers to Base64 so UXP's IPC bridge never drops binary data.
 */
export function sendToUxp(message: WebViewToUxpMessage): void {
  if (window.uxpHost) {
    const _msgId = `${Date.now()}_${++msgCounter}_${Math.random().toString(36).slice(2, 7)}`;

    if (message.type === "COMMIT_LAYER") {
      let base64 = "";
      if (typeof message.buffer === "string") {
        base64 = message.buffer;
      } else if (message.buffer instanceof ArrayBuffer) {
        base64 = uint8ToBase64(new Uint8Array(message.buffer));
      } else if (ArrayBuffer.isView(message.buffer)) {
        base64 = uint8ToBase64(
          new Uint8Array(message.buffer.buffer, message.buffer.byteOffset, message.buffer.byteLength)
        );
      }

      window.uxpHost.postMessage({
        ...message,
        base64,
        buffer: base64, // Pass base64 string instead of raw ArrayBuffer across IPC
        _msgId,
      });
    } else {
      window.uxpHost.postMessage({
        ...message,
        _msgId,
      });
    }
  } else {
    console.warn("[GlowX bridge] window.uxpHost not available – running outside UXP?", message);
  }
}

/**
 * Subscribe to messages sent from the UXP host to the WebView.
 * Decodes Base64 buffers back into Uint8Array.
 * Returns an unsubscribe function for use in React cleanup.
 */
export function onUxpMessage(
  handler: (message: UxpToWebViewMessage) => void
): () => void {
  const listener = (event: MessageEvent) => {
    const rawPayload = (
      (event as unknown as { message?: unknown }).message ??
      event.data
    );

    let payload = rawPayload;
    if (typeof rawPayload === "string") {
      try {
        payload = JSON.parse(rawPayload);
      } catch {
        // not JSON
      }
    }

    if (payload && typeof payload === "object" && "type" in payload) {
      const msg = payload as Record<string, unknown>;

      if (msg.type === "LAYER_PIXELS") {
        let uint8: Uint8Array;
        if (typeof msg.base64 === "string") {
          uint8 = base64ToUint8(msg.base64);
        } else if (typeof msg.buffer === "string") {
          uint8 = base64ToUint8(msg.buffer);
        } else if (msg.buffer instanceof ArrayBuffer) {
          uint8 = new Uint8Array(msg.buffer);
        } else if (ArrayBuffer.isView(msg.buffer)) {
          uint8 = new Uint8Array(
            (msg.buffer as Uint8Array).buffer,
            (msg.buffer as Uint8Array).byteOffset,
            (msg.buffer as Uint8Array).byteLength
          );
        } else {
          uint8 = new Uint8Array(0);
        }

        handler({
          type: "LAYER_PIXELS",
          width: Number(msg.width),
          height: Number(msg.height),
          channels: Number(msg.channels),
          buffer: uint8,
        });
        return;
      }

      handler(payload as UxpToWebViewMessage);
    }
  };

  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
