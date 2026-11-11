/* =========================================================================
   EXPEDITION LOG
   Real-time ray-marched terrain (WebGL2): eroded fBm mountains, slope/height
   based snow + vegetation, soft sun shadows, aerial perspective, a volumetric
   cloud layer you climb through, sky + stars. Scroll = camera ascent.
   ========================================================================= */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const params = new URLSearchParams(location.search);

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

  /* ---------------- terrain (JS mirror of the shader, for the camera) ---------------- */
  function hash(ix, iy) {
    let n = Math.imul(ix | 0, 1597334677) ^ Math.imul(iy | 0, -482951495);
    n = Math.imul(n ^ (n >>> 16), -2048144777);
    n ^= n >>> 13;
    return (n >>> 0) * (2 / 4294967295) - 1;
  }
  function noised(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const dux = 30 * fx * fx * (fx * (fx - 2) + 1), duy = 30 * fy * fy * (fy * (fy - 2) + 1);
    const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    const k1 = b - a, k2 = c - a, k4 = a - b - c + d;
    return [a + k1 * ux + k2 * uy + k4 * ux * uy, dux * (k1 + k4 * uy), duy * (k2 + k4 * ux)];
  }
  function terrain(x, z, oct = 8) {
    let px = x * 0.0007 + 3.1, py = z * 0.0007 + 1.7, a = 0, b = 1, dx = 0, dy = 0;
    for (let i = 0; i < oct; i++) {
      const n = noised(px, py);
      dx += n[1]; dy += n[2];
      a += b * n[0] / (1 + dx * dx + dy * dy);
      b *= 0.5;
      const nx = 1.6 * px - 1.2 * py, ny = 1.2 * px + 1.6 * py; px = nx; py = ny;
    }
    return 1500 * a + 600;
  }

  /* ---------------- route: valley floor → summit ---------------- */
  const START = [4938, 1428], PEAK = [1545, 1215], PEAK_H = 2817;
  const DIR = (() => { const dx = PEAK[0] - START[0], dz = PEAK[1] - START[1], l = Math.hypot(dx, dz); return [dx / l, dz / l]; })();
  const ROUTE_LEN = Math.hypot(PEAK[0] - START[0], PEAK[1] - START[1]);
  const YAW0 = Math.atan2(DIR[0], DIR[1]);
  const GROUND0 = terrain(START[0], START[1], 10);

  function cameraAt(c, mx, my) {
    const s = 0.982 * c;
    const x = START[0] + (PEAK[0] - START[0]) * s, z = START[1] + (PEAK[1] - START[1]) * s;
    const yPath = lerp(GROUND0 + 30, PEAK_H + 42, Math.pow(c, 1.2));
    let g = -1e9;
    for (const ahead of [0, 40, 100, 180]) for (const side of [-70, 0, 70]) {
      g = Math.max(g, terrain(x + DIR[0] * ahead - DIR[1] * side, z + DIR[1] * ahead + DIR[0] * side, 9) + 40 - ahead * 0.06 - Math.abs(side) * .2);
    }
    const y = Math.max(yPath, g);
    const pitch = (c < .5 ? lerp(.13, -.03, smooth(0, .5, c)) : lerp(-.03, -.24, smooth(.5, 1, c))) - my * .045;
    const yaw = YAW0 + .2 * Math.sin(c * Math.PI * 1.4) - .12 * smooth(.85, 1, c) + mx * .08;
    const fw = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
    const rl = Math.hypot(fw[2], fw[0]);
    const rt = [-fw[2] / rl, 0, fw[0] / rl];                // cross(fw, up)
    const up = [rt[1] * fw[2] - rt[2] * fw[1], rt[2] * fw[0] - rt[0] * fw[2], rt[0] * fw[1] - rt[1] * fw[0]];
    return { ro: [x, y, z], fw, rt, up };
  }

  /* ---------------- time of day ---------------- */
  const TOD = [
    { at: 0,   el: .045, az: .95, sun: [1.0, .62, .40], si: .75, zen: [.16, .22, .34], hor: [.56, .52, .52], expo: 1.25, stars: .18 },
    { at: .3,  el: .30,  az: 1.1, sun: [1.0, .88, .74], si: 1.0, zen: [.20, .32, .55], hor: [.60, .67, .76], expo: 1.2,  stars: 0 },
    { at: .6,  el: .55,  az: -.7, sun: [1.0, .95, .88], si: 1.1, zen: [.19, .31, .55], hor: [.62, .68, .76], expo: 1.1,  stars: 0 },
    { at: .86, el: .075, az: -.55, sun: [1.0, .56, .28], si: 1.15, zen: [.14, .19, .32], hor: [.80, .56, .42], expo: 1.25, stars: 0 },
    { at: 1,   el: -.015, az: -.5, sun: [.95, .42, .26], si: .6, zen: [.035, .05, .10], hor: [.40, .28, .28], expo: 1.7, stars: 1 },
  ];
  function tod(c) {
    let i = 0;
    while (i < TOD.length - 2 && c > TOD[i + 1].at) i++;
    const a = TOD[i], b = TOD[i + 1], t = smooth(0, 1, (c - a.at) / (b.at - a.at));
    const el = lerp(a.el, b.el, t), az = YAW0 + lerp(a.az, b.az, t);
    const si = lerp(a.si, b.si, t);
    return {
      sun: [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)],
      sunCol: mix3(a.sun, b.sun, t).map((v) => v * si),
      zen: mix3(a.zen, b.zen, t), hor: mix3(a.hor, b.hor, t),
      expo: lerp(a.expo, b.expo, t), stars: lerp(a.stars, b.stars, t),
    };
  }

  /* ---------------- shaders ---------------- */
  const VS = `#version 300 es
in vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const FS = `#version 300 es
precision highp float;
precision highp int;
out vec4 fragColor;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uRo, uFw, uRt, uUp;
uniform vec3 uSun, uSunCol, uZen, uHor;
uniform float uExpo, uStars;

