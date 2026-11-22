// GlowX – Dual-Kawase HDR Bloom WebGL2 Shader Engine
// Features 6-level RGBA16F FBO pyramid, Premultiplied Alpha Threshold+Knee prefilter,
// Hue-Targeted Glow / Color Keying, Depth Anything V2 Z-Gating,
// Dual-Tone Core & Halo Tint, Analog Film Halation,
// Anamorphic stretch & Angle directional offsets, Inverse-square falloff,
// Radial Chromatic Aberration, Saturation, Exposure, Soft Roll-Off, and Anti-Banding Dither.

import type { DepthData } from "./depthEngine";

export interface GlowEngineOptions {
  intensity: number;          // 0.0 – 5.0
  radius: number;             // 1.0 – 50.0
  threshold: number;          // 0.0 – 1.0
  knee: number;               // 0.0 – 1.0
  falloff: number;            // 0.1 – 3.0 (inverse-square decay)
  aspectRatio: number;        // 0.2 – 5.0 (horizontal/vertical anamorphic stretch)
  angle: number;              // -90 – +90 degrees
  chromaShift: number;        // 0.0 – 20.0 (radial R/B shift)
  exposure: number;           // -3.0 – +3.0 EV
  saturation: number;         // 0.0 – 3.0 (color vibrancy)
  rolloff: number;            // 0.0 – 2.0 (filmic shoulder)
  dither: number;             // 0.0 – 2.0 (anti-banding screen dither)
  coreTint: string;           // hex color for inner tight mips 0-2 (e.g. "#ffffff")
  haloTint: string;           // hex color for outer wide mips 3-5 (e.g. "#7dd3fc")
  tint?: string;              // legacy fallback
  blendMode: "screen" | "linearDodge";
  viewMode: "composite" | "effectOnly" | "split";
  splitPos?: number;          // 0.0 – 1.0
  flipY?: boolean;

  // Analog Film Halation
  halationEnabled: boolean;
  halationIntensity: number;  // 0.0 – 3.0
  halationSpread: number;     // 0.5 – 4.0

  // Hue-Targeted Glow / Color Keying
  hueKeyEnabled: boolean;
  targetHue: number;          // 0.0 – 360.0 degrees
  hueTolerance: number;       // 5.0 – 180.0 degrees

  // Depth Anything V2 Z-Gating
  depthGatingEnabled: boolean;
  focusDepth: number;         // 0.00 – 1.00
  depthRange: number;         // 0.05 – 1.00
  invertZ: boolean;
}

export const DEFAULT_GLOW_OPTIONS: GlowEngineOptions = {
  intensity: 1.5,
  radius: 16.0,
  threshold: 0.15,
  knee: 0.5,
  falloff: 1.0,
  aspectRatio: 1.0,
  angle: 0.0,
  chromaShift: 2.0,
  exposure: 0.0,
  saturation: 1.0,
  rolloff: 1.0,
  dither: 0.5,
  coreTint: "#ffffff",
  haloTint: "#7dd3fc",
  tint: "#f4f4f6",
  blendMode: "screen",
  viewMode: "composite",
  splitPos: 0.5,
  flipY: true,
  halationEnabled: false,
  halationIntensity: 0.8,
  halationSpread: 1.5,
  hueKeyEnabled: false,
  targetHue: 320.0,
  hueTolerance: 35.0,
  depthGatingEnabled: false,
  focusDepth: 0.5,
  depthRange: 0.3,
  invertZ: false,
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

// Pass 1: Prefilter with Premultiplied Alpha, Hue Keying & Depth Z-Gating
// Multiplies texColor.rgb * texColor.a BEFORE computing luminance and threshold
// so semi-transparent PNG edges and faint drop shadows never ignite into hard glowing outlines.
const FS_PREFILTER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_image;
uniform float u_threshold;
uniform float u_knee;

// Hue Keying Uniforms
uniform bool u_hueKeyEnabled;
uniform float u_targetHue;     // 0.0 – 360.0 degrees
uniform float u_hueTolerance; // 5.0 – 180.0 degrees

// Depth Z-Gating Uniforms
uniform sampler2D u_depthMap;
uniform bool u_depthGatingEnabled;
uniform bool u_hasDepthMap;
uniform float u_focusDepth;    // 0.00 – 1.00
uniform float u_depthRange;    // 0.05 – 1.00
uniform bool u_invertZ;

// Accurate RGB to HSV conversion
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));

  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

