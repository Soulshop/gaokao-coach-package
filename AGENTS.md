# gaokao-coach-package · 开发规则

本文件是仓库开发上下文，在 `~/gaokao-coach-package` 内开发时由 pi 自动加载。教学会话不会加载本文件，它不进入学员系统提示。

## 仓库定位

这是广东高考学习教员的分发包。它只包含程序与规则：扩展、技能、提示、macOS 工具链、模板种子、安装脚本。它不包含任何学员数据。

- 学员数据（profile.json、知识节点演化版、学习计划）只在消费端工作目录。
- 数据单向流动：包 → 工作目录。工作目录的数据绝不回写本包。
- 消费端通过 `git:git@github.com:Soulshop/gaokao-coach-package` 安装并在线更新。

## 唯一参考事实

- 消费端工作仓库（`~/gaokao-coach`）的 `.pi/README.md`「架构总览」一节包含两张图：**教学法架构图**与**系统架构图**。它们是本项目设计的唯一参考事实。
- 开始任何改动前先读取这两张图。

## 开发顺序

1. 先更新对应图，再改实现。禁止先改实现后补图。
2. 新增文件、工具、状态字段、事件或链路 → 反映到系统架构图。
3. 修改教学策略、判定规则或掌握层级 → 反映到教学法架构图。
4. 发现图与实现不一致时，以图为准。先修正图，再继续开发。
5. 每次改动完成后，核对两张图仍然准确。

## 目录说明

| 目录 | 内容 | 生命周期 |
| --- | --- | --- |
| `extensions/coach/` | 教学扩展（10 工具、状态机、SM-2） | 随包版本提交 |
| `skills/` | `coach` 主规则 + `exam-orientation` 高考全貌引导 | 随包版本提交 |
| `prompts/` | `/coach` 开场流程 | 随包版本提交 |
| `macos/` | 提醒工具链（remind.sh + notifier），部署到 `.pi/macos/` | 随包版本提交 |
| `templates/` | 标准版种子（知识节点、地图、APPEND_SYSTEM、settings、gitignore、计划） | 随包版本提交 |
| `scripts/setup.sh` | 安装引导 | 随包版本提交 |
| `test/` | 逻辑与流程测试（fixture 读 templates/） | 随包版本提交 |

## 模板与设置要点

- `templates/gitignore` 必须忽略 `.pi/git/`（分发包自动 clone 目录），否则新消费端 git 状态会被包 clone 污染。
- `templates/APPEND_SYSTEM.md` 只放教学规则（教学角色 + 会话流程）。开发规则只在本 `AGENTS.md`。pi 不从包内加载 APPEND_SYSTEM，setup.sh 部署到 `.pi/APPEND_SYSTEM.md`。
- `templates/settings.json` 只含 packages 引用。
- setup.sh 三层语义：数据/演化件只首次复制；配置件首次复制不自动覆盖；规则/工具件（APPEND_SYSTEM、macos）随包更新覆盖。

## 测试

```bash
node --experimental-strip-types --test test/logic.test.ts test/extension-flow.test.mjs
```

改任何逻辑后必须跑测试。改目录结构（新增/删除节点）时校验 `templates/知识节点.json`（ID、前置边、无环）。

## 发布

- 随时可推 main（消费端不带 @ref 跟随更新）。
- 锁稳定版：`git tag -a vX.Y.Z -m "..."`，推送 tag。锁版消费端用 `@vX.Y.Z`，升级需显式换 ref。
- 发布前确认：测试通过、归档图准确、无学员数据入库。