import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { validateCatalog } from "../extensions/coach/catalog.ts";

const ROOT = import.meta.dirname ?? ".";
const templates = join(ROOT, "..", "templates");
const fixtures = join(ROOT, "fixtures");
const coverageDir = join(fixtures, "coverage");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

// 预期教材清单：每科、每学段的册数（与 scratch 素材清单一致）
const EXPECTED_BOOKS: Record<string, Record<string, number>> = {
  语文: { 高中: 5 },
  数学: { 高中: 5, 初中: 6 },
  英语: { 高中: 7, 初中: 5 },
  物理: { 高中: 6, 初中: 3 },
  化学: { 高中: 5, 初中: 2 },
  生物: { 高中: 5, 初中: 4 },
  历史: { 高中: 5 },
  政治: { 高中: 7 },
  地理: { 高中: 5 },
};

const ALLOWED_EXEMPT_PREFIXES = ["栏目：", "范围：", "选学：", "缺口：", "课文篇目，"];

test("覆盖矩阵：文件与结构合法", () => {
  const files = readdirSync(coverageDir).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, Object.keys(EXPECTED_BOOKS).length, "科目矩阵文件数");
  for (const f of files) {
    const mat = readJson(join(coverageDir, f)) as {
      subject: string;
      books: { title: string; level?: string; rows: { section: string; nodes?: string[]; exempt?: string }[] }[];
    };
    assert.equal(typeof mat.subject, "string");
    assert.ok(Array.isArray(mat.books) && mat.books.length > 0, `${f} 缺 books`);
    for (const b of mat.books) {
      assert.ok(b.title, `${f} 缺书名`);
      assert.ok(Array.isArray(b.rows) && b.rows.length > 0, `${f} 空册 ${b.title}`);
      for (const r of b.rows) {
        assert.ok(r.section, `${f} ${b.title} 行缺 section`);
        const hasNodes = Array.isArray(r.nodes) && r.nodes.length > 0;
        const hasExempt = typeof r.exempt === "string" && r.exempt.length > 0;
        assert.ok(hasNodes !== hasExempt, `${f} ${b.title} ${r.section} 必须且只能有 nodes 或 exempt 之一`);
        if (hasExempt) {
          assert.ok(
            ALLOWED_EXEMPT_PREFIXES.some((p) => r.exempt?.startsWith(p)),
            `${f} ${b.title} ${r.section} 豁免理由非法：${r.exempt}`,
          );
        }
      }
    }
  }
});

test("覆盖矩阵：教材清单与预期一致", () => {
  const files = readdirSync(coverageDir).filter((f) => f.endsWith(".json"));
  const seen = new Set<string>();
  for (const f of files) {
    const mat = readJson(join(coverageDir, f)) as { subject: string; books: { title: string; level?: string }[] };
    const expect = EXPECTED_BOOKS[mat.subject];
    assert.ok(expect, `未知科目 ${mat.subject}`);
    const byLevel: Record<string, number> = {};
    for (const b of mat.books) {
      const level = b.level ?? (b.title.includes("初中") ? "初中" : "高中");
      byLevel[level] = (byLevel[level] ?? 0) + 1;
      assert.ok(!seen.has(b.title), `书名重复：${b.title}`);
      seen.add(b.title);
    }
    for (const [level, count] of Object.entries(expect)) {
      assert.equal(byLevel[level], count, `${mat.subject} ${level} 册数应为 ${count}`);
    }
  }
});

test("覆盖矩阵：节点引用全部存在于目录，且高中册无缺口行", () => {
  const catalog = validateCatalog(readJson(join(templates, "知识节点.json")));
  const byId = new Map(catalog.nodes.map((n) => [n.id, n]));
  const files = readdirSync(coverageDir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const mat = readJson(join(coverageDir, f)) as { subject: string; books: { title: string; level?: string; rows: { section: string; nodes?: string[]; exempt?: string }[] }[] };
    for (const b of mat.books) {
      const isJh = b.level === "初中" || b.title.includes("初中");
      for (const r of b.rows) {
        for (const nid of r.nodes ?? []) {
          assert.ok(byId.has(nid), `${f} ${b.title} 引用了不存在的节点 ${nid}`);
        }
        if (!isJh && r.exempt?.startsWith("缺口：")) {
          assert.fail(`${f} ${b.title} 高中册仍有缺口行：${r.section} ${r.exempt}`);
        }
      }
    }
  }
});

test("覆盖矩阵：目录节点全部被引用或登记豁免", () => {
  const catalog = validateCatalog(readJson(join(templates, "知识节点.json")));
  const extra = readJson(join(fixtures, "coverage-extra-nodes.json")) as Record<string, string>;
  const referenced = new Set<string>();
  const files = readdirSync(coverageDir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const mat = readJson(join(coverageDir, f)) as { books: { rows: { nodes?: string[] }[] }[] };
    for (const b of mat.books) for (const r of b.rows) for (const nid of r.nodes ?? []) referenced.add(nid);
  }
  for (const node of catalog.nodes) {
    if (referenced.has(node.id) || extra[node.id]) continue;
    assert.fail(`目录节点未被任何矩阵行引用也未登记豁免：${node.id}`);
  }
  // 豁免清单不得引用不存在的节点
  for (const nid of Object.keys(extra)) {
    assert.ok(catalog.nodes.some((n) => n.id === nid), `coverage-extra-nodes.json 引用了不存在的节点 ${nid}`);
  }
});

test("覆盖矩阵：初中英语九年级全一册必须覆盖全部 14 个单元", () => {
  const mat = readJson(join(coverageDir, "矩阵-英语.json")) as {
    books: { title: string; rows: { section: string }[] }[];
  };
  const book = mat.books.find((b) => b.title.includes("九年级全一册"));
  assert.ok(book, "矩阵缺少 九年级全一册");
  const units = book.rows.map((r) => r.section).filter((s) => /^Unit \d+/.test(s));
  assert.equal(units.length, 14, `九年级全一册应覆盖 14 个单元，当前 ${units.length}：${units.join(", ")}`);
});