void main() {
  vec4 texColor = texture(u_image, v_uv);
  
  // Premultiply alpha: eliminates edge halos and false threshold triggers on transparent PNGs
  vec3 src = texColor.rgb * texColor.a;
  float brightness = max(src.r, max(src.g, src.b));

  // 1. Hue-Targeted Glow / Color Keying
  if (u_hueKeyEnabled) {
    vec3 hsv = rgb2hsv(src);
    float hueDeg = hsv.x * 360.0;
    
    // Circular shortest-distance angle difference
    float hueDiff = abs(hueDeg - u_targetHue);
    hueDiff = min(hueDiff, 360.0 - hueDiff);
    
    // Smooth proximity falloff within tolerance
    float hueWeight = 1.0 - smoothstep(u_hueTolerance * 0.65, u_hueTolerance, hueDiff);
    
    // Saturation gate: isolate vibrant color highlights while preventing desaturated skin tones and white highlights from blooming
    float satWeight = smoothstep(0.08, 0.25, hsv.y);
    hueWeight *= satWeight;
    
    brightness *= hueWeight;
  }

  // 2. Depth Z-Gating
  float depthGate = 1.0;
  if (u_depthGatingEnabled && u_hasDepthMap) {
    float z = texture(u_depthMap, v_uv).r;
    if (u_invertZ) {
      z = 1.0 - z;
    }
    
    float distZ = abs(z - u_focusDepth);
    float normDist = distZ / max(0.001, u_depthRange * 0.5);
    
    // Smooth Gaussian depth gate around u_focusDepth
    depthGate = exp(-normDist * normDist * 2.0);
    depthGate *= (1.0 - smoothstep(0.8, 1.25, normDist));
    depthGate = clamp(depthGate, 0.0, 1.0);
    
    brightness *= depthGate;
  }
  
  // Soft knee: smooth transition around threshold to prevent hard staircasing
  float knee = max(0.0001, u_threshold * u_knee);
  float soft = brightness - u_threshold + knee;
  soft = clamp(soft, 0.0, 2.0 * knee);
  soft = (soft * soft) / (4.0 * knee + 0.00001);
  
  float contribution = max(soft, brightness - u_threshold) / max(brightness, 0.00001);
  contribution = clamp(contribution, 0.0, 1.0);

  if (u_depthGatingEnabled && u_hasDepthMap) {
    contribution *= depthGate;
  }
  
  fragColor = vec4(src * contribution, texColor.a * contribution);
}
`;

// Dual-Kawase Downsample with Anamorphic Stretch & Directional Angle
const FS_DOWNSAMPLE = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_image;
uniform vec2 u_texelSize;
uniform float u_offset;
uniform vec2 u_anamorphicScale;
uniform vec2 u_rotCosSin;

vec2 transformOffset(vec2 off) {
  vec2 scaled = off * u_anamorphicScale;
  return vec2(
    scaled.x * u_rotCosSin.x - scaled.y * u_rotCosSin.y,
    scaled.x * u_rotCosSin.y + scaled.y * u_rotCosSin.x
  );
}

void main() {
  vec2 halfPixel = u_texelSize * u_offset;
  
  vec2 off1 = transformOffset(vec2(-1.0, -1.0)) * halfPixel;
  vec2 off2 = transformOffset(vec2(1.0, -1.0)) * halfPixel;
  vec2 off3 = transformOffset(vec2(-1.0, 1.0)) * halfPixel;
  vec2 off4 = transformOffset(vec2(1.0, 1.0)) * halfPixel;
  
  vec4 sum = texture(u_image, v_uv) * 4.0;
  sum += texture(u_image, v_uv + off1);
  sum += texture(u_image, v_uv + off2);
  sum += texture(u_image, v_uv + off3);
  sum += texture(u_image, v_uv + off4);
  
  fragColor = sum * 0.125;
}
`;