const float CLO = 930.0;
const float CHI = 1180.0;
const float MAXH = 3150.0;

float hash(ivec2 p){
  uint n = uint(p.x)*1597334677u ^ uint(p.y)*3812015801u;
  n = (n ^ (n >> 16u)) * 2246822519u;
  n ^= n >> 13u;
  return float(n) * (2.0/4294967295.0) - 1.0;
}
float hash3(ivec3 p){
  uint n = uint(p.x)*1597334677u ^ uint(p.y)*3812015801u ^ uint(p.z)*2798796415u;
  n = (n ^ (n >> 16u)) * 2246822519u;
  n ^= n >> 13u;
  return float(n) / 4294967295.0;
}
vec3 noised(vec2 x){
  vec2 fl = floor(x); ivec2 i = ivec2(fl); vec2 f = x - fl;
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  vec2 du = 30.0*f*f*(f*(f-2.0)+1.0);
  float a = hash(i), b = hash(i+ivec2(1,0)), c = hash(i+ivec2(0,1)), d = hash(i+ivec2(1,1));
  float k1 = b-a, k2 = c-a, k4 = a-b-c+d;
  return vec3(a + k1*u.x + k2*u.y + k4*u.x*u.y, du*vec2(k1 + k4*u.y, k2 + k4*u.x));
}
float vnoise(vec2 x){ return noised(x).x; }
const mat2 M2 = mat2(1.6, 1.2, -1.2, 1.6);

float terrain(vec2 x, int oct){
  vec2 p = x*0.0007 + vec2(3.1, 1.7);
  float a = 0.0, b = 1.0; vec2 d = vec2(0.0);
  for(int i = 0; i < 14; i++){
    if(i >= oct) break;
    vec3 n = noised(p);
    d += n.yz;
    a += b*n.x/(1.0 + dot(d,d));
    b *= 0.5;
    p = M2*p;
  }
  return 1500.0*a + 600.0;
}

float fbmC(vec2 p){
  float a = 0.0, b = 0.5;
  for(int i = 0; i < 5; i++){ a += b*vnoise(p); b *= 0.5; p = M2*p*1.03; }
  return a;
}

