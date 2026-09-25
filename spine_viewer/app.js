/* Black Sheep Spine 查看器
 * 数据：../characters/<角色>/*.json 骨架 + *.atlas.txt + textures/*.png
 * 运行时：vendor/spine-webgl.js（Spine 3.8），用 new Function 隔离全局 spine
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const VIEWER = './';

  const S = {
    manifest: null,
    rt: null, rtFile: 'spine-webgl.js',
    canvas: null, gl: null, renderer: null, camera: null,
    skeleton: null, animState: null, skeletonData: null, atlas: null,
    textures: [],        // 本页面创建的 GLTexture，切换骨架时释放
    cur: null,           // 当前变体描述
    curChar: null,
    paused: false, speed: 1, loop: true,
    animName: null,
    zoom: 1, camX: 0, camY: 0,
    last: 0, dragging: false, lastPt: null,
    bounds: null,
  };

  const fmt = n => (n / 1048576).toFixed(2) + ' MB';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const url = p => encodeURI(VIEWER + p);

  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms || 2200);
  }
  function status(msg) { $('stat').textContent = msg; }
  const BG = { grid: [0.94, 0.94, 0.95, 1], light: [0.96, 0.965, 0.975, 1], dark: [0.13, 0.14, 0.16, 1] };

  /* ---------------- 运行时 ---------------- */
  async function loadRuntime(file) {
    const res = await fetch(url('vendor/' + file));
    if (!res.ok) throw new Error('无法加载运行时 ' + file);
    const text = await res.text();
    // new Function 包一层：内部的 `var spine` 变成局部变量，两个版本互不污染
    return new Function(text + '\nreturn typeof spine !== "undefined" ? spine : null;')();
  }

  /* ---------------- WebGL ---------------- */
  function setupGL() {
    const old = $('glcanvas');
    const canvas = document.createElement('canvas');
    canvas.id = 'glcanvas';
    if (old) old.replaceWith(canvas);
    S.canvas = canvas;
    const gl = canvas.getContext('webgl', { alpha: false, antialias: true, premultipliedAlpha: false })
      || canvas.getContext('experimental-webgl', { alpha: false, antialias: true });
    if (!gl) { toast('浏览器不支持 WebGL'); return; }
    S.gl = gl;
    S.renderer = new S.rt.webgl.SceneRenderer(canvas, gl);
    S.camera = S.renderer.camera;
    resize();
    window.addEventListener('resize', resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe($('canvasWrap'));

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('dblclick', () => fit());
  }

  let dpr = 1;
  function resize() {
    if (!S.canvas) return;
    const wrap = $('canvasWrap');
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(wrap.clientWidth * dpr));
    const h = Math.max(1, Math.floor(wrap.clientHeight * dpr));
    if (S.canvas.width !== w || S.canvas.height !== h) {
      S.canvas.width = w; S.canvas.height = h;
    }
    S.camera.setViewport(w, h);
    S.gl.viewport(0, 0, w, h);
  }

  function screenToWorld(px, py) {
    const v = new S.rt.webgl.Vector3(px * dpr, py * dpr, 0);
    return S.camera.screenToWorld(v, S.canvas.width, S.canvas.height);
  }

  function onWheel(e) {
    if (!S.skeleton) return;
    e.preventDefault();
    const rect = S.canvas.getBoundingClientRect();
    const before = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    // 该相机里 zoom = 每像素对应的世界单位数，所以放大要除以系数
    const k = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    S.zoom = Math.min(50, Math.max(0.002, S.zoom * k));
    S.camera.zoom = S.zoom;
    S.camera.update();
    const after = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    S.camX += before.x - after.x;
    S.camY += before.y - after.y;
  }
  function onDown(e) { S.dragging = true; S.lastPt = { x: e.clientX, y: e.clientY }; }
  function onUp() { S.dragging = false; }
  function onMove(e) {
    if (!S.dragging || !S.skeleton || !S.lastPt) return;
    const dx = e.clientX - S.lastPt.x, dy = e.clientY - S.lastPt.y;
    S.lastPt = { x: e.clientX, y: e.clientY };
    S.camX -= dx * S.zoom;
    S.camY += dy * S.zoom;
  }

  /* ---------------- 骨架加载 ---------------- */
  function releaseTextures() {
    for (const t of S.textures) { try { t.dispose(); } catch (e) { } }
    S.textures = [];
  }

  async function loadImage(src) {
    return new Promise((ok, no) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => no(new Error('图片加载失败: ' + src));
      img.src = src;
    });
  }

  /* ---------------- atlas 坐标空间修正 ----------------
   * spine-ts 的 TextureAtlas 解析器会忽略 atlas 文本里声明的页尺寸（size 行），
   * 改成用贴图实际像素算 UV：region.u = x / 贴图宽。
   * 但本项目的 PNG 是 Unity 导入时按 Non-Power-Of-2 / MaxSize 重新缩放过的
   * （例：xiameng 声明 1311²，实际 PNG 1024²），atlas 坐标仍在“页空间”，
   * 于是 UV 整体缩水，每个部件都取到图集里错误的位置 —— 看起来就是“全错位”。
   * 这里按 贴图尺寸 / 声明尺寸 把区域的 uv 缩放回正确的比例。
   */
  function declaredPageSizes(atlasText) {
    const sizes = {};
    const lines = atlasText.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim() || raw.indexOf(':') !== -1) continue;
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      // 页面属性顶格写，区域属性缩进写 —— 下一行缩进说明本行是区域名
      if (j >= lines.length || /^\s/.test(lines[j])) continue;
      const m = /^\s*size\s*:\s*(\d+)\s*,\s*(\d+)/.exec(lines[j]);
      if (m) sizes[raw.trim()] = { w: +m[1], h: +m[2] };
    }
    return sizes;
  }

  function fixAtlasUVs(atlas, atlasText) {
    const sizes = declaredPageSizes(atlasText);
    let fixed = 0;
    for (const r of atlas.regions || []) {
      const page = r.page;
      const d = page && sizes[page.name];
      if (!d || !d.w || !d.h || !page.width || !page.height) continue;
      const kx = page.width / d.w, ky = page.height / d.h;
      if (Math.abs(kx - 1) < 1e-6 && Math.abs(ky - 1) < 1e-6) continue;
      r.u *= kx; r.u2 *= kx; r.v *= ky; r.v2 *= ky;
      fixed++;
    }
    // 关键补充：MeshAttachment.updateUVs 用 texture.getImage() 的尺寸做 UV 分母，
    // 但那是 Unity POT 缩放后的实际尺寸；region.u 上面已按声明尺寸修正 ——
    // 分母不一致会让 mesh 的 UV 跨度偏差 k 倍，部件（尤其脸部小 mesh）碎裂错位。
    // 统一分母：让 getImage() 返回 atlas 声明的页尺寸，
    // GPU 纹理是线性映射的，UV 按声明空间给定后采样位置自然正确。
    for (const page of atlas.pages || []) {
      const d = sizes[page.name];
      if (!d || !d.w || !d.h || !page.texture) continue;
      if (page.width === d.w && page.height === d.h) continue;
      try { page.texture._realImage = page.texture.getImage(); } catch (e) { /* ignore */ }
      page.texture.getImage = function () { return { width: d.w, height: d.h }; };
    }
    return fixed;
  }

  // 老 Spine 2.x 导出格式：mesh 的 uvs 字段是相对 region 矩形的 0-1 归一化坐标，
  // 2.x runtime 用 u + (u2-u)*nx 直接插值；而 3.8 runtime 把它当像素坐标用，
  // 导致 mesh UV 全部塌缩到 region 角落采样（黑剪影/碎裂，gujia 即此情况）。
  // 检测：regionUVs 最大值 <= 1.001 即判为归一化，改用 2.x 插值公式直接算最终 UV。
  // （已用 NCP2_body 数值验证：顶点全部落回 region 页内矩形。）
  function patchLegacyMeshUVs() {
    const proto = S.rt.MeshAttachment && S.rt.MeshAttachment.prototype;
    if (!proto || proto.__legacyUVPatched) return;
    proto.__legacyUVPatched = true;
    const orig = proto.updateUVs;
    proto.updateUVs = function () {
      orig.call(this); // 先走原逻辑：负责分配 this.uvs 数组
      try {
        const r = this.region;
        if (r && this.regionUVs && this.uvs && this.uvs.length) {
          let mx = 0;
          for (let i = 0; i < this.regionUVs.length; i++) if (this.regionUVs[i] > mx) mx = this.regionUVs[i];
          if (mx <= 1.001) {
            const uvs = this.uvs;
            const n = uvs.length;
            // rotate 插值方向组合可由 URL 参数 ?guv=1..4 覆盖（默认 3，实测正确）
            const mode = (S.guvMode || 3);
            if (r.rotate) { // degrees 90
              for (let i = 0; i < n; i += 2) {
                const nx = this.regionUVs[i], ny = this.regionUVs[i + 1];
                let fu, fv;
                if (mode === 1) { fu = 1 - ny; fv = nx; }
                else if (mode === 2) { fu = ny; fv = nx; }
                else if (mode === 3) { fu = ny; fv = 1 - nx; }
                else { fu = 1 - ny; fv = 1 - nx; }
                uvs[i] = r.u + (r.u2 - r.u) * fu;
                uvs[i + 1] = r.v + (r.v2 - r.v) * fv;
              }
            } else {
              // 非 rotate mesh 的 v 方向：nrv=2（v 用 ny）对全部正立贴图角色正确；
              // gujia 的贴图页本身 Y 轴颠倒（美术导出即倒），需 nrv=1（v 用 1-ny）。
              // URL ?nrv= 可强制覆盖所有角色（调试用）。
              const nrv = (!S.nrvForced && S.curChar && /gujia/i.test(S.curChar)) ? 1 : (S.nrvMode || 2);
              for (let i = 0; i < n; i += 2) {
                uvs[i] = r.u + (r.u2 - r.u) * this.regionUVs[i];
                uvs[i + 1] = r.v + (r.v2 - r.v) * (nrv === 1 ? 1 - this.regionUVs[i + 1] : this.regionUVs[i + 1]);
              }
            }
          }
        }
      } catch (e) { /* ignore */ }
    };
  }

  async function loadVariant(v, charName) {
    if (!v || !v.json || !v.atlas) return toast('该骨架缺少 json 或 atlas');
    $('loading').classList.remove('hidden');
    status('加载 ' + v.label + ' …');
    try {
      releaseTextures();
      const [jsonText, atlasText] = await Promise.all([
        fetch(url(v.json)).then(r => { if (!r.ok) throw new Error('json 404'); return r.text(); }),
        fetch(url(v.atlas)).then(r => { if (!r.ok) throw new Error('atlas 404'); return r.text(); }),
      ]);

      // 贴图页
      const texMap = {};
      for (const p of v.pages) {
        try {
          const img = await loadImage(url(p.file));
          const tex = new S.rt.webgl.GLTexture(S.renderer.context, img, false);
          S.textures.push(tex);
          texMap[p.page] = tex;
          texMap[p.page.replace(/^.*[\\/]/, '')] = tex;
        } catch (e) {
          toast('贴图页失败: ' + p.page);
        }
      }

      S.atlas = new S.rt.TextureAtlas(atlasText, path => {
        let t = texMap[path];
        if (!t) t = texMap[String(path).replace(/^.*[\\/]/, '')];
        return t || (S.rt.FakeTexture ? new S.rt.FakeTexture() : null);
      });
      // 必须在 readSkeletonData 之前修正：mesh 的 uvs 是在解析时按 region.u/v 算出来并缓存的
      patchLegacyMeshUVs();
      try {
        const n = fixAtlasUVs(S.atlas, atlasText);
        if (n) console.log('[atlas] 贴图与声明页尺寸不一致，已修正 ' + n + ' 个区域的 UV');
      } catch (e) { console.warn('atlas UV 修正跳过：', e); }
      const loader = new S.rt.AtlasAttachmentLoader(S.atlas);
      const json = new S.rt.SkeletonJson(loader);
      S.skeletonData = json.readSkeletonData(jsonText);
      S.skeleton = new S.rt.Skeleton(S.skeletonData);
      S.skeleton.updateWorldTransform();

      const asd = new S.rt.AnimationStateData(S.skeletonData);
      asd.defaultMix = 0.2;
      S.animState = new S.rt.AnimationState(asd);
      S.animState.addListener({
        event: (entry, ev) => toast('Spine 事件：' + ev.data.name),
        complete: () => { },
      });

      S.cur = v; S.curChar = charName;
      fillAnimList();
      renderInfo();
      const keep = S.animName && S.skeletonData.findAnimation(S.animName) ? S.animName
        : (S.skeletonData.animations.length ? S.skeletonData.animations[0].name : null);
      if (keep) setAnim(keep); else { S.animName = null; $('animSel').value = ''; }
      fit();
      status('已加载 ' + charName + ' / ' + v.label);
    } catch (e) {
      console.error(e);
      toast('加载失败：' + e.message, 5000);
      status('加载失败：' + e.message);
    } finally {
      $('loading').classList.add('hidden');
    }
  }

  function setAnim(name) {
    if (!S.skeletonData) return;
    S.animName = name;
    const sel = $('animSel');
    sel.value = name || '';
    if (!name) {
      S.animState.clearTrack(0);
      S.skeleton.setToSetupPose();
      S.skeleton.updateWorldTransform();
      return;
    }
    const entry = S.animState.setAnimation(0, name, $('loopChk').checked);
    entry.trackTime = 0;
    S.paused = false;
    $('btnPlay').textContent = '暂停';
  }

  function fillAnimList() {
    const sel = $('animSel');
    const names = (S.skeletonData.animations || []).map(a => a.name);
    sel.innerHTML = '<option value="">（静止姿态）</option>' +
      names.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
  }

  function fit() {
    if (!S.skeleton) return;
    let x, y, w, h;
    const d = S.skeletonData;
    // 优先用导出时的 setup 包围盒；SkeletonBounds 只统计 boundingBox 附件，多数骨架没有，不能依赖
    if (d && d.width > 0 && d.height > 0) {
      x = d.x; y = d.y; w = d.width; h = d.height;
    } else {
      let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
      for (const b of S.skeleton.bones) {
        if (b.worldX < minX) minX = b.worldX;
        if (b.worldX > maxX) maxX = b.worldX;
        if (b.worldY < minY) minY = b.worldY;
        if (b.worldY > maxY) maxY = b.worldY;
      }
      if (!(maxX > minX) || !(maxY > minY)) { minX = -200; minY = -200; maxX = 200; maxY = 200; }
      x = minX; y = minY; w = maxX - minX; h = maxY - minY;
    }
    S.bounds = { x: x + w / 2, y: y + h / 2, w: w, h: h };
    const vw = S.canvas.width, vh = S.canvas.height;
    S.zoom = Math.max(w / (vw * 0.86), h / (vh * 0.86));
    S.camX = S.bounds.x; S.camY = S.bounds.y;
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    const gl = S.gl, r = S.renderer;
    if (!gl || !r) return;
    const c = BG[$('bgSel').value] || BG.light;
    gl.clearColor(c[0], c[1], c[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!S.skeleton) return;
    S.camera.position.x = S.camX;
    S.camera.position.y = S.camY;
    S.camera.zoom = S.zoom;
    r.begin();
    r.drawSkeleton(S.skeleton, false);
    const dbg = r.skeletonDebugRenderer;
    const showBone = $('boneChk').checked, showAtt = $('slotChk').checked;
    if (dbg && (showBone || showAtt)) {
      dbg.drawBones = showBone;
      dbg.drawRegionAttachments = showAtt;
      dbg.drawMeshHull = showAtt;
      dbg.drawBoundingBoxes = showAtt;
      dbg.drawClipping = false;
      dbg.drawPaths = false;
      dbg.drawAabbs = false;
      r.drawSkeletonDebug(S.skeleton, false);
    }
    r.end();
  }

  function frame(now) {
    const dt = S.last ? Math.min(0.05, (now - S.last) / 1000) : 0;
    S.last = now;
    if (S.skeleton && !S.paused) {
      S.animState.update(dt * S.speed);
      S.animState.apply(S.skeleton);
      S.skeleton.updateWorldTransform();
      updateTime();
    }
    render();
    requestAnimationFrame(frame);
  }

  function updateTime() {
    const e = S.animState.getCurrent ? S.animState.getCurrent(0) : null;
    const lab = $('timeLabel'), seek = $('seek');
    if (!e || !e.animation) {
      lab.textContent = '0.00 / 0.00 s';
      return;
    }
    const dur = e.animation.duration;
    const t = e.getAnimationTime ? e.getAnimationTime() : e.trackTime;
    lab.textContent = t.toFixed(2) + ' / ' + dur.toFixed(2) + ' s';
    if (document.activeElement !== seek && dur > 0) {
      seek.value = String(Math.round(Math.min(1, t / dur) * 1000));
    }
  }

  /* ---------------- 列表 / 信息 ---------------- */
  function buildList(filter) {
    const box = $('charList');
    const f = (filter || '').trim().toLowerCase();
    let html = '', nChar = 0, nVar = 0;
    for (const c of S.manifest.characters) {
      const animHit = c.variants.some(v => (v.anims || []).some(a => a.toLowerCase().includes(f)));
      if (f && !(c.name.toLowerCase().includes(f) || animHit)) continue;
      nChar++; nVar += c.n_variants;
      const open = S.curChar === c.name;
      html += '<div class="char' + (open ? ' open' : '') + '" data-char="' + esc(c.name) + '">' +
        '<div class="char-head"><span class="char-name">' + esc(c.name) + '</span>' +
        '<span class="char-tag">' + c.n_variants + ' 份</span>' +
        '<span class="char-tag">' + c.max_bones + ' 骨</span>' +
        '<span class="char-tag">' + c.max_anims + ' 动画</span></div><div class="char-body">';
      for (const v of c.variants) {
        const bad = (v.coverage || 0) < 0.9 || (v.missing_pages || []).length;
        html += '<div class="var' + (S.cur === v ? ' active' : '') + '" data-file="' + esc(v.json) +
          '"><span class="v-name">' + esc(v.label) + '</span>' +
          '<span class="v-meta">' + (v.bones || 0) + '骨/' + (v.n_anims || 0) + '动</span>' +
          (bad ? '<span class="badge-warn">配对 ' + Math.round((v.coverage || 0) * 100) + '%</span>' : '') +
          '</div>';
      }
      html += '</div></div>';
    }
    box.innerHTML = html || '<div class="muted" style="padding:12px">没有匹配项</div>';
    $('sideMeta').textContent = nChar + ' 个角色 / ' + nVar + ' 份骨架';
    box.querySelectorAll('.char-head').forEach(h => h.onclick = () => {
      const p = h.parentElement;
      const was = p.classList.contains('open');
      box.querySelectorAll('.char').forEach(x => x.classList.remove('open'));
      p.classList.toggle('open', !was);
    });
    box.querySelectorAll('.var').forEach(el => el.onclick = () => {
      const file = el.dataset.file;
      for (const c of S.manifest.characters) {
        const v = c.variants.find(x => x.json === file);
        if (v) { loadVariant(v, c.name); return; }
      }
    });
  }

  function renderInfo() {
    const v = S.cur;
    if (!v) return;
    const d = S.skeletonData;
    let nAtt = 0;
    for (const s of d.skins) nAtt += Object.keys(s.attachments || {}).length;
    const pages = (v.pages || []).map(p => '<div class="path">' + esc(p.file) + ' (' + fmt(v.tex_bytes ? v.tex_bytes / (v.pages.length || 1) : 0) + ')</div>').join('');
    const cands = (v.atlas_candidates || []).map(c =>
      '<option value="' + esc(c.file) + '"' + (c.file === v.atlas ? ' selected' : '') + '>' +
      esc(c.file) + ' — 命中 ' + Math.round(Math.min(1, c.coverage) * 100) + '%</option>').join('');
    const animChips = (d.animations || []).map(a =>
      '<span class="chip' + (a.name === S.animName ? ' on' : '') + '" data-anim="' + esc(a.name) + '">' + esc(a.name) + '</span>').join('');
    const skinChips = (d.skins || []).map(s =>
      '<span class="chip" data-skin="' + esc(s.name) + '">' + esc(s.name) + '</span>').join('');

    $('info').innerHTML =
      '<h4>当前</h4>' +
      kv('角色', esc(S.curChar)) + kv('变体', esc(v.label)) +
      '<h4>规模</h4>' +
      kv('骨骼', d.bones.length) + kv('插槽', d.slots.length) +
      kv('皮肤', d.skins.length) + kv('附件(全部皮肤)', nAtt) +
      kv('IK 约束', (d.ikConstraints || []).length) +
      kv('动画', (d.animations || []).length) +
      kv('骨架尺寸', (v.width ? Math.round(v.width) : '?') + ' × ' + (v.height ? Math.round(v.height) : '?')) +
      '<h4>源文件</h4>' +
      '<div class="path">' + esc(v.json) + '</div>' +
      '<div class="path">' + esc(v.atlas || '（无）') + '</div>' + pages +
      ((v.page_meta || []).length ?
        '<div class="path">' + (v.page_meta || []).map(p =>
          esc('页 ' + p.page + ' ← ' + (p.src || '') + '（声明 ' + (p.declared || '?') +
              ' / 实际 ' + (p.actual || '?') + '，互证 ' + (p.score || '-') + '）')).join('</div><div class="path">') + '</div>' : '') +
      kv('atlas ↔ 骨架命中', Math.round(Math.min(1, v.coverage || 0) * 100) + '%') +
      ((v.missing_pages || []).length ?
        '<div class="warnbox">缺贴图页：' + esc(v.missing_pages.join(', ')) + '</div>' : '') +
      ((v.atlas_candidates || []).length > 1 ?
        '<div class="warnbox">同一角色有多个 atlas 变体，页贴图已按内容互证逐变体配对；如仍可疑可手动换 atlas：<br><select id="atlasSel">' + cands + '</select></div>' : '') +
      '<h4>动画（' + (d.animations || []).length + '）</h4><div class="chips">' + (animChips || '<span class="muted">无</span>') + '</div>' +
      '<h4>皮肤</h4><div class="chips">' + skinChips + '</div>';

    const sel = $('atlasSel');
    if (sel) sel.onchange = () => { S.cur = Object.assign({}, v, { atlas: sel.value }); loadVariant(S.cur, S.curChar); };
    $('info').querySelectorAll('[data-anim]').forEach(el => el.onclick = () => setAnim(el.dataset.anim));
    $('info').querySelectorAll('[data-skin]').forEach(el => el.onclick = () => {
      const sk = d.findSkin(el.dataset.skin);
      if (sk) { S.skeleton.setSkin(sk); S.skeleton.setSlotsToSetupPose(); toast('皮肤 → ' + el.dataset.skin); }
    });
  }
  function kv(k, val) { return '<div class="kv"><span>' + k + '</span><span>' + val + '</span></div>'; }

  /* ---------------- 事件绑定 ---------------- */
  function bindUI() {
    $('search').addEventListener('input', e => buildList(e.target.value));
    $('animSel').addEventListener('change', e => setAnim(e.target.value));
    $('btnPlay').addEventListener('click', () => {
      S.paused = !S.paused;
      $('btnPlay').textContent = S.paused ? '播放' : '暂停';
    });
    $('btnFit').addEventListener('click', () => fit());
    $('btnReset').addEventListener('click', () => { S.speed = 1; $('speed').value = 1; $('speedVal').textContent = '1.0×'; fit(); });
    $('speed').addEventListener('input', e => { S.speed = parseFloat(e.target.value); $('speedVal').textContent = S.speed.toFixed(1) + '×'; });
    $('loopChk').addEventListener('change', e => {
      const en = S.animState && S.animState.getCurrent ? S.animState.getCurrent(0) : null;
      if (en) en.loop = e.target.checked;
    });
    $('seek').addEventListener('input', e => {
      const en = S.animState && S.animState.getCurrent ? S.animState.getCurrent(0) : null;
      if (!en || !en.animation) return;
      en.trackTime = (parseFloat(e.target.value) / 1000) * en.animation.duration;
      S.animState.apply(S.skeleton);
      S.skeleton.updateWorldTransform();
    });
    $('bgSel').addEventListener('change', () => render());
    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); $('btnPlay').click(); }
      else if (e.key === 'f' || e.key === 'F') fit();
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const sel = $('animSel');
        const i = Math.max(1, sel.selectedIndex + (e.key === 'ArrowRight' ? 1 : -1));
        sel.selectedIndex = Math.min(sel.options.length - 1, i);
        setAnim(sel.value);
      }
    });
  }

  /* ---------------- 启动 ---------------- */
  async function init() {
    status('读取清单…');
    S.manifest = await fetch(url('data/manifest.json')).then(r => r.json());
    buildList('');
    bindUI();
    status('加载运行时…');
    S.rt = await loadRuntime(S.rtFile);
    setupGL();
    requestAnimationFrame(frame);
    status(S.manifest.n_characters + ' 个角色 / ' + S.manifest.n_variants + ' 份骨架 · 左侧点开角色，再选一份骨架');
    // 默认加载第一个角色；支持 ?char=<角色名> 直达
    const q = new URLSearchParams(location.search);
    S.guvMode = parseInt(q.get('guv') || '3', 10) || 3;
    // 非 rotate mesh 的 v 方向：2 = v 用 ny（默认，正立贴图组验证：chenfei/boss_jiejie/BOSSmeimei 等）；
    // gujia 贴图页 Y 颠倒，在补丁内按角色名单独走 nrv=1；URL ?nrv= 强制覆盖所有角色
    S.nrvMode = q.get('nrv') ? (parseInt(q.get('nrv'), 10) || 2) : 2;
    S.nrvForced = !!q.get('nrv');
    let target = S.manifest.characters[0];
    const want = q.get('char');
    if (want) {
      const c = S.manifest.characters.find(x => x.name.toLowerCase() === want.toLowerCase());
      if (c) target = c; else toast('没有角色 ' + want);
    }
    // ?v=<骨架变体标签> 可指定该角色下的具体一份骨架
    const wantV = q.get('v');
    let pick = target.variants[0];
    if (wantV) {
      const hit = target.variants.find(x => x.label === wantV) ||
        target.variants.find(x => x.label.toLowerCase() === wantV.toLowerCase());
      if (hit) pick = hit; else toast('没有骨架 ' + wantV);
    }
    if (target) {
      const head = $('charList').querySelector('.char[data-char="' + CSS.escape(target.name) + '"]');
      if (head) head.classList.add('open');
      loadVariant(pick, target.name);
    }
  }

  init().catch(e => {
    console.error(e);
    status('初始化失败：' + e.message);
    toast('初始化失败：' + e.message, 8000);
  });

  // 调试句柄：console 里可用 S.atlas.regions、S.skeleton 等排查
  window.S = S;
})();
