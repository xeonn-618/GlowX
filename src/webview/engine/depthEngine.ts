// Depth Anything V2 Engine for GlowX Depth Z-Gating
// Uses @huggingface/transformers pipeline with onnx-community/depth-anything-v2-small
// Automatic WebGPU device selection with fallback to WASM.
// Pipeline singleton and depth map results are cached in memory for locked 60fps slider interactions.

import { pipeline, env, RawImage } from "@huggingface/transformers";

// Configure transformers.js environment for browser / webview execution
env.allowLocalModels = false;

export interface DepthData {
  normalizedDepth: Float32Array; // values in [0.0, 1.0]
  width: number;
  height: number;
}

// Pipeline singleton cache
let depthPipelinePromise: Promise<any> | null = null;
let cachedPipeline: any = null;

/**
 * Initializes and caches the Depth Anything V2 pipeline singleton.
 * Attempts WebGPU first, falling back to WASM if unavailable.
 */
export async function getDepthPipeline(
  onProgress?: (statusText: string) => void
): Promise<any> {
  if (cachedPipeline) {
    return cachedPipeline;
  }

  if (depthPipelinePromise) {
    return depthPipelinePromise;
  }

  depthPipelinePromise = (async () => {
    onProgress?.("Initializing WebGPU device...");
    try {
      const pipe = await pipeline(
        "depth-estimation",
        "onnx-community/depth-anything-v2-small",
        {
          device: "webgpu",
          progress_callback: (info: any) => {
            if (info?.status === "progress" && typeof info.progress === "number") {
              onProgress?.(`Loading model weights: ${Math.round(info.progress)}%`);
            } else if (info?.status === "initiate") {
              onProgress?.(`Loading ${info.file || "weights"}...`);
            } else if (info?.status === "ready") {
              onProgress?.("Model ready");
            }
          },
        }
      );
      cachedPipeline = pipe;
      return pipe;
    } catch (webgpuErr) {
      console.warn(
        "[DepthEngine] WebGPU unavailable or failed, falling back to WASM:",
        webgpuErr
      );
      onProgress?.("WebGPU unavailable, falling back to WASM...");
      const pipe = await pipeline(
        "depth-estimation",
        "onnx-community/depth-anything-v2-small",
        {
          device: "wasm",
          progress_callback: (info: any) => {
            if (info?.status === "progress" && typeof info.progress === "number") {
              onProgress?.(`Loading model weights (WASM): ${Math.round(info.progress)}%`);
            } else if (info?.status === "initiate") {
              onProgress?.(`Loading ${info.file || "weights"}...`);
            } else if (info?.status === "ready") {
              onProgress?.("Model ready");
            }
          },
        }
      );
      cachedPipeline = pipe;
      return pipe;
    } finally {
      depthPipelinePromise = null;
    }
  })();

  return depthPipelinePromise;
}

/**
 * Runs depth estimation on an RGBA Uint8Array image buffer.
 * Returns normalized Float32Array depth data in [0.0, 1.0].
 */
export async function estimateDepth(
  rgbaPixels: Uint8Array,
  width: number,
  height: number,
  onProgress?: (statusText: string) => void
): Promise<DepthData> {
  const pipe = await getDepthPipeline(onProgress);

  onProgress?.("Running depth inference...");
  const rawImage = new RawImage(rgbaPixels, width, height, 4);
  const result = await pipe(rawImage);

  onProgress?.("Normalizing depth map...");
  const totalPixels = width * height;
  const normalizedDepth = new Float32Array(totalPixels);

  if (result?.depth?.data && result.depth.data.length === totalPixels) {
    const depthBytes: Uint8Array = result.depth.data;
    for (let i = 0; i < totalPixels; i++) {
      normalizedDepth[i] = depthBytes[i] / 255.0;
    }
  } else if (result?.predicted_depth?.data) {
    const rawTensorData = result.predicted_depth.data as Float32Array;
    let minVal = Infinity;
    let maxVal = -Infinity;
    for (let i = 0; i < rawTensorData.length; i++) {
      const v = rawTensorData[i];
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
    const range = Math.max(0.0001, maxVal - minVal);
    const count = Math.min(totalPixels, rawTensorData.length);
    for (let i = 0; i < count; i++) {
      normalizedDepth[i] = (rawTensorData[i] - minVal) / range;
    }
  } else {
    throw new Error("Depth pipeline did not return recognized depth data.");
  }

  onProgress?.("Depth map ready");
  return {
    normalizedDepth,
    width,
    height,
  };
}
