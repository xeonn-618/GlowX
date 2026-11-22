// GlowX – UXP Host Bridge
// Runs in UXP context; has access to photoshop APIs but NO WebGL / ONNX.
// All Photoshop mutations must run inside executeAsModal.

/* eslint-disable */
const { app, core, imaging } = require("photoshop");

const webview = document.getElementById("app-view");

// ── Base64 Encoding & Decoding ────────────────────────────────────────────────
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function uint8ToBase64(bytes) {
  if (typeof btoa === "function") {
    try {
      let binary = "";
      const len = bytes.length;
      const chunkSize = 16384;
      for (let i = 0; i < len; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    } catch (e) {
      // fallback to manual encoding
    }
  }

  let base64 = "";
  const len = bytes.length;
  const byteRemainder = len % 3;
  const mainLength = len - byteRemainder;

  let a, b, c, d;
  let chunk;

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

function base64ToUint8(base64) {
  if (typeof atob === "function") {
    try {
      const binary = atob(base64);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch (e) {
      // fallback to manual decoding
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

// ── Helpers ──────────────────────────────────────────────────────────────────
function sendToWebView(payload) {
  try {
    const target = webview || document.getElementById("app-view");
    if (target && typeof target.postMessage === "function") {
      target.postMessage(payload);
    } else {
      console.error("[GlowX host] WebView element not found for postMessage");
    }
  } catch (err) {
    console.error("[GlowX host] sendToWebView failed:", err);
  }
}

// ── Deduplication Guard ──────────────────────────────────────────────────────
const processedMessageIds = new Set();
let lastSignature = "";
let lastTime = 0;

function isDuplicate(msg) {
  if (!msg || typeof msg !== "object") return true;

  if (msg._msgId) {
    if (processedMessageIds.has(msg._msgId)) {
      return true;
    }
    processedMessageIds.add(msg._msgId);
    if (processedMessageIds.size > 200) {
      const oldest = processedMessageIds.values().next().value;
      processedMessageIds.delete(oldest);
    }
    return false;
  }

  try {
    const sig = msg.type + "_" + JSON.stringify(msg);
    const now = Date.now();
    if (sig === lastSignature && now - lastTime < 300) {
      return true;
    }
    lastSignature = sig;
    lastTime = now;
    return false;
  } catch {
    return false;
  }
}

// ── Central Message Handler ──────────────────────────────────────────────────
async function handle(rawMsg) {
  let msg = rawMsg;
  if (typeof rawMsg === "string") {
    try {
      msg = JSON.parse(rawMsg);
    } catch {
      // not JSON string
    }
  }
  if (!msg || typeof msg !== "object" || !msg.type) return;

  if (isDuplicate(msg)) {
    return;
  }

  // ── REQUEST_ACTIVE_LAYER ──────────────────────────────────────────────────
  if (msg.type === "REQUEST_ACTIVE_LAYER") {
    try {
      const doc = app.activeDocument;
      if (!doc) {
        throw new Error("No active document found in Photoshop.");
      }
      if (!doc.activeLayers || !doc.activeLayers.length) {
        throw new Error("No active layer selected.");
      }
      const layer = doc.activeLayers[0];

      const docW = typeof doc.width === "number" ? doc.width : Math.round(Number(doc.width) || 1000);
      const docH = typeof doc.height === "number" ? doc.height : Math.round(Number(doc.height) || 1000);

      await core.executeAsModal(
        async () => {
          // Full-document bounds so layer aligns pixel-for-pixel across full canvas
          const sourceBounds = { left: 0, top: 0, right: docW, bottom: docH };

          /** @type {any} */
          const opts = {
            layerID: layer.id,
            componentSize: 8,
            colorSpace: "RGB",
            applyAlpha: false,
            sourceBounds: sourceBounds,
          };

          // Preserve Aspect Ratio on Preview:
          // When maxPreviewDim is set, compute aspect-correct dimensions
          if (msg.maxPreviewDim) {
            const boundsW = docW;
            const boundsH = docH;
            const scale = Math.min(1, msg.maxPreviewDim / Math.max(boundsW, boundsH));
            opts.targetSize = {
              width: Math.max(1, Math.round(boundsW * scale)),
              height: Math.max(1, Math.round(boundsH * scale)),
            };
          }

          const pixelObj = await imaging.getPixels(opts);
          const rawData = await pixelObj.imageData.getData(); // Uint8Array
          let channels = pixelObj.imageData.components;
          const width = pixelObj.imageData.width;
          const height = pixelObj.imageData.height;

          let pixelData = rawData;
          // If channels === 3, pad an opaque 255 alpha channel so buffer is strictly width * height * 4
          if (channels === 3) {
            const pixelCount = width * height;
            const rgba = new Uint8Array(pixelCount * 4);
            for (let i = 0, j = 0; i < pixelCount; i++, j += 3) {
              const dest = i * 4;
              rgba[dest]     = rawData[j];       // R
              rgba[dest + 1] = rawData[j + 1];   // G
              rgba[dest + 2] = rawData[j + 2];   // B
              rgba[dest + 3] = 255;             // A (opaque)
            }
            pixelData = rgba;
            channels = 4;
          }

          // Encode buffer as Base64 string so UXP's <webview> IPC bridge never drops binary buffers
          const base64 = uint8ToBase64(pixelData);

          sendToWebView({
            type: "LAYER_PIXELS",
            width,
            height,
            channels,
            base64,
            purpose: msg.purpose || (msg.maxPreviewDim ? "PREVIEW" : "COMMIT"),
            docWidth: docW,
            docHeight: docH,
          });

          pixelObj.imageData.dispose();
        },
        { commandName: "GlowX – Read Layer Pixels" }
      );
    } catch (err) {
      console.error("[GlowX host] REQUEST_ACTIVE_LAYER error:", err);
      sendToWebView({
        type: "ERROR",
        message: err ? (err.message || String(err)) : "Failed to read layer pixels",
      });
    }
  }

  // ── COMMIT_LAYER ──────────────────────────────────────────────────────────
  if (msg.type === "COMMIT_LAYER") {
    try {
      await core.executeAsModal(
        async () => {
          const doc = app.activeDocument;
          if (!doc) {
            throw new Error("No active document found in Photoshop.");
          }

          const docW = typeof doc.width === "number" ? doc.width : Math.round(Number(doc.width) || msg.width);
          const docH = typeof doc.height === "number" ? doc.height : Math.round(Number(doc.height) || msg.height);

          const newLayer = await doc.createLayer({
            name: msg.name || "GlowX Effect",
            opacity: msg.opacity ?? 100,
            blendMode: msg.blendMode || "screen",
          });

          let uint8;
          if (msg.base64) {
            uint8 = base64ToUint8(msg.base64);
          } else if (typeof msg.buffer === "string") {
            uint8 = base64ToUint8(msg.buffer);
          } else if (msg.buffer instanceof ArrayBuffer) {
            uint8 = new Uint8Array(msg.buffer);
          } else if (ArrayBuffer.isView(msg.buffer)) {
            uint8 = new Uint8Array(msg.buffer.buffer, msg.buffer.byteOffset, msg.buffer.byteLength);
          } else {
            throw new Error("Missing or invalid pixel buffer for COMMIT_LAYER");
          }

          const imageData = await imaging.createImageDataFromBuffer(uint8, {
            width: msg.width,
            height: msg.height,
            components: 4,
            colorSpace: "RGB",
          });

          // Pass targetBounds matching the full document bounds for pixel-for-pixel alignment
          const targetBounds = {
            left: 0,
            top: 0,
            right: docW,
            bottom: docH,
          };

          await imaging.putPixels({
            layerID: newLayer.id,
            imageData: imageData,
            targetBounds: targetBounds,
          });
          imageData.dispose();
        },
        { commandName: `GlowX – Apply ${msg.name || "Effect"}` }
      );

      sendToWebView({ type: "COMMIT_DONE" });
    } catch (err) {
      console.error("[GlowX host] COMMIT_LAYER error:", err);
      sendToWebView({
        type: "ERROR",
        message: err ? (err.message || String(err)) : "Failed to apply layer",
      });
    }
  }
}

// ── Dual Event Listeners with Deduplication ───────────────────────────────────
window.addEventListener("message", (e) => handle(e.data));

if (webview) {
  webview.addEventListener("message", (e) => handle(e.message ?? e.data));
} else {
  document.addEventListener("DOMContentLoaded", () => {
    const view = document.getElementById("app-view");
    if (view) {
      view.addEventListener("message", (e) => handle(e.message ?? e.data));
    }
  });
}
