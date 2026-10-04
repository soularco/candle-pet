# 出处与署名 / Origin and Attribution

**本仓库是 [AAAAGENT](https://github.com/phoiex/AAAAGENT) 的改良版，不是原创项目。**

**This repository is a modified version of [AAAAGENT](https://github.com/phoiex/AAAAGENT).
It is not an original work.**

---

## 原版出处 / Original project

| | |
|---|---|
| **项目名** | AAAAGENT |
| **作者** | phoiex |
| **仓库** | https://github.com/phoiex/AAAAGENT |
| **许可** | AAAAGENT 非商业使用及署名许可 1.0（见 [LICENSE](LICENSE)）|
| **本仓库基于的提交** | `2752349`（`docs: align setup authentication and existing Windows validation status`）|

引用的建议格式 / Suggested citation：

> AAAAGENT, phoiex and project contributors,
> https://github.com/phoiex/AAAAGENT, commit 2752349, accessed 2025-10.

---

## 我们改了什么 / What we changed

本仓库在原版基础上做了以下修改。**原版的核心设计、架构与绝大部分代码均由 phoiex 及
AAAAGENT 贡献者完成。**

This repository modifies the original. **The core design, architecture and the great
majority of the code are the work of phoiex and the AAAAGENT contributors.**

### 内容层 / Content

- 台词库从原版扩充到 **742 条**，反应 **83 条**，共 **1100 个句子节点**
- 场景组扩充到 **46 个**（新增设计软件、办公、下载、虚拟机、远程桌面、邮件、
  考试、阅读、开机、午休、下班前、加班、黎明、周日晚上、周四、长时间相处、
  天气、节日、安静陪伴）
- 新增 **8 种组合手势**（搓脸→戳胸、摸头→戳胸、摸头→摸脸、连搓两下脸、
  连摸两下头、连碰两次手、连戳两次胸、摸脸→碰手）
- 新增 **9 个不对称姿态动作**（捂脸、比耶、打招呼、双手交叠、转脸、托腮、
  前伸、歪头抬手、完全挡脸）
- 语音重新合成为 **1008 句**

### 记忆层 / Memory

- 新增 **14 个记忆主题** 与 **遗忘曲线**（久不提及会逐渐淡忘：提过 1 次约 3 天
  变模糊、6 天忘掉；聊过 5 次两周后仍清晰）
- 新增记忆门控台词、关联台词与联动写入

### 交互层 / Interaction

- 新增 **身体部位点击**（头/脸/胸/手/腰/裙/腿，各带专属动作）
- 新增 **指针穿透**（非角色区域点击穿透到下层窗口）
- 新增 **手机访问**（局域网聊天页，与桌面共享同一份记忆）

### 界面层 / Interface

- 重新设计工具栏与对话栏，集成音量、免打扰、控制台、设置
- 设置面板改为分组折叠结构，新增**取景切换**、**模型大小**、**动作预览**、
  **手机访问**、**诊断**
- 托盘菜单扩充

### 工程层 / Engineering

- 新增 `tools/refresh-model-fingerprint.mjs`（只重算模型指纹，保留目录配置）
- 新增 `tools/pack-archive.mjs`（固定「先刷新运行时指纹再打包」的顺序）
- 模型资源读取加 `cache: 'no-store'`（修掉 Chromium 缓存导致指纹不匹配的问题）
- 模型指纹不匹配时**降级为警告**而非抛异常，模型加载失败不再中断界面初始化
- 重命名为「烛 / candle-pet」，重新绘制图标

---

## 未包含的内容 / What is NOT included

本仓库**刻意不包含**以下内容，它们属于第三方或原作者：

| 内容 | 原因 |
|---|---|
| **Live2D 模型文件**（`.moc3` / `.physics3.json` / 纹理） | 版权属于模型原作者，**请自行准备** |
| **Live2D Cubism SDK** | 遵循 Live2D 公司自己的许可 |
| **API 凭据**（`*.key`） | 个人凭据，且原项目采用试用绑定 |
| **配音缓存**（`speech-cache/`，约 87 MB） | 云端合成产物，可自行重新生成 |
| **个人数据**（`windows/.local/`） | 含关系状态与运行日志 |

**使用本仓库需要你自己准备：**
1. 一个 Live2D 模型（Cubism 3/4/5 格式）
2. 语音合成服务的 API Key

---

## 许可与使用限制 / License and restrictions

本仓库沿用原版的 **AAAAGENT 非商业使用及署名许可 1.0**，见 [LICENSE](LICENSE)。

**要点：**

- ✅ **允许**非商业目的的查看、运行、复制、研究、**修改、引用与再分发**
- ❌ **禁止任何形式的商业使用**（出售、付费托管、订阅、集成进商业产品、商业推广、
  企业内部业务使用等）
- "免费提供、改名、二次打包或修改代码"**都不会免除**这条限制
- ✅ **必须署名**：标明 **AAAAGENT**、保留原作者与贡献者署名、提供
  https://github.com/phoiex/AAAAGENT
- ✅ **必须说明已作修改**
- ❌ **不得暗示原作者为你的修改背书**
- ⚠️ 这不是 MIT / Apache / OSI 认可的开源许可，而是**非商业源码可见许可**

**重要：** 本仓库的维护者与 AAAAGENT 原作者**没有隶属关系**，
原作者**未对本仓库的任何修改表示认可或背书**。

**Important:** the maintainer of this repository is **not affiliated with** the
AAAAGENT authors, and the original authors have **not endorsed** any of the
modifications here.

---

## 致谢 / Credits

- **AAAAGENT** — phoiex 及贡献者 · https://github.com/phoiex/AAAAGENT
- **Live2D Cubism SDK for Web** — Live2D Inc.
- **Electron** — OpenJS Foundation
- 语音合成 — 阿里云通义千问

---

## 如果原作者有异议 / If the original author objects

如果你是这个项目的原作者，且不希望本仓库存在，请开 issue 或联系维护者，
我们会**立即下架**。
