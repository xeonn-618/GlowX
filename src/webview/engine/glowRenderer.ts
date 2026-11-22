// GlowX – Dual-Kawase HDR Bloom WebGL2 Shader Engine
// Features 6-level RGBA16F FBO pyramid, Threshold+Knee prefilter,
// 5-tap Dual-Kawase downsample/upsample with inverse-square falloff,
// Tint, Radial Chromatic Aberration, Exposure, and Soft Highlight Roll-Off.

export interface GlowEngineOptions {
  intensity: number;       // 0.0 – 5.0
  radius: number;          // 1.0 – 50.0
  threshold: number;       // 0.0 – 1.0
  knee: number;            // 0.0 – 1.0
  falloff: number;         // 0.1 – 3.0 (inverse-square decay)
  chromaShift: number;     // 0.0 – 20.0 (radial R/B shift)
  exposure: number;        // -3.0 – +3.0 EV
  rolloff: number;         // 0.0 – 2.0 (filmic shoulder)
  tint: string;            // hex color string e.g. "#f4f4f6"
  blendMode: "screen" | "linearDodge";
  viewMode: "composite" | "effectOnly" | "split";
  splitPos?: number;       // 0.0 – 1.0
  flipY?: boolean;
}

export const DEFAULT_GLOW_OPTIONS: GlowEngineOptions = {
  intensity: 1.5,
  radius: 16.0,
  threshold: 0.15,
  knee: 0.5,
  falloff: 1.0,
  chromaShift: 2.0,
  exposure: 0.0,
  rolloff: 1.0,
  tint: "#f4f4f6",
  blendMode: "screen",
  viewMode: "composite",
  splitPos: 0.5,
  flipY: true,
};

// ── GLSL Shaders ─────────────────────────────────────────────────────────────

const VS_QUAD = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Prefilter: isolates highlights using soft knee curve
const FS_PREFILTER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_image;
uniform float u_threshold;
uniform float u_knee;

void main() {
  vec4 color = texture(u_image, v_uv);
  float brightness = max(color.r, max(color.g, color.b));
  
  // Soft knee: smooth transition around threshold to prevent hard staircasing
  float knee = max(0.0001, u_threshold * u_knee);
  float soft = brightness - u_threshold + knee;
  soft = clamp(soft, 0.0, 2.0 * knee);
  soft = (soft * soft) / (4.0 * knee + 0.00001);
  
  float contribution = max(soft, brightness - u_threshold) / max(brightness, 0.00001);
  contribution = clamp(contribution, 0.0, 1.0);
  
  fragColor = vec4(color.rgb * contribution, color.a * contribution);
}
`;

// Dual-Kawase Downsample: 5 taps (center 4.0, 4 diagonal corners 1.0 each)
const FS_DOWNSAMPLE = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_image;
uniform vec2 u_texelSize;
uniform float u_offset;

void main() {
  vec2 halfPixel = u_texelSize * u_offset;
  
  vec4 sum = texture(u_image, v_uv) * 4.0;
  sum += texture(u_image, v_uv - halfPixel);
  sum += texture(u_image, v_uv + halfPixel);
  sum += texture(u_image, v_uv + vec2(halfPixel.x, -halfPixel.y));
  sum += texture(u_image, v_uv + vec2(-halfPixel.x, halfPixel.y));
  
  fragColor = sum * 0.125;
}
`;

// Dual-Kawase Upsample: 5-tap tent filter with inverse-square falloff accumulation
const FS_UPSAMPLE = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_currentLevel;
uniform sampler2D u_lowerLevel;
uniform vec2 u_texelSize;
uniform float u_offset;
uniform float u_weight;

