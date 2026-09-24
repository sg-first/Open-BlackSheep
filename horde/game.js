/* 横板射击 · 割草
 * 场景素材来自 _index/bg_files.tsv（153 张 1920x1080 背景），敌人用 duke 等角色骨架。
 * 三层画布：#bg 视差背景(2D) · #gl 角色(WebGL/Spine) · #fx 前景与特效(2D)
 */
(() => {
  'use strict';
  const sp = window.spine;
  const $ = id => document.getElementById(id);
  const DEG = 180 / Math.PI, RAD = Math.PI / 180;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rnd = (a, b) => a + Math.random() * (b - a);

  // ---------------------------------------------------------------- 画布
  const glc = $('gl'), bgc = $('bg'), fxc = $('fx');
  const gl = glc.getContext('webgl', { alpha: true, premultipliedAlpha: false }) ||
             glc.getContext('experimental-webgl', { alpha: true, premultipliedAlpha: false });
  if (!gl) { fail('浏览器不支持 WebGL'); return; }
  const renderer = new sp.webgl.SceneRenderer(glc, gl);
  const camera = renderer.camera;
  const bgx = bgc.getContext('2d');
  const fx = fxc.getContext('2d');
  let dpr = 1, W = 0, H = 0, groundY = 0, camX = 0, camY = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    for (const c of [glc, bgc, fxc]) {
      const w = Math.max(1, Math.floor(W * dpr)), h = Math.max(1, Math.floor(H * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
    groundY = Math.round(H * 0.76);
    camera.setViewport(glc.width, glc.height);
    gl.viewport(0, 0, glc.width, glc.height);
    camera.zoom = 1 / dpr;
  }
  addEventListener('resize', resize);

  const v3 = (x, y) => new sp.webgl.Vector3(x, y, 0);
  const w2s = (x, y) => ({ x: x - camX + W / 2, y: H / 2 + camY - y });
  const s2w = (px, py) => camera.screenToWorld(v3(px * dpr, py * dpr), glc.width, glc.height);

  // ---------------------------------------------------------------- 状态
  const G = {
    enemies: [], bullets: [], parts: [], texts: [],
    player: null, assets: {}, wave: 0, kills: 0, combo: 0, comboT: 0,
    speedScale: 1, damage: 34, cap: 18, shake: 0, hitstop: 0,
    queue: 0, spawnT: 0, waveState: 'idle', waveT: 0, paused: false, bones: false,
    onPlayerHit: (dmg, dir) => {
      const P = G.player;
      if (!P || P.dead) return;          // 倒地后不再吃伤害，否则复活计时一直被重置
      P.hurt(dmg);
      G.shake = Math.max(G.shake, 9);
      blood(P.x, 130, 8, dir * 0.4);
      if (P.dead) { G.waveState = 'dead'; G.waveT = 0; }
    },
  };

  // ---------------------------------------------------------------- 背景
  const BG = { list: [], imgs: {}, far: null, mid: null, near: null };

  async function loadBgList() {
    const t = await fetch('../_index/bg_files.tsv').then(r => r.text());
    const lines = t.split(/\r?\n/).filter(Boolean);
    const head = lines[0].split('\t');
    const iScene = head.indexOf('scene'), iFile = head.indexOf('file');
    const seen = new Set();
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split('\t');
      const scene = c[iScene], file = c[iFile];
      if (!file || !/\.png$/i.test(file)) continue;
      const key = scene + '/' + file;
      if (seen.has(key)) continue;
      seen.add(key);
      BG.list.push({ scene, file, url: '../scenes/' + scene + '/' + file, label: scene + ' · ' + file });
    }
    BG.list.sort((a, b) => a.label.localeCompare(b.label));
    const fill = (sel, def) => {
      sel.innerHTML = '<option value="">（无）</option>' +
        BG.list.map((b, i) => '<option value="' + i + '">' + b.label + '</option>').join('');
      if (def) {
        const idx = BG.list.findIndex(b => b.label.indexOf(def) >= 0);
        if (idx >= 0) sel.value = String(idx);
      }
      sel.onchange = () => pick(sel);
    };
    fill($('bgFar'), '00_main/BG1_977');
    fill($('bgMid'), '00_main/BG2_1203');
    fill($('bgNear'), '');
    await pick($('bgFar')); await pick($('bgMid')); await pick($('bgNear'));
  }

  async function getImg(i) {
    if (i === '' || i === null || i === undefined) return null;
    const b = BG.list[+i];
    if (!b) return null;
    if (!BG.imgs[b.url]) BG.imgs[b.url] = await HORDE.loadImage(b.url).catch(() => null);
    return BG.imgs[b.url];
  }
  async function pick(sel) {
    const img = await getImg(sel.value);
    if (sel.id === 'bgFar') BG.far = img;
    else if (sel.id === 'bgMid') BG.mid = img;
    else BG.near = img;
  }

  function drawLayer(img, parallax, alpha, tint) {
    if (!img) return;
    const sc = H / img.height;
    const w = img.width * sc, h = img.height * sc;
    let x = -(((camX * parallax) % w) + w) % w;
    bgx.globalAlpha = alpha;
    while (x < W) { bgx.drawImage(img, x, groundY - h, w, h); x += w; }
    bgx.globalAlpha = 1;
    if (tint) { bgx.fillStyle = tint; bgx.fillRect(0, 0, W, H); }
  }

  function drawBackground() {
    bgx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bgx.clearRect(0, 0, W, H);
    const sky = bgx.createLinearGradient(0, 0, 0, groundY);
    sky.addColorStop(0, '#111823'); sky.addColorStop(1, '#1d2735');
    bgx.fillStyle = sky; bgx.fillRect(0, 0, W, H);
    drawLayer(BG.far, 0.18, 1, 'rgba(16,22,32,.34)');
    drawLayer(BG.mid, 0.45, 1, 'rgba(16,22,32,.12)');
    if (!$('optGround').checked) return;
    // 地平线以下：地面
    const g = bgx.createLinearGradient(0, groundY, 0, H);
    g.addColorStop(0, '#2a2119'); g.addColorStop(1, '#100c09');
    bgx.fillStyle = g; bgx.fillRect(0, groundY, W, H - groundY);
    bgx.strokeStyle = 'rgba(255,190,120,.22)'; bgx.lineWidth = 2;
    bgx.beginPath(); bgx.moveTo(0, groundY); bgx.lineTo(W, groundY); bgx.stroke();
    // 地面纹理条（随镜头滚动）
    bgx.strokeStyle = 'rgba(255,255,255,.045)'; bgx.lineWidth = 1;
    for (let i = 0; i < 9; i++) {
      const t = i / 9, yy = groundY + 8 + t * t * (H - groundY);
      bgx.beginPath(); bgx.moveTo(0, yy); bgx.lineTo(W, yy); bgx.stroke();
    }
    bgx.strokeStyle = 'rgba(0,0,0,.25)';
    const step = 96, off = -((camX % step) + step) % step;
    for (let x = off; x < W; x += step) {
      bgx.beginPath(); bgx.moveTo(x, groundY); bgx.lineTo(x - 40, H); bgx.stroke();
    }
  }

  // ---------------------------------------------------------------- 特效
  function blood(x, y, n, dir) {
    for (let i = 0; i < n; i++) {
      G.parts.push({ x, y, vx: rnd(-160, 160) + (dir || 0) * 190, vy: rnd(60, 300),
        r: rnd(1.6, 4.4), t: rnd(0.4, 0.9), life: 0.9, c: '#c0262f', g: 1500 });
    }
  }
  function spark(x, y, n) {
    for (let i = 0; i < n; i++) {
      G.parts.push({ x, y, vx: rnd(-260, 260), vy: rnd(-60, 220),
        r: rnd(1, 2.4), t: 0.22, life: 0.22, c: '#ffd27a', g: 900 });
    }
  }
  function popText(x, y, s, c) {
    G.texts.push({ x, y, s, c: c || '#ffdf9a', t: 0.9, life: 0.9 });
  }
  let flashes = [];
  function muzzleFlash(x, y, a) { flashes.push({ x, y, a, t: 0.075, life: 0.075 }); }

  function updateParts(dt) {
    for (const p of G.parts) {
      p.t -= dt; p.vy -= p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.y < 0) { p.y = 0; p.vy *= -0.32; p.vx *= 0.6; }
    }
    for (let i = G.parts.length - 1; i >= 0; i--) if (G.parts[i].t <= 0) G.parts.splice(i, 1);
    for (const t of G.texts) { t.t -= dt; t.y += 46 * dt; }
    for (let i = G.texts.length - 1; i >= 0; i--) if (G.texts[i].t <= 0) G.texts.splice(i, 1);
    for (const f of flashes) f.t -= dt;
    flashes = flashes.filter(f => f.t > 0);
  }

  // ---------------------------------------------------------------- 波次
  function wavePool(n) {
    const pool = [{ t: 0, w: 3 }, { t: 1, w: 2 }, { t: 2, w: 1 }, { t: 3, w: 1 }];
    const out = [];
    for (const p of pool) if (n >= p.t) for (let i = 0; i < p.w; i++) out.push(ENEMY.TYPES[p.t]);
    return out;
  }
  function startWave(n) {
    G.wave = n;
    G.queue = Math.min(G.cap * 2, 3 + Math.floor(n * 2.2));
    G.waveState = 'run'; G.waveT = 0;
    if (n % 5 === 0) {                       // Boss 波：杂兵减半，另挂一只 Boss
      G.queue = Math.max(2, Math.floor(G.queue * 0.5));
      G.pendingBoss = true;
    }
    popText(G.player.x, 260, '第 ' + n + ' 波', '#ffb340');
  }
  function spawnOne() {
    const n = G.wave;
    const useBoss = G.pendingBoss && G.enemies.filter(e => !e.dead).length < 3;
    let type;
    if (useBoss) { type = ENEMY.TYPES.find(t => t.boss); G.pendingBoss = false; }
    else {
      const pool = wavePool(n).filter(t => G.assets[t.id]);
      if (!pool.length) return false;
      type = pool[Math.floor(Math.random() * pool.length)];
    }
    const A = G.assets[type.id];
    if (!A) return false;
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = camX + side * (W / 2 + rnd(60, 220));
    const e = new ENEMY.Enemy(type, A.data, {
      x, dir: -side, footY: A.footY, box: A.box,
      hpScale: (1 + (n - 1) * 0.09) * (G.bossScale || 1),
    });
    G.enemies.push(e);
    return true;
  }

  function updateWave(dt) {
    if (G.waveState === 'run') {
      G.spawnT -= dt;
      const alive = G.enemies.filter(e => !e.dead).length;
      if (G.queue > 0 || G.pendingBoss) {
        if (G.spawnT <= 0 && alive < G.cap) { if (spawnOne()) { G.queue--; G.spawnT = 0.34; } }
      } else if (alive === 0) {
        G.waveState = 'clear'; G.waveT = 0;
        popText(G.player.x, 300, '第 ' + G.wave + ' 波 清空', '#8ce08c');
      }
    } else if (G.waveState === 'clear') {
      G.waveT += dt;
      if (G.waveT > 2.6) startWave(G.wave + 1);
    } else if (G.waveState === 'dead') {
      G.waveT += dt;
      if (G.waveT > 2.4) {                       // 倒地 2.4s 后满血复活，重打本波
        const P = G.player;
        P.hp = P.maxHp; P.dead = false; P.deadT = 0; P.hitT = 0;
        P.cur = ['idle', 'upper_idle'];
        P.state.clearTracks(); P.state.setAnimation(0, 'idle', true);
        G.enemies.length = 0; G.bullets.length = 0; G.combo = 0;
        startWave(Math.max(1, G.wave));
      }
    }
  }

  // ---------------------------------------------------------------- 子弹
  function shoot(x, y, a) {
    const sp2 = 1750;
    G.bullets.push({ x, y, vx: Math.cos(a * RAD) * sp2, vy: Math.sin(a * RAD) * sp2,
      t: 1.1, dmg: G.damage });
    muzzleFlash(x, y, a);
    G.shake = Math.max(G.shake, 1.6);
  }
  function hitTest(x0, y0, x1, y1, box) {
    // 线段与 AABB：用采样步进，简单可靠
    const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 26));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) return true;
    }
    return false;
  }
  function updateBullets(dt) {
    for (const b of G.bullets) {
      const nx = b.x + b.vx * dt, ny = b.y + b.vy * dt;
      let hit = null, bestD = Infinity;
      for (const e of G.enemies) {
        if (e.dead) continue;
        if (!hitTest(b.x, b.y, nx, ny, e.aabb())) continue;
        const d = Math.abs(e.x - b.x);
        if (d < bestD) { bestD = d; hit = e; }
      }
      if (hit) {
        b.t = 0;
        const dirx = Math.sign(b.vx) || 1;
        blood(nx, ny, 7, dirx);
        spark(nx, ny, 4);
        G.hitstop = Math.max(G.hitstop, 0.028);
        const dead = hit.hurt(b.dmg, dirx, 150);
        if (dead) {
          G.kills++; G.combo++; G.comboT = 2.2;
          G.shake = Math.max(G.shake, hit.boss ? 14 : 5.5);
          blood(hit.x, hit.boxH * 0.55, 22, dirx);
          popText(hit.x, hit.boxH * 0.8, hit.boss ? 'BOSS 倒下' : '+1', hit.boss ? '#ff9a3c' : '#ffe9b0');
        }
      }
      b.x = nx; b.y = ny; b.t -= dt;
      if (ny < -50) b.t = 0;
    }
    for (let i = G.bullets.length - 1; i >= 0; i--) if (G.bullets[i].t <= 0) G.bullets.splice(i, 1);
  }

  // ---------------------------------------------------------------- 输入
  const keys = {};
  const mouse = { x: 0, y: 0, down: false };
  // 调试钩子：控制台里可直接看 G.enemies / G.player，或派发合成事件做自动化测试
  window.__dbg = { G, mouse, keys, w2s, s2w, camera: () => camera };
  addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    keys[k] = true;
    if (k === 'r') G.player && G.player.tryReload();
    if (k === 'f') G.player && G.player.tryMelee();
    if (k === 'p') G.paused = !G.paused;
    if (e.key === 'Enter' && G.waveState === 'clear') startWave(G.wave + 1);
    if (k === ' ') e.preventDefault();
  });
  addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
  addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
  addEventListener('mousedown', e => { if (e.button === 0) mouse.down = true; });
  addEventListener('mouseup', e => { if (e.button === 0) mouse.down = false; });
  addEventListener('contextmenu', e => e.preventDefault());
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouse.down = false; });

  function aimDeg() {
    const P = G.player;
    const wp = s2w(mouse.x, mouse.y);
    const ox = P.x + P.face * 40, oy = P.y + 150;
    return Math.atan2(wp.y - oy, wp.x - ox) * DEG;
  }

  // ---------------------------------------------------------------- 引导
  async function boot() {
    resize();
    const setT = s => { $('loadT').textContent = s; };
    const setP = p => { $('loadP').style.width = Math.round(p * 100) + '%'; };
    let done = 0;
    const total = 1 + ENEMY.TYPES.length;
    const tick = () => setP(done++ / total);

    setT('加载主角…');
    const P = await HORDE.loadSpine({
      json: '../gunner/nanzhu_gunner.json',
      atlas: '../characters/nanzhu/nanzhu__var1.atlas.txt',
      texDir: '../characters/nanzhu/textures',
      gun: true, renderer,
    });
    tick();
    const pbox = HORDE.measureBox(P.data, ['idle', 'walk', 'run']);
    const pfoot = HORDE.measureFoot(P.data, ['idle', 'walk', 'run']);
    const player = new PLAYER.Player(P.data, { footY: pfoot, scale: 190 / Math.max(120, pbox.h) });
    player.onFire = shoot;
    player.onEvent = name => { if (name === 'muzzle_flash') { const m = player.muzzle(); muzzleFlash(m.x, m.y, m.a); } };
    G.player = player;
    camX = player.x;

    for (const t of ENEMY.TYPES) {
      setT('加载敌人：' + t.name + '…');
      try {
        const A = await HORDE.loadSpine({
          json: t.json, atlas: t.atlas, texDir: t.tex, renderer,
        });
        const anims = ENEMY.pickAnims(A.data, ENEMY.WANT);
        const use = [anims.idle, anims.walk, anims.run].filter(Boolean);
        G.assets[t.id] = {
          data: A.data,
          footY: HORDE.measureFoot(A.data, use.length ? use : undefined),
          box: HORDE.measureBox(A.data, use),
        };
      } catch (err) {
        console.warn('跳过敌人', t.id, err.message);
      }
      tick();
    }

    setT('读取背景清单…');
    await loadBgList();
    $('load').classList.add('hidden');
    startWave(1);
    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- 主循环
  let last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    let dt = (now - last) / 1000; last = now;
    dt = Math.min(dt, 1 / 20);
    if (G.paused) dt = 0;
    if (G.hitstop > 0) { G.hitstop -= dt; dt *= 0.35; }

    step(dt);
    render();
  }

  function step(dt) {
    const P = G.player;
    // 选项
    G.cap = +$('optCap').value; $('capv').textContent = G.cap;
    G.speedScale = +$('optSpd').value / 100; $('spdv').textContent = G.speedScale.toFixed(1);
    G.damage = +$('optDmg').value; $('dmgv').textContent = G.damage;
    G.bones = $('optBones').checked;
    G.viewW = W;

    P.update(dt, {
      left: !!(keys['a'] || keys['arrowleft']),
      right: !!(keys['d'] || keys['arrowright']),
      run: !!keys['shift'], jump: !!keys[' '] || !!keys['w'],
      fire: mouse.down, aimDeg: aimDeg(),
    });

    updateWave(dt);
    for (const e of G.enemies) e.update(dt, G);
    // 清理尸体
    for (let i = G.enemies.length - 1; i >= 0; i--) {
      const e = G.enemies[i];
      if (e.dead && e.removeT > 2.4) G.enemies.splice(i, 1);
    }
    updateBullets(dt);
    updateParts(dt);
    if (G.comboT > 0) { G.comboT -= dt; if (G.comboT <= 0) G.combo = 0; }
    if (G.shake > 0) G.shake = Math.max(0, G.shake - 22 * dt);
    if (!P.dead) P.x = clamp(P.x, camX - W * 0.62, camX + W * 0.62);

    // 相机
    camX += (P.x - camX) * Math.min(1, 5 * dt);
    camY = groundY - H / 2;
    camera.position.x = camX;
    camera.position.y = camY + ($('optShake').checked ? rnd(-G.shake, G.shake) : 0);
    camera.update();

    hud();
  }

  function hud() {
    const P = G.player;
    $('hp').firstElementChild.style.width = (P.hp / P.maxHp * 100) + '%';
    $('ammo').innerHTML = P.ammo + '<small> / ' + P.mag + '</small>';
    $('wave').textContent = G.wave;
    $('alive').textContent = G.enemies.filter(e => !e.dead).length + (G.queue > 0 ? '+' + G.queue : '');
    $('kills').textContent = G.kills;
    const c = $('combo');
    c.textContent = 'x' + G.combo;
    $('right').style.opacity = G.combo > 1 ? 1 : 0;
  }

  // ---------------------------------------------------------------- 绘制
  function render() {
    drawBackground();

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    renderer.begin();
    const drawOne = (skel, alpha) => {
      const c = skel.color;
      const a0 = c.a;
      c.a = a0 * (alpha === undefined ? 1 : alpha);
      renderer.drawSkeleton(skel, false);
      if (G.bones) {
        const dbg = renderer.skeletonDebugRenderer;
        if (dbg) { dbg.drawBones = true; dbg.drawRegionAttachments = false; dbg.drawMeshHull = false;
          dbg.drawClipping = false; dbg.drawPaths = false; dbg.drawAabbs = false;
          renderer.drawSkeletonDebug(skel, false); }
      }
      c.a = a0;
    };
    for (const e of G.enemies) { const a = e.draw(G); drawOne(e.skel, a); }
    drawOne(G.player.skel, 1);
    renderer.end();

    // --- 2D 层
    fx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fx.clearRect(0, 0, W, H);
    // 近景（画在角色之上，制造前景遮挡）
    if (BG.near) {
      const sc = H / BG.near.height, w = BG.near.width * sc, h = BG.near.height * sc;
      let x = -(((camX * 1.15) % w) + w) % w;
      fx.globalAlpha = 0.75;
      while (x < W) { fx.drawImage(BG.near, x, groundY - h, w, h); x += w; }
      fx.globalAlpha = 1;
    }
    // 粒子
    for (const p of G.parts) {
      const s = w2s(p.x, p.y);
      fx.globalAlpha = Math.min(1, p.t / p.life * 1.6);
      fx.fillStyle = p.c;
      fx.beginPath(); fx.arc(s.x, s.y, p.r, 0, 7); fx.fill();
    }
    fx.globalAlpha = 1;
    // 子弹曳光
    fx.strokeStyle = 'rgba(255,231,160,.9)'; fx.lineWidth = 2;
    for (const b of G.bullets) {
      const s = w2s(b.x, b.y), e2 = w2s(b.x - b.vx * 0.014, b.y - b.vy * 0.014);
      fx.beginPath(); fx.moveTo(s.x, s.y); fx.lineTo(e2.x, e2.y); fx.stroke();
    }
    // 枪口火光
    for (const f of flashes) {
      const s = w2s(f.x, f.y), k = f.t / f.life;
      fx.save(); fx.translate(s.x, s.y); fx.rotate(-f.a * RAD);
      fx.globalAlpha = k;
      const gr = fx.createRadialGradient(0, 0, 2, 0, 0, 42 * k + 10);
      gr.addColorStop(0, '#fff6d0'); gr.addColorStop(.4, 'rgba(255,190,90,.9)'); gr.addColorStop(1, 'rgba(255,120,40,0)');
      fx.fillStyle = gr; fx.beginPath(); fx.arc(0, 0, 42 * k + 10, 0, 7); fx.fill();
      fx.fillStyle = '#fff2c8';
      fx.beginPath(); fx.moveTo(6, -7); fx.lineTo(48 * k + 14, 0); fx.lineTo(6, 7); fx.closePath(); fx.fill();
      fx.restore();
    }
    fx.globalAlpha = 1;
    // 飘字
    fx.textAlign = 'center'; fx.font = '700 20px "Segoe UI","Microsoft YaHei",sans-serif';
    for (const t of G.texts) {
      const s = w2s(t.x, t.y);
      fx.globalAlpha = Math.min(1, t.t / t.life * 1.8);
      fx.fillStyle = t.c; fx.fillText(t.s, s.x, s.y);
    }
    fx.globalAlpha = 1;
    // 敌人血条（精英 / Boss）与判定框
    for (const e of G.enemies) {
      if (e.dead) continue;
      if (e.boss || e.hp < e.maxHp) {
        const s = w2s(e.x, e.boxH + 26);
        const w = e.boss ? 120 : 46;
        fx.fillStyle = 'rgba(0,0,0,.5)'; fx.fillRect(s.x - w / 2, s.y, w, 5);
        fx.fillStyle = e.boss ? '#ff7a45' : '#ff5d5d';
        fx.fillRect(s.x - w / 2, s.y, w * clamp(e.hp / e.maxHp, 0, 1), 5);
      }
      if (G.bones) {
        const b = e.aabb();
        const p0 = w2s(b.x0, b.y1), p1 = w2s(b.x1, b.y0);
        fx.strokeStyle = 'rgba(90,209,255,.7)'; fx.lineWidth = 1;
        fx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
      }
    }
    // 准星
    fx.strokeStyle = 'rgba(255,255,255,.75)'; fx.lineWidth = 1;
    fx.beginPath(); fx.arc(mouse.x, mouse.y, 11, 0, 7); fx.stroke();
    fx.beginPath();
    fx.moveTo(mouse.x - 18, mouse.y); fx.lineTo(mouse.x - 5, mouse.y);
    fx.moveTo(mouse.x + 5, mouse.y); fx.lineTo(mouse.x + 18, mouse.y);
    fx.moveTo(mouse.x, mouse.y - 18); fx.lineTo(mouse.x, mouse.y - 5);
    fx.moveTo(mouse.x, mouse.y + 5); fx.lineTo(mouse.x, mouse.y + 18);
    fx.stroke();
    if (G.paused) {
      fx.fillStyle = 'rgba(0,0,0,.55)'; fx.fillRect(0, 0, W, H);
      fx.fillStyle = '#fff'; fx.textAlign = 'center';
      fx.font = '700 34px "Segoe UI","Microsoft YaHei",sans-serif';
      fx.fillText('已暂停', W / 2, H / 2);
      fx.font = '400 14px "Segoe UI","Microsoft YaHei",sans-serif';
      fx.fillText('按 P 继续', W / 2, H / 2 + 30);
    }
  }

  function fail(msg) {
    const el = $('load'); el.classList.remove('hidden');
    el.innerHTML = '<div class="err">' + msg + '</div>';
  }
  addEventListener('error', e => fail('运行出错：' + (e.message || e.error)));

  $('fold').onclick = () => $('panel').classList.toggle('fold');
  boot().catch(e => fail('加载失败：' + (e && e.message ? e.message : e)));
})();
