/* 横板射击 Demo：nanzhu + 注入的持枪骨骼 / IK / 上半身动画集
 * 轨道分配：track0 下半身（原 idle/walk/run） · track1 上半身（upper_*） · track2 开火（add 叠加）
 */
(() => {
  'use strict';
  const sp = window.spine;
  const $ = id => document.getElementById(id);

  const BASE = '..';
  const JSON_URL = 'nanzhu_gunner.json';
  const ATLAS_URL = BASE + '/characters/nanzhu/nanzhu__var1.atlas.txt';
  const PAGE_URL = BASE + '/characters/nanzhu/textures/nanzhu__nanzhu__var1.png';

  // ---------------------------------------------------------------- 画布 / 相机
  const glc = $('gl'), fxc = $('fx');
  const gl = glc.getContext('webgl', { alpha: false, premultipliedAlpha: false }) ||
             glc.getContext('experimental-webgl', { alpha: false });
  if (!gl) { fail('浏览器不支持 WebGL'); return; }
  const renderer = new sp.webgl.SceneRenderer(glc, gl);
  const camera = renderer.camera;
  const ctx = fxc.getContext('2d');
  let dpr = 1, W = 0, H = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    for (const c of [glc, fxc]) {
      const w = Math.max(1, Math.floor(W * dpr)), h = Math.max(1, Math.floor(H * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
    camera.setViewport(glc.width, glc.height);
    gl.viewport(0, 0, glc.width, glc.height);
    camera.zoom = 1 / dpr;                 // 1 世界单位 = 1 CSS 像素
    camera.update();
  }
  addEventListener('resize', resize);

  const v3 = (x, y) => new sp.webgl.Vector3(x, y, 0);
  // spine-webgl 3.8 的 OrthoCamera 只有 screenToWorld，没有 worldToScreen：
  // 按它的正交投影参数手写一个逆映射（世界 -> CSS 像素）
  function w2s(x, y) {
    const hw = camera.zoom * camera.viewportWidth / 2;
    const hh = camera.zoom * camera.viewportHeight / 2;
    const nx = (x - camera.position.x) / hw;
    const ny = (y - camera.position.y) / hh;
    return { x: (nx + 1) / 2 * W, y: (1 - (ny + 1) / 2) * H };
  }
  const s2w = (px, py) => camera.screenToWorld(v3(px * dpr, py * dpr), glc.width, glc.height);

  // ---------------------------------------------------------------- 图集：追加程序化枪页
  function gunCanvas() {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 384;
    const g = c.getContext('2d');
    g.scale(3.2, 3.2);                     // 枪画满整页：像素量与「枪大小」滑块解耦，放大也不糊
    const metal = g.createLinearGradient(0, 12, 0, 74);
    metal.addColorStop(0, '#6f7885'); metal.addColorStop(.45, '#454c57'); metal.addColorStop(1, '#2b3038');
    const dark = '#1b1f26';
    g.lineJoin = 'round';
    // 枪管
    g.fillStyle = metal; g.fillRect(196, 40, 92, 16);
    g.fillStyle = dark;  g.fillRect(196, 34, 74, 6);
    // 机匣
    g.fillStyle = metal; g.beginPath();
    g.moveTo(74, 30); g.lineTo(206, 30); g.lineTo(206, 62); g.lineTo(74, 62); g.lineTo(64, 48); g.closePath(); g.fill();
    // 上机匣导轨 + 准星
    g.fillStyle = dark; g.fillRect(96, 24, 74, 8); g.fillRect(178, 20, 8, 12); g.fillRect(266, 24, 6, 12);
    // 枪托
    g.fillStyle = '#3a4049'; g.beginPath();
    g.moveTo(74, 32); g.lineTo(14, 40); g.lineTo(10, 66); g.lineTo(74, 60); g.closePath(); g.fill();
    // 弹匣
    g.fillStyle = '#333a44'; g.beginPath();
    g.moveTo(120, 62); g.lineTo(154, 62); g.lineTo(164, 108); g.lineTo(126, 108); g.closePath(); g.fill();
    // 握把
    g.fillStyle = '#2a3039'; g.beginPath();
    g.moveTo(74, 60); g.lineTo(104, 60); g.lineTo(96, 112); g.lineTo(66, 106); g.closePath(); g.fill();
    // 高光
    g.strokeStyle = 'rgba(255,255,255,.28)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(80, 34); g.lineTo(200, 34); g.stroke();
    return c;
  }

  function appendGunPage(atlasText) {
    return atlasText.replace(/\s*$/, '\n\n') + [
      'gun.png', 'size: 1024,384', 'format: RGBA8888', 'filter: Linear,Linear', 'repeat: none',
      'gun', 'rotate: false', 'xy: 0, 0', 'size: 1024,384', 'orig: 1024,384', 'offset: 0,0', 'index: -1', ''
    ].join('\n');
  }

  function declaredPageSizes(text) {
    const sizes = {}, lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim() || raw.indexOf(':') !== -1) continue;
      let j = i + 1; while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length || /^\s/.test(lines[j])) continue;
      const m = /^\s*size\s*:\s*(\d+)\s*,\s*(\d+)/.exec(lines[j]);
      if (m) sizes[raw.trim()] = { w: +m[1], h: +m[2] };
    }
    return sizes;
  }

  function fixAtlasUVs(atlas, text) {
    const sizes = declaredPageSizes(text);
    for (const r of atlas.regions || []) {
      const d = r.page && sizes[r.page.name];
      if (!d || !d.w || !r.page.width) continue;
      const kx = r.page.width / d.w, ky = r.page.height / d.h;
      if (Math.abs(kx - 1) < 1e-6 && Math.abs(ky - 1) < 1e-6) continue;
      r.u *= kx; r.u2 *= kx; r.v *= ky; r.v2 *= ky;
    }
    for (const p of atlas.pages || []) {
      const d = sizes[p.name];
      if (!d || !d.w || !p.texture || p.width === d.w) continue;
      p.texture.getImage = function () { return { width: d.w, height: d.h }; };
    }
  }

  function loadImage(src) {
    return new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('img ' + src)); i.src = src;
    });
  }

  // ---------------------------------------------------------------- 玩家状态
  const P = {
    x: 0, y: 0, vx: 0, vy: 0, onGround: true,
    facing: 1, flipT: 0, flipFrom: 1,
    ammo: 30, mag: 30, fireCd: 0, reloadT: 0, meleeT: 0, hitT: 0, landT: 0,
    drawT: 0, holsterT: 0, holstered: false, dead: false,
    aim: 0, aimTarget: 0, aimLock: null, auto: false, lockUpper: null, armPick: true,
    scale: 0.095, grip: 340, damp: 20, panUp: 0,
  };
  const GRAV = 1900, JUMP_V = 720, WALK_V = 210, RUN_V = 430;

  // 背景与叠加层配色：与角色拉开对比
  const BG = {
    clear: [0.64, 0.67, 0.70],
    ground: '#4b5563', fill: 'rgba(70,82,102,.10)',
    cross: 'rgba(28,34,44,.65)', bullet: '#d8660f', dust: '#6f7788', trail: 'rgba(200,110,30,.55)',
  };
  const TH = () => BG;
  let camX = 0, camY = 0;
  const bullets = [], shells = [], flashes = [], dusts = [];
  const keys = Object.create(null);
  let mouse = { x: 0, y: 0, down: false };

  // ---------------------------------------------------------------- 骨架
  let skeleton, state, boneAim, boneGun, boneSpine2, boneHead, boneMuzzle, ikR, ikL;
  let gunAt = null, gunAtW = 0, gunAtH = 0, muzzleX0 = 0;
  let boneGripR = null, boneGripL = null;

  async function boot() {
    resize();
    const bust = '?v=' + Date.now();     // 开发期避免浏览器缓存住旧骨架
    const [jsonText, atlasRaw, pageImg] = await Promise.all([
      fetch(JSON_URL + bust).then(r => r.text()),
      fetch(ATLAS_URL).then(r => r.text()),
      loadImage(PAGE_URL),
    ]);
    const atlasText = appendGunPage(atlasRaw);
    const gunImg = gunCanvas();

    const texMap = {};
    const mk = img => new sp.webgl.GLTexture(renderer.context, img, false);
    texMap['nanzhu.png'] = mk(pageImg);
    texMap['nanzhu.png'.replace(/^.*[\\/]/, '')] = texMap['nanzhu.png'];
    texMap['gun.png'] = mk(gunImg);

    const atlas = new sp.TextureAtlas(atlasText, p => texMap[String(p).replace(/^.*[\\/]/, '')]);
    fixAtlasUVs(atlas, atlasText);

    const json = new sp.SkeletonJson(new sp.AtlasAttachmentLoader(atlas));
    skeleton = new sp.Skeleton(json.readSkeletonData(jsonText));
    skeleton.scaleX = P.scale; skeleton.scaleY = P.scale;

    const asd = new sp.AnimationStateData(skeleton.data);
    asd.defaultMix = 0.18;
    const mix = (a, b, d) => { asd.setMix(a, b, d); asd.setMix(b, a, d); };
    mix('idle', 'walk', 0.16); mix('idle', 'run', 0.2); mix('walk', 'run', 0.18);
    for (const a of ['upper_idle', 'upper_walk', 'upper_run']) {
      for (const b of ['upper_jump', 'upper_fall']) mix(a, b, 0.12);
    }
    mix('upper_idle', 'upper_walk', 0.16); mix('upper_idle', 'upper_run', 0.2);
    mix('upper_walk', 'upper_run', 0.18);
    for (const a of ['upper_idle', 'upper_walk', 'upper_run', 'upper_jump', 'upper_fall']) {
      mix(a, 'upper_land', 0.08); mix(a, 'upper_gethit', 0.09);
      mix(a, 'upper_melee', 0.1); mix(a, 'upper_reload', 0.22);
      mix(a, 'upper_holster', 0.16); mix('upper_holster', 'upper_draw', 0.16);
      mix(a, 'upper_die', 0.3); mix(a, 'upper_turn', 0.1);
    }
    state = new sp.AnimationState(asd);
    state.addListener({
      event: (e, ev) => onEvent(ev.data.name),
      complete: e => onComplete(e.animation.name),
    });

    boneAim = skeleton.findBone('aim_pivot');
    boneGun = skeleton.findBone('gun');
    boneSpine2 = skeleton.findBone('Spine2');
    boneHead = skeleton.findBone('Head');
    boneMuzzle = skeleton.findBone('muzzle');
    boneGripR = skeleton.findBone('grip_R');
    boneGripL = skeleton.findBone('grip_L');
    muzzleX0 = boneMuzzle.data.x;
    ikR = skeleton.findIkConstraint('ik_arm_R');
    ikL = skeleton.findIkConstraint('ik_arm_L');
    // 枪的世界尺寸写在附件上（与图集像素无关），滑块直接改它就能实时换枪大小
    gunAt = skeleton.getAttachmentByName('gun', 'gun');
    if (gunAt) { gunAtW = gunAt.width; gunAtH = gunAt.height; }
    // 数据里保留了 IK 约束（导出给编辑器 / 其它 runtime 用），运行时改由下面的
    // solveArm() 解析求解 —— 完全可控，也便于按状态调权重。
    if (ikR) ikR.mix = 0;
    if (ikL) ikL.mix = 0;

    // 骨架 root 不在脚底：在 run / idle 动画上各采一轮，取"脚最低的那一帧"当地面基准，
    // 这样跑动落地和站立都不会悬空或陷进地里。
    let lo = Infinity;
    skeleton.scaleX = 1; skeleton.scaleY = 1;      // 采样用骨架单位，使用时再乘缩放
    for (const name of ['run', 'idle', 'walk']) {
      const an = skeleton.data.findAnimation(name);
      if (!an) continue;
      const step = an.duration / 16;
      for (let t = 0; t < an.duration; t += step) {
        an.apply(skeleton, 0, t, false, null, 1, sp.MixBlend.setup, sp.MixDirection.mix);
        skeleton.updateWorldTransform();
        for (const b of skeleton.bones) {
          lo = Math.min(lo, b.worldY);
          // 腿部骨骼再算一次"末端"，脚掌才不会浮在地面线上
          if (/thigh|foot|leg/i.test(b.name)) lo = Math.min(lo, b.worldY - Math.abs(b.data.length) * Math.abs(b.c));
        }
      }
    }
    P.footY = isFinite(lo) ? -lo : 0;
    skeleton.setToSetupPose();

    P.x = W * 0.5; P.y = 0;
    camX = P.x;                          // 首帧就对上角色，避免开局"镜头拉过去"

    // URL 参数：?bones=1&scale=160&grip=380&high=60&aim=-70&upper=upper_reload
    const q = new URLSearchParams(location.search);
    if (q.get('bones')) $('cBones').checked = true;
    if (q.get('trail')) $('cTrail').checked = true;
    if (q.get('slow')) $('cSlow').checked = true;
    if (q.get('scale')) { $('cScale').value = q.get('scale'); P.scale = +q.get('scale') / 1000; }
    if (q.get('grip')) { $('cGrip').value = q.get('grip'); P.grip = +q.get('grip'); }
    if (q.get('high')) $('cHigh').value = q.get('high');
    if (q.get('gun')) $('cGun').value = q.get('gun');
    if (q.get('damp')) $('cDamp').value = q.get('damp');
    if (q.get('panup')) P.panUp = +q.get('panup');
    if (q.get('demo')) P.auto = true;      // 演示模式：自动走 / 跑 / 跳 / 射击 / 换弹
    if (q.get('aim')) { P.aimLock = +q.get('aim'); P.aim = P.aimLock; }
    if (q.get('upper')) { P.lockUpper = q.get('upper'); cur[1] = P.lockUpper; state.setAnimation(1, cur[1], true); }
    if (q.get('lower')) { cur[0] = q.get('lower'); state.setAnimation(0, cur[0], true); }
    mouse = { x: W * 0.72, y: H * 0.45, down: false };
    window.__dbg = { skeleton, P, camera, state, w2s };
    $('load').classList.add('hidden');
    requestAnimationFrame(loop);
  }

  function onEvent(name) {
    switch (name) {
      case 'muzzle_flash': muzzleFlash(); break;
      case 'eject': ejectShell(); break;
      case 'walk': case 'run': footDust(); break;
      case 'reload_done': P.reloadT = 0; P.ammo = P.mag; break;
      case 'draw_done': P.drawT = 0; P.holstered = false; break;
      case 'holster_done': P.holsterT = 0; P.holstered = true; break;
      case 'melee_hit': P.meleeT = Math.min(P.meleeT, 0.27); break;
    }
  }
  function onComplete(name) {
    if (name === 'upper_holster') P.holsterT = 0;
  }

  // ---------------------------------------------------------------- 输入
  addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    if (keys[k]) return;
    keys[k] = true;
    if (k === ' ') { e.preventDefault(); if (P.onGround && !P.dead) { P.vy = JUMP_V; P.onGround = false; } }
    if (k === 'r') tryReload();
    if (k === 'e') tryMelee();
    if (k === 'h') tryHolster();
    if (k === 'f' && !P.dead) { P.hitT = 0.42; }
    if (k === 'g') { P.dead = !P.dead; if (!P.dead) { P.hitT = 0; } }
    if (k === 'arrowup' || k === 'arrowdown') e.preventDefault();
  });
  addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouse.down = false; });

  fxc.style.pointerEvents = 'none';
  addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
  addEventListener('mousedown', e => { if (e.button === 0) mouse.down = true; });
  addEventListener('mouseup', e => { if (e.button === 0) mouse.down = false; });
  addEventListener('contextmenu', e => e.preventDefault());

  function tryReload() {
    if (P.dead || P.reloadT > 0 || P.holstered || P.ammo === P.mag) return;
    P.reloadT = 1.75;
  }
  function tryMelee() {
    if (P.dead || P.meleeT > 0 || P.reloadT > 0 || P.holstered) return;
    P.meleeT = 0.58;
  }
  function tryHolster() {
    if (P.dead || P.drawT > 0 || P.holsterT > 0) return;
    if (P.holstered) { P.reloadT = 0; P.drawT = 0.55; } else { P.holsterT = 0.55; }
  }
  function tryFire(dt) {
    if (P.dead || P.holstered || P.reloadT > 0 || P.meleeT > 0 || P.fireCd > 0) return;
    if (P.ammo <= 0) { tryReload(); return; }
    P.ammo--; P.fireCd = 0.11;
    const e = state.setAnimation(2, 'upper_fire', false);
    e.mixBlend = sp.MixBlend.add; e.mixDuration = 0; e.alpha = 1;
    state.setEmptyAnimation(2, 0.13);
    // 后坐：给一点整体退让
    P.vx -= Math.cos(P.aim * Math.PI / 180) * 26;
  }

  // ---------------------------------------------------------------- 特效
  function muzzleFlash() {
    flashes.push({ x: boneMuzzle.worldX, y: boneMuzzle.worldY, t: 0.09, life: 0.09, a: P.aim });
    shootBullet();
  }
  function ejectShell() {
    const a = (P.aim + (P.facing > 0 ? 105 : 75)) * Math.PI / 180;
    shells.push({ x: boneGun.worldX, y: boneGun.worldY, vx: Math.cos(a) * 150,
      vy: Math.sin(a) * 190 + 90, rot: 0, vr: 9, life: 1.6 });
  }
  function footDust() {
    dusts.push({ x: P.x - P.facing * 12, y: 4, t: 0.35, life: 0.35, r: 3 + Math.random() * 4 });
  }
  function shootBullet() {
    const a = (P.aim + (Math.random() - 0.5) * 2.4) * Math.PI / 180;
    bullets.push({ x: boneMuzzle.worldX, y: boneMuzzle.worldY,
      vx: Math.cos(a) * 1500, vy: Math.sin(a) * 1500, life: 1.4 });
  }

  // ---------------------------------------------------------------- 动画选择
  const cur = { 0: null, 1: null };
  function setTrack(track, name, loop) {
    if (cur[track] === name) return null;
    cur[track] = name;
    return state.setAnimation(track, name, loop);
  }
  function moveDir() {
    return (keys['d'] ? 1 : 0) - (keys['a'] ? 1 : 0) ||
           (keys['arrowright'] ? 1 : 0) - (keys['arrowleft'] ? 1 : 0);
  }
  function lowerAnim() {
    if (P.dead) return ['death', false];
    if (P.hitT > 0) return ['gethit', false];
    if (!P.onGround) return ['run', true];
    if (moveDir()) return [keys['shift'] ? 'run' : 'walk', true];
    return ['idle', true];
  }
  // 一次性动作播完停在末帧即可，不必循环（重播由状态机控制）
  const ONESHOT = {
    upper_reload: 1, upper_gethit: 1, upper_melee: 1, upper_land: 1,
    upper_die: 1, upper_draw: 1, upper_holster: 1, upper_jump: 1,
  };
  function upperAnim() {
    if (P.dead) return 'upper_die';
    if (P.holstered && P.holsterT <= 0 && P.drawT <= 0) return 'upper_holster';
    if (P.holsterT > 0) return 'upper_holster';
    if (P.drawT > 0) return 'upper_draw';
    if (P.reloadT > 0) return 'upper_reload';
    if (P.meleeT > 0) return 'upper_melee';
    if (P.hitT > 0) return 'upper_gethit';
    if (!P.onGround) return P.vy > 0 ? 'upper_jump' : 'upper_fall';
    if (P.landT > 0) return 'upper_land';
    if (moveDir()) return keys['shift'] ? 'upper_run' : 'upper_walk';
    return 'upper_idle';
  }

  const DEG = 180 / Math.PI, RAD = Math.PI / 180;
  function worldRot(b) { return Math.atan2(b.c, b.a) * DEG; }

  // 枪原图（region 300x112，附件中心 = 图 (150,56)）上各关键点的像素位置。
  // 所有挂点都由这些像素换算，枪缩放时自动跟随，不必再手填 CFG 偏移。
  const GUN_PX = { tailX: 10, gripX: 85, gripY: 86, foreX: 134, foreY: 84, muzX: 298, muzY: 48 };
  const CHAIN = 529;                       // 上臂 + 前臂（本骨架），握点必须落在它之内

  // 枪尺寸 / 抵肩 / 握点 / 枪口 一体换算
  function fitGun(gripK) {
    const el = $('cGun');
    const k = el ? +el.value / 100 : 1.3;
    if (gunAt) {
      gunAt.width = gunAtW * k; gunAt.height = gunAtH * k;
      gunAt.updateOffset();                // 3.8 改了尺寸必须重算顶点，否则画面纹丝不动
    }
    const w = gunAtW * k, s = w / 300;     // 世界单位 / 原图像素
    const cx = gunAt.x, cy = gunAt.y;
    const lx = px => cx + (px - 150) * s;
    const ly = py => cy - (py - 56) * s;

    // 抵肩：枪托底对准肩点（再叠加滑块微调，正值=枪往前挪一点）
    const tail = lx(GUN_PX.tailX);
    boneGun.data.x = (-tail + P.grip) * gripK;

    boneMuzzle.data.x = lx(GUN_PX.muzX); boneMuzzle.data.y = ly(GUN_PX.muzY);

    // 握点按真实图形位置；枪放大到手臂够不着时，把该手沿枪身往回收
    const setGrip = (bone, pxX, pxY, maxReach) => {
      bone.data.y = ly(pxY);
      let x = lx(pxX);
      if (boneGun.data.x + x > maxReach) x = maxReach - boneGun.data.x;
      bone.data.x = x;
    };
    setGrip(boneGripR, GUN_PX.gripX, GUN_PX.gripY, CHAIN - 100);
    setGrip(boneGripL, GUN_PX.foreX, GUN_PX.foreY, CHAIN - 60);
  }

  // 双手持枪权重：空手 / 受击 / 换弹时按状态松开（比纯动画 timeline 更好调）
  function armWeights() {
    if (P.dead || P.lockUpper === 'upper_die') return { r: 0, l: 0 };
    if (P.holsterT > 0 || P.lockUpper === 'upper_holster') {
      const k = P.holsterT > 0 ? 1 - P.holsterT / 0.55 : 0;      // 锁定时按"已收好"处理
      return { r: k, l: k };
    }
    if (P.drawT > 0 || P.lockUpper === 'upper_draw') {
      const k = P.drawT > 0 ? 1 - P.drawT / 0.55 : 1;            // 锁定时按"已举好"处理
      return { r: Math.min(1, k * 1.4), l: k };
    }
    if (P.reloadT > 0 || P.lockUpper === 'upper_reload') {
      const t = P.reloadT > 0 ? 1.75 - P.reloadT : 0.9;  // 换弹进度
      const hand = (a, b, va, vb) => va + (vb - va) * Math.min(1, Math.max(0, (t - a) / (b - a)));
      const l = t < 0.85 ? hand(0, 0.25, 0.9, 0.05) : hand(1.0, 1.45, 0.05, 0.9);
      const r = t < 0.3 ? hand(0, 0.3, 1, 0.75) : (t < 1.45 ? 0.75 : hand(1.45, 1.7, 0.75, 1));
      return { r, l };
    }
    return { r: 1, l: 1 };               // 双手都完全贴合握把（<1 会留下肉眼可见的偏差）
  }

  // 两骨 IK（余弦定理）。世界角 -> 局部角时要按镜像翻符号，否则转身后手臂会反向。
  function solveArm(side, bendDir, weight) {
    if (weight <= 0.001) return;
    const b1 = skeleton.findBone('UpperArm_1_' + side);
    const b2 = skeleton.findBone('UpperArm_2_' + side);
    const g = skeleton.findBone('grip_' + side);
    if (!b1 || !b2 || !g) return;
    const L1 = b1.data.length * Math.hypot(b1.a, b1.c);
    const L2 = b2.data.length * Math.hypot(b2.a, b2.c);
    const dx = g.worldX - b1.worldX, dy = g.worldY - b1.worldY;
    const raw = Math.hypot(dx, dy);
    const d = Math.min(Math.max(raw, Math.abs(L1 - L2) + 0.01), L1 + L2 - 0.01);
    const base = Math.atan2(dy, dx) * DEG;
    const cosA = Math.min(1, Math.max(-1, (d * d + L1 * L1 - L2 * L2) / (2 * d * L1)));
    const A = Math.acos(cosA) * DEG;
    // 两个解（肘在肩的两侧）。用"肘部世界 y 更低"来选，而不是固定 ±：
    // 固定符号在朝右时恰好朝下，转向左边就变成朝上了（手臂会甩到头顶）。
    const dy1 = Math.sin((base + A) * RAD) * L1, dy2 = Math.sin((base - A) * RAD) * L1;
    let pick;                                        // true => base + A
    if (Math.abs(dy1 - dy2) < L1 * 0.04) pick = P.armPick;   // 近乎对称时保持上一帧，避免抖动
    else pick = bendDir < 0 ? (dy1 < dy2) : (dy1 > dy2);
    P.armPick = pick;
    const armDir = pick ? base + A : base - A;
    const ex = b1.worldX + Math.cos(armDir * RAD) * L1;
    const ey = b1.worldY + Math.sin(armDir * RAD) * L1;
    const foreDir = Math.atan2(g.worldY - ey, g.worldX - ex) * DEG;
    const par = b1.parent;
    const pw = Math.atan2(par.c, par.a) * DEG;
    const mir = skeleton.scaleX < 0 ? -1 : 1;
    const t1 = mir > 0 ? (armDir - pw) : (pw - armDir);
    const t2 = mir > 0 ? (foreDir - armDir) : (armDir - foreDir);
    const blend = (from, to) => from + (((to - from + 540) % 360) - 180) * weight;
    b1.rotation = blend(b1.rotation, t1);
    b2.rotation = blend(b2.rotation, t2);
  }

  // ---------------------------------------------------------------- 主循环
  let last = performance.now();
  function loop(now) {
    let dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if ($('cSlow').checked) dt *= 0.35;
    update(dt);
    render();
    requestAnimationFrame(loop);
  }

  // 演示模式：把输入脚本化，一次跑完走 / 跑 / 跳 / 射击 / 换弹 / 收枪
  function autoDrive(t) {
    keys['d'] = Math.sin(t * 0.33) > -0.45;
    keys['a'] = Math.sin(t * 0.33) < -0.45;
    keys['shift'] = Math.sin(t * 0.21) > 0.55;
    mouse.down = Math.sin(t * 0.85) > 0.5;
    P.aimLock = Math.sin(t * 0.42) * 42;
    if (P.onGround && Math.sin(t * 0.6) > 0.97) { P.vy = JUMP_V; P.onGround = false; }
    if (Math.sin(t * 0.29) > 0.985) tryReload();
    if (Math.sin(t * 0.17) > 0.99) tryHolster();
  }

  function update(dt) {
    if (P.auto) autoDrive(performance.now() / 1000);
    // --- 瞄准角
    if (keys['arrowup']) P.aimLock = (P.aimLock === null ? 0 : P.aimLock) + 90 * dt;
    else if (keys['arrowdown']) P.aimLock = (P.aimLock === null ? 0 : P.aimLock) - 90 * dt;
    if (P.aimLock !== null && !keys['arrowup'] && !keys['arrowdown'] && !mouse.down) { /* 保持锁定 */ }
    const mw = s2w(mouse.x, mouse.y);
    if (P.aimLock === null) {
      const dx = mw.x - (skeleton ? boneAim.worldX : P.x);
      const dy = mw.y - (skeleton ? boneAim.worldY : P.y + 900 * P.scale);
      P.aimTarget = Math.atan2(dy, dx) * DEG;
    } else P.aimTarget = P.aimLock;
    // 角度阻尼（走最短弧）
    let d = ((P.aimTarget - P.aim + 540) % 360) - 180;
    P.aim += d * (1 - Math.exp(-P.damp * dt));

    // --- 朝向翻转（含 0.14s 转身缩放，避免硬切）
    const want = Math.cos(P.aim * Math.PI / 180) >= 0 ? 1 : -1;
    if (want !== P.facing && P.flipT <= 0) { P.flipFrom = P.facing; P.facing = want; P.flipT = 0.14; }
    if (P.flipT > 0) P.flipT = Math.max(0, P.flipT - dt);

    // --- 移动
    if (!P.dead) {
      const mv = (keys['d'] ? 1 : 0) - (keys['a'] ? 1 : 0);
      const target = mv * (keys['shift'] ? RUN_V : WALK_V);
      const accel = P.onGround ? 12 : 5;
      P.vx += (target - P.vx) * Math.min(1, accel * dt);
      P.x += P.vx * dt;
      P.vy -= GRAV * dt;
      P.y += P.vy * dt;
      if (P.y <= 0) {
        if (!P.onGround && P.vy < -200) P.landT = 0.28;
        P.y = 0; P.vy = 0; P.onGround = true;
      } else P.onGround = false;
    }
    P.x = Math.max(60, Math.min(W * 3, P.x));

    // --- 计时器
    const dec = k => { if (P[k] > 0) P[k] = Math.max(0, P[k] - dt); };
    ['fireCd', 'reloadT', 'meleeT', 'hitT', 'landT', 'drawT', 'holsterT'].forEach(dec);
    if (P.ammo === 0 && P.reloadT === 0 && !P.holstered && !P.dead) tryReload();

    // --- 开火
    if (mouse.down) tryFire(dt);

    // --- 动画轨道
    const [ln, ll] = lowerAnim();
    setTrack(0, ln, ll);
    const t0 = state.getCurrent(0);
    // 空中没有专门动画：沿用 run，但放慢并定格成"腾空蹬腿"的观感
    if (t0) t0.timeScale = (ln === 'run' && !P.onGround) ? (P.vy > 0 ? 0.35 : 0.5) : 1;
    const un = P.lockUpper || upperAnim();
    setTrack(1, un, !ONESHOT[un]);

    // --- apply + 程序化瞄准 + IK
    state.update(dt);
    state.apply(skeleton);
    // 收枪时把枪收回腰侧（动画负责下沉转向，这里负责贴身）
    let gripK = 1;
    if (P.holsterT > 0) gripK = 1 - 0.58 * (1 - P.holsterT / 0.55);
    else if ((P.holstered || P.lockUpper === 'upper_holster') && P.drawT <= 0) gripK = 0.42;
    else if (P.drawT > 0) gripK = 0.42 + 0.58 * (1 - P.drawT / 0.55);
    boneAim.data.x = 232; boneAim.data.y = +$('cHigh').value;
    fitGun(gripK);                          // 枪尺寸 + 抵肩 + 握点/枪口（见下）

    // 躯干 / 头随俯仰角轻微跟随：往上抬枪时身体后仰，避免"手举着、身子不动"的僵感
    const pitch = Math.asin(Math.sin(P.aim * RAD)) * DEG;      // 相对水平面的俯仰
    const dirS = P.facing > 0 ? 1 : -1;
    boneSpine2.rotation += Math.max(-12, Math.min(12, pitch * 0.16)) * dirS;
    boneHead.rotation += Math.max(-8, Math.min(8, pitch * 0.12)) * dirS;

    const p = P.flipT > 0 ? P.flipT / 0.14 : 1;
    const sx = P.flipT > 0 ? (p < 0.5 ? P.flipFrom * (1 - p * 2) : P.facing * (p * 2 - 1)) : P.facing;
    skeleton.scaleX = sx * P.scale; skeleton.scaleY = P.scale;
    skeleton.x = P.x; skeleton.y = P.y + P.footY * P.scale;
    skeleton.updateWorldTransform();

    // 枪的世界角 = 玩家瞄准角；反推 aim_pivot 局部角（镜像时局部旋转方向相反）
    const pw = worldRot(boneSpine2);
    boneAim.rotation = P.facing > 0 ? (P.aim - pw) : (pw - P.aim);
    skeleton.updateWorldTransform();      // 第二次：枪 / 握把世界位置就绪

    const bendDir = $('cBend').value === '0' ? -1 : 1;
    const armW = armWeights();
    solveArm('R', bendDir, armW.r);
    solveArm('L', bendDir, armW.l);
    skeleton.updateWorldTransform();      // 第三次：手臂按解算结果落到枪上

    if (ikR) ikR.bendPositive = $('cBend').value === '0' ? false : true;
    P.damp = +$('cDamp').value; P.grip = +$('cGrip').value; P.scale = +$('cScale').value / 1000;

    // --- 粒子
    for (const b of bullets) { b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt; }
    for (let i = bullets.length - 1; i >= 0; i--) if (bullets[i].life <= 0) bullets.splice(i, 1);
    for (const s of shells) {
      s.vy -= GRAV * 0.6 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.rot += s.vr * dt; s.life -= dt;
      if (s.y < 2) { s.y = 2; s.vy *= -0.35; s.vx *= 0.6; s.vr *= 0.5; }
    }
    for (let i = shells.length - 1; i >= 0; i--) if (shells[i].life <= 0) shells.splice(i, 1);
    for (const f of flashes) f.t -= dt;
    for (let i = flashes.length - 1; i >= 0; i--) if (flashes[i].t <= 0) flashes.splice(i, 1);
    for (const d of dusts) { d.t -= dt; d.r += 26 * dt; }
    for (let i = dusts.length - 1; i >= 0; i--) if (dusts[i].t <= 0) dusts.splice(i, 1);

    // --- 相机
    camX += (P.x - camX) * Math.min(1, 6 * dt);
    camY = 0.28 * H + P.panUp;
    camera.position.x = camX; camera.position.y = camY; camera.update();

    hud();
  }

  function hud() {
    const a = $('ammo');
    a.textContent = P.ammo + ' / ' + P.mag;
    a.className = P.ammo <= 6 ? 'v low' : 'v';
    $('state').textContent = P.dead ? '倒地' : (P.reloadT > 0 ? '换弹' : P.meleeT > 0 ? '近战' :
      P.holsterT > 0 ? '收枪' : P.drawT > 0 ? '拔枪' : P.hitT > 0 ? '受击' :
      !P.onGround ? (P.vy > 0 ? '上升' : '下落') : (keys['shift'] ? '跑' : keys['a'] || keys['d'] ? '走' : '待机'));
    $('upper').textContent = cur[1] || '—';
    $('lower').textContent = cur[0] || '—';
    const b1 = skeleton.findBone('UpperArm_1_R'), b2 = skeleton.findBone('UpperArm_2_R'), gR = skeleton.findBone('grip_R');
    const tipX = b2.worldX + b2.a * b2.data.length, tipY = b2.worldY + b2.c * b2.data.length;
    const err = Math.hypot(tipX - gR.worldX, tipY - gR.worldY);        // 已是世界单位(px)
    const L = (b1.data.length + b2.data.length) * P.scale;
    const d = Math.hypot(gR.worldX - b1.worldX, gR.worldY - b1.worldY);
    const wa1 = Math.atan2(b1.c, b1.a) * DEG, wa2 = Math.atan2(b2.c, b2.a) * DEG;
    const want = Math.atan2(gR.worldY - b1.worldY, gR.worldX - b1.worldX) * DEG;
    $('dbg3').textContent = '链 ' + L.toFixed(0) + ' 距 ' + d.toFixed(0) +
      ' · 臂角 ' + wa1.toFixed(0) + '/' + wa2.toFixed(0) + ' · 目标 ' + want.toFixed(0);
    $('dbg2').textContent = 'cam ' + camX.toFixed(0) + ' · P ' + P.x.toFixed(0) +
      ' · 脚 ' + skeleton.findBone('Thigh_3_R').worldY.toFixed(0) +
      ' · 枪口 ' + skeleton.findBone('muzzle').worldX.toFixed(0) + ',' +
      skeleton.findBone('muzzle').worldY.toFixed(0) +
      ' · 手到位差 ' + err.toFixed(2) + 'px';
    $('aimv').textContent = P.aim.toFixed(0) + '°';
  }

  // ---------------------------------------------------------------- 绘制
  function render() {
    const th = TH();
    gl.clearColor(th.clear[0], th.clear[1], th.clear[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    renderer.begin();
    renderer.drawSkeleton(skeleton, false);
    if ($('cBones').checked) {
      const dbg = renderer.skeletonDebugRenderer;
      if (dbg) { dbg.drawBones = true; dbg.drawRegionAttachments = false; dbg.drawMeshHull = false;
        dbg.drawClipping = false; dbg.drawPaths = false; dbg.drawAabbs = false;
        renderer.drawSkeletonDebug(skeleton, false); }
    }
    renderer.end();

    // --- 2D 叠加层
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const g0 = w2s(0, 0);
    ctx.strokeStyle = th.ground; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, g0.y); ctx.lineTo(W, g0.y); ctx.stroke();
    ctx.fillStyle = th.fill; ctx.fillRect(0, g0.y, W, H - g0.y);

    // 枪口轨迹
    if ($('cTrail').checked && flashes.length) {
      const f = flashes[0], s = w2s(f.x, f.y);
      ctx.strokeStyle = th.trail;
      ctx.beginPath(); ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x + Math.cos(f.a * Math.PI / 180) * 900, s.y - Math.sin(f.a * Math.PI / 180) * 900);
      ctx.stroke();
    }
    // 火光
    for (const f of flashes) {
      const s = w2s(f.x, f.y), k = f.t / f.life;
      const ca = Math.cos(-f.a * Math.PI / 180), sa = Math.sin(-f.a * Math.PI / 180);
      ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(-f.a * Math.PI / 180);
      ctx.globalAlpha = k;
      const gr = ctx.createRadialGradient(0, 0, 2, 0, 0, 40 * k + 12);
      gr.addColorStop(0, '#fff6d0'); gr.addColorStop(.4, 'rgba(255,190,90,.9)'); gr.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, 40 * k + 12, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff2c8';
      ctx.beginPath(); ctx.moveTo(6, -7); ctx.lineTo(46 * k + 16, 0); ctx.lineTo(6, 7); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    // 子弹
    ctx.strokeStyle = th.bullet; ctx.lineWidth = 2;
    for (const b of bullets) {
      const s = w2s(b.x, b.y), e = w2s(b.x - b.vx * 0.012, b.y - b.vy * 0.012);
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y); ctx.stroke();
    }
    // 弹壳
    for (const s of shells) {
      const p = w2s(s.x, s.y);
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(s.rot);
      ctx.fillStyle = '#c9a24a'; ctx.fillRect(-3, -5, 7, 10); ctx.restore();
    }
    // 尘土
    for (const d of dusts) {
      const p = w2s(d.x, d.y);
      ctx.globalAlpha = d.t / d.life * 0.5; ctx.fillStyle = th.dust;
      ctx.beginPath(); ctx.arc(p.x, p.y, d.r, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
    }
    // 准星
    ctx.globalAlpha = 1;
    ctx.strokeStyle = th.cross; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(mouse.x, mouse.y, 10, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(mouse.x - 16, mouse.y); ctx.lineTo(mouse.x - 4, mouse.y);
    ctx.moveTo(mouse.x + 4, mouse.y); ctx.lineTo(mouse.x + 16, mouse.y);
    ctx.moveTo(mouse.x, mouse.y - 16); ctx.lineTo(mouse.x, mouse.y - 4);
    ctx.moveTo(mouse.x, mouse.y + 4); ctx.lineTo(mouse.x, mouse.y + 16); ctx.stroke();

    // 骨骼调试：IK 目标点
    if ($('cBones').checked) {
      for (const b of ['grip_R', 'grip_L', 'muzzle']) {
        const bb = skeleton.findBone(b); if (!bb) continue;
        const p = w2s(bb.worldX, bb.worldY);
        ctx.fillStyle = b === 'muzzle' ? '#ff9a3c' : '#5ad1ff';
        ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 7); ctx.fill();
      }
    }
  }

  function fail(msg) {
    const el = $('load'); el.classList.remove('hidden');
    el.innerHTML = '<div class="err">' + msg + '</div>';
  }
  addEventListener('error', e => {
    const el = $('dbg3');
    if (el) { el.style.color = '#ff8080'; el.textContent = 'ERR ' + (e.message || e.error); }
  });
  boot().catch(e => fail('加载失败：' + (e && e.message || e) +
    '\n\n请通过 HTTP 打开（仓库根目录 serve.bat 或 python -m http.server）'));
})();
