// GlowX – WebGL2 Glow & Bloom Shader Engine
// Provides high-performance GPU glow rendering for preview and full-res offscreen export.

const VS_SOURCE = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FS_SOURCE = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_intensity;
uniform float u_radius;
uniform float u_threshold;
uniform bool u_flipForScreen;

float getLuminance(vec3 color) {
  return dot(color, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec2 uv = v_uv;
  if (u_flipForScreen) {
    uv.y = 1.0 - uv.y;
  }

  vec4 baseColor = texture(u_image, uv);

  vec2 texelSize = 1.0 / u_resolution;
  vec4 glowSum = vec4(0.0);
  float totalWeight = 0.0;

  // 16-sample golden-angle disk kernel for smooth radial bloom without banding
  const int NUM_SAMPLES = 16;
  const float GOLDEN_ANGLE = 2.39996323;

  for (int i = 0; i < NUM_SAMPLES; i++) {
    float fi = float(i);
    float r = sqrt((fi + 0.5) / float(NUM_SAMPLES));
    float theta = fi * GOLDEN_ANGLE;
    vec2 offset = vec2(cos(theta), sin(theta)) * r * u_radius * texelSize;

    vec4 sampleColor = texture(u_image, uv + offset);

    float lum = max(getLuminance(sampleColor.rgb), sampleColor.a);
    float glowFactor = smoothstep(u_threshold, u_threshold + 0.25, lum);

    float weight = 1.0 - r * 0.5;
    glowSum += sampleColor * glowFactor * weight;
    totalWeight += weight;
  }

  vec4 avgGlow = (totalWeight > 0.0) ? (glowSum / totalWeight) : vec4(0.0);

  vec3 glowRgb = avgGlow.rgb * u_intensity;
  float glowAlpha = min(1.0, avgGlow.a * u_intensity);

  // Additive / Screen composite: original layer + luminous glow
  vec3 finalRgb = baseColor.rgb + glowRgb;
  float finalAlpha = max(baseColor.a, glowAlpha);

  fragColor = vec4(clamp(finalRgb, 0.0, 1.0), clamp(finalAlpha, 0.0, 1.0));
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${info}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to create WebGL program");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link error: ${info}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

export interface GlowOptions {
  intensity?: number;
  radius?: number;
  threshold?: number;
  flipForScreen?: boolean;
}

/**
 * Execute a single WebGL2 glow pass on the given context.
 */
export function executeGlowPass(
  gl: WebGL2RenderingContext,
  pixels: Uint8Array,
  width: number,
  height: number,
  options: GlowOptions = {}
): void {
  const {
    intensity = 1.8,
    radius = 16.0,
    threshold = 0.05,
    flipForScreen = false,
  } = options;

  gl.viewport(0, 0, width, height);

  const program = createProgram(gl, VS_SOURCE, FS_SOURCE);
  gl.useProgram(program);

  // Fullscreen quad
  const posBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW
  );

  const posLoc = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  // Input RGBA Texture
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels
  );

  // Uniforms
  gl.uniform1i(gl.getUniformLocation(program, "u_image"), 0);
  gl.uniform2f(gl.getUniformLocation(program, "u_resolution"), width, height);
  gl.uniform1f(gl.getUniformLocation(program, "u_intensity"), intensity);
  gl.uniform1f(gl.getUniformLocation(program, "u_radius"), radius);
  gl.uniform1f(gl.getUniformLocation(program, "u_threshold"), threshold);
  gl.uniform1i(gl.getUniformLocation(program, "u_flipForScreen"), flipForScreen ? 1 : 0);

  // Render quad
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  // Clean up
  gl.deleteTexture(texture);
  gl.deleteBuffer(posBuffer);
  gl.deleteProgram(program);
}

/**
 * Render glow pass onto the on-screen preview canvas with screen-correct Y orientation.
 */
export function renderGlowToCanvas(
  canvas: HTMLCanvasElement,
  pixels: Uint8Array,
  width: number,
  height: number,
  options?: Omit<GlowOptions, "flipForScreen">
): void {
  canvas.width = width;
  canvas.height = height;

  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  });

  if (!gl) {
    // 2D fallback
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const rgba = new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.byteLength);
      const imgData = new ImageData(rgba, width, height);
      ctx.putImageData(imgData, 0, 0);
    }
    return;
  }

  executeGlowPass(gl, pixels, width, height, {
    ...options,
    flipForScreen: true,
  });
}

/**
 * Run WebGL2 glow shader pass offscreen at full document resolution and return RGBA buffer.
 * Aligns row 0 to Photoshop top row for imaging.putPixels().
 */
export function renderGlowOffscreen(
  pixels: Uint8Array,
  width: number,
  height: number,
  options?: Omit<GlowOptions, "flipForScreen">
): Uint8Array {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  });

  if (!gl) {
    throw new Error("WebGL2 is not supported for full-resolution offscreen render.");
  }

  // flipForScreen: false ensures gl.readPixels reads row 0 (Photoshop top row) first
  executeGlowPass(gl, pixels, width, height, {
    ...options,
    flipForScreen: false,
  });

  const output = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, output);
  return output;
}