float march(vec3 ro, vec3 rd, float tmax){
  float t = 2.0, tp = 0.0;
  for(int i = 0; i < 280; i++){
    vec3 p = ro + rd*t;
    float h = p.y - terrain(p.xz, t < 500.0 ? 11 : 8);
    if(h < 0.0015*t){
      // refine the hit with a short bisection to kill terracing on silhouettes
      float lo = t - tp, hi = t;
      for(int j = 0; j < 5; j++){
        float m = 0.5*(lo + hi);
        vec3 q = ro + rd*m;
        if(q.y - terrain(q.xz, m < 500.0 ? 11 : 8) < 0.0015*m) hi = m; else lo = m;
      }
      return hi;
    }
    if(t > tmax) break;
    tp = max(0.42*h, 0.4 + 0.0008*t);
    t += tp;
  }
  return -1.0;
}

vec3 calcNormal(vec3 p, float t){
  float e = max(0.02, 0.0015*t);
  int oct = t < 1200.0 ? 13 : (t < 5000.0 ? 11 : 9);
  float h = terrain(p.xz, oct);
  return normalize(vec3(h - terrain(p.xz + vec2(e,0.0), oct), e, h - terrain(p.xz + vec2(0.0,e), oct)));
}

float softShadow(vec3 ro, vec3 rd){
  if(rd.y < -0.05) return 0.0;
  float res = 1.0, t = 10.0;
  for(int i = 0; i < 60; i++){
    vec3 p = ro + rd*t;
    float h = p.y - terrain(p.xz, 7);
    res = min(res, 14.0*h/t);
    t += clamp(h*0.7, 3.0, 220.0);
    if(res < 0.0 || p.y > MAXH || t > 14000.0) break;
  }
  return smoothstep(0.0, 1.0, clamp(res, 0.0, 1.0));
}

float fogAmount(vec3 ro, vec3 rd, float t){
  const float a = 0.000115, b = 0.00062;
  float k = b*rd.y;
  float integ = abs(k) > 1e-6 ? (1.0 - exp(-k*t))/k : t;
  return 1.0 - exp(-a*exp(-b*ro.y)*integ);
}
vec3 fogColor(vec3 rd){
  float s = max(dot(rd, uSun), 0.0);
  return mix(uHor, uSunCol*0.9, 0.55*pow(s, 7.0));
}

vec3 sky(vec3 ro, vec3 rd){
  float y = max(rd.y, 0.0);
  vec3 col = mix(uHor, uZen, pow(y, 0.42));
  float s = max(dot(rd, uSun), 0.0);
  col += uSunCol*(0.28*pow(s, 5.0) + 0.5*pow(s, 64.0));
  col += uSunCol*smoothstep(0.99955, 0.9998, s)*18.0*step(-0.01, uSun.y);
  // stars
  if(uStars > 0.01 && rd.y > -0.02){
    vec3 d = rd*260.0;
    ivec3 id = ivec3(floor(d));
    float h = hash3(id);
    if(h > 0.9955){
      vec3 f = fract(d) - 0.5;
      float st = smoothstep(0.32, 0.0, length(f)) * (h - 0.9955)/0.0045;
      st *= 0.65 + 0.35*sin(uTime*1.7 + h*900.0);
      col += vec3(st*2.2)*uStars*smoothstep(-0.02, 0.15, rd.y);
    }
  }
  // high cloud deck
  if(rd.y > 0.0){
    float tt = (6500.0 - ro.y)/rd.y;
    vec2 q = (ro.xz + rd.xz*tt)*0.00009 + vec2(uTime*0.0025, uTime*0.001);
    float c = fbmC(q)*0.5 + fbmC(q*3.1 + 4.0)*0.25;
    c = smoothstep(0.02, 0.45, c) * smoothstep(0.0, 0.25, rd.y);
    vec3 cc = uZen*1.2 + uSunCol*0.35*(0.4 + 1.2*pow(s, 3.0)) + uHor*0.25;
    col = mix(col, cc, c*0.6);
  }
  return col;
}

