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
| `extensions/coach/` | 教学扩展（10 个工具、状态机、SM-2） | 随包版本 |
| `skills/` | `coach` 主规则 + `exam-orientation` 高考全貌引导 | 随包版本 |
| `prompts/` | `/coach` 开场流程 | 随包版本 |
| `macos/` | 提醒工具链（remind.sh + notifier） | 随包版本，部署到工作目录 `.pi/macos/` |
| `templates/` | 标准版种子（知识节点、地图、APPEND_SYSTEM 等） | 随包版本，仅首次复制 |
| `scripts/setup.sh` | 安装引导 | 随包版本 |

## 数据/程序分离规则

1. 包内无 `profile.json`、无运行时知识节点实例、无学习计划内容。
2. 数据单向流动：包 → 工作目录。工作目录的演化数据绝不回写包。
3. `catalog.ts` 永远读取工作目录的 `学习资料/知识节点.json`（演化版），可用环境变量 `GAOKAO_COACH_KNOWLEDGE_CATALOG` 覆盖。
4. `scripts/setup.sh` 分三层：
   - 数据/演化件（知识节点、地图、学习计划、gitignore）：首次复制，绝不覆盖。
   - 配置件（settings.json）：首次复制；升级时手动删除后重跑可获新默认值，避免覆盖用户追加的自定义 packages。
   - 规则/工具件（APPEND_SYSTEM.md、macos/）：随包更新覆盖。pi 不从包内加载 APPEND_SYSTEM，必须部署到 `.pi/APPEND_SYSTEM.md`，升级后重跑 setup.sh 即同步新规则。

## 开发

```bash
# 测试
node --experimental-strip-types --test test/logic.test.ts test/extension-flow.test.mjs
```

更改规则或代码时，同步更新工作仓库 `.pi/README.md` 的两张架构图（教学法架构、系统架构），二者是项目唯一参考事实。修改教学法先改图再实现；新增文件/工具/链路先改系统架构图再实现。

## 版本策略

- 主分支跟随最新：不带 `@ref` 注册，`pi update --extensions` 自动更新。
- 稳定版：打 tag（`git tag v1.0.0`），学员机改用 `@v1.0.0` 锁定。
- 锁版后升级需显式 `pi install git:...@新tag`。