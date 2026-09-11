# gaokao-coach-package

广东高考学习教员教学系统分发包。核心原则：**程序与规则入库（跨机器唯一事实），数据与部署留在学员工作目录**。本仓库不含任何学员数据，可公开。

## 安装

在学员工作目录（pi 项目根）的 `.pi/settings.json` 中写入：

```json
{
  "packages": ["git:git@github.com:Soulshop/gaokao-coach-package"]
}
```

首次在项目里启动 pi 并信任项目后，pi 会自动 clone 并加载本包的扩展、技能与提示。之后运行 `pi update --extensions` 跟随默认分支在线更新；需要锁定版本时改用 `git:git@github.com:Soulshop/gaokao-coach-package@v1.0.0`。

## 初始化学员工作目录

分发包本身不含学员数据。初始化时把模板种子复制到工作目录：

```bash
bash scripts/setup.sh /path/to/学员工作目录
```

脚本只创建缺失文件，绝不覆盖已存在的演化数据（知识节点、计划、状态）。

随后在工作目录内启动 pi，输入 `/coach` 完成初始化引导，生成首个两周计划。

## 数据结构

| 目录 | 内容 | 生命周期 |
| --- | --- | --- |
| `extensions/coach/` | 教学扩展（13 个工具、状态机、SM-2、评分审计） | 随包版本 |
| `extensions/reminder/` | 提醒控制扩展（reminder_get/set/test，渲染 plist + launchctl bootstrap） | 随包版本 |
| `skills/` | `coach` 主规则 + `exam-orientation` 高考全貌 + `reminder` 提醒控制 | 随包版本 |
| `prompts/` | `/coach` 开场流程 | 随包版本 |
| `macos/` | 提醒工具链（remind.sh + notifier） | 随包版本，部署到工作目录 `.pi/macos/` |
| `templates/` | 标准版种子（知识节点、地图、APPEND_SYSTEM 仅教学规则、settings、gitignore、计划） | 随包版本，仅首次复制 |
| `templates/agents/` | 子代理定义（grading-auditor 评分复评员） | 随包版本，部署到 `.pi/agents/`，随包覆盖 |
| `AGENTS.md` | 开发规则（唯一参考事实、先图后实现） | 随包版本，仅开发加载，不进学员会话 |
| `scripts/setup.sh` | 安装引导 | 随包版本 |
| `docs/architecture.md` | 两张架构图（教学法、系统），唯一参考事实 | 随包版本 |

## 外部依赖注入

本包经 `dependencies` 引入 `@mjakl/pi-subagent`（子代理框架），由 pi 安装本包时自动 `npm install`（适用于 git 与 npm 源），并在 `pi.extensions` 里以 `node_modules/` 路径注册其入口。消费端因此获得 `subagent` 工具与 `.pi/agents/` 项目代理发现机制，执教规则用它做评分盲评复评。

注意：

1. 消费端不得再自行安装 pi-subagent（全局或项目），同名 tool/flag 冲突会导致 pi 启动报错。
2. 开发机若已全局安装 pi-subagent，在本机 `pi config` 或 settings 里对两边任选其一禁用，再在学员工作目录调试。
3. 复评员与执教师继承同一模型（学员端不另配模型）。复评过滤判定的随机抖动；一致性统计是监测信号，不构成效度证明。

## 数据/程序分离规则

1. 包内无 `profile.json`、无运行时知识节点实例、无学习计划内容。
2. 数据单向流动：包 → 工作目录。工作目录的演化数据绝不回写包。
3. `catalog.ts` 永远读取工作目录的 `学习资料/知识节点.json`（演化版），可用环境变量 `GAOKAO_COACH_KNOWLEDGE_CATALOG` 覆盖。
4. `scripts/setup.sh` 分三层：
   - 数据/演化件（知识节点、地图、学习计划、gitignore）：首次复制，绝不覆盖。
   - 配置件（settings.json）：首次复制；升级时手动删除后重跑可获新默认值，避免覆盖用户追加的自定义 packages。
   - 规则/工具件（APPEND_SYSTEM.md、templates/agents/、macos/）：随包更新覆盖。pi 不从包内加载 APPEND_SYSTEM，pi-subagent 只发现工作目录 `.pi/agents/` 下的项目代理；两者都必须部署到工作目录，升级后重跑 setup.sh 即同步新规则。
   - gitignore 例外：属演化件不覆盖，但 setup.sh 会追加缺失的 `.pi/state/` 忽略行（评分审计日志含学员原话，必须被忽略）。

## 开发规则归属

- `APPEND_SYSTEM.md` 只承载**教学规则**（教学角色 + 会话流程）。它被注入每次学员会话，不包含开发规则。
- **开发规则**在 `AGENTS.md`。它是仓库开发上下文，开发时由 pi 加载，学员会话不加载。
- 职责分离：触达学员的提示文件与仓库开发约定不再混放。

## 独立 Web 插件

Web 交互插件的目录骨架位于并列项目 [`~/gaokao-coach-web/`](../gaokao-coach-web/README.md)。当前没有 UI、服务或部署实现，也未加入本包的加载清单。

Web 只负责交互，教学规则与状态继续由本包管理。本包 `docs/architecture.md` 的系统架构图只保留一个 Web 外部入口。Web 内部架构独立维护在 [`gaokao-coach-web/docs/architecture.md`](../gaokao-coach-web/docs/architecture.md)。

## 开发

```bash
# 测试
node --experimental-strip-types --test test/logic.test.ts test/extension-flow.test.mjs
```

更改规则或代码时，先更新 `docs/architecture.md` 的对应架构图（教学法、系统）再改实现，二者是项目唯一参考事实。修改教学法先改图再实现；新增文件/工具/链路先改系统架构图再实现。

## 版本策略

- 主分支跟随最新：不带 `@ref` 注册，`pi update --extensions` 自动更新。
- 稳定版：打 tag（`git tag v1.0.0`），学员机改用 `@v1.0.0` 锁定。
- 锁版后升级需显式 `pi install git:...@新tag`。
