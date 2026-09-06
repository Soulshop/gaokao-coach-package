import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = join(import.meta.dirname ?? ".", "..");
const SCRIPT = join(ROOT, "scripts", "migrate-catalog.mjs");
const TEMPLATE_RAW = JSON.parse(readFileSync(join(ROOT, "templates", "知识节点.json"), "utf8"));

function setupCwd(nodes: unknown[], aliases: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gaokao-migrate-"));
  mkdirSync(join(dir, "学习资料"), { recursive: true });
  writeFileSync(join(dir, "学习资料", "知识节点.json"), JSON.stringify({ version: 1, scope: "本地演化版", aliases, nodes }, null, 2));
  return dir;
}

function run(dir: string, dry = false, force = false) {
  const args = [SCRIPT, dir];
  if (dry) args.push("--dry-run");
  if (force) args.push("--force");
  return spawnSync("node", args, { encoding: "utf8" });
}

function readCatalog(dir: string) {
  return JSON.parse(readFileSync(join(dir, "学习资料", "知识节点.json"), "utf8"));
}

function backups(dir: string) {
  return readdirSync(join(dir, "学习资料")).filter((f) => f.includes(".bak-"));
}

test("迁移：向初始小目录追加缺失节点并保留本地节点", () => {
  const seed = structuredClone(TEMPLATE_RAW.nodes).slice(0, 2);
  const localNode = {
    id: "数学::初中数与式::本地自定义节点",
    subject: "数学",
    module: "初中数与式",
    name: "本地自定义节点",
    prerequisites: [],
    successCriteria: ["能自定义并复习该节点"],
  };
  const dir = setupCwd([...seed, localNode]);
  const res = run(dir);
  assert.equal(res.status, 0, res.stderr);
  const cat = readCatalog(dir);
  assert.equal(cat.nodes.length, TEMPLATE_RAW.nodes.length + 1, "追加模板全部节点并保留本地节点");
  const local = cat.nodes.find((n: { id: string }) => n.id === localNode.id);
  assert.deepEqual(local, localNode, "本地节点内容未被覆盖");
  assert.equal(cat.version, TEMPLATE_RAW.version, "version 提升到模板版本");
  assert.equal(backups(dir).length, 1, "写文件前创建备份");
  rmSync(dir, { recursive: true, force: true });
});

test("迁移：幂等，二次运行无改动", () => {
  const dir = setupCwd(structuredClone(TEMPLATE_RAW.nodes));
  assert.equal(run(dir).status, 0);
  const before = readCatalog(dir);
  const res2 = run(dir);
  assert.equal(res2.status, 0);
  assert.match(res2.stdout, /无改动/);
  assert.deepEqual(readCatalog(dir), before, "第二次运行不修改任何内容");
  rmSync(dir, { recursive: true, force: true });
});

test("迁移：本地演化节点与模板冲突时中止并写备份", () => {
  const evolved = structuredClone(TEMPLATE_RAW.nodes[0]);
  evolved.successCriteria.push("本地新增的通过标准");
  const dir = setupCwd([evolved]);
  const before = readCatalog(dir);
  const res = run(dir);
  assert.equal(res.status, 1, "冲突返回非零");
  assert.match(res.stdout + res.stderr, /冲突/);
  assert.deepEqual(readCatalog(dir), before, "冲突时不改文件");
  assert.equal(backups(dir).length, 1, "冲突也写备份");
  rmSync(dir, { recursive: true, force: true });
});

test("迁移：模板别名把旧 ID 节点改名并登记引用", () => {
  const oldId = "历史::中国史::古代史阶段联系";
  const tAlias = TEMPLATE_RAW.aliases ?? {};
  assert.ok(tAlias[oldId], "模板应登记该别名");
  const newId = tAlias[oldId];
  const tgt = TEMPLATE_RAW.nodes.find((n: { id: string }) => n.id === newId);
  assert.ok(tgt, "模板应包含目标节点");
  // 旧版消费端：内容与模板目标一致（v1 种子节点的同构迁移），仅 ID/模块字段不同
  const oldNode = { ...structuredClone(tgt), id: oldId, module: "中国史" };
  const anchor = TEMPLATE_RAW.nodes.find((n: { id: string }) => n.id === "历史::方法::时空定位");
  assert.ok(anchor, "模板应含 历史::方法::时空定位");
  const dir = setupCwd([oldNode, structuredClone(anchor)]);
  const res = run(dir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const cat = readCatalog(dir);
  assert.ok(cat.nodes.some((n: { id: string }) => n.id === newId), "旧 ID 节点已迁移到目标 ID");
  assert.ok(!cat.nodes.some((n: { id: string }) => n.id === oldId), "旧 ID 不再作为正式节点存在");
  assert.equal(cat.aliases[oldId], newId, "登记 alias 使旧引用可解析");
  rmSync(dir, { recursive: true, force: true });
});

test("迁移：dry-run 不修改任何文件", () => {
  const dir = setupCwd(structuredClone(TEMPLATE_RAW.nodes).slice(0, 3));
  const before = readCatalog(dir);
  const res = run(dir, true);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /dry-run/);
  assert.deepEqual(readCatalog(dir), before, "dry-run 不改文件");
  assert.equal(backups(dir).length, 0, "dry-run 不写备份");
  rmSync(dir, { recursive: true, force: true });
});

