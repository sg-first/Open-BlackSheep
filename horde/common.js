/* 公共加载器：把 Spine 资源（json + atlas + 多页贴图）变成可用的 SkeletonData。
 *
 * 与 gunner/ 的区别：这里要同时加载「玩家」和「好几种敌人」，所以做成了通用函数：
 *   - 图集页面名直接从 atlas 文本里解析，贴图按 characters/<角色>/textures/<页面名> 取
 *   - 解包出来的 atlas 声明尺寸经常和 png 实际尺寸不一致，加载后统一做一次 UV 修正
 *   - 玩家用的骨架带注入枪页（程序化生成的枪），敌人不带枪
 */
window.HORDE = (() => {
  'use strict';
  const sp = window.spine;

  function loadImage(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('贴图加载失败: ' + src));
      img.src = src;
    });
  }

  // atlas 里声明的页面尺寸（页面名 -> {w,h}）
  function declaredPageSizes(text) {
    const sizes = {}, lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim() || raw.indexOf(':') !== -1) continue;
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length || /^\s/.test(lines[j])) continue;
      const m = /^\s*size\s*:\s*(\d+)\s*,\s*(\d+)/.exec(lines[j]);
      if (m) sizes[raw.trim()] = { w: +m[1], h: +m[2] };
    }
    return sizes;
  }

  // 声明尺寸 != png 实际尺寸时，按实际尺寸重算 UV（解包产物的常见坑）
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

  // atlas 里出现的页面文件名（形如 "duke.png" 的独占行）
  function pageNames(text) {
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
      const s = raw.trim();
      if (!s || s.indexOf(':') !== -1 || /^\s/.test(raw)) continue;
      if (/\.png$/i.test(s)) out.push(s);
    }
    return out;
  }

  // ------------------------------------------------------------ 程序化枪（只给玩家用）
  function gunCanvas() {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 384;
    const g = c.getContext('2d');
    g.scale(3.2, 3.2);
    const metal = g.createLinearGradient(0, 12, 0, 74);
    metal.addColorStop(0, '#6f7885'); metal.addColorStop(.45, '#454c57'); metal.addColorStop(1, '#2b3038');
    const dark = '#1b1f26';
    g.lineJoin = 'round';
    g.fillStyle = metal; g.fillRect(196, 40, 92, 16);
    g.fillStyle = dark;  g.fillRect(196, 34, 74, 6);
    g.fillStyle = metal; g.beginPath();
    g.moveTo(74, 30); g.lineTo(206, 30); g.lineTo(206, 62); g.lineTo(74, 62); g.lineTo(64, 48); g.closePath(); g.fill();
    g.fillStyle = dark; g.fillRect(96, 24, 74, 8); g.fillRect(178, 20, 8, 12); g.fillRect(266, 24, 6, 12);
    g.fillStyle = '#3a4049'; g.beginPath();
    g.moveTo(74, 32); g.lineTo(14, 40); g.lineTo(10, 66); g.lineTo(74, 60); g.closePath(); g.fill();
    g.fillStyle = '#333a44'; g.beginPath();
    g.moveTo(120, 62); g.lineTo(154, 62); g.lineTo(164, 108); g.lineTo(126, 108); g.closePath(); g.fill();
    g.fillStyle = '#2a3039'; g.beginPath();
    g.moveTo(74, 60); g.lineTo(104, 60); g.lineTo(96, 112); g.lineTo(66, 106); g.closePath(); g.fill();
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

  /* 加载一套 Spine 资源
   * opts: { json, atlas, texDir, gun:boolean, renderer }
   * 返回 { data: SkeletonData, atlas }
   */
  async function loadSpine(opts) {
    const [jsonText, atlasRaw] = await Promise.all([
      fetch(opts.json).then(r => { if (!r.ok) throw new Error('404 ' + opts.json); return r.text(); }),
      fetch(opts.atlas).then(r => { if (!r.ok) throw new Error('404 ' + opts.atlas); return r.text(); }),
    ]);
    let atlasText = atlasRaw;
    if (opts.gun) atlasText = appendGunPage(atlasRaw);

    const names = pageNames(atlasRaw);
    const imgs = await Promise.all(names.map(n => loadImage(opts.texDir + '/' + n)));
    const texMap = {};
    const mk = img => new sp.webgl.GLTexture(opts.renderer.context, img, false);
    names.forEach((n, i) => { texMap[n] = mk(imgs[i]); });
    if (opts.gun) texMap['gun.png'] = mk(gunCanvas());

    const atlas = new sp.TextureAtlas(atlasText, p => {
      const key = String(p).replace(/^.*[\\/]/, '');
      return texMap[key] || texMap[String(p)];
    });
    fixAtlasUVs(atlas, atlasText);

    const loader = new sp.SkeletonJson(new sp.AtlasAttachmentLoader(atlas));
    return { data: loader.readSkeletonData(jsonText), atlas, pages: names };
  }

  // 新建一个可播放的实例（骨架 + 动画状态机）
  function makeActor(data, defaultMix) {
    const skeleton = new sp.Skeleton(data);
    const asd = new sp.AnimationStateData(data);
    asd.defaultMix = defaultMix === undefined ? 0.15 : defaultMix;
    return { skeleton, state: new sp.AnimationState(asd), asd };
  }

  /* 用 SkeletonBounds 量「实际画出来的内容」的包围盒。
   * 直接用骨骼端点会被头发 / 飘带 / 长骨骼拉出一个离谱的高度（duke 能测到 2400+），
   * 而包围盒只统计附件顶点，才是真正的身高与宽度。
   */
  // 注意：spine.SkeletonBounds 只统计 BoundingBoxAttachment（角色身上没有），
  // 所以这里自己遍历插槽，用附件顶点算包围盒（region 4 点 / mesh N 点）。
  const _buf = new Float32Array(4096);
  function boundsOf(sk) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const slot of sk.slots) {
      const at = slot.getAttachment();
      if (!at) continue;
      let n = 0;
      if (sp.RegionAttachment && at instanceof sp.RegionAttachment) {
        at.computeWorldVertices(slot, _buf, 0, 2); n = 4;
      } else if (sp.MeshAttachment && at instanceof sp.MeshAttachment) {
        const c = at.worldVerticesLength;
        if (c > _buf.length) continue;
        at.computeWorldVertices(slot, 0, c, _buf, 0, 2); n = c / 2;
      }
      for (let i = 0; i < n; i++) {
        const x = _buf[i * 2], y = _buf[i * 2 + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    return { minX, minY, maxX, maxY };
  }

  // 量「脚底」：在指定动画上采样，取最低点，用来把角色摆到地面上
  function measureFoot(data, anims) {
    const sk = new sp.Skeleton(data);
    sk.scaleX = 1; sk.scaleY = 1;
    let lo = Infinity;
    const sample = () => {
      const b = boundsOf(sk);
      if (isFinite(b.minY)) lo = Math.min(lo, b.minY);
    };
    sk.setToSetupPose(); sk.updateWorldTransform(); sample();
    for (const name of anims || []) {
      const an = data.findAnimation(name);
      if (!an) continue;
      const step = Math.max(0.04, an.duration / 12);
      for (let t = 0; t <= an.duration + 1e-6; t += step) {
        an.apply(sk, 0, t, false, null, 1, sp.MixBlend.setup, sp.MixDirection.mix);
        sk.updateWorldTransform(); sample();
      }
    }
    return isFinite(lo) ? -lo : 0;
  }

  // 包围盒尺寸（用于等比缩放与命中判定）
  function measureBox(data, anims) {
    const sk = new sp.Skeleton(data);
    sk.setToSetupPose(); sk.updateWorldTransform();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const sample = () => {
      const b = boundsOf(sk);
      if (!isFinite(b.minY)) return;
      x0 = Math.min(x0, b.minX); x1 = Math.max(x1, b.maxX);
      y0 = Math.min(y0, b.minY); y1 = Math.max(y1, b.maxY);
    };
    sample();
    for (const name of anims || []) {
      const an = data.findAnimation(name);
      if (!an) continue;
      for (let t = 0; t <= an.duration; t += Math.max(0.08, an.duration / 6)) {
        an.apply(sk, 0, t, false, null, 1, sp.MixBlend.setup, sp.MixDirection.mix);
        sk.updateWorldTransform(); sample();
      }
    }
    sk.setToSetupPose();
    if (!isFinite(y0)) return { w: 300, h: 900, cy: 450 };
    return { w: x1 - x0, h: y1 - y0, cy: (y0 + y1) / 2 };
  }

  return { loadImage, loadSpine, makeActor, measureFoot, measureBox, fixAtlasUVs, gunCanvas };
})();