void main() {
  vec2 halfPixel = u_texelSize * u_offset;
  
  // 5-tap Dual Kawase upsample kernel
  vec4 lower = texture(u_lowerLevel, v_uv) * 4.0;
  lower += texture(u_lowerLevel, v_uv + vec2(-halfPixel.x * 2.0, 0.0));
  lower += texture(u_lowerLevel, v_uv + vec2(halfPixel.x * 2.0, 0.0));
  lower += texture(u_lowerLevel, v_uv + vec2(0.0, -halfPixel.y * 2.0));
  lower += texture(u_lowerLevel, v_uv + vec2(0.0, halfPixel.y * 2.0));
  lower += texture(u_lowerLevel, v_uv + vec2(-halfPixel.x, -halfPixel.y)) * 2.0;
  lower += texture(u_lowerLevel, v_uv + vec2(halfPixel.x, -halfPixel.y)) * 2.0;
  lower += texture(u_lowerLevel, v_uv + vec2(-halfPixel.x, halfPixel.y)) * 2.0;
  lower += texture(u_lowerLevel, v_uv + vec2(halfPixel.x, halfPixel.y)) * 2.0;
  lower *= (1.0 / 16.0);
  
  vec4 current = texture(u_currentLevel, v_uv);
  fragColor = current + lower * u_weight;
}
`;

// Final Composite: Tint, Radial Chromatic Aberration, Exposure, Soft Roll-Off,
// Screen vs Linear Dodge blend, and Split wipe view.
const FS_COMPOSITE = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_baseImage;
uniform sampler2D u_glowImage;
uniform vec2 u_resolution;

uniform float u_intensity;
uniform vec3 u_tint;
uniform float u_chromaShift;
uniform float u_exposure;
uniform float u_rolloff;

uniform int u_blendMode; // 0 = Screen, 1 = Linear Dodge
uniform int u_viewMode;  // 0 = Composite, 1 = Effect Only, 2 = Split
uniform float u_splitPos;
uniform bool u_flipY;

void main() {
  vec2 uv = v_uv;
  if (u_flipY) {
    uv.y = 1.0 - uv.y;
  }
  
  vec4 baseColor = texture(u_baseImage, uv);
  
  // Radial Chromatic Aberration (R/B shift)
  vec2 center = vec2(0.5, 0.5);
  vec2 dir = uv - center;
  float dist = length(dir);
  vec2 caOffset = normalize(dir + 0.00001) * (dist * u_chromaShift * 0.012);
  
  float glowR = texture(u_glowImage, uv + caOffset).r;
  float glowG = texture(u_glowImage, uv).g;
  float glowB = texture(u_glowImage, uv - caOffset).b;
  float glowA = texture(u_glowImage, uv).a;
  vec3 glowRgb = vec3(glowR, glowG, glowB);
  
  // Tint application
  glowRgb = glowRgb * u_tint;
  
  // Exposure (2^EV)
  glowRgb = glowRgb * exp2(u_exposure);
  
  // Master Intensity
  glowRgb = glowRgb * u_intensity;
  float glowAlpha = glowA * u_intensity;
  
  // Soft highlight roll-off (filmic shoulder to prevent harsh blown highlights)
  if (u_rolloff > 0.001) {
    float shoulder = u_rolloff * 0.65;
    glowRgb = glowRgb / (1.0 + glowRgb * shoulder);
  }
  
  // Blend calculations
  vec3 compositeRgb;
  if (u_blendMode == 1) {
    // Linear Dodge (Add)
    compositeRgb = baseColor.rgb + glowRgb;
  } else {
    // Screen: 1 - (1 - base) * (1 - glow)
    compositeRgb = 1.0 - (1.0 - clamp(baseColor.rgb, 0.0, 1.0)) * (1.0 - clamp(glowRgb, 0.0, 1.0));
  }
  
  float finalAlpha = max(baseColor.a, clamp(glowAlpha, 0.0, 1.0));
  
  if (u_viewMode == 1) {
    // Effect Only
    fragColor = vec4(clamp(glowRgb, 0.0, 1.0), clamp(glowAlpha, 0.0, 1.0));
  } else if (u_viewMode == 2) {
    // Split View (Original left, Composite right with 1px divider)
    float pixelWidth = 1.0 / u_resolution.x;
    if (abs(uv.x - u_splitPos) < pixelWidth * 1.5) {
      fragColor = vec4(1.0, 1.0, 1.0, 1.0);
    } else if (uv.x < u_splitPos) {
      fragColor = baseColor;
    } else {
      fragColor = vec4(clamp(compositeRgb, 0.0, 1.0), finalAlpha);
    }
  } else {
    // Composite
    fragColor = vec4(clamp(compositeRgb, 0.0, 1.0), finalAlpha);
  }
}
`;