vec3 shade(vec3 p, vec3 n, vec3 rd, float t){
  // fold height into the lookup so steep faces don't smear vertically
  vec2 tp = p.xz + vec2(p.y*0.9, -p.y*0.6)*(1.0 - n.y);
  float n1 = vnoise(tp*0.012);
  float n2 = vnoise(tp*0.06 + 7.0);
  float n3 = vnoise(p.xz*0.0035 + 3.0);
  // rock with strata
  vec3 rock = mix(vec3(0.085, 0.078, 0.07), vec3(0.15, 0.14, 0.125), 0.5 + 0.5*n1);
  rock *= 0.82 + 0.18*sin(p.y*0.09 + n1*5.0 + n2);
  rock = mix(rock, vec3(0.11, 0.095, 0.08), smoothstep(0.3, 0.8, n3)*0.5);
  // vegetation on low, gentle slopes
  float veg = smoothstep(0.72, 0.88, n.y) * (1.0 - smoothstep(380.0, 780.0, p.y + 140.0*n3));
  vec3 forest = mix(vec3(0.030, 0.040, 0.024), vec3(0.055, 0.060, 0.034), 0.5 + 0.5*n2);
  vec3 alb = mix(rock, forest, veg);
  // scree / talus on mid slopes
  float scree = smoothstep(0.55, 0.75, n.y) * (1.0 - veg) * 0.5;
  alb = mix(alb, vec3(0.16, 0.15, 0.14), scree*(0.5 + 0.5*n2));
  // snow
  float sh = p.y + 260.0*n3 + 60.0*n2;
  float snow = smoothstep(1250.0, 1550.0, sh) * smoothstep(0.52, 0.78, n.y + 0.12*n2);
  snow = max(snow, smoothstep(2150.0, 2400.0, sh) * smoothstep(0.35, 0.55, n.y));
  alb = mix(alb, vec3(0.80, 0.83, 0.88), snow);

  float dif = clamp(dot(n, uSun), 0.0, 1.0);
  float sha = dif > 0.001 ? softShadow(p + n*4.0 + vec3(0.0, 4.0, 0.0), uSun) : 0.0;
  float amb = 0.55 + 0.45*n.y;
  float bou = clamp(0.25 - 0.75*n.y, 0.0, 1.0);
  float occ = clamp(0.55 + 0.45*smoothstep(-200.0, 300.0, p.y - terrain(p.xz, 4)), 0.0, 1.0);
  vec3 lin = dif*sha*uSunCol*3.2;
  lin += amb*uZen*1.15*occ;
  lin += bou*uSunCol*0.08*occ;
  vec3 col = alb*lin;
  vec3 h = normalize(uSun - rd);
  col += snow*uSunCol*sha*pow(clamp(dot(n, h), 0.0, 1.0), 40.0)*0.35;
  return col;
}

vec4 clouds(vec3 ro, vec3 rd, float tEnd){
  float t0, t1;
  if(abs(rd.y) < 1e-4){
    if(ro.y < CLO || ro.y > CHI) return vec4(0.0);
    t0 = 0.0; t1 = 30000.0;
  } else {
    float ta = (CLO - ro.y)/rd.y, tb = (CHI - ro.y)/rd.y;
    t0 = max(min(ta, tb), 0.0); t1 = max(ta, tb);
  }
  t1 = min(t1, min(tEnd, 30000.0));
  if(t1 <= t0) return vec4(0.0);
  float T = 1.0; vec3 acc = vec3(0.0);
  const int N = 10;
  float len = t1 - t0, prev = 0.0;
  float s = max(dot(rd, uSun), 0.0);
  for(int i = 0; i < N; i++){
    float u = (float(i) + 1.0)/float(N);
    float w = u*u;
    float t = t0 + len*mix(prev, w, 0.5);
    float dt = len*(w - prev); prev = w;
    vec3 p = ro + rd*t;
    vec2 q = p.xz*0.00075 + vec2(uTime*0.006, 0.0);
    float cov = fbmC(q) + 0.35*fbmC(q*3.7 + 11.0);
    float top = mix(CLO + 40.0, CHI, clamp(0.55 + 0.9*cov, 0.0, 1.0));
    float dens = smoothstep(top, top - 70.0, p.y) * smoothstep(CLO, CLO + 90.0, p.y);
    dens *= smoothstep(-0.38, -0.05, cov) * 0.012;
    if(dens <= 0.0) continue;
    float hn = clamp((p.y - CLO)/(top - CLO), 0.0, 1.0);
    vec3 L = uZen*(0.75 + 0.6*hn) + uHor*0.25;
    L += uSunCol*max(uSun.y + 0.12, 0.0)*2.6*hn*hn;
    L += uSunCol*0.9*pow(s, 6.0)*hn;
    float a = 1.0 - exp(-dens*dt);
    acc += T*a*L;
    T *= 1.0 - a;
    if(T < 0.02) break;
  }
  float alpha = 1.0 - T;
  float f = fogAmount(ro, rd, t0 + 200.0);
  acc = mix(acc, fogColor(rd)*alpha, f);
  return vec4(acc, alpha);
}

