# -*- coding: utf-8 -*-
"""
为 nanzhu 骨架注入「持枪」骨骼 / 插槽 / IK，并生成一整套横板射击上半身动画。

用法：
    python build_gun_anims.py
输出：
    nanzhu_gunner.json     （原骨架 + 新增内容，原文件不改动）

设计要点：
 1. 手臂不再靠关键帧摆姿势，而是交给 IK：枪绕肩部 aim_pivot 旋转，双手 IK 自动解算
    —— 任何瞄准角度下肘部弯曲都自然，不会出现"手臂穿模/僵直"。
 2. 上半身动画只负责躯干 / 头 / 呼吸 / 后坐位移，瞄准角由运行时写 bone.rotation，
    动画里刻意不含 aim_pivot 的 rotate 时间轴，避免互相打架。
 3. 所有循环动画首尾帧数值一致 + 贝塞尔缓动，保证 loop 无跳帧。
 4. 步频从原 walk / run 动画自动读取时长，bob 与脚步严格同频。
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
SRC = os.path.join(ROOT, 'characters', 'nanzhu', 'nanzhu.json')
OUT = os.path.join(HERE, 'nanzhu_gunner.json')

# ---------------------------------------------------------------- 可调参数
CFG = dict(
    shoulder_bone='Spine2',   # 持枪枢轴挂在哪个骨骼下
    shoulder_x=232.0,         # 枢轴在骨骼局部坐标（两肩之间）
    shoulder_y=40.0,
    grip_dist=235.0,          # 肩 -> 握把（整枪往身前收，左手才够得到护木）
    # 枪尺度：身高约 950 骨架单位，臂链(上臂+前臂) 529。枪长取身高 ~0.72 才压得住手掌；
    # 握点必须满足「肩 -> 握点 < 臂链」，否则 IK 伸直也够不到。
    grip_r_off=(-27.0, -77.0),  # 右手握把（肩 -> 313）
    grip_l_off=(160.0, -77.0),  # 左手护木（肩 -> 500，留 29 余量给肘部弯曲）
    muzzle=(571.0, 9.0),        # 枪口（枪局部）
    gun_w=680.0, gun_h=255.0,   # 枪附件尺寸
    gun_at_x=254.0, gun_at_y=-9.0,
    bend_r=False,             # 右肘弯曲方向（画面上不对就翻转）
    bend_l=True,
    hand_r_rot=-14.0,         # 右手掌贴合握把的固定角
    hand_l_rot=-6.0,
)

E = {"curve": 0.25, "c3": 0.75}                          # ease-in-out
EO = {"curve": 0.0, "c2": 0.0, "c3": 0.58, "c4": 1.0}   # ease-out（冲击后缓收）
EI = {"curve": 0.42, "c2": 0.0, "c3": 1.0, "c4": 1.0}   # ease-in

ARM_BONES = ['UpperArm_1_R', 'UpperArm_2_R', 'UpperArm_3_R',
             'UpperArm_1_L', 'UpperArm_2_L', 'UpperArm_3_L', 'Wrist']
TORSO_BONES = ['Spine', 'Spine2', 'Head']


# ---------------------------------------------------------------- 时间轴工具
def rot(frames):
    """frames: [(time, angle, curve|None)] -> rotate 时间轴"""
    out = []
    for i, (t, v, c) in enumerate(frames):
        f = {}
        if i > 0 or t:
            f['time'] = round(t, 4)
        f['angle'] = round(v, 3)
        if c:
            f.update(c)
        out.append(f)
    return out


def _sample(frames, t):
    """在 (t,v,c) 序列上线性取 v"""
    if not frames:
        return 0.0
    if t <= frames[0][0]:
        return frames[0][1]
    for i in range(len(frames) - 1):
        a, b = frames[i], frames[i + 1]
        if a[0] <= t <= b[0]:
            k = 0 if b[0] == a[0] else (t - a[0]) / (b[0] - a[0])
            return a[1] + (b[1] - a[1]) * k
    return frames[-1][1]


def tr(xf=None, yf=None):
    """合并 x / y 两条曲线 -> translate 时间轴（缺值自动插值）"""
    times = sorted({0.0} | {t for t, _, _ in (xf or [])} | {t for t, _, _ in (yf or [])})
    out = []
    for i, t in enumerate(times):
        f = {}
        if i > 0 or t:
            f['time'] = round(t, 4)
        f['x'] = round(_sample(xf, t), 3)
        f['y'] = round(_sample(yf, t), 3)
        c = None
        for src in (xf, yf):
            if not src:
                continue
            for tt, _, cc in src:
                if abs(tt - t) < 1e-6 and cc:
                    c = cc
        if c:
            f.update(c)
        out.append(f)
    return out


def sine(dur, cycles, amp, phase=0.0, n=16, bias=0.0):
    """用密集采样近似正弦，避免线性折线的生硬感"""
    fs = []
    for i in range(n + 1):
        t = dur * i / n
        v = bias + amp * math.sin(2 * math.pi * cycles * i / n + phase)
        fs.append((t, v, None))
    fs[-1] = (dur, fs[0][1], None)
    return fs


def dur_of(anim):
    """从已有动画里取时长（最大关键帧时间）"""
    d = 0.0
    for bone, tls in anim.get('bones', {}).items():
        for tl in tls.values():
            if isinstance(tl, list):
                for f in tl:
                    d = max(d, f.get('time', 0.0))
    return round(d, 4)


# ---------------------------------------------------------------- 骨架改造
def build():
    data = json.load(open(SRC, encoding='utf-8'))
    bones = data['bones']
    by_name = {b['name']: b for b in bones}

    def world_rot(name):
        r, b = 0.0, by_name.get(name)
        while b:
            r += b.get('rotation', 0.0)
            b = by_name.get(b.get('parent'))
        return r

    # 让 aim_pivot 的局部 X 轴在 setup 姿势下指向世界 +X（角色朝右）
    aim_base = -world_rot(CFG['shoulder_bone'])

    new_bones = [
        {'name': 'aim_pivot', 'parent': CFG['shoulder_bone'],
         'x': CFG['shoulder_x'], 'y': CFG['shoulder_y'],
         'rotation': round(aim_base, 3), 'length': 40, 'color': 'ff9a3cff'},
        {'name': 'gun', 'parent': 'aim_pivot',
         'x': CFG['grip_dist'], 'y': 0, 'length': 60, 'color': 'ff9a3cff'},
        {'name': 'grip_R', 'parent': 'gun',
         'x': CFG['grip_r_off'][0], 'y': CFG['grip_r_off'][1], 'length': 20, 'color': 'ff9a3cff'},
        {'name': 'grip_L', 'parent': 'gun',
         'x': CFG['grip_l_off'][0], 'y': CFG['grip_l_off'][1], 'length': 20, 'color': 'ff9a3cff'},
        {'name': 'muzzle', 'parent': 'gun',
         'x': CFG['muzzle'][0], 'y': CFG['muzzle'][1], 'length': 20, 'color': 'ff9a3cff'},
    ]
    bones.extend(new_bones)

    # 插槽：排在手之前 -> 手指画在枪上面，像真的握住握把
    slots = data['slots']
    idx = next((i for i, s in enumerate(slots) if s['name'] == 'UpperArm_3_R'), len(slots))
    slots.insert(idx, {'name': 'gun', 'bone': 'gun', 'attachment': 'gun'})

    # 附件
    skins = data.get('skins')
    if isinstance(skins, dict):
        default = skins.setdefault('default', {}).setdefault('attachments', {})
    else:
        skins = skins or []
        d0 = next((s for s in skins if s.get('name') == 'default'), None)
        if d0 is None:
            d0 = {'name': 'default', 'attachments': {}}
            skins.append(d0)
        default = d0['attachments']
        data['skins'] = skins
    default.setdefault('gun', {})['gun'] = {
        'x': CFG['gun_at_x'], 'y': CFG['gun_at_y'], 'rotation': 0,
        'width': CFG['gun_w'], 'height': CFG['gun_h'],
    }

    # IK：双手跟随枪上的握点
    data.setdefault('ik', []).extend([
        {'name': 'ik_arm_R', 'order': 5, 'bones': ['UpperArm_1_R', 'UpperArm_2_R'],
         'target': 'grip_R', 'mix': 1, 'bendPositive': CFG['bend_r'],
         'compress': False, 'stretch': False},
        {'name': 'ik_arm_L', 'order': 6, 'bones': ['UpperArm_1_L', 'UpperArm_2_L'],
         'target': 'grip_L', 'mix': 0.9, 'bendPositive': CFG['bend_l'],
         'compress': False, 'stretch': False},
    ])

    anims = data['animations']
    walk_d = dur_of(anims['walk']) or 1.1
    run_d = dur_of(anims['run']) or 0.867
    print('walk duration =', walk_d, ' run duration =', run_d)

    upper = {}

    def put(name, bones_tl, events=None, ik=None):
        a = {'bones': bones_tl}
        if ik:
            a['ik'] = ik
        if events:
            a['events'] = events
        upper[name] = a

    def base(dur):
        """所有上半身动画的公共底：手臂根部锁定、手掌贴合握把、躯干归零"""
        tl = {}
        for b in ARM_BONES:
            tl[b] = {'translate': tr([(0, 0, None), (dur, 0, None)])}
        tl['UpperArm_3_R'] = {'translate': tr([(0, 0, None), (dur, 0, None)]),
                              'rotate': rot([(0, CFG['hand_r_rot'], None), (dur, CFG['hand_r_rot'], None)])}
        tl['UpperArm_3_L'] = {'translate': tr([(0, 0, None), (dur, 0, None)]),
                              'rotate': rot([(0, CFG['hand_l_rot'], None), (dur, CFG['hand_l_rot'], None)])}
        return tl

    # ---- idle：呼吸 + 枪口极缓慢浮动（3.2s，首尾闭合）
    d = 3.2
    tl = base(d)
    tl['Spine'] = {'rotate': rot([(0, 0, E), (d / 2, 0.5, E), (d, 0, None)])}
    tl['Spine2'] = {'rotate': rot([(0, 0, E), (d / 2, -0.7, E), (d, 0, None)])}
    tl['Head'] = {'rotate': rot([(0, 0, E), (d / 2, 1.4, E), (d, 0, None)])}
    tl['aim_pivot'] = {'translate': tr(sine(d, 1, 2.0, phase=0.0), sine(d, 1, 2.6, phase=math.pi / 2))}
    tl['gun'] = {'rotate': rot([(0, 0, E), (d / 2, -1.0, E), (d, 0, None)])}
    put('upper_idle', tl)

    # ---- walk：枪口 bob 与步频同频（每步一次起伏），躯干反相抵消
    d = walk_d
    tl = base(d)
    tl['Spine'] = {'rotate': rot(sine(d, 2, 0.7, phase=math.pi))}
    tl['Spine2'] = {'rotate': rot(sine(d, 2, 1.1, phase=math.pi))}
    tl['Head'] = {'rotate': rot(sine(d, 2, 0.9))}
    tl['aim_pivot'] = {'translate': tr(sine(d, 2, 3.0, phase=math.pi / 2), sine(d, 2, 5.0))}
    tl['gun'] = {'rotate': rot(sine(d, 2, 1.8, phase=math.pi))}   # 反向补偿 -> 枪口更稳
    put('upper_walk', tl)

    # ---- run：幅度更大 + 躯干前倾
    d = run_d
    tl = base(d)
    tl['Spine'] = {'rotate': rot(sine(d, 2, 1.2, phase=math.pi, bias=1.0))}
    tl['Spine2'] = {'rotate': rot(sine(d, 2, 2.0, phase=math.pi, bias=-3.2))}
    tl['Head'] = {'rotate': rot(sine(d, 2, 1.6, bias=-1.5))}
    tl['aim_pivot'] = {'translate': tr(sine(d, 2, 6.0, phase=math.pi / 2), sine(d, 2, 11.0))}
    tl['gun'] = {'rotate': rot(sine(d, 2, 3.4, phase=math.pi))}
    put('upper_run', tl)

    # ---- jump：起跳枪口上扬
    d = 0.55
    tl = base(d)
    tl['Spine2'] = {'rotate': rot([(0, 0, EO), (0.12, -6.0, E), (0.35, -3.0, E), (d, 0, None)])}
    tl['Head'] = {'rotate': rot([(0, 0, EO), (0.12, -2.5, E), (d, 0, None)])}
    tl['aim_pivot'] = {'translate': tr(
        [(0, 0, EO), (0.12, -8.0, E), (0.35, -3.0, E), (d, 0, None)],
        [(0, 0, EO), (0.12, 26.0, E), (0.35, 16.0, E), (d, 0, None)])}
    tl['gun'] = {'rotate': rot([(0, 0, EO), (0.12, 9.0, E), (0.35, 4.0, E), (d, 0, None)])}
    put('upper_jump', tl)

    # ---- fall：空中漂浮
    d = 0.5
    tl = base(d)
    tl['Spine2'] = {'rotate': rot(sine(d, 1, 1.8, bias=2.0))}
    tl['aim_pivot'] = {'translate': tr(sine(d, 1, 2.5), sine(d, 1, 5.0, phase=math.pi / 2))}
    tl['gun'] = {'rotate': rot(sine(d, 1, 2.2, phase=math.pi))}
    put('upper_fall', tl)

    # ---- land：落地吸震
    d = 0.28
    tl = base(d)
    tl['Spine'] = {'rotate': rot([(0, 0, EO), (0.07, 5.0, E), (0.16, -2.0, E), (d, 0, None)])}
    tl['Spine2'] = {'rotate': rot([(0, 0, EO), (0.07, 7.0, E), (0.16, -2.5, E), (d, 0, None)])}
    tl['Head'] = {'rotate': rot([(0, 0, EO), (0.09, 4.0, E), (d, 0, None)])}
    tl['aim_pivot'] = {'translate': tr(
        [(0, 0, EO), (0.07, -6.0, E), (0.16, 2.0, E), (d, 0, None)],
        [(0, 0, EO), (0.07, -22.0, E), (0.16, 6.0, E), (d, 0, None)])}
    tl['gun'] = {'rotate': rot([(0, 0, EO), (0.07, -9.0, E), (0.16, 3.0, E), (d, 0, None)])}
    put('upper_land', tl)

    # ---- fire：3 帧冲出、缓收（0.3s）
    d = 0.3
    tl = base(d)
    tl['Spine2'] = {'rotate': rot([(0, 0, EO), (0.04, 2.4, E), (d, 0, None)])}
    tl['Head'] = {'rotate': rot([(0, 0, EO), (0.04, -2.0, E), (d, 0, None)])}
    tl['aim_pivot'] = {'translate': tr(
        [(0, 0, EO), (0.03, -11.0, E), (0.1, -3.5, E), (d, 0, None)],
        [(0, 0, EO), (0.03, 3.0, E), (d, 0, None)])}
    tl['gun'] = {
        'translate': tr([(0, 0, EO), (0.03, -28.0, E), (0.1, -10.0, E), (0.18, -2.0, E), (d, 0, None)],
                        [(0, 0, EO), (0.03, 2.0, E), (d, 0, None)]),
        'rotate': rot([(0, 0, EO), (0.035, 12.0, E), (0.1, 4.5, E), (d, 0, None)]),
    }
    # fire 用 add 混合叠加在任意上层动画之上：两只手的 rotate 必须是「增量」，
    # 不能沿用握枪固定角，否则每开一枪手腕就多转一次。
    tl['UpperArm_3_R']['rotate'] = rot([(0, 0, EO), (0.03, -6.0, E), (d, 0, None)])
    tl['UpperArm_3_L']['rotate'] = rot([(0, 0, EO), (0.035, -3.0, E), (d, 0, None)])
    put('upper_fire', tl, events=[
        {'time': 0.0, 'name': 'fire'},
        {'time': 0.02, 'name': 'muzzle_flash'},
        {'time': 0.07, 'name': 'eject'},
    ])

    # ---- reload：1.7s，左手离枪掏弹匣再回握
    d = 1.7
    tl = base(d)
    tl['Spine'] = {'rotate': rot([(0, 0, E), (0.35, 1.5, E), (0.9, 1.5, E), (d - 0.2, 0, None)])}
    tl['Spine2'] = {'rotate': rot([(0, 0, E), (0.35, 3.5, E), (0.9, 3.0, E), (d - 0.2, 0, None)])}
    tl['Head'] = {'rotate': rot([(0, 0, E), (0.4, 4.5, E), (0.95, 4.0, E), (d - 0.2, 0, None)])}
    tl['aim_pivot'] = {'translate': tr(
        [(0, 0, E), (0.3, -18.0, E), (0.8, -20.0, E), (1.15, -6.0, E), (d - 0.15, 0, None)],
        [(0, 0, E), (0.3, -34.0, E), (0.8, -38.0, E), (1.15, -12.0, E), (d - 0.15, 0, None)])}
    tl['gun'] = {
        'translate': tr([(0, 0, E), (0.3, -26.0, E), (0.8, -30.0, E), (1.15, -10.0, E), (d - 0.15, 0, None)],
                        [(0, 0, E), (0.3, -6.0, E), (d - 0.15, 0, None)]),
        'rotate': rot([(0, 0, E), (0.3, -38.0, E), (0.8, -42.0, E), (1.2, -16.0, EO), (d - 0.15, 0, None)]),
    }
    put('upper_reload', tl, events=[
        {'time': 0.55, 'name': 'mag_out'},
        {'time': 1.02, 'name': 'mag_in'},
        {'time': 1.6, 'name': 'reload_done'},
    ], ik={'ik_arm_L': [
        {'mix': 0.9}, {'time': 0.25, 'mix': 0.05}, {'time': 0.85, 'mix': 0.05}, {'time': 1.45, 'mix': 0.9}],
        'ik_arm_R': [
            {'mix': 1.0}, {'time': 0.3, 'mix': 0.7}, {'time': 0.85, 'mix': 0.7}, {'time': 1.45, 'mix': 1.0}]})

    # ---- draw / holster：拔枪与收枪（含 IK 权重渐变，手不会瞬移）
    d = 0.5
    tl = base(d)
    tl['Spine2'] = {'rotate': rot([(0, 0, E), (0.2, 5.0, EO), (d, 0, None)])}
    tl['aim_pivot'] = {'translate': tr(
        [(0, 0, E), (0.2, -14.0, EO), (d, 0, None)],
        [(0, -155.0, E), (0.2, -96.0, EO), (d, 0, None)])}
    tl['gun'] = {'rotate': rot([(0, -106.0, E), (0.2, -68.0, EO), (d, 0, None)])}
    put('upper_draw', tl, events=[{'time': 0.5, 'name': 'draw_done'}], ik={
        'ik_arm_R': [{'mix': 0.0}, {'time': 0.2, 'mix': 0.0}, {'time': 0.45, 'mix': 1.0}],
        'ik_arm_L': [{'mix': 0.0}, {'time': 0.35, 'mix': 0.0}, {'time': 0.5, 'mix': 0.9}]})

    tl = base(d)
    tl['Spine2'] = {'rotate': rot([(0, 0, E), (0.25, 4.0, EI), (d, 0, None)])}
    tl['aim_pivot'] = {'translate': tr(
        [(0, 0, E), (0.25, -10.0, EI), (d, 0, None)],
        [(0, 0, EI), (0.25, -84.0, EI), (d, -155.0, None)])}
    tl['gun'] = {'rotate': rot([(0, 0, EI), (0.25, -62.0, EI), (d, -106.0, None)])}
    put('upper_holster', tl, events=[{'time': 0.5, 'name': 'holster_done'}], ik={
        'ik_arm_R': [{'mix': 1.0}, {'time': 0.25, 'mix': 0.6}, {'time': 0.5, 'mix': 0.0}],
        'ik_arm_L': [{'mix': 0.9}, {'time': 0.2, 'mix': 0.0}, {'time': 0.5, 'mix': 0.0}]})

    # ---- turn：转身时躯干先拧，枪滞后一拍（避免"整体贴图翻转"的僵硬）
    d = 0.26
    tl = base(d)
    tl['Spine'] = {'rotate': rot([(0, 0, E), (d / 2, -3.0, E), (d, 0, None)])}
    tl['Spine2'] = {'rotate': rot([(0, 0, E), (d / 2, -8.0, E), (d, 0, None)])}
    tl['Head'] = {'rotate': rot([(0, 0, E), (d * 0.35, -4.0, E), (d, 0, None)])}
    tl['aim_pivot'] = {'translate': tr(
        [(0, 0, E), (d / 2, -14.0, E), (d, 0, None)], [(0, 0, E), (d, 0, None)])}
    put('upper_turn', tl)

    # ---- gethit：受击后仰、枪口上跳
    d = 0.42
    tl = base(d)
    tl['Spine'] = {'rotate': rot([(0, 0, EO), (0.08, -4.5, E), (0.22, -1.5, E), (d, 0, None)])}
    tl['Spine2'] = {'rotate': rot([(0, 0, EO), (0.08, 10.0, E), (0.22, 5.0, E), (d, 0, None)])}
    tl['Head'] = {'rotate': rot([(0, 0, EO), (0.1, -7.0, E), (d, 0, None)])}
    tl['aim_pivot'] = {'translate': tr(
        [(0, 0, EO), (0.08, -20.0, E), (0.22, -7.0, E), (d, 0, None)],
        [(0, 0, EO), (0.08, 14.0, E), (d, 0, None)])}
    tl['gun'] = {'rotate': rot([(0, 0, EO), (0.08, -24.0, E), (0.22, -8.0, E), (d, 0, None)])}
    put('upper_gethit', tl)

    # ---- melee：枪托前刺砸击
    d = 0.55
    tl = base(d)
    tl['Spine'] = {'rotate': rot([(0, 0, EI), (0.14, -5.0, EO), (0.3, 5.0, E), (d, 0, None)])}
    tl['Spine2'] = {'rotate': rot([(0, 0, EI), (0.14, -9.0, EO), (0.3, 8.0, E), (d, 0, None)])}
    tl['aim_pivot'] = {'translate': tr(
        [(0, 0, EI), (0.14, -24.0, EO), (0.3, 58.0, E), (d, 0, None)],
        [(0, 0, EI), (0.14, 22.0, EO), (0.3, -10.0, E), (d, 0, None)])}
    tl['gun'] = {'rotate': rot([(0, 0, EI), (0.14, -58.0, EO), (0.3, 26.0, E), (d, 0, None)])}
    put('upper_melee', tl, events=[{'time': 0.28, 'name': 'melee_hit'}])

    # ---- die：脱力，双手松开（IK 权重归零）
    d = 0.9
    tl = base(d)
    tl['Spine'] = {'rotate': rot([(0, 0, EI), (0.5, -14.0, E), (d, -18.0, None)])}
    tl['Spine2'] = {'rotate': rot([(0, 0, EI), (0.5, 12.0, E), (d, 16.0, None)])}
    tl['Head'] = {'rotate': rot([(0, 0, EI), (0.6, 12.0, E), (d, 16.0, None)])}
    tl['aim_pivot'] = {'translate': tr(
        [(0, 0, EI), (0.5, -30.0, E), (d, -34.0, None)],
        [(0, 0, EI), (0.5, -70.0, E), (d, -86.0, None)])}
    tl['gun'] = {'rotate': rot([(0, 0, EI), (0.5, -70.0, E), (d, -88.0, None)])}
    put('upper_die', tl, ik={
        'ik_arm_R': [{'mix': 1.0}, {'time': 0.3, 'mix': 0.25}, {'time': 0.6, 'mix': 0.0}],
        'ik_arm_L': [{'mix': 0.9}, {'time': 0.3, 'mix': 0.0}, {'time': 0.6, 'mix': 0.0}]})

    anims.update(upper)

    # 事件必须先在本体声明，动画时间轴才能引用（3.8 会报 Event not found）
    NEW_EVENTS = ['fire', 'muzzle_flash', 'eject', 'mag_out', 'mag_in',
                  'reload_done', 'draw_done', 'holster_done', 'melee_hit']
    ev = data.setdefault('events', {})
    if isinstance(ev, dict):
        for n in NEW_EVENTS:
            ev.setdefault(n, {})
    else:
        for n in NEW_EVENTS:
            ev.append({'name': n})

    data['skeleton'] = dict(data['skeleton'])
    json.dump(data, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False)
    print('written ->', OUT)
    print('upper anims:', ', '.join(upper.keys()))


if __name__ == '__main__':
    build()