// ── WebGL Helper Functions ───────────────────────────────────────────────────

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create shader");
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
  if (!program) throw new Error("Unable to create program");
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

function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.replace("#", "").trim();
  if (cleaned.length === 3) {
    const r = parseInt(cleaned[0] + cleaned[0], 16) / 255;
    const g = parseInt(cleaned[1] + cleaned[1], 16) / 255;
    const b = parseInt(cleaned[2] + cleaned[2], 16) / 255;
    return [r, g, b];
  }
  if (cleaned.length === 6) {
    const r = parseInt(cleaned.slice(0, 2), 16) / 255;
    const g = parseInt(cleaned.slice(2, 4), 16) / 255;
    const b = parseInt(cleaned.slice(4, 6), 16) / 255;
    return [r, g, b];
  }
  return [1.0, 1.0, 1.0];
}

// ── 6-Level Dual-Kawase HDR Bloom Engine ──────────────────────────────────────

interface PyramidLevel {
  width: number;
  height: number;
  downTexture: WebGLTexture;
  downFbo: WebGLFramebuffer;
  upTexture: WebGLTexture;
  upFbo: WebGLFramebuffer;
}

export class DualKawaseGlowEngine {
  private gl: WebGL2RenderingContext;
  private quadBuffer: WebGLBuffer;
  
  // Programs
  private prefilterProg: WebGLProgram;
  private downsampleProg: WebGLProgram;
  private upsampleProg: WebGLProgram;
  private compositeProg: WebGLProgram;

  // Input Base Texture
  private baseTexture: WebGLTexture | null = null;
  private baseWidth: number = 0;
  private baseHeight: number = 0;

  // 6-Level RGBA16F Pyramid
  private pyramid: PyramidLevel[] = [];
  private hasFloatExtension: boolean = false;
  private internalFormat: number;
  private textureType: number;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;

    // Enable EXT_color_buffer_float for HDR RGBA16F rendering
    const extFloat = gl.getExtension("EXT_color_buffer_float");
    gl.getExtension("OES_texture_float_linear");
    gl.getExtension("OES_texture_half_float_linear");

    this.hasFloatExtension = !!extFloat;
    this.internalFormat = this.hasFloatExtension ? gl.RGBA16F : gl.RGBA8;
    this.textureType = this.hasFloatExtension ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    // Compile programs
    this.prefilterProg = createProgram(gl, VS_QUAD, FS_PREFILTER);
    this.downsampleProg = createProgram(gl, VS_QUAD, FS_DOWNSAMPLE);
    this.upsampleProg = createProgram(gl, VS_QUAD, FS_UPSAMPLE);
    this.compositeProg = createProgram(gl, VS_QUAD, FS_COMPOSITE);

