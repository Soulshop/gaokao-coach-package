import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface KnowledgeDefinition {
  id: string;
  subject: string;
  module: string;
  name: string;
  prerequisites: string[];
  successCriteria: string[];
}

export interface KnowledgeCatalog {
  version: number;
  scope: string;
  aliases: Record<string, string>;
  nodes: KnowledgeDefinition[];
}

export function catalogPath(cwd: string): string {
  // 可配置覆盖：测试与特殊布局可用绝对路径指定目录
  const override = process.env.GAOKAO_COACH_KNOWLEDGE_CATALOG;
  if (override?.trim()) return override.trim();
  return join(cwd, "学习资料", "知识节点.json");
}

function assertStringArray(value: unknown, field: string, id: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`知识节点 ${id} 的 ${field} 必须是非空字符串数组`);
  }
}

export function validateCatalog(value: unknown): KnowledgeCatalog {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("知识节点目录必须是 JSON 对象");
  }

  const raw = value as Record<string, unknown>;
  if (!Number.isInteger(raw.version) || Number(raw.version) < 1) {
    throw new Error("知识节点目录缺少有效 version");
  }
  if (typeof raw.scope !== "string" || !raw.scope.trim()) {
    throw new Error("知识节点目录缺少 scope");
  }
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new Error("知识节点目录必须包含 nodes");
  }

  const nodes: KnowledgeDefinition[] = [];
  const ids = new Set<string>();
  for (const item of raw.nodes) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("知识节点必须是 JSON 对象");
    }
    const node = item as Record<string, unknown>;
    for (const field of ["id", "subject", "module", "name"] as const) {
      if (typeof node[field] !== "string" || !node[field].trim()) {
        throw new Error(`知识节点缺少 ${field}`);
      }
    }

    const id = node.id as string;
    const expectedId = `${node.subject}::${node.module}::${node.name}`;
    if (id !== expectedId) {
      throw new Error(`知识节点 ID 与字段不一致：${id}，应为 ${expectedId}`);
    }
    if (ids.has(id)) throw new Error(`知识节点 ID 重复：${id}`);
    ids.add(id);

    if (!Array.isArray(node.prerequisites) || node.prerequisites.some((item) => typeof item !== "string")) {
      throw new Error(`知识节点 ${id} 的 prerequisites 必须是字符串数组`);
    }
    assertStringArray(node.successCriteria, "successCriteria", id);

    nodes.push({
      id,
      subject: node.subject as string,
      module: node.module as string,
      name: node.name as string,
      prerequisites: node.prerequisites as string[],
      successCriteria: node.successCriteria,
    });
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const aliases: Record<string, string> = {};
  if (raw.aliases !== undefined) {
    if (typeof raw.aliases !== "object" || raw.aliases === null || Array.isArray(raw.aliases)) {
      throw new Error("知识节点目录的 aliases 必须是 JSON 对象");
    }
    for (const [oldId, target] of Object.entries(raw.aliases as Record<string, unknown>)) {
      if (!oldId.trim() || typeof target !== "string" || !target.trim()) {
        throw new Error("知识节点别名必须使用非空字符串");
      }
      if (byId.has(oldId)) throw new Error(`知识节点别名与正式 ID 冲突：${oldId}`);
      if (!byId.has(target)) throw new Error(`知识节点别名指向不存在的 ID：${oldId} -> ${target}`);
      aliases[oldId] = target;
    }
  }

  for (const node of nodes) {
    for (const prerequisite of node.prerequisites) {
      if (prerequisite === node.id) throw new Error(`知识节点不能依赖自身：${node.id}`);
      if (!byId.has(prerequisite)) {
        throw new Error(`知识节点 ${node.id} 引用了不存在的前置节点：${prerequisite}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error(`知识节点存在循环依赖：${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const prerequisite of byId.get(id)?.prerequisites ?? []) visit(prerequisite);
    visiting.delete(id);
    visited.add(id);
  }
  for (const node of nodes) visit(node.id);

  return { version: Number(raw.version), scope: raw.scope, aliases, nodes };
}

export function loadCatalog(cwd: string): KnowledgeCatalog {
  const path = catalogPath(cwd);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取知识节点目录 ${path}：${message}`);
  }
  return validateCatalog(raw);
}

export function catalogMap(catalog: KnowledgeCatalog): Map<string, KnowledgeDefinition> {
  return new Map(catalog.nodes.map((node) => [node.id, node]));
}

export function canonicalKnowledgeId(catalog: KnowledgeCatalog, id: string): string {
  return catalog.aliases[id] ?? id;
}

export function requireKnowledge(catalog: KnowledgeCatalog, id: string): KnowledgeDefinition {
  const canonicalId = canonicalKnowledgeId(catalog, id);
  const node = catalog.nodes.find((item) => item.id === canonicalId);
  if (!node) throw new Error(`未知 knowledgeId：${id}。先在 学习资料/知识节点.json 注册该教学单元。`);
  return node;
}
