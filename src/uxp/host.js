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

function getDocDimensions(doc) {
  let w = doc.width;
  let h = doc.height;
  if (typeof w === "object" && w !== null) {
    w = typeof w.as === "function" ? w.as("px") : (w.value || Number(w));
  }
  if (typeof h === "object" && h !== null) {
    h = typeof h.as === "function" ? h.as("px") : (h.value || Number(h));
  }
  return {
    width: Math.max(1, Math.round(Number(w) || 1000)),
    height: Math.max(1, Math.round(Number(h) || 1000)),
  };
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

      const { width: docW, height: docH } = getDocDimensions(doc);

      await core.executeAsModal(
        async () => {
          // 1. Read layer pixels WITHOUT sourceBounds or targetSize so Photoshop
          // returns the exact non-transparent pixel rectangle and sourceBounds.
          const opts = {
            layerID: layer.id,
            componentSize: 8,
            colorSpace: "RGB",
            applyAlpha: false,
          };

          const pixelObj = await imaging.getPixels(opts);
          const rawData = await pixelObj.imageData.getData(); // Uint8Array
          const channels = pixelObj.imageData.components;
          const layerW = pixelObj.imageData.width;
          const layerH = pixelObj.imageData.height;

          // Read sourceBounds (provides layer's exact document coordinates)
          const b = pixelObj.sourceBounds || layer.bounds || { left: 0, top: 0, right: docW, bottom: docH };
          let bLeft = typeof b.left === "object" && b.left !== null
            ? (typeof b.left.as === "function" ? b.left.as("px") : (b.left.value || Number(b.left)))
            : Number(b.left || 0);
          let bTop = typeof b.top === "object" && b.top !== null
            ? (typeof b.top.as === "function" ? b.top.as("px") : (b.top.value || Number(b.top)))
            : Number(b.top || 0);
          const left = Math.round(bLeft);
          const top = Math.round(bTop);

          // 2. Composite Layer into Full-Document Canvas Buffer (docW x docH)
          // Allocate zero-filled Uint8Array of size docW * docH * 4 (transparent black RGBA)
          const fullDocBuffer = new Uint8Array(docW * docH * 4);

          // Copy layer rows into fullDocBuffer offset by (left, top) with safe clipping
          const startY = Math.max(0, top);
          const endY = Math.min(docH, top + layerH);
          const startX = Math.max(0, left);
          const endX = Math.min(docW, left + layerW);

          if (startX < endX && startY < endY) {
            const copyWidth = endX - startX;
            for (let y = startY; y < endY; y++) {
              const layerY = y - top;
              const destRowOffset = (y * docW + startX) * 4;
              const srcRowOffset = (layerY * layerW + (startX - left)) * channels;

              if (channels === 4) {
                fullDocBuffer.set(
                  rawData.subarray(srcRowOffset, srcRowOffset + copyWidth * 4),
                  destRowOffset
                );
              } else {
                for (let x = 0; x < copyWidth; x++) {
                  const s = srcRowOffset + x * 3;
                  const d = destRowOffset + x * 4;
                  fullDocBuffer[d]     = rawData[s];
                  fullDocBuffer[d + 1] = rawData[s + 1];
                  fullDocBuffer[d + 2] = rawData[s + 2];
                  fullDocBuffer[d + 3] = 255;
                }
              }
            }
          }

          pixelObj.imageData.dispose();

          // 3. For preview (when maxPreviewDim is set), downsample the full-document RGBA buffer
          // preserving docW / docH aspect ratio via smooth bilinear box sampling in JS.
          let outBuffer = fullDocBuffer;
          let outW = docW;
          let outH = docH;

          if (msg.maxPreviewDim && (docW > msg.maxPreviewDim || docH > msg.maxPreviewDim)) {
            const scale = Math.min(1, msg.maxPreviewDim / Math.max(docW, docH));
            const previewW = Math.max(1, Math.round(docW * scale));
            const previewH = Math.max(1, Math.round(docH * scale));
            const previewBuffer = new Uint8Array(previewW * previewH * 4);

            const scaleX = docW / previewW;
            const scaleY = docH / previewH;

            for (let py = 0; py < previewH; py++) {
              const gy = py * scaleY;
              const y0 = Math.floor(gy);
              const y1 = Math.min(docH - 1, y0 + 1);
              const wy = gy - y0;
              const destRow = py * previewW * 4;

              for (let px = 0; px < previewW; px++) {
                const gx = px * scaleX;
                const x0 = Math.floor(gx);
                const x1 = Math.min(docW - 1, x0 + 1);
                const wx = gx - x0;

                const i00 = (y0 * docW + x0) * 4;
                const i10 = (y0 * docW + x1) * 4;
                const i01 = (y1 * docW + x0) * 4;
                const i11 = (y1 * docW + x1) * 4;

                const d = destRow + px * 4;

                const w00 = (1 - wx) * (1 - wy);
                const w10 = wx * (1 - wy);
                const w01 = (1 - wx) * wy;
                const w11 = wx * wy;

                previewBuffer[d]     = Math.round(fullDocBuffer[i00] * w00 + fullDocBuffer[i10] * w10 + fullDocBuffer[i01] * w01 + fullDocBuffer[i11] * w11);
                previewBuffer[d + 1] = Math.round(fullDocBuffer[i00 + 1] * w00 + fullDocBuffer[i10 + 1] * w10 + fullDocBuffer[i01 + 1] * w01 + fullDocBuffer[i11 + 1] * w11);
                previewBuffer[d + 2] = Math.round(fullDocBuffer[i00 + 2] * w00 + fullDocBuffer[i10 + 2] * w10 + fullDocBuffer[i01 + 2] * w01 + fullDocBuffer[i11 + 2] * w11);
                previewBuffer[d + 3] = Math.round(fullDocBuffer[i00 + 3] * w00 + fullDocBuffer[i10 + 3] * w10 + fullDocBuffer[i01 + 3] * w01 + fullDocBuffer[i11 + 3] * w11);
              }
            }

            outBuffer = previewBuffer;
            outW = previewW;
            outH = previewH;
          }

          const base64 = uint8ToBase64(outBuffer);

          sendToWebView({
            type: "LAYER_PIXELS",
            width: outW,
            height: outH,
            channels: 4,
            base64,
            purpose: msg.purpose || (msg.maxPreviewDim ? "PREVIEW" : "COMMIT"),
            docWidth: docW,
            docHeight: docH,
          });
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

          let newLayer;
          try {
            newLayer = await doc.createLayer({
              name: msg.name || "GlowX - Deep Glow",
              opacity: msg.opacity ?? 100,
              blendMode: msg.blendMode || "screen",
            });
          } catch (layerErr) {
            newLayer = await doc.createLayer({
              name: msg.name || "GlowX - Deep Glow",
              opacity: msg.opacity ?? 100,
              blendMode: "screen",
            });
          }

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

          // Buffer is already full-document size (docW x docH).
          // Calling putPixels without targetBounds offset stamps it at (0, 0)
          // covering the full canvas and matching document coordinates exactly.
          await imaging.putPixels({
            layerID: newLayer.id,
            imageData: imageData,
          });
          imageData.dispose();
        },
        { commandName: `GlowX – Apply ${msg.name || "Deep Glow"}` }
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