test("迁移：dry-run 遇冲突也不写备份", () => {
  const evolved = structuredClone(TEMPLATE_RAW.nodes[0]);
  evolved.successCriteria.push("本地新增");
  const dir = setupCwd([evolved]);
  const before = readCatalog(dir);
  const res = run(dir, true);
  assert.equal(res.status, 1, "dry-run 冲突返回非零");
  assert.deepEqual(readCatalog(dir), before, "dry-run 冲突不改文件");
  assert.equal(backups(dir).length, 0, "dry-run 冲突不写备份");
  rmSync(dir, { recursive: true, force: true });
});

test("迁移：--force 以模板覆盖同 ID 节点", () => {
  const evolved = structuredClone(TEMPLATE_RAW.nodes[0]);
  evolved.successCriteria.push("本地新增的通过标准");
  const dir = setupCwd([evolved]);
  const res = run(dir, false, true);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const cat = readCatalog(dir);
  const t0 = TEMPLATE_RAW.nodes.find((n: { id: string }) => n.id === evolved.id);
  assert.deepEqual(
    cat.nodes.find((n: { id: string }) => n.id === evolved.id),
    t0,
    "--force 后同 ID 节点以模板内容为准",
  );
  assert.equal(backups(dir).length, 1, "--force 也写备份");
  rmSync(dir, { recursive: true, force: true });
});

test("迁移：消费端自带的悬空别名被拒绝而不是静默清除", () => {
  const dir = setupCwd(structuredClone(TEMPLATE_RAW.nodes).slice(0, 1), { "本地::旧名": "本地::不存在的目标" });
  const before = readCatalog(dir);
  const res = run(dir);
  assert.equal(res.status, 1, "悬空别名触发非零退出");
  assert.match(res.stdout + res.stderr, /别名目标不存在|consumer-alias/, "拒绝原因应明确");
  assert.deepEqual(readCatalog(dir), before, "悬空别名时不改文件");
  assert.equal(backups(dir).length, 0, "加载校验拒绝时不写备份");
  rmSync(dir, { recursive: true, force: true });
});

test("迁移：successCriteria 含非字符串元素被加载校验拒绝", () => {
  const bad = structuredClone(TEMPLATE_RAW.nodes[0]);
  bad.successCriteria.push(1 as never);
  const dir = setupCwd([bad]);
  const before = readCatalog(dir);
  const res = run(dir);
  assert.equal(res.status, 1, "非法 successCriteria 触发非零退出");
  assert.match(res.stdout + res.stderr, /successCriteria 必须是非空字符串数组/);
  assert.deepEqual(readCatalog(dir), before, "不改文件");
  assert.equal(backups(dir).length, 0, "不写备份");
  rmSync(dir, { recursive: true, force: true });
});

test("迁移：空别名键与空目标被加载校验拒绝", () => {
  const ok = structuredClone(TEMPLATE_RAW.nodes[0]);
  const dirA = setupCwd([ok], { "": "数学::初高衔接::有理数运算" });
  const resA = run(dirA);
  assert.equal(resA.status, 1, "空别名键被拒绝");
  assert.match(resA.stdout + resA.stderr, /别名校必须是非空字符串/);
  assert.equal(backups(dirA).length, 0, "不写备份");
  rmSync(dirA, { recursive: true, force: true });
  const dirB = setupCwd([ok], { "本地::旧名": "" });
  const resB = run(dirB);
  assert.equal(resB.status, 1, "空别名目标被拒绝");
  assert.match(resB.stdout + resB.stderr, /别名目标必须是非空字符串/);
  rmSync(dirB, { recursive: true, force: true });
});

test("迁移：本地别名指向被改名移除的旧 ID 时重定向而不是删除", () => {
  const oldId = "历史::中国史::古代史阶段联系";
  const newId = (TEMPLATE_RAW.aliases ?? {})[oldId];
  assert.ok(newId, "模板应含该别名");
  const tgt = TEMPLATE_RAW.nodes.find((n: { id: string }) => n.id === newId);
  const anchor = TEMPLATE_RAW.nodes.find((n: { id: string }) => n.id === "历史::方法::时空定位");
  const oldNode = { ...structuredClone(tgt), id: oldId, module: "中国史" };
  const dir = setupCwd([oldNode, structuredClone(anchor)], { "本地::快捷方式": oldId });
  const res = run(dir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const cat = readCatalog(dir);
  assert.equal(cat.aliases["本地::快捷方式"], newId, "本地别名被重定向到新 ID，而不是被删除");
  rmSync(dir, { recursive: true, force: true });
});

test("迁移：--force 覆盖同 ID 且保留模板外本地专有节点", () => {
  const evolved = structuredClone(TEMPLATE_RAW.nodes[0]);
  evolved.successCriteria.push("本地新增的通过标准");
  const localExtra = {
    id: "语文::整本书阅读::本地专有节点",
    subject: "语文",
    module: "整本书阅读",
    name: "本地专有节点",
    prerequisites: [],
    successCriteria: ["能本地记录并复习","能保持本地演化"],
  };
  const dir = setupCwd([evolved, localExtra]);
  const res = run(dir, false, true);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const cat = readCatalog(dir);
  const t0 = TEMPLATE_RAW.nodes.find((n: { id: string }) => n.id === evolved.id);
  assert.deepEqual(
    cat.nodes.find((n: { id: string }) => n.id === evolved.id),
    t0,
    "--force 后同 ID 节点以模板内容为准",
  );
  assert.ok(cat.nodes.some((n: { id: string }) => n.id === localExtra.id), "模板外本地专有节点保留");
  assert.equal(backups(dir).length, 1, "--force 也写备份");
  rmSync(dir, { recursive: true, force: true });
});