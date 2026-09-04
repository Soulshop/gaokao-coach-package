# coach 扩展

教学规则在 `skills/coach/SKILL.md`。本扩展只负责状态保存、计划、知识证据与间隔复习的强制执行。

数据结构、10 个工具与关键不变量见包根 `README.md`。状态模型见 `state.ts`。

## 数据/程序分离

- 本扩展是程序，随包版本更新。
- 学员数据在消费端工作目录演化，绝不写回本包。
- `catalog.ts` 永远读取消费端工作目录 `学习资料/知识节点.json`（演化版）；可用环境变量 `GAOKAO_COACH_KNOWLEDGE_CATALOG` 覆盖。

## 测试

```bash
node --experimental-strip-types --test test/logic.test.ts test/extension-flow.test.mjs
```

测试覆盖回合计数、情绪优先、讲解组 A、五步验证、前置恢复、计划与三次间隔掌握。