// Dual-Kawase Upsample with Anamorphic Stretch, Directional Angle & Inverse-Square Falloff
const FS_UPSAMPLE = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_currentLevel;
uniform sampler2D u_lowerLevel;
uniform vec2 u_texelSize;
uniform float u_offset;
uniform float u_weight;
uniform vec2 u_anamorphicScale;
uniform vec2 u_rotCosSin;

vec2 transformOffset(vec2 off) {
  vec2 scaled = off * u_anamorphicScale;
  return vec2(
    scaled.x * u_rotCosSin.x - scaled.y * u_rotCosSin.y,
    scaled.x * u_rotCosSin.y + scaled.y * u_rotCosSin.x
  );
}

void main() {
  vec2 halfPixel = u_texelSize * u_offset;
  
  vec4 lower = texture(u_lowerLevel, v_uv) * 4.0;
  lower += texture(u_lowerLevel, v_uv + transformOffset(vec2(-2.0, 0.0)) * halfPixel);
  lower += texture(u_lowerLevel, v_uv + transformOffset(vec2(2.0, 0.0)) * halfPixel);
  lower += texture(u_lowerLevel, v_uv + transformOffset(vec2(0.0, -2.0)) * halfPixel);
  lower += texture(u_lowerLevel, v_uv + transformOffset(vec2(0.0, 2.0)) * halfPixel);
  lower += texture(u_lowerLevel, v_uv + transformOffset(vec2(-1.0, -1.0)) * halfPixel) * 2.0;
  lower += texture(u_lowerLevel, v_uv + transformOffset(vec2(1.0, -1.0)) * halfPixel) * 2.0;
  lower += texture(u_lowerLevel, v_uv + transformOffset(vec2(-1.0, 1.0)) * halfPixel) * 2.0;
  lower += texture(u_lowerLevel, v_uv + transformOffset(vec2(1.0, 1.0)) * halfPixel) * 2.0;
  lower *= (1.0 / 16.0);
  
  vec4 current = texture(u_currentLevel, v_uv);
  fragColor = current + lower * u_weight;
}
`;

// Final Composite: Dual-Tone Core & Halo Tint, Analog Film Halation,
// Radial Chromatic Aberration, Saturation, Exposure,
// Soft Highlight Roll-Off, Screen / Linear Dodge blend, and Anti-Banding Dither.
const FS_COMPOSITE = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_baseImage;
uniform sampler2D u_glowImage;  // Level 0 accumulated upsample (total glow)
uniform sampler2D u_haloImage;  // Level 3 accumulated upsample (outer wide mips 3-5)
uniform sampler2D u_mip0Image;  // Level 0 downsample (sharp highlight core)
uniform sampler2D u_mip1Image;  // Level 1 downsample (scatter boundary)
uniform vec2 u_resolution;

uniform float u_intensity;
uniform vec3 u_coreTint;
uniform vec3 u_haloTint;
uniform float u_chromaShift;
uniform float u_exposure;
uniform float u_saturation;
uniform float u_rolloff;
uniform float u_dither;

// Halation Uniforms
uniform bool u_halationEnabled;
uniform float u_halationIntensity;
uniform float u_halationSpread;

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
  
  // 1. Total Glow Sampling (with chromatic aberration)
  float glowR = texture(u_glowImage, uv + caOffset).r;
  float glowG = texture(u_glowImage, uv).g;
  float glowB = texture(u_glowImage, uv - caOffset).b;
  vec3 totalGlow = vec3(glowR, glowG, glowB);

  // 2. Halo Glow Sampling (outer wide mip levels 3-5)
  float haloR = texture(u_haloImage, uv + caOffset).r;
  float haloG = texture(u_haloImage, uv).g;
  float haloB = texture(u_haloImage, uv - caOffset).b;
  vec3 haloGlow = vec3(haloR, haloG, haloB);

  // 3. Core Glow (inner tight mip levels 0-2)
  vec3 coreGlow = max(vec3(0.0), totalGlow - haloGlow);

  // 4. Analog Film Halation:
  // Tight high-contrast edge scatter pass using the difference between mip 0 and mip 1/2
  // Tinted warm 35mm red-orange (#ff3b1f) and blended into the inner boundary before the wide bloom pass
  vec3 halationRgb = vec3(0.0);
  if (u_halationEnabled) {
    vec3 m0 = texture(u_mip0Image, uv).rgb;
    vec2 halationDir = normalize(dir + 0.00001) * (u_halationSpread * 0.0035);
    vec3 m1 = texture(u_mip1Image, uv + halationDir).rgb;

    float l0 = dot(m0, vec3(0.299, 0.587, 0.114));
    float l1 = dot(m1, vec3(0.299, 0.587, 0.114));

    // High-contrast edge scatter: m1 bleeds outside sharp m0 boundary
    float edgeScatter = max(0.0, l1 * u_halationSpread - l0 * 0.75);

    // Warm 35mm red-orange (#ff3b1f)
    vec3 halationColor = vec3(1.0, 0.23137, 0.12157);
    halationRgb = halationColor * (edgeScatter * u_halationIntensity);
  }

  // 5. Dual-Tone Interpolation:
  // Smoothly interpolate from Core Tint at bright center to Halo Tint across outer falloff octaves
  vec3 glowRgb = (coreGlow * u_coreTint) + halationRgb + (haloGlow * u_haloTint);
  
  // Glow Saturation adjustment
  float lum = dot(glowRgb, vec3(0.2126, 0.7152, 0.0722));
  glowRgb = mix(vec3(lum), glowRgb, u_saturation);
  
  // Exposure (2^EV)
  glowRgb = glowRgb * exp2(u_exposure);
  
  // Master Intensity
  glowRgb = glowRgb * u_intensity;
  
  // Soft highlight roll-off (filmic shoulder to prevent harsh blown highlights)
  if (u_rolloff > 0.001) {
    float shoulder = u_rolloff * 0.65;
    glowRgb = glowRgb / (1.0 + glowRgb * shoulder);
  }
  
  // Anti-Banding Screen Dither (TPDF dither to eliminate 8-bit banding on smooth gradients)
  if (u_dither > 0.001) {
    float d1 = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    float d2 = fract(sin(dot(gl_FragCoord.xy + 0.5, vec2(12.9898, 78.233))) * 43758.5453);
    float ditherVal = ((d1 + d2 - 1.0) / 255.0) * u_dither;
    glowRgb = max(vec3(0.0), glowRgb + ditherVal);
  }
  
  // Blend calculations for Composite
  vec3 compositeRgb;
  if (u_blendMode == 1) {
    // Linear Dodge (Add): Base + Glow
    compositeRgb = baseColor.rgb + glowRgb;
  } else {
    // Screen: 1 - (1 - Base) * (1 - Glow)
    compositeRgb = 1.0 - (1.0 - clamp(baseColor.rgb, 0.0, 1.0)) * (1.0 - clamp(glowRgb, 0.0, 1.0));
  }
  
  // View Modes
  if (u_viewMode == 1) {
    // Effect Only: glow RGB on solid black with alpha 1.0
    // Screen / Linear Dodge in Photoshop adds this over the base layer without double-exposing
    fragColor = vec4(clamp(glowRgb, 0.0, 1.0), 1.0);
  } else if (u_viewMode == 2) {
    // Split View (Original left, Composite right with 1px divider)
    float pixelWidth = 1.0 / u_resolution.x;
    if (abs(uv.x - u_splitPos) < pixelWidth * 1.5) {
      fragColor = vec4(1.0, 1.0, 1.0, 1.0);
    } else if (uv.x < u_splitPos) {
      fragColor = baseColor;
    } else {
      fragColor = vec4(clamp(compositeRgb, 0.0, 1.0), 1.0);
    }
  } else {
    // Composite
    fragColor = vec4(clamp(compositeRgb, 0.0, 1.0), 1.0);
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

export function hexToRgb(hex: string): [number, number, number] {
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

  // Depth Texture
  private depthTexture: WebGLTexture | null = null;
  private hasDepthMap: boolean = false;

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

  /**
   * Uploads a normalized Float32Array depth map [0.0, 1.0] as an RGBA8 WebGLTexture.
   * Linear filtering is enabled so it scales cleanly to full resolution during commits.
   */
  public setDepthMap(normalizedDepth: Float32Array, width: number, height: number): void {
    const gl = this.gl;
    if (!this.depthTexture) {
      this.depthTexture = gl.createTexture();
    }

    const totalPixels = width * height;
    const rgba = new Uint8Array(totalPixels * 4);
    for (let i = 0; i < totalPixels; i++) {
      const b = Math.round(clamp(normalizedDepth[i], 0.0, 1.0) * 255);
      const idx = i * 4;
      rgba[idx] = b;
      rgba[idx + 1] = b;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 255;
    }

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTexture);
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
      rgba
    );

    this.hasDepthMap = true;
  }

  public clearDepthMap(): void {
    const gl = this.gl;
    if (this.depthTexture) {
      gl.deleteTexture(this.depthTexture);
      this.depthTexture = null;
    }
    this.hasDepthMap = false;
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
      aspectRatio = 1.0,
      angle = 0.0,
      chromaShift,
      exposure,
      saturation = 1.0,
      rolloff,
      dither = 0.5,
      coreTint,
      haloTint,
      tint,
      blendMode,
      viewMode,
      splitPos = 0.5,
      flipY = true,
      halationEnabled = false,
      halationIntensity = 0.8,
      halationSpread = 1.5,
      hueKeyEnabled = false,
      targetHue = 320.0,
      hueTolerance = 35.0,
      depthGatingEnabled = false,
      focusDepth = 0.5,
      depthRange = 0.3,
      invertZ = false,
    } = options;

    const spreadOffset = Math.max(0.5, radius * 0.12);

    // Compute Anamorphic scale vector and rotation matrix for directional streaks
    const safeAspect = Math.max(0.1, Math.min(10.0, aspectRatio));
    const anamorphicX = Math.sqrt(safeAspect);
    const anamorphicY = 1.0 / anamorphicX;

    const rad = (angle * Math.PI) / 180.0;
    const cosAngle = Math.cos(rad);
    const sinAngle = Math.sin(rad);

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

    // Hue Keying Uniforms
    gl.uniform1i(gl.getUniformLocation(this.prefilterProg, "u_hueKeyEnabled"), hueKeyEnabled ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.prefilterProg, "u_targetHue"), targetHue);
    gl.uniform1f(gl.getUniformLocation(this.prefilterProg, "u_hueTolerance"), hueTolerance);

    // Depth Z-Gating Uniforms
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTexture || this.baseTexture);
    gl.uniform1i(gl.getUniformLocation(this.prefilterProg, "u_depthMap"), 1);
    gl.uniform1i(
      gl.getUniformLocation(this.prefilterProg, "u_depthGatingEnabled"),
      depthGatingEnabled ? 1 : 0
    );
    gl.uniform1i(
      gl.getUniformLocation(this.prefilterProg, "u_hasDepthMap"),
      this.hasDepthMap ? 1 : 0
    );
    gl.uniform1f(gl.getUniformLocation(this.prefilterProg, "u_focusDepth"), focusDepth);
    gl.uniform1f(gl.getUniformLocation(this.prefilterProg, "u_depthRange"), depthRange);
    gl.uniform1i(gl.getUniformLocation(this.prefilterProg, "u_invertZ"), invertZ ? 1 : 0);

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
      gl.uniform2f(
        gl.getUniformLocation(this.downsampleProg, "u_anamorphicScale"),
        anamorphicX,
        anamorphicY
      );
      gl.uniform2f(
        gl.getUniformLocation(this.downsampleProg, "u_rotCosSin"),
        cosAngle,
        sinAngle
      );

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
      gl.uniform2f(
        gl.getUniformLocation(this.upsampleProg, "u_anamorphicScale"),
        anamorphicX,
        anamorphicY
      );
      gl.uniform2f(
        gl.getUniformLocation(this.upsampleProg, "u_rotCosSin"),
        cosAngle,
        sinAngle
      );

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

    // Unit 2: Halo texture (Level 3 accumulated upsample – outer wide mips 3-5)
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.pyramid[3].upTexture);
    gl.uniform1i(gl.getUniformLocation(this.compositeProg, "u_haloImage"), 2);

    // Unit 3: Mip 0 downsample (sharp highlight core for halation)
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.pyramid[0].downTexture);
    gl.uniform1i(gl.getUniformLocation(this.compositeProg, "u_mip0Image"), 3);

    // Unit 4: Mip 1 downsample (scatter boundary for halation)
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.pyramid[1].downTexture);
    gl.uniform1i(gl.getUniformLocation(this.compositeProg, "u_mip1Image"), 4);

    // Resolution & Master Intensity
    gl.uniform2f(
      gl.getUniformLocation(this.compositeProg, "u_resolution"),
      targetWidth,
      targetHeight
    );
    gl.uniform1f(gl.getUniformLocation(this.compositeProg, "u_intensity"), intensity);

    // Dual-Tone Core & Halo Tints
    const effectiveCoreHex = coreTint || tint || "#ffffff";
    const effectiveHaloHex = haloTint || tint || "#7dd3fc";
    const [cR, cG, cB] = hexToRgb(effectiveCoreHex);
    const [hR, hG, hB] = hexToRgb(effectiveHaloHex);
    gl.uniform3f(gl.getUniformLocation(this.compositeProg, "u_coreTint"), cR, cG, cB);
    gl.uniform3f(gl.getUniformLocation(this.compositeProg, "u_haloTint"), hR, hG, hB);

    // Halation Uniforms
    gl.uniform1i(
      gl.getUniformLocation(this.compositeProg, "u_halationEnabled"),
      halationEnabled ? 1 : 0
    );
    gl.uniform1f(
      gl.getUniformLocation(this.compositeProg, "u_halationIntensity"),
      halationIntensity
    );
    gl.uniform1f(
      gl.getUniformLocation(this.compositeProg, "u_halationSpread"),
      halationSpread
    );

    // Falloff & Optics
    gl.uniform1f(gl.getUniformLocation(this.compositeProg, "u_chromaShift"), chromaShift);
    gl.uniform1f(gl.getUniformLocation(this.compositeProg, "u_exposure"), exposure);
    gl.uniform1f(gl.getUniformLocation(this.compositeProg, "u_saturation"), saturation);
    gl.uniform1f(gl.getUniformLocation(this.compositeProg, "u_rolloff"), rolloff);
    gl.uniform1f(gl.getUniformLocation(this.compositeProg, "u_dither"), dither);

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
    if (this.depthTexture) {
      gl.deleteTexture(this.depthTexture);
      this.depthTexture = null;
    }
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteProgram(this.prefilterProg);
    gl.deleteProgram(this.downsampleProg);
    gl.deleteProgram(this.upsampleProg);
    gl.deleteProgram(this.compositeProg);
  }
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

// ── Standalone Offscreen Full-Res Render Function ────────────────────────────

export function renderGlowOffscreen(
  pixels: Uint8Array,
  width: number,
  height: number,
  options: Partial<GlowEngineOptions> = {},
  depthData?: DepthData | null
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

  if (depthData && depthData.normalizedDepth && depthData.width > 0 && depthData.height > 0) {
    engine.setDepthMap(depthData.normalizedDepth, depthData.width, depthData.height);
  }

  const fullOpts: GlowEngineOptions = {
    ...DEFAULT_GLOW_OPTIONS,
    ...options,
    // Always render isolated Effect Only pass (glow RGB on solid black with alpha 1.0)
    // for Screen or Linear Dodge additive blend modes so Photoshop does not double-expose.
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