vec3 aces(vec3 x){ return clamp((x*(2.51*x + 0.03))/(x*(2.43*x + 0.59) + 0.14), 0.0, 1.0); }

void main(){
  vec2 uv = (2.0*gl_FragCoord.xy - uRes)/uRes.y;
  vec3 ro = uRo;
  vec3 rd = normalize(uv.x*uRt + uv.y*uUp + 1.5*uFw);

  float tmax = 32000.0;
  if(rd.y > 0.0) tmax = min(tmax, (MAXH - ro.y)/rd.y);
  float t = tmax > 0.0 ? march(ro, rd, tmax) : -1.0;

  vec3 col;
  if(t > 0.0){
    vec3 p = ro + rd*t;
    vec3 n = calcNormal(p, t);
    col = shade(p, n, rd, t);
    col = mix(col, fogColor(rd), fogAmount(ro, rd, t));
  } else {
    col = sky(ro, rd);
  }
  vec4 cl = clouds(ro, rd, t > 0.0 ? t : 1e9);
  col = col*(1.0 - cl.a) + cl.rgb;

  // grade
  col *= uExpo;
  col = aces(col);
  col = pow(col, vec3(0.4545));
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, 0.8);
  col = mix(col, col*col*(3.0 - 2.0*col), 0.3);
  col *= vec3(1.0, 0.99, 0.97);
  vec2 q = gl_FragCoord.xy/uRes;
  col *= 0.5 + 0.5*pow(16.0*q.x*q.y*(1.0 - q.x)*(1.0 - q.y), 0.16);
  col += (hash(ivec2(gl_FragCoord.xy) + ivec2(int(uTime*30.0)*7, 0))*0.5)/255.0;
  fragColor = vec4(col, 1.0);
}`;

  /* ---------------- WebGL setup ---------------- */
  const canvas = $('#scene');
  const gl = canvas.getContext('webgl2', { antialias: false, depth: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  let prog = null, U = {};
  if (gl) {
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error(gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
    if (vs && fs) {
      prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs);
      gl.bindAttribLocation(prog, 0, 'aPos');
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(prog)); prog = null; }
    }
    if (prog) {
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      ['uRes', 'uTime', 'uRo', 'uFw', 'uRt', 'uUp', 'uSun', 'uSunCol', 'uZen', 'uHor', 'uExpo', 'uStars']
        .forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });
    }
  }
  if (!prog) document.body.classList.add('no-gl');

  // adaptive resolution
  const fixedScale = parseFloat(params.get('scale'));
  let W = 0, H = 0, scale = 0, maxScale = 1;
  function sizeCanvas() {
    W = innerWidth; H = innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    maxScale = Math.min(dpr, Math.sqrt(1.1e6 / (W * H)));
    if (!scale) scale = Math.min(maxScale, coarse ? .45 : .62);
    if (fixedScale) scale = fixedScale;
    scale = Math.min(scale, maxScale);
    canvas.width = Math.max(64, Math.round(W * scale));
    canvas.height = Math.max(64, Math.round(H * scale));
  }
  sizeCanvas();
  let lastH = innerHeight;
  addEventListener('resize', () => {
    if (Math.abs(innerWidth - W) > 1 || Math.abs(innerHeight - lastH) > 120) { lastH = innerHeight; sizeCanvas(); dirty = true; }
    layoutStages();
  });

  /* ---------------- frame loop ---------------- */
  const root = document.documentElement;
  let cam = 0, time = 0, mx = 0, my = 0, mxs = 0, mys = 0, dirty = true;
  let lastRender = { c: -1, mx: 9, my: 9 }, frameN = 0, ema = 16, adjustT = 0, last = performance.now();

  function render() {
    if (!prog) return;
    const C = cameraAt(cam, mxs, mys), S = tod(cam);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, time);
    gl.uniform3fv(U.uRo, C.ro); gl.uniform3fv(U.uFw, C.fw); gl.uniform3fv(U.uRt, C.rt); gl.uniform3fv(U.uUp, C.up);
    gl.uniform3fv(U.uSun, S.sun); gl.uniform3fv(U.uSunCol, S.sunCol);
    gl.uniform3fv(U.uZen, S.zen); gl.uniform3fv(U.uHor, S.hor);
    gl.uniform1f(U.uExpo, S.expo); gl.uniform1f(U.uStars, S.stars);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(.1, Math.max(.001, (now - last) / 1000));
    last = now; time += dt;
    const max = Math.max(1, root.scrollHeight - innerHeight);
    const target = clamp(scrollY / max);
    cam = reduce ? target : cam + (target - cam) * (1 - Math.pow(.004, dt));
    if (Math.abs(target - cam) < 1e-5) cam = target;
    const k = 1 - Math.pow(.05, dt);
    mxs += (mx - mxs) * k; mys += (my - mys) * k;

    const moving = Math.abs(cam - lastRender.c) > 1e-5 || Math.abs(mxs - lastRender.mx) > 1e-4 || Math.abs(mys - lastRender.my) > 1e-4;
    frameN++;
    // render every frame while moving; idle → ~15fps to keep clouds/stars alive cheaply
    if (moving || dirty || frameN % 4 === 0) {
      render();
      lastRender = { c: cam, mx: mxs, my: mys }; dirty = false;
    }
    // adaptive quality
    if (!fixedScale && prog && moving) {
      ema = lerp(ema, dt * 1000, .08);
      adjustT += dt;
      if (adjustT > .8) {
        adjustT = 0;
        if (ema > 24 && scale > .3) { scale = Math.max(.3, scale * .85); sizeCanvas(); }
        else if (ema < 13 && scale < maxScale) { scale = Math.min(maxScale, scale * 1.08); sizeCanvas(); }
      }
    }
    hud();
    document.body.classList.toggle('at-bottom', target > .985);
  }

  /* =========================================================================
     UI
     ========================================================================= */
  const elAlt = $('#alt-ft'), hAlt = $('#h-alt'), hTime = $('#h-time'), hTemp = $('#h-temp'), hStage = $('#h-stage');
  const hLat = $('#h-lat'), hLon = $('#h-lon'), hBrg = $('#h-brg'), tape = $('#tape');
  const PX_PER_FT = 0.085;
  let lastFt = -1;
  function clockAt(c) {
    const mins = 5 * 60 + 30 + Math.round(c * (14 * 60 + 15));
    return `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }
  function hud() {
    root.style.setProperty('--cam', cam.toFixed(4));
    const ft = Math.round(cam * 14505);
    if (ft === lastFt) return;
    lastFt = ft;
    const s = ft.toLocaleString('en-US');
    elAlt.textContent = s; hAlt.textContent = s + ' FT';
    hTime.textContent = clockAt(cam);
    hTemp.textContent = Math.round(lerp(58, 14, cam)) + '°F';
    hLat.textContent = lerp(36.5872, 36.5785, cam).toFixed(4) + '° N';
    hLon.textContent = lerp(118.24, 118.2923, cam).toFixed(4) + '° W';
    hBrg.textContent = String(Math.round(247 + 14 * Math.sin(cam * Math.PI * 1.4))).padStart(3, '0') + '°';
    tape.style.transform = `translateY(${ft * PX_PER_FT}px)`;
    let stage = stages[0];
    for (const st of stages) if (cam >= st.p - .005) stage = st;
    if (stage) hStage.textContent = stage.name.toUpperCase();
  }

  // altitude tape ticks
  (function buildTape() {
    let html = '';
    for (let f = 0; f <= 15000; f += 250) {
      const major = f % 1000 === 0;
      html += `<div class="tk${major ? ' major' : ''}" style="top:${-f * PX_PER_FT}px">${major ? `<em>${(f / 1000).toFixed(0)}K</em>` : ''}</div>`;
    }
    tape.innerHTML = html;
  })();

  // stages (sections) → progress + elevation
  const sections = $$('section[data-stage]');
  let stages = [];
  function layoutStages() {
    const max = Math.max(1, root.scrollHeight - innerHeight);
    stages = sections.map((s, i) => ({ name: s.dataset.stage, el: s, p: i === sections.length - 1 ? 1 : clamp(s.offsetTop / max) }));
    $$('.camp', tape).forEach((n) => n.remove());
    stages.forEach((st) => {
      const ft = Math.round(st.p * 14505 / 10) * 10;
      const e = $('.elev', st.el);
      if (e) e.textContent = ft.toLocaleString('en-US') + ' FT';
      if (st.p > 0) {
        const m = document.createElement('div');
        m.className = 'camp';
        m.style.top = (-ft * PX_PER_FT) + 'px';
        m.innerHTML = `<em>${st.name.toUpperCase()}</em>`;
        tape.appendChild(m);
      }
    });
    lastFt = -1;
  }

  // word split for section titles
  $$('[data-split]').forEach((el) => {
    const words = el.textContent.trim().split(/\s+/);
    el.innerHTML = words.map((w, i) => `<span class="w"><span style="--i:${i}">${w}</span></span>`).join(' ');
  });
  // stagger kit checklist
  $$('.check').forEach((ul) => $$('li', ul).forEach((li, i) => li.style.setProperty('--i', i)));

  // counters
  const counted = new WeakSet();
  function countUp(el) {
    if (counted.has(el)) return; counted.add(el);
    const to = parseFloat(el.dataset.to), dec = +(el.dataset.dec || 0), pad = +(el.dataset.pad || 0);
    const fmt = (v) => { let s = dec ? v.toFixed(dec) : Math.round(v).toLocaleString('en-US'); return pad ? s.padStart(pad, '0') : s; };
    if (reduce) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 1800;
    const step = (now) => {
      const t = clamp((now - t0) / dur), e = t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
      el.textContent = fmt(to * e);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      $$('.count', e.target).forEach(countUp);
      io.unobserve(e.target);
    });
  }, { threshold: .15, rootMargin: '0px 0px -8% 0px' });

  // nav active
  const navLinks = $$('.nav a');
  const navIO = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      navLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id));
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  sections.forEach((s) => navIO.observe(s));

  // replica counter in the pods diagram (synced to its 8s CSS loop)
  const rep = $('.rep');
  if (rep) setInterval(() => {
    const ph = ((performance.now() / 1000) % 8) / 8;
    let n = 0;
    for (let i = 0; i < 4; i++) { const p = ph - i * .05; if (p > .18 && p < .7) n++; }
    rep.textContent = n;
  }, 120);

  // summit stamp time
  $('#stamp-time').textContent = clockAt(1);
  $('#yr').textContent = new Date().getFullYear();

  // pointer
  const xh = $('.xhair');
  addEventListener('pointermove', (e) => {
    mx = e.clientX / innerWidth * 2 - 1; my = e.clientY / innerHeight * 2 - 1;
    if (!coarse && e.pointerType === 'mouse') {
      document.body.classList.add('has-cursor');
      xh.style.transform = `translate(${e.clientX}px,${e.clientY}px)`;
    }
  }, { passive: true });
  document.addEventListener('pointerleave', () => document.body.classList.remove('has-cursor'));
  document.addEventListener('pointerover', (e) => xh.classList.toggle('hot', !!e.target.closest('a,button,.panel,.honor')));

  /* ---------------- boot ---------------- */
  const ldBar = $('.ld-bar'), ldPct = $('#ld-pct');
  let booted = false, pct = 0;
  const ldTimer = setInterval(() => {
    pct = Math.min(booted ? 100 : 92, pct + Math.random() * 14 + 4);
    ldBar.style.setProperty('--p', pct / 100);
    ldPct.textContent = String(Math.round(pct)).padStart(3, '0');
  }, 90);
  function boot() {
    if (booted) return; booted = true;
    ldBar.style.setProperty('--p', 1); ldPct.textContent = '100';
    setTimeout(() => {
      clearInterval(ldTimer);
      $('#loader').classList.add('gone');
      document.body.classList.remove('loading');
      document.body.classList.add('ready');
      layoutStages();
      $$('[data-reveal],[data-split]').forEach((el) => io.observe(el));
    }, 350);
  }
  render(); // compile + first frame behind the loader
  requestAnimationFrame(frame);
  const minShow = new Promise((r) => setTimeout(r, reduce ? 0 : 1300));
  const loaded = new Promise((r) => (document.readyState === 'complete' ? r() : addEventListener('load', r)));
  Promise.all([minShow, loaded]).then(boot);
  setTimeout(boot, 5000);
  if (document.fonts) document.fonts.ready.then(layoutStages);
})();
