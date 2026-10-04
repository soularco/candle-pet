# 烛 · candle-pet

> **⚠️ 这是 [AAAAGENT](https://github.com/phoiex/AAAAGENT) 的改良版，不是原创项目。**
>
> **原版作者：phoiex** · **原仓库：https://github.com/phoiex/AAAAGENT**
> **许可：AAAAGENT 非商业使用及署名许可 1.0 —— 禁止任何商业用途**
>
> 本仓库全部基于原版修改。原版的核心设计、架构与绝大部分代码均由 phoiex 及
> AAAAGENT 贡献者完成。本仓库维护者与原作者**没有隶属关系**，原作者**未对本仓库的
> 修改表示认可或背书**。详细说明见 **[NOTICE.md](NOTICE.md)**。

---

一个会主动说话、会记住你、会安静陪着你的桌面伙伴。

她叫**烛** —— 一截小蜡烛，坐在你的桌面上。

---

## 换模型前的自检：动作参数适配性

Cubism 的参数名**在模型之间并不通用**。同一个 `Param33`：

| 模型 | `Param33` 的含义 |
|---|---|
| 希罗 / 雪 | 裙子物理x1 |
| 无尽夏 | 前左长发 |

动作表是按某一个模型的语义写的，套到别的模型上就会「推错部件」——
本该推裙子的动作去推了头发，表现就是头发乱晃、裙子不动、整体和身体脱节。
更极端的是 `Param3`：在希罗上是「L1物理x1」，在无尽夏上却是
「制作者：墨舞笔歌」，一驱动就把作者名字显示出来了。

所以换模型或改动作表之前，先跑一遍自检：

```bash
npm run check:actions
# 机器可读结果（便于接进 CI）：
node tools/check-action-parameters.mjs --json
```

它会比对动作表里用到的每个参数与各模型 `pet.cdi3.json` 里的实际名字，报出三类问题：

- **参数含义在各模型间不一致** —— 动作错位的直接原因
- **参数名本身不该被驱动** —— 例如名字是「制作者：…」或者一个日期
- **参数在部分模型里不存在** —— 写值会被忽略

退出码 1 表示有需要处理的项。

本项目的处理方式是**关掉动作对物理参数的整体驱动**
（`cubism-renderer.mjs` 里的 `PHYSICS_PUSH_ENABLED`），
让模型自带的 `physics3.json` 跟随身体自然摆动 —— 裙子被身体带动，
而不是被一股外力来回拉扯。

## 这是什么

Windows 桌面宠物，基于 Electron + Live2D，改良自 [AAAAGENT](https://github.com/phoiex/AAAAGENT)。

- **1008 句配音** ── 温柔活泼的少女嗓音，本地缓存，离线可播
- **742 条台词 / 46 个场景组** ── 分时段、星期、月内、软件、状态
- **记忆系统** ── 记得你聊过什么，久不提会**慢慢忘掉**（遗忘曲线）
- **22 个动作** ── 点头、歪头、抬手、捂脸、比耶……
- **8 种组合手势** ── 先搓脸再戳胸、摸头再戳胸……
- **16 种交互** ── 拖动 / 点击 / 滚轮 / 右键 / 7 个身体部位
- **指针穿透** ── 非角色区域点击穿透到下层窗口
- **手机访问** ── 同一局域网用手机浏览器聊天，与桌面共享记忆

---

## 快速开始

### 需要什么

- Windows 10 / 11
- [Node.js 20+](https://nodejs.org/)（默认路径安装）
- **一个 Live2D 模型**（见下方「模型」一节）
- **语音合成 API Key**（可选，不用则退回系统语音）

### 安装

1. 克隆或解压到 `D:\aaa\AAAAGENT\`
2. 准备模型（见下）
3. 配置 API Key
4. 双击 `烛.exe`

首次启动约 5 秒。

---

## 模型

**本仓库不包含 Live2D 模型文件** —— 模型版权属于原作者。

你需要自己准备一个 Cubism 3/4/5 格式的模型，放进：

```
windows\code\desktop-pet\desktop\assets\local-model\
```

需要的文件：

```
pet.moc3              模型本体
pet.model3.json       模型描述
pet.physics3.json     物理
pet.8192/             纹理目录
*.exp3.json           表情（可选）
```

然后改 `pet.model3.json` 里的 `FileReferences` 指向你的文件名，
并重算指纹：

```bash
cd windows\code\desktop-pet
node tools\refresh-model-fingerprint.mjs
```

**★ 换模型不会丢失台词、反应、场景或记忆** —— 它们与模型无关。
详见 `01-文档\换模型指南.txt`。

---

## 怎么用

| 操作 | 效果 |
|---|---|
| **左键单击** | 触发反应（头 / 脸 / 胸 / 手 / 腰 / 裙 / 腿 各有专属动作）|
| **连续点击同一部位** | 组合手势（8 种）|
| **拖动** | 移动位置 |
| **滚轮** | 缩放 |
| **右键** | 菜单 |
| **Ctrl + Shift + P** | 预览全部动作 |

设置面板（右下齿轮）分四组：**显示 / 动作 / 连接 / 诊断**，
含取景切换、模型大小、动作预览、手机访问、日志。

---

## 自己改

```bash
cd windows\code\desktop-pet

npm.cmd run build:desktop    # 构建界面
npm.cmd run refresh:runtime  # 刷新运行时指纹（改完源码必须跑）
node tools\pack-archive.mjs  # 打包（会自动先 refresh）
```

改完源码**必须**跑 `refresh:runtime`，否则启动时会因指纹失效而静默退出。

---

## 出问题了

**设置面板 → 诊断 → 打开日志**，看 `windows\.local\logs\electron.log`。

**启动后没有反应**
运行时指纹失效。在 `windows\code\desktop-pet` 下运行：
```
npm.cmd run refresh:runtime
```

**没有声音**
检查设置面板里的「朗读台词」和「语音音量」。

---

## 许可

**AAAAGENT 非商业使用及署名许可 1.0** —— 见 [LICENSE](LICENSE)。

- ✅ 允许非商业的查看、运行、复制、研究、**修改、引用与再分发**
- ❌ **禁止任何形式的商业使用**
- ✅ **必须署名** AAAAGENT 并保留原作者信息
- ✅ **必须说明已作修改**
- ❌ **不得暗示原作者背书**
- ⚠️ 不是 MIT / Apache / OSI 认可的开源许可

**本仓库不包含：** Live2D 模型、Cubism SDK、API 凭据、配音缓存、个人数据。
详见 [NOTICE.md](NOTICE.md)。

---

## 致谢

- **[AAAAGENT](https://github.com/phoiex/AAAAGENT)** — phoiex 及贡献者 · **本项目的基础**
- [Live2D Cubism SDK for Web](https://www.live2d.com/en/sdk/download/web/) — Live2D Inc.
- [Electron](https://www.electronjs.org/) — OpenJS Foundation
- 语音合成 — 阿里云通义千问

---

## 给原作者

如果你不希望本仓库存在，请开 issue，我们会**立即下架**。
