#!/usr/bin/env node
// 知识目录追加式迁移工具。
//
// 用法:
//   node scripts/migrate-catalog.mjs <消费端工作目录> [--dry-run]
//
// 语义（幂等、追加为主、冲突即失败）:
//   1. 模板目录中没有而消费端已有的节点: 保留消费端内容, 不覆盖。
//   2. 模板目录中有而消费端没有的节点: 追加模板内容。
//   3. 两边都存在但内容不同的节点: 冲突, aborted 并写备份, 不改文件。
//   4. 模板 aliases 指向的旧 ID 若在消费端以正式节点存在: 改名到目标 ID
//      （保留内容）, 使旧引用走 canonicalKnowledgeId。
//   5. 写文件前先生成 <知识节点.json>.bak-<时间戳> 备份；原子写（tmp+rename）。
//   6. 幂等: 已迁移过的目录再次运行不产生任何修改。

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(here, "..", "templates", "知识节点.json");

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// 轻量结构校验：ID 唯一、三段一致、前置闭合、无环。
function validate(catalog, origin) {
  if (typeof catalog !== "object" || catalog === null || Array.isArray(catalog)) {
    throw new Error(`${origin}: 目录必须是 JSON 对象`);
  }
  if (!Number.isInteger(catalog.version) || catalog.version < 1) throw new Error(`${origin}: 缺少有效 version`);
  if (typeof catalog.scope !== "string" || !catalog.scope.trim()) throw new Error(`${origin}: 缺少 scope`);
  if (!Array.isArray(catalog.nodes) || catalog.nodes.length === 0) throw new Error(`${origin}: nodes 为空`);
  const ids = new Set();
  for (const n of catalog.nodes) {
    if (typeof n?.id !== "string" || typeof n?.subject !== "string" || typeof n?.module !== "string" || typeof n?.name !== "string") {
      throw new Error(`${origin}: 节点字段不完整 ${n?.id ?? "?"}`);
    }
    const expect = `${n.subject}::${n.module}::${n.name}`;
    if (n.id !== expect) throw new Error(`${origin}: ID 与字段不一致 ${n.id} != ${expect}`);
    if (ids.has(n.id)) throw new Error(`${origin}: 节点 ID 重复 ${n.id}`);
    ids.add(n.id);
    if (!Array.isArray(n.prerequisites)) throw new Error(`${origin}: ${n.id} prerequisites 必须是数组`);
    if (!Array.isArray(n.successCriteria) || n.successCriteria.length === 0) throw new Error(`${origin}: ${n.id} successCriteria 必须非空`);
    for (const p of n.prerequisites) {
      if (!ids.has(p) && !catalog.nodes.some((x) => x.id === p)) throw new Error(`${origin}: ${n.id} 前置引用不存在 ${p}`);
    }
  }
  // 环检测
  const color = new Map();
  const stack = [];
  const cycle = [];
  const byId = new Map(catalog.nodes.map((n) => [n.id, n]));
  function dfs(u) {
    color.set(u, 1);
    stack.push(u);
    for (const v of byId.get(u)?.prerequisites ?? []) {
      if (color.get(v) === 1) cycle.push([...stack.slice(stack.indexOf(v)), v]);
      else if (!color.has(v)) dfs(v);
    }
    stack.pop();
    color.set(u, 2);
  }
  for (const n of catalog.nodes) if (!color.has(n.id)) dfs(n.id);
  if (cycle.length) throw new Error(`${origin}: 存在循环依赖 ${cycle[0].join(" -> ")}`);
  return catalog;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function plan(target, template) {
  const tById = new Map(template.nodes.map((n) => [n.id, n]));
  const cById = new Map(target.nodes.map((n) => [n.id, n]));
  const additions = [];
  const conflicts = [];
  for (const t of template.nodes) {
    if (!cById.has(t.id)) additions.push(t);
    else if (!deepEqual(cById.get(t.id), t)) conflicts.push(t.id);
  }
  // aliases 处理: 旧 ID 节点在消费端存在时, 若内容与模板目标一致则迁移(删旧留新),
  // 不一致则记为冲突。模板目标节点本身必在 additions 中被追加。
  const renames = [];
  const aliasAdds = [];
  const norm = (n, newId) => ({ ...n, id: newId, module: newId.split("::")[1] });
  for (const [oldId, newId] of Object.entries(template.aliases ?? {})) {
    const tgt = tById.get(newId);
    if (!tgt) throw new Error(`模板 aliases 目标不存在: ${oldId} -> ${newId}`);
    if (cById.has(oldId)) {
      const oldNode = cById.get(oldId);
      if (!cById.has(newId)) {
        if (deepEqual(norm(oldNode, newId), norm(tgt, newId))) renames.push({ oldId, newId });
        else conflicts.push(`alias:${oldId}`);
      } else {
        if (deepEqual(norm(oldNode, newId), cById.get(newId))) renames.push({ oldId, newId });
        else conflicts.push(`alias:${oldId}`);
      }
    }
    if (oldId in (target.aliases ?? {})) continue;
    aliasAdds.push([oldId, newId]);
  }
  return { additions, conflicts, renames, aliasAdds, tById };
}

function apply(target, template, p) {
  for (const n of p.additions) target.nodes.push(structuredClone(n));
  for (const r of p.renames) {
    const idx = target.nodes.findIndex((n) => n.id === r.oldId);
    if (idx >= 0) target.nodes.splice(idx, 1); // 旧节点删除, 以模板目标副本为准
    target.aliases = { ...(target.aliases ?? {}), [r.oldId]: r.newId };
  }
  for (const [oldId, newId] of p.aliasAdds) target.aliases = { ...(target.aliases ?? {}), [oldId]: newId };
  for (const n of target.nodes) {
    n.prerequisites = n.prerequisites.map((pr) => p.tById.get(pr) ? pr : (template.aliases[pr] ?? pr));
  }
  target.version = Math.max(target.version ?? 1, template.version);
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const cwdArg = dryRun ? args.find((a) => a !== "--dry-run") : args[0];
  if (!cwdArg) {
    console.error("用法: node scripts/migrate-catalog.mjs <消费端目录> [--dry-run]");
    process.exit(2);
  }
  const cwd = resolve(cwdArg);
  const targetPath = join(cwd, "学习资料", "知识节点.json");
  if (!existsSync(targetPath)) {
    console.error(`未找到消费端目录文件: ${targetPath}。请先运行 setup.sh 或确认目录路径。`);
    process.exit(2);
  }
  const template = validate(readJson(TEMPLATE), "模板");
  const target = validate(readJson(targetPath), "消费端");
  const p = plan(target, template);
  if (p.conflicts.length) {
    for (const id of p.conflicts) console.error(`冲突: ${id} 在模板与消费端内容不一致`);
    const backup = `${targetPath}.bak-${nowStamp()}`;
    writeFileSync(backup, JSON.stringify(target, null, 2));
    console.error(`已写备份: ${backup}`);
    console.error("迁移中止，未修改目录。请人工决定消费端演化内容如何处理。");
    process.exit(1);
  }
  if (p.additions.length === 0 && p.renames.length === 0 && p.aliasAdds.length === 0) {
    console.log("目录已是最新，无改动。");
    process.exit(0);
  }
  if (dryRun) {
    console.log(`dry-run: 将追加 ${p.additions.length} 节点, 迁移别名 ${p.renames.length} 个, 补别名 ${p.aliasAdds.length} 条`);
    for (const r of p.renames) console.log(`  rename ${r.oldId} -> ${r.newId}`);
    return;
  }
  const backup = `${targetPath}.bak-${nowStamp()}`;
  writeFileSync(backup, JSON.stringify(target, null, 2));
  apply(target, template, p);
  // 原子写
  const tmp = `${targetPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(target, null, 2) + "\n");
  renameSync(tmp, targetPath);
  validate(readJson(targetPath), "写入后");
  console.log(`完成: 追加 ${p.additions.length} 节点, 别名迁移 ${p.renames.length} 个, 补别名 ${p.aliasAdds.length} 条`);
  console.log(`备份: ${backup}`);
}

main();