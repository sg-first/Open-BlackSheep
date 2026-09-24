/* 敌人系统：杂兵 / 精英 / Boss
 * 素材里没有任何「持枪敌人」，所以敌人一律空手近战：追击 -> 前摇 -> 扑击。
 * 角色自带的动画只有 idle / walk / run（duke 连 attack / death 都没有），
 * 因此攻击前摇与死亡倒地都用程序化骨骼变换实现，不依赖缺失的动画。
 */
window.ENEMY = (() => {
  'use strict';
  const sp = window.spine;

  // 可用敌人类型（路径与 spine_viewer/data/manifest.json 一致）
  const TYPES = [
    { id: 'duke', name: '杜克', tier: 0,
      json: '../characters/duke/duke__var1.json',
      atlas: '../characters/duke/duke.atlas.txt',
      tex: '../characters/duke/textures',
      hp: 100, speed: 215, dmg: 7, reach: 62, mass: 1.0, targetH: 168 },
    { id: 'chenxin', name: '陈新', tier: 0,
      json: '../characters/chenxin/chenxin.json',
      atlas: '../characters/chenxin/chenxin__var1.atlas.txt',
      tex: '../characters/chenxin/textures',
      hp: 78, speed: 252, dmg: 5, reach: 56, mass: 0.85, targetH: 160 },
    { id: 'xiameng', name: '夏梦', tier: 1,
      json: '../characters/xiameng/xiameng__var6.json',
      atlas: '../characters/xiameng/xiameng.atlas.txt',
      tex: '../characters/xiameng/textures',
      hp: 145, speed: 228, dmg: 9, reach: 66, mass: 1.15, targetH: 172 },
    { id: 'zhouwan', name: '周婉', tier: 1,
      json: '../characters/zhouwan/zhouwan.json',
      atlas: '../characters/zhouwan/zhouwan__var1.atlas.txt',
      tex: '../characters/zhouwan/textures',
      hp: 120, speed: 262, dmg: 8, reach: 60, mass: 0.95, targetH: 166 },
    { id: 'boss', name: 'BOSS·妹妹', tier: 9, boss: true,
      json: '../characters/BOSSmeimei/BOSSmeimei__var1.json',
      atlas: '../characters/BOSSmeimei/BOSSmeimei.atlas.txt',
      tex: '../characters/BOSSmeimei/textures',
      hp: 1500, speed: 176, dmg: 18, reach: 92, mass: 3.2, targetH: 300 },
  ];

  // 动画名兜底：不同角色命名不统一，这里按优先级挑第一条存在的
  function pickAnims(data, want) {
    const has = n => !!data.findAnimation(n);
    const find = list => list.find(has) || null;
    return {
      idle: find(want.idle),
      walk: find(want.walk),
      run: find(want.run),
      attack: find(want.attack || []),
      hurt: find(want.hurt || []),
      death: find(want.death || []),
    };
  }
  const WANT = {
    idle: ['idle', 'idle_normal', 'idle2', 'stand'],
    walk: ['walk', 'walk_Thriller', 'zhuiji'],
    run: ['run', 'run2', 'run4', 'run7', 'run_catch'],
    attack: ['attack_norma', 'atk', 'attack', 'attack_QTE', 'attack_loop', 'skill01'],
    hurt: ['gethit', 'hurt', 'blood_idle'],
    death: ['death', 'blood_death', 'blood_fall', 'die'],
  };

  class Enemy {
    constructor(type, data, opt) {
      this.type = type;
      this.data = data;
      const a = HORDE.makeActor(data, 0.16);
      this.skel = a.skeleton;
      this.state = a.state;
      this.anims = pickAnims(data, WANT);

      // 按目标身高反推缩放，各种体型自动统一到同一画面尺度
      const box = opt.box || { h: 950 };
      this.scale = (type.targetH / Math.max(120, box.h));
      this.footY = opt.footY || 0;
      this.boxW = (box.w || 320) * this.scale;
      this.boxH = (box.h || 950) * this.scale;

      this.x = opt.x; this.y = 0;
      this.vx = 0; this.vy = 0;
      this.face = opt.dir || -1;
      this.hp = type.hp * (opt.hpScale || 1);
      this.maxHp = this.hp;
      this.root = this.skel.getRootBone() || this.skel.bones[0];

      this.st = 'spawn'; this.t = 0;
      this.alpha = 0;
      this.hitT = 0; this.atkCd = 0; this.knock = 0;
      this.dead = false; this.removeT = 0;
      this.anim = null;
      this.stunT = 0;
      this.deathAnim = this.anims.death;
      this.boss = !!type.boss;
      this.skel.scaleX = this.face * this.scale;
      this.skel.scaleY = this.scale;
    }

    setAnim(name, loop) {
      if (!name || name === this.anim) return;
      this.anim = name;
      this.state.setAnimation(0, name, !!loop);
    }

    // 世界坐标下的命中框
    aabb() {
      const w = this.boxW * 0.62, h = this.boxH;
      return { x0: this.x - w / 2, x1: this.x + w / 2, y0: this.y, y1: this.y + h };
    }

    hurt(dmg, dirX, power) {
      if (this.dead) return false;
      this.hp -= dmg;
      this.hitT = 0.16;
      this.knock = (power || 130) / this.type.mass;
      this.vx += dirX * this.knock;
      this.stunT = Math.max(this.stunT, 0.12);
      if (this.hp <= 0) { this.kill(dirX); return true; }
      return false;
    }

    kill(dirX) {
      this.dead = true; this.st = 'dead'; this.t = 0;
      this.vx = dirX * 220 / this.type.mass;
      this.vy = 130;
      if (this.deathAnim) { this.state.setAnimation(0, this.deathAnim, false); this.anim = this.deathAnim; }
      else this.state.setAnimation(0, this.anims.idle || this.anims.walk, false);
    }

    update(dt, G) {
      this.t += dt;
      const P = G.player;
      const dx = P.x - this.x;
      const adx = Math.abs(dx);

      if (this.dead) {
        this.removeT += dt;
        // 无死亡动画时程序化倒地：root 旋转 + 落地弹一下
        this.vy -= 1500 * dt;
        this.y += this.vy * dt;
        this.x += this.vx * dt;
        this.vx *= Math.pow(0.02, dt);
        if (this.y < 0) { this.y = 0; this.vy *= -0.28; if (Math.abs(this.vy) < 40) this.vy = 0; }
        const fall = Math.min(1, this.t / 0.55);
        if (!this.deathAnim && this.root) this.root.rotation = -dir(this.x) * 88 * fall;
        this.alpha = Math.max(0, 1 - Math.max(0, this.removeT - 1.4) / 0.9);
        this.state.update(dt); this.state.apply(this.skel);
        return;
      }

      if (this.st === 'spawn') {
        this.alpha = Math.min(1, this.t / 0.3);
        if (this.t > 0.3) { this.st = 'chase'; this.t = 0; }
      }

      // ---- 追击
      if (this.st === 'chase' || this.st === 'wind') {
        this.face = dx >= 0 ? 1 : -1;
        // 橡皮筋：玩家跑得比杂兵快，落后一屏以上就加速，否则永远追不上、只能在屏幕外干瞪眼
        const far = adx > (G.viewW || 1200) * 1.25;
        const spd = this.type.speed * G.speedScale * (far ? 2.3 : 1);
        const want = this.st === 'wind' ? spd * 0.25 : spd;
        const accel = 900;
        this.vx += Math.sign(want * this.face - this.vx) * Math.min(accel * dt, Math.abs(want * this.face - this.vx));
        if (this.stunT > 0) { this.stunT -= dt; this.vx *= 0.86; }
        if (adx < this.type.reach && this.atkCd <= 0 && this.st === 'chase') {
          this.st = 'wind'; this.t = 0;
        }
      }

      // ---- 前摇 -> 扑击
      if (this.st === 'wind') {
        const wind = this.boss ? 0.55 : 0.34;
        if (this.t > wind) { this.st = 'attack'; this.t = 0; this.didHit = false; }
      } else if (this.st === 'attack') {
        const dur = this.boss ? 0.42 : 0.3;
        if (!this.didHit && this.t > dur * 0.35) {
          this.didHit = true;
          if (Math.abs(P.x - this.x) < this.type.reach * 1.15 && Math.abs(P.y - this.y) < 120) {
            G.onPlayerHit(this.type.dmg, Math.sign(P.x - this.x) || 1);
          }
        }
        // 扑击有一小段前冲
        this.vx = this.face * this.type.speed * G.speedScale * (this.boss ? 1.5 : 1.9) * (1 - this.t / dur);
        // 攻击间隔放宽，否则一群杂兵能在两秒内把玩家打死，割草就没得玩了
        if (this.t > dur) { this.st = 'chase'; this.t = 0; this.atkCd = this.boss ? 1.5 : 1.15 + Math.random() * 0.8; }
      }
      if (this.atkCd > 0) this.atkCd -= dt;
      if (this.hitT > 0) this.hitT -= dt;

      // ---- 位移与阻尼
      this.x += this.vx * dt;
      this.vx *= Math.pow(0.12, dt);
      if (Math.abs(this.vx) < 4) this.vx = 0;

      // 同类之间轻微互斥，避免叠成一坨
      for (const o of G.enemies) {
        if (o === this || o.dead) continue;
        const d = this.x - o.x, ad = Math.abs(d);
        const minD = (this.boxW * 0.34 + o.boxW * 0.34);
        if (ad < minD && ad > 0.001) {
          const push = (minD - ad) * 6 * dt * 60 * (o.type.mass / (o.type.mass + this.type.mass));
          this.x += Math.sign(d) * push * dt * 60;
        }
      }

      // ---- 动画
      let an = this.anims.walk || this.anims.idle;
      const moving = Math.abs(this.vx) > 12;
      if (this.st === 'spawn') an = this.anims.walk || this.anims.idle;
      else if (!moving) an = this.anims.idle || an;
      else if (Math.abs(this.vx) > this.type.speed * G.speedScale * 0.7) an = this.anims.run || an;
      if (this.st === 'attack' && this.anims.attack) an = this.anims.attack;
      this.setAnim(an, true);
      if (this.anims.run && this.anims.walk) {
        // 走跑按速度微调播放速率，避免脚滑
        const tr = this.state.getCurrent(0);
        if (tr) tr.timeScale = Math.max(0.6, Math.min(1.5, Math.abs(this.vx) / (this.type.speed * G.speedScale || 1) * 1.05));
      }

      this.state.update(dt); this.state.apply(this.skel);

      // 程序化：受击后仰、前摇蓄力（这些动画素材里没有）
      if (this.root) {
        let r = 0, ty = 0;
        if (this.hitT > 0) r = -this.face * 9 * (this.hitT / 0.16);
        else if (this.st === 'wind') r = -this.face * 13 * (this.t / 0.34);
        else if (this.st === 'attack') r = this.face * 16 * Math.sin(Math.PI * Math.min(1, this.t / 0.3));
        this.root.rotation = r;
        this.root.y = ty;
      }
    }

    // 应用到骨架并提交绘制
    draw(G) {
      this.skel.scaleX = this.face * this.scale;
      this.skel.scaleY = this.scale;
      this.skel.x = this.x;
      this.skel.y = this.y + this.footY * this.scale;
      this.skel.updateWorldTransform();
      return this.alpha;
    }
  }

  function dir(x) { return x >= 0 ? 1 : -1; }

  return { TYPES, Enemy, WANT, pickAnims };
})();
