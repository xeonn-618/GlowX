// GlowX – UXP Host Bridge
// Runs in UXP context; has access to photoshop APIs but NO WebGL / ONNX.
// All Photoshop mutations must run inside executeAsModal.

/* eslint-disable */
const { app, core, imaging } = require("photoshop");

const webview = document.getElementById("app-view");

webview.addEventListener("message", async (event) => {
  const msg = event.message ?? event.data;
  if (!msg || !msg.type) return;

  // ── REQUEST_ACTIVE_LAYER ──────────────────────────────────────────────────
  if (msg.type === "REQUEST_ACTIVE_LAYER") {
    try {
      const doc = app.activeDocument;
      if (!doc || !doc.activeLayers.length) {
        throw new Error("No active layer selected.");
      }
      const layer = doc.activeLayers[0];

      await core.executeAsModal(
        async () => {
          /** @type {any} */
          const opts = { layerID: layer.id, applyAlpha: true };
          if (msg.maxPreviewDim) {
            opts.targetSize = {
              width: msg.maxPreviewDim,
              height: msg.maxPreviewDim,
            };
          }

          const pixelObj = await imaging.getPixels(opts);
          const rawData = await pixelObj.imageData.getData(); // Uint8Array RGBA

          // Slice to own ArrayBuffer so transfer doesn't invalidate the pixelObj
          const buffer = rawData.buffer.slice(
            rawData.byteOffset,
            rawData.byteOffset + rawData.byteLength
          );

          webview.postMessage({
            type: "LAYER_PIXELS",
            width: pixelObj.imageData.width,
            height: pixelObj.imageData.height,
            channels: pixelObj.imageData.components,
            buffer,
          });

          pixelObj.imageData.dispose();
        },
        { commandName: "GlowX – Read Layer Pixels" }
      );
    } catch (err) {
      webview.postMessage({ type: "ERROR", message: err.message });
    }
  }

  // ── COMMIT_LAYER ──────────────────────────────────────────────────────────
  if (msg.type === "COMMIT_LAYER") {
    try {
      await core.executeAsModal(
        async () => {
          const doc = app.activeDocument;
          const newLayer = await doc.createLayer({
            name: msg.name || "GlowX Effect",
            opacity: msg.opacity ?? 100,
            blendMode: msg.blendMode || "normal",
          });

          const uint8 = new Uint8Array(msg.buffer);
          const imageData = await imaging.createImageDataFromBuffer(uint8, {
            width: msg.width,
            height: msg.height,
            components: 4,
            colorSpace: "RGB",
          });

          await imaging.putPixels({ layerID: newLayer.id, imageData });
          imageData.dispose();
        },
        { commandName: `GlowX – Apply ${msg.name || "Effect"}` }
      );

      webview.postMessage({ type: "COMMIT_DONE" });
    } catch (err) {
      webview.postMessage({ type: "ERROR", message: err.message });
    }
  }
});
