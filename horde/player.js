/* 玩家：nanzhu_gunner（注入了持枪骨骼 / IK / 上半身动画集的骨架）
 * 沿用 gunner/ 里已经调好的套路：
 *   track0 下半身（idle/walk/run/death）· track1 上半身（upper_*）· track2 开火（add 叠加）
 *   瞄准角直接写 aim_pivot.rotation，双手用两骨 IK（余弦定理）解析求解
 * 对外只暴露 update / hurt / 几个回调，方便 game.js 做割草玩法。
 */
window.PLAYER = (() => {
  'use strict';
  const sp = window.spine;
  const DEG = 180 / Math.PI, RAD = Math.PI / 180;

  // 枪原图（region 300x112，中心 (150,56)）上关键点的像素位置
  const GUN_PX = { tailX: 10, gripX: 85, gripY: 86, foreX: 134, foreY: 84, muzX: 298, muzY: 48 };
  const CHAIN = 529;                                  // 上臂 + 前臂
  const ONESHOT = { upper_reload: 1, upper_gethit: 1, upper_melee: 1, upper_land: 1,
                    upper_die: 1, upper_draw: 1, upper_holster: 1, upper_jump: 1 };
  const MAG = 30, RELOAD_T = 1.75, FIRE_CD = 0.105;

  class Player {
    constructor(data, opt) {
      const a = HORDE.makeActor(data, 0.18);
      this.skel = a.skeleton; this.state = a.state; this.asd = a.asd;
      const mix = (x, y, d) => { this.asd.setMix(x, y, d); this.asd.setMix(y, x, d); };
      mix('idle', 'walk', 0.16); mix('idle', 'run', 0.2); mix('walk', 'run', 0.18);
      for (const u of ['upper_idle', 'upper_walk', 'upper_run']) {
        for (const v of ['upper_jump', 'upper_fall']) mix(u, v, 0.12);
      }
      mix('upper_idle', 'upper_walk', 0.16); mix('upper_idle', 'upper_run', 0.2);
      mix('upper_walk', 'upper_run', 0.18);
      for (const u of ['upper_idle', 'upper_walk', 'upper_run', 'upper_jump', 'upper_fall']) {
        mix(u, 'upper_land', 0.08); mix(u, 'upper_gethit', 0.09);
        mix(u, 'upper_melee', 0.1); mix(u, 'upper_reload', 0.22);
        mix(u, 'upper_holster', 0.16); mix(u, 'upper_die', 0.3); mix(u, 'upper_turn', 0.1);
      }
      this.state.addListener({ event: (e, ev) => { if (this.onEvent) this.onEvent(ev.data.name); } });

      this.bAim = this.skel.findBone('aim_pivot');
      this.bGun = this.skel.findBone('gun');
      this.bSpine2 = this.skel.findBone('Spine2');
      this.bHead = this.skel.findBone('Head');
      this.bMuzzle = this.skel.findBone('muzzle');
      this.bGripR = this.skel.findBone('grip_R');
      this.bGripL = this.skel.findBone('grip_L');
      this.gunAt = this.skel.getAttachmentByName('gun', 'gun');
      this.gunW0 = this.gunAt ? this.gunAt.width : 680;
      this.gunH0 = this.gunAt ? this.gunAt.height : 255;
      const ikR = this.skel.findIkConstraint('ik_arm_R'); if (ikR) ikR.mix = 0;
      const ikL = this.skel.findIkConstraint('ik_arm_L'); if (ikL) ikL.mix = 0;

      this.footY = opt.footY || 0;
      this.scale = opt.scale || 0.2;
      this.skel.scaleX = this.scale; this.skel.scaleY = this.scale;

      this.x = 0; this.y = 0; this.vy = 0;
      this.face = 1; this.flipT = 0; this.flipFrom = 1;
      this.onGround = true;
      this.aim = 0; this.aimTarget = 0; this.damp = 22;
      this.hp = 140; this.maxHp = 140;
      this.ammo = MAG; this.mag = MAG;
      this.fireCd = 0; this.reloadT = 0; this.meleeT = 0; this.hitT = 0;
      this.landT = 0; this.dead = false; this.deadT = 0;
      this.cur = ['idle', 'upper_idle'];
      this.invul = 0;
      this.onFire = null; this.onEvent = null; this.onShell = null;
      this.gunSize = 130;
      this.stockOff = 8;
      this.armPick = { R: true, L: true };              // IK 肘部选解的迟滞记忆（防抖动）
      this.aimX0 = this.bAim ? this.bAim.data.x : 232;  // aim_pivot 位置来自骨架，每帧重申防动画漂移
      this.aimY0 = this.bAim ? this.bAim.data.y : 150;
    }

    // ---------------------------------------------------------- 动画选择
    lowerAnim(mv) {
      if (this.dead) return ['death', false];
      if (this.hitT > 0) return ['gethit', false];
      if (!this.onGround) return ['run', true];
      if (mv) return [mv > 1 ? 'run' : 'walk', true];
      return ['idle', true];
    }
    upperAnim(mv) {
      if (this.dead) return 'upper_die';
      if (this.meleeT > 0) return 'upper_melee';
      if (this.reloadT > 0) return 'upper_reload';
      if (this.hitT > 0) return 'upper_gethit';
      if (this.landT > 0) return 'upper_land';
      if (!this.onGround) return this.vy > 0 ? 'upper_jump' : 'upper_fall';
      if (mv) return mv > 1 ? 'upper_run' : 'upper_walk';
      return 'upper_idle';
    }
    setTrack(i, name, loop) {
      if (this.cur[i] === name) return;
      this.cur[i] = name;
      this.state.setAnimation(i, name, loop);
    }

    // ---------------------------------------------------------- 战斗
    tryFire() {
      if (this.dead || this.reloadT > 0 || this.meleeT > 0 || this.fireCd > 0) return false;
      if (this.ammo <= 0) { this.tryReload(); return false; }
      this.ammo--; this.fireCd = FIRE_CD;
      this.state.setAnimation(2, 'upper_fire', false);
      this.state.addAnimation(2, 'upper_' + (this.onGround ? 'idle' : 'fall'), 0, false);
      const m = this.muzzle();
      if (this.onFire) this.onFire(m.x, m.y, this.aim);
      return true;
    }
    tryReload() {
      if (this.dead || this.reloadT > 0 || this.ammo >= this.mag) return false;
      this.reloadT = RELOAD_T;
      this.setTrack(1, 'upper_reload', false);
      return true;
    }
    tryMelee() {
      if (this.dead || this.meleeT > 0) return false;
      this.meleeT = 0.42;
      this.setTrack(1, 'upper_melee', false);
      return true;
    }
    hurt(dmg) {
      if (this.dead || this.invul > 0) return;
      this.hp -= dmg;
      this.hitT = 0.3; this.invul = 0.35;
      if (this.hp <= 0) { this.hp = 0; this.dead = true; this.deadT = 0; }
    }
    muzzle() {
      const b = this.bMuzzle;
      return { x: b.worldX, y: b.worldY, a: this.aim };
    }

    // ---------------------------------------------------------- 每帧
    update(dt, input) {
      const P = this;
      if (P.dead) { P.deadT += dt; }
      if (P.invul > 0) P.invul -= dt;
      if (P.fireCd > 0) P.fireCd -= dt;
      if (P.reloadT > 0) { P.reloadT -= dt; if (P.reloadT <= 0) { P.ammo = P.mag; P.reloadT = 0; } }
      if (P.meleeT > 0) P.meleeT -= dt;
      if (P.hitT > 0) P.hitT -= dt;
      if (P.landT > 0) P.landT -= dt;
      if (P.flipT > 0) P.flipT -= dt;

      // --- 移动
      const mv = P.dead ? 0 : (input.right ? 1 : 0) - (input.left ? 1 : 0);
      const runK = input.run ? 1.75 : 1;
      const spd = 250 * runK * (mv ? 1 : 0);
      if (!P.dead) P.x += mv * spd * dt;
      // 朝向只跟瞄准走（gunner 同款）：按移动方向翻面会和瞄准翻面打架，来回横跳

      if (!P.dead && input.jump && P.onGround) { P.vy = 760; P.onGround = false; }
      if (!P.onGround) {
        P.vy -= 2200 * dt;
        P.y += P.vy * dt;
        if (P.y <= 0) { P.y = 0; P.vy = 0; P.onGround = true; P.landT = 0.22; }
      }

      // --- 瞄准
      P.aimTarget = input.aimDeg;
      const k = Math.min(1, P.damp * dt);
      P.aim += (((P.aimTarget - P.aim + 540) % 360) - 180) * k;
      P.aim = ((P.aim + 540) % 360) - 180;        // 保持在 ±180，避免累加漂移
      // 面朝方向跟着瞄准走（横板射击常见做法）
      if (Math.abs(Math.cos(P.aim * RAD)) > 0.12) {
        const nf = P.aim > -90 && P.aim < 90 ? 1 : -1;
        if (nf !== P.face && P.flipT <= 0) { P.flipFrom = P.face; P.face = nf; P.flipT = 0.14; }
      }
      if (!P.dead && input.fire) P.tryFire();

      // --- 动画轨道
      const [ln, ll] = P.lowerAnim(Math.abs(mv) * runK);
      P.setTrack(0, ln, ll);
      const t0 = P.state.getCurrent(0);
      if (t0) t0.timeScale = (ln === 'run' && !P.onGround) ? (P.vy > 0 ? 0.35 : 0.5) : (runK > 1 ? 1.15 : 1);
      const un = P.upperAnim(Math.abs(mv) * runK);
      P.setTrack(1, un, !ONESHOT[un]);

      P.state.update(dt);
      P.state.apply(P.skel);

      // --- 持枪：尺寸 / 抵肩 / 握点（gunner 同款 fitGun）
      P.bAim.data.x = P.aimX0; P.bAim.data.y = P.aimY0;
      P.fitGun(1);

      // 躯干 / 头随俯仰轻微跟随
      const pitch = Math.asin(Math.sin(P.aim * RAD)) * DEG;
      const ds = P.face > 0 ? 1 : -1;
      P.bSpine2.rotation += Math.max(-12, Math.min(12, pitch * 0.16)) * ds;
      P.bHead.rotation += Math.max(-8, Math.min(8, pitch * 0.12)) * ds;

      // --- 转身（gunner 同款）：scaleX 在 0.14s 内从旧朝向收缩过 0 再展开成新朝向，
      // 镜像不硬切；且 scaleX 必须先于任何世界角计算写入，IK 才不会拿上一帧的朝向解算。
      const p = P.flipT > 0 ? P.flipT / 0.14 : 1;
      const sx = P.flipT > 0 ? (p < 0.5 ? P.flipFrom * (1 - p * 2) : P.face * (p * 2 - 1)) : P.face;
      P.skel.scaleX = sx * P.scale;
      P.skel.scaleY = P.scale;
      P.skel.x = P.x; P.skel.y = P.y + P.footY * P.scale;
      P.skel.updateWorldTransform();

      // 枪的世界角 = 瞄准角；镜像时局部旋转方向相反
      const pw = Math.atan2(P.bSpine2.c, P.bSpine2.a) * DEG;
      P.bAim.rotation = P.face > 0 ? (P.aim - pw) : (pw - P.aim);
      P.skel.updateWorldTransform();

      const w = P.armWeights();
      P.solveArm('R', -1, w.r);   // bendDir -1 = 肘朝下（gunner 默认），两个朝向都成立
      P.solveArm('L', -1, w.l);
      P.skel.updateWorldTransform();
    }

    // IK 权重（gunner 同款，去掉收枪/拔枪）：死亡松手；换弹时左手离枪去摸弹匣、
    // 右手虚握，权重 <1 时手臂向动画姿势靠拢，换弹动作才看得出来
    armWeights() {
      if (this.dead) return { r: 0, l: 0 };
      if (this.reloadT > 0) {
        const t = RELOAD_T - this.reloadT;
        const hand = (a, b, va, vb) => va + (vb - va) * Math.min(1, Math.max(0, (t - a) / (b - a)));
        const l = t < 0.85 ? hand(0, 0.25, 0.9, 0.05) : hand(1.0, 1.45, 0.05, 0.9);
        const r = t < 0.3 ? hand(0, 0.3, 1, 0.75) : (t < 1.45 ? 0.75 : hand(1.45, 1.7, 0.75, 1));
        return { r, l };
      }
      return { r: 1, l: 1 };
    }

    // 枪尺寸 + 抵肩 + 握点（与 gunner 同源；改尺寸必须 updateOffset）
    fitGun(gripK) {
      const at = this.gunAt; if (!at) return;
      const k = this.gunSize / 100;
      at.width = this.gunW0 * k; at.height = this.gunH0 * k;
      at.updateOffset();
      const w = this.gunW0 * k, s = w / 300;
      const cx = at.x, cy = at.y;
      const lx = px => cx + (px - 150) * s;
      const ly = py => cy - (py - 56) * s;
      const tail = lx(GUN_PX.tailX);
      this.bGun.data.x = (-tail + this.stockOff) * gripK;
      this.bMuzzle.data.x = lx(GUN_PX.muzX); this.bMuzzle.data.y = ly(GUN_PX.muzY);
      const setGrip = (bone, pxX, pxY, maxReach) => {
        bone.data.y = ly(pxY);
        let x = lx(pxX);
        if (this.bGun.data.x + x > maxReach) x = maxReach - this.bGun.data.x;
        bone.data.x = x;
      };
      setGrip(this.bGripR, GUN_PX.gripX, GUN_PX.gripY, CHAIN - 100);
      setGrip(this.bGripL, GUN_PX.foreX, GUN_PX.foreY, CHAIN - 60);
    }

    // 两骨 IK（余弦定理）。肘部有两个解（肩的两侧），用「肘部世界 y 更低」来选——
    // 固定符号在朝右时恰好朝下，转向左就变成朝上（手臂甩到头顶），gunner 里踩过的坑。
    // 近对称（两个解几乎一样高）时保持上一帧选解，避免肘部来回跳。
    solveArm(side, bendDir, weight) {
      if (weight <= 0.001) return;
      const b1 = this.skel.findBone('UpperArm_1_' + side);
      const b2 = this.skel.findBone('UpperArm_2_' + side);
      const g = this.skel.findBone('grip_' + side);
      if (!b1 || !b2 || !g) return;
      const L1 = b1.data.length * Math.hypot(b1.a, b1.c);
      const L2 = b2.data.length * Math.hypot(b2.a, b2.c);
      const dx = g.worldX - b1.worldX, dy = g.worldY - b1.worldY;
      const raw = Math.hypot(dx, dy);
      const d = Math.min(Math.max(raw, Math.abs(L1 - L2) + 0.01), L1 + L2 - 0.01);
      const base = Math.atan2(dy, dx) * DEG;
      const cosA = Math.min(1, Math.max(-1, (d * d + L1 * L1 - L2 * L2) / (2 * d * L1)));
      const A = Math.acos(cosA) * DEG;
      const dy1 = Math.sin((base + A) * RAD) * L1, dy2 = Math.sin((base - A) * RAD) * L1;
      let pick;                                         // true => base + A
      if (Math.abs(dy1 - dy2) < L1 * 0.04) pick = this.armPick[side];
      else pick = bendDir < 0 ? (dy1 < dy2) : (dy1 > dy2);
      this.armPick[side] = pick;
      const armDir = pick ? base + A : base - A;
      const ex = b1.worldX + Math.cos(armDir * RAD) * L1;
      const ey = b1.worldY + Math.sin(armDir * RAD) * L1;
      const foreDir = Math.atan2(g.worldY - ey, g.worldX - ex) * DEG;
      const par = b1.parent;
      const pw = Math.atan2(par.c, par.a) * DEG;
      const mir = this.skel.scaleX < 0 ? -1 : 1;
      const t1 = mir > 0 ? (armDir - pw) : (pw - armDir);
      const t2 = mir > 0 ? (foreDir - armDir) : (armDir - foreDir);
      const blend = (from, to) => from + (((to - from + 540) % 360) - 180) * weight;
      b1.rotation = blend(b1.rotation, t1);
      b2.rotation = blend(b2.rotation, t2);
    }
  }

  return { Player, MAG, RELOAD_T };
})();
