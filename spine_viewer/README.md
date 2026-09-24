# Spine 骨架查看器（H5 / WebGL）

直接看 `unpack/characters` 里解出来的 19 个角色、43 份 Spine 骨架，不用装任何东西。

## 怎么跑

必须通过 HTTP 打开（`file://` 下浏览器会因跨域拒绝读取 json/atlas/png）：

```
双击  unpack\start_spine_viewer.bat
```

它会起一个 `python -m http.server 8765`（根目录 = unpack），然后打开
<http://127.0.0.1:8765/spine_viewer/index.html>。

手动方式：

```bat
cd /d "E:\BaiduNetdiskDownload\9dm Black Sheep\unpack"
python -m http.server 8765 --bind 127.0.0.1
```

## 能做什么

- 左栏按角色分组列出全部骨架，标注骨骼数 / 动画数 / 份数；搜索框支持按角色名或**动画名**过滤
- 舞台：WebGL 渲染，滚轮缩放（以鼠标为锚点）、拖拽平移、双击自适应
- 播放：动画下拉 / 播放暂停 / 0.1–3× 速度 / 循环 / 进度条拖动 seek
- 调试：骨骼线（`drawBones`）、附件线框（region / mesh hull / 包围盒）
- 皮肤切换：右侧点皮肤 chip
- 运行时切换：默认 spine-webgl **3.8**，可切 4.2 / 4.1 回退
- 信息面板：骨骼 / 插槽 / 皮肤 / 附件 / IK / 动画数、源文件路径、atlas 命中率，命中率偏低时给一个 atlas 候选下拉手动换

快捷键：`空格` 播放暂停 · `F` 自适应 · `←/→` 切动画。

URL 直达：`?char=<角色名>`（如 `?char=xiameng` / `?char=nanzhu`）。

## 目录

```
spine_viewer/
├── index.html          页面骨架
├── app.js              加载 / 渲染 / 交互
├── style.css
├── data/manifest.json  由 make_spine_manifest.py 生成的角色清单
└── vendor/
    ├── spine-webgl.js           3.8 官方构建（默认）
    ├── spine-webgl-4.2.67.js    回退
    └── spine-webgl-4.1.24.js    回退
```

## 数据说明

- 骨架数据本体是 **Spine 3.8.95**（1 份是 3.6.46）。42 份的 `skins` 是 4.x 的数组写法，
  但动画键名仍是 3.8 的 `rotate`/`angle`。实测 3.8 runtime 解析出的时间轴更多（gujia 491 vs 464），
  所以默认用 3.8。
- `manifest.json` 里每个骨架都带 `atlas_candidates`：脚本按「骨架附件名 ∩ atlas region 名」算命中率，
  在**全库**（不只同目录）挑最优 atlas 配对，因此跨 bundle 复用也能配上。
- 贴图被 Unity 导入时缩放过（声明页尺寸 != PNG 尺寸），查看器会用 `fixAtlasUVs()` 按声明页尺寸修正 UV
- 目前 43 份中只有 `vine-pro` 命中率 50%，其余 100%（无头冒烟 43/43 构建 + 播放成功）。
- 角色贴图是 RGBA8888 PNG，尺寸 2048² 上下，一部分角色有多张图集页。

## 已知限制

- 音频、材质 / Shader 参数不在查看器范围内
- 骨骼调试线在超大骨架（gujia 412 骨）上线条很密，可只勾「附件线框」
- 切运行时会重建 WebGL 上下文，首帧会有一次短暂重新加载
