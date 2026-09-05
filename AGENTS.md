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
| `extensions/coach/` | 教学扩展（12 工具、状态机、SM-2、评分审计） | 随包版本提交 |
| `extensions/reminder/` | 提醒控制扩展（reminder_get/set/test，渲染 plist + launchctl bootstrap） | 随包版本提交 |
| `templates/agents/` | 子代理定义（grading-auditor 评分复评员） | 随包版本提交 |
| `skills/` | `coach` 主规则 + `exam-orientation` 高考全貌 + `reminder` 提醒控制 | 随包版本提交 |
| `prompts/` | `/coach` 开场流程 | 随包版本提交 |
| `macos/` | 提醒工具链（remind.sh + notifier），部署到 `.pi/macos/` | 随包版本提交 |
| `templates/` | 标准版种子（知识节点、地图、APPEND_SYSTEM、settings、gitignore、计划） | 随包版本提交 |
| `scripts/setup.sh` | 安装引导 | 随包版本提交 |
| `test/` | 逻辑与流程测试（fixture 读 templates/） | 随包版本提交 |

## 外部依赖注入

外部依赖可以注入消费端 pi agent，机制已验证（pi 文档 packages.md）：pi 安装 git/npm 包后自动执行 `npm install`，`pi` manifest 可用 `node_modules/` 相对路径注册依赖包的扩展入口。规则：

1. 第三方运行时依赖放 `dependencies`。其他 pi 包（扩展/技能）同时列入 `bundledDependencies`，并在 `pi.extensions` 等 manifest 字段里用 `node_modules/<pkg>/...` 路径引用其资源。
2. pi 核心包（`@earendil-works/*`、`typebox`）只能在 `peerDependencies`，且必须在 `peerDependenciesMeta` 标 `optional: true`。否则 npm 会把整套核心装进每个消费端 clone。
3. 注入的扩展与消费端已全局安装的同名扩展共存会报 tool/flag 冲突，pi 启动失败。本包注入 `@mjakl/pi-subagent`：消费端不得再自行安装；开发机全局已装的，用 `pi config` 在本机禁用其一。
4. 子代理的 agent 定义不随包加载：pi-subagent 只发现 `~/.pi/agent/agents/` 与工作目录 `.pi/agents/`（项目代理需项目已信任）。包内代理定义放 `templates/agents/`，由 setup.sh 按规则件覆盖部署。
5. 复评员不指定 `model`，继承执教主模型（学员端不另配模型）。引入新依赖时必须先确认它在学员默认 registry（npmmirror）可达，再提交。

## 模板与设置要点

- `templates/gitignore` 必须忽略 `.pi/git/`（分发包自动 clone 目录），否则新消费端 git 状态会被包 clone 污染。
- `templates/APPEND_SYSTEM.md` 只放教学规则（教学角色 + 会话流程）。开发规则只在本 `AGENTS.md`。pi 不从包内加载 APPEND_SYSTEM，setup.sh 部署到 `.pi/APPEND_SYSTEM.md`。
- `templates/settings.json` 只含 packages 引用。
- setup.sh 三层语义：数据/演化件只首次复制；配置件首次复制不自动覆盖；规则/工具件（APPEND_SYSTEM、templates/agents、macos）随包更新覆盖。gitignore 属演化件不覆盖，但对必须由包保证的忽略行（如 `.pi/state/`），setup.sh 只做缺失追加，不改动已有行。

## 测试

```bash
node --experimental-strip-types --test test/logic.test.ts test/extension-flow.test.mjs test/reminder.test.ts
```

改任何逻辑后必须跑测试。改目录结构（新增/删除节点）时校验 `templates/知识节点.json`（ID、前置边、无环）。

## 提交规范

本仓库遵循 Conventional Commits 风格，与 `~/singbox-files` 一致：

```
类型(作用域): 中文主题
```

- 类型用英文前缀：`feat`、`fix`、`docs`、`refactor`、`chore`、`config`、`cleanup`、`dev`、`revert`。
- 跨模块或大改动加括号作用域，例如 `fix(coach):`、`refactor(setup):`、`docs(templates):`。简单改动可无作用域。
- 主题单行，信息密度高，包含具体细节（文件名、节点数、路径、行为变化）。不以句号结尾。
- 复杂改动用 `- ` 清单列正文，每条一行；简单改动无正文。
- 遵循 atomic commit：一个提交只包含一个可独立还原的行为及其直接配套。

示例：

```
feat: 新增 exam-orientation 高考全貌引导技能（三问三讲一复述）
fix(scheduler): 日期计算改 UTC，去除午夜临近的到期漂移
refactor(catalog): 知识目录路径改可配置，默认读工作目录演化版
```

## 发布

- 随时可推 main（消费端不带 @ref 跟随更新）。
- 锁稳定版：`git tag -a vX.Y.Z -m "..."`，推送 tag。锁版消费端用 `@vX.Y.Z`，升级需显式换 ref。
- 发布前确认：测试通过、归档图准确、无学员数据入库。