    // Quad geometry
    const buf = gl.createBuffer();
    if (!buf) throw new Error("Failed to create quad buffer");
    this.quadBuffer = buf;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );
  }

  private setupQuadAttributes(program: WebGLProgram) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const loc = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  private allocatePyramid(width: number, height: number) {
    const gl = this.gl;

    // Clean up existing levels if already allocated
    this.destroyPyramid();

    let curW = Math.max(1, Math.floor(width / 2));
    let curH = Math.max(1, Math.floor(height / 2));

    for (let i = 0; i < 6; i++) {
      // Downsample texture & FBO
      const downTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, downTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        this.internalFormat,
        curW,
        curH,
        0,
        gl.RGBA,
        this.textureType,
        null
      );

      const downFbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, downFbo);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        downTex,
        0
      );

      // Upsample texture & FBO
      const upTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, upTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        this.internalFormat,
        curW,
        curH,
        0,
        gl.RGBA,
        this.textureType,
        null
      );

      const upFbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, upFbo);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        upTex,
        0
      );

      this.pyramid.push({
        width: curW,
        height: curH,
        downTexture: downTex,
        downFbo: downFbo,
        upTexture: upTex,
        upFbo: upFbo,
      });

      curW = Math.max(1, Math.floor(curW / 2));
      curH = Math.max(1, Math.floor(curH / 2));
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  public setInputPixels(pixels: Uint8Array, width: number, height: number): void {
    const gl = this.gl;
    this.baseWidth = width;
    this.baseHeight = height;

    if (!this.baseTexture) {
      this.baseTexture = gl.createTexture();
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.baseTexture);
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

    // Reallocate pyramid if dimensions changed
    this.allocatePyramid(width, height);
  }

  public executePipeline(
    options: GlowEngineOptions,
    targetFbo: WebGLFramebuffer | null = null,
    targetWidth: number = this.baseWidth,
    targetHeight: number = this.baseHeight
  ): void {
    const gl = this.gl;
    if (!this.baseTexture || this.pyramid.length < 6) return;

    const {
      intensity,
      radius,
      threshold,
      knee,
      falloff,
      chromaShift,
      exposure,
      rolloff,
      tint,
      blendMode,
      viewMode,
      splitPos = 0.5,
      flipY = true,
    } = options;

    const spreadOffset = Math.max(0.5, radius * 0.12);

    // ── 1. Prefilter Pass (Input → Level 0 Down FBO) ─────────────────────────
    const lvl0 = this.pyramid[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, lvl0.downFbo);
    gl.viewport(0, 0, lvl0.width, lvl0.height);
    gl.useProgram(this.prefilterProg);
    this.setupQuadAttributes(this.prefilterProg);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.baseTexture);
    gl.uniform1i(gl.getUniformLocation(this.prefilterProg, "u_image"), 0);
    gl.uniform1f(gl.getUniformLocation(this.prefilterProg, "u_threshold"), threshold);
    gl.uniform1f(gl.getUniformLocation(this.prefilterProg, "u_knee"), knee);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // ── 2. Downsample Passes (Levels 1 to 5) ─────────────────────────────────
    gl.useProgram(this.downsampleProg);
    this.setupQuadAttributes(this.downsampleProg);

    for (let i = 1; i < 6; i++) {
      const src = this.pyramid[i - 1];
      const dst = this.pyramid[i];

      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.downFbo);
      gl.viewport(0, 0, dst.width, dst.height);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.downTexture);
      gl.uniform1i(gl.getUniformLocation(this.downsampleProg, "u_image"), 0);
      gl.uniform2f(
        gl.getUniformLocation(this.downsampleProg, "u_texelSize"),
        1.0 / src.width,
        1.0 / src.height
      );
      gl.uniform1f(gl.getUniformLocation(this.downsampleProg, "u_offset"), spreadOffset);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // ── 3. Upsample Passes (Levels 4 down to 0) ──────────────────────────────
    gl.useProgram(this.upsampleProg);
    this.setupQuadAttributes(this.upsampleProg);

    for (let i = 4; i >= 0; i--) {
      const current = this.pyramid[i];
      const lower = (i === 4) ? this.pyramid[5].downTexture : this.pyramid[i + 1].upTexture;
      const lowerW = (i === 4) ? this.pyramid[5].width : this.pyramid[i + 1].width;
      const lowerH = (i === 4) ? this.pyramid[5].height : this.pyramid[i + 1].height;

      gl.bindFramebuffer(gl.FRAMEBUFFER, current.upFbo);
      gl.viewport(0, 0, current.width, current.height);

      // Bind current level from downsample pyramid
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, current.downTexture);
      gl.uniform1i(gl.getUniformLocation(this.upsampleProg, "u_currentLevel"), 0);

      // Bind lower level from previous upsample
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, lower);
      gl.uniform1i(gl.getUniformLocation(this.upsampleProg, "u_lowerLevel"), 1);

      gl.uniform2f(
        gl.getUniformLocation(this.upsampleProg, "u_texelSize"),
        1.0 / lowerW,
        1.0 / lowerH
      );
      gl.uniform1f(gl.getUniformLocation(this.upsampleProg, "u_offset"), spreadOffset);

      // Inverse-square falloff weight: 1.0 / (1.0 + level * falloff)
      const levelWeight = 1.0 / (1.0 + i * falloff);
      gl.uniform1f(gl.getUniformLocation(this.upsampleProg, "u_weight"), levelWeight);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // ── 4. Final Composite Pass ──────────────────────────────────────────────
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    gl.viewport(0, 0, targetWidth, targetHeight);
    gl.useProgram(this.compositeProg);
    this.setupQuadAttributes(this.compositeProg);

    // Unit 0: Base image
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.baseTexture);
    gl.uniform1i(gl.getUniformLocation(this.compositeProg, "u_baseImage"), 0);

    // Unit 1: Deep glow texture (Level 0 accumulated upsample)
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.pyramid[0].upTexture);
    gl.uniform1i(gl.getUniformLocation(this.compositeProg, "u_glowImage"), 1);

    // Uniforms
    gl.uniform2f(
      gl.getUniformLocation(this.compositeProg, "u_resolution"),
      targetWidth,
      targetHeight
    );
    gl.uniform1f(gl.getUniformLocation(this.compositeProg, "u_intensity"), intensity);

    const [tr, tg, tb] = hexToRgb(tint);
    gl.uniform3f(gl.getUniformLocation(this.compositeProg, "u_tint"), tr, tg, tb);

    gl.uniform1f(gl.getUniformLocation(this.compositeProg, "u_chromaShift"), chromaShift);
    gl.uniform1f(gl.getUniformLocation(this.compositeProg, "u_exposure"), exposure);
    gl.uniform1f(gl.getUniformLocation(this.compositeProg, "u_rolloff"), rolloff);

    gl.uniform1i(
      gl.getUniformLocation(this.compositeProg, "u_blendMode"),
      blendMode === "linearDodge" ? 1 : 0
    );

    let viewModeInt = 0;
    if (viewMode === "effectOnly") viewModeInt = 1;
    else if (viewMode === "split") viewModeInt = 2;
    gl.uniform1i(gl.getUniformLocation(this.compositeProg, "u_viewMode"), viewModeInt);

    gl.uniform1f(gl.getUniformLocation(this.compositeProg, "u_splitPos"), splitPos);
    gl.uniform1i(gl.getUniformLocation(this.compositeProg, "u_flipY"), flipY ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private destroyPyramid() {
    const gl = this.gl;
    for (const lvl of this.pyramid) {
      gl.deleteTexture(lvl.downTexture);
      gl.deleteFramebuffer(lvl.downFbo);
      gl.deleteTexture(lvl.upTexture);
      gl.deleteFramebuffer(lvl.upFbo);
    }
    this.pyramid = [];
  }

  public dispose() {
    const gl = this.gl;
    this.destroyPyramid();
    if (this.baseTexture) {
      gl.deleteTexture(this.baseTexture);
      this.baseTexture = null;
    }
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteProgram(this.prefilterProg);
    gl.deleteProgram(this.downsampleProg);
    gl.deleteProgram(this.upsampleProg);
    gl.deleteProgram(this.compositeProg);
  }
}

// ── Standalone Offscreen Full-Res Render Function ────────────────────────────

export function renderGlowOffscreen(
  pixels: Uint8Array,
  width: number,
  height: number,
  options: Partial<GlowEngineOptions> = {}
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
    throw new Error("WebGL2 context could not be created for full-res render.");
  }

  const engine = new DualKawaseGlowEngine(gl);
  engine.setInputPixels(pixels, width, height);

  const fullOpts: GlowEngineOptions = {
    ...DEFAULT_GLOW_OPTIONS,
    ...options,
    // Effect Only for Photoshop commit so Photoshop blends the layer via Screen or Linear Dodge
    viewMode: "effectOnly",
    // flipY: false aligns row 0 to Photoshop top-left row for imaging.putPixels()
    flipY: false,
  };

  engine.executePipeline(fullOpts, null, width, height);

  const output = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, output);

  engine.dispose();
  return output;
}
