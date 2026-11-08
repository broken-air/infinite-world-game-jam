#!/usr/bin/env node
/**
 * check-game.mjs —— 发布阻断扫描（Task 7）
 *
 * 递归扫描自有源码（game/index.html、game/js/**、game/css/**），报告：
 *   1. 禁用 API：alert( / confirm( / prompt(
 *   2. iframe 逃逸：window.top.location、parent.location
 *   3. 站内绝对路径资源：src="/..."、href="/..."、url(/...)
 *   4. 待替换理智遗物 ID：PENDING_UPSTREAM_SANITY_RELIC_ID（仅提醒，不阻断发布；
 *      未配置遗物即按无遗物路线验收，取得真实 ID 替换后提醒消失）
 *
 * 官方协议库 game/shared/save-protocol.js 不在扫描范围（含官方调试用的 alert，禁止修改）。
 * 本工具只扫描自有源码，不能替代官方 ZIP 检查：
 *   node participant-delivery-kit-v3.3.2/tools/check.mjs <zip> global-items.json
 *
 * 用法：node tools/check-game.mjs
 * 退出码：0 = 通过（允许存在待替换 ID 提醒）；1 = 存在阻断项。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const gameDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'game');
const officialProtocol = ['shared', 'save-protocol.js'].join(sep);

const RULES = [
  { id: 'banned-api', pattern: /\b(alert|confirm|prompt)\s*\(/, why: '禁用阻塞式弹窗 API' },
  { id: 'iframe-escape', pattern: /window\.top\.location|parent\.location/, why: '疑似 iframe 顶层逃逸' },
  {
    id: 'absolute-resource',
    pattern: /\b(?:src|href)\s*=\s*["'`]\s*\/(?!\/)|url\(\s*['"]?\/(?!\/)/,
    why: '站内绝对路径资源（投稿 ZIP 必须全部相对路径）',
  },
  { id: 'pending-id', pattern: /PENDING_UPSTREAM_SANITY_RELIC_ID/, why: '待替换的理智遗物 ID（仅提醒：按无遗物路线验收，不阻断发布）', warnOnly: true },
];

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

const scanned = listFiles(gameDir).filter((file) => {
  const rel = relative(gameDir, file);
  if (rel === officialProtocol) return false; // 官方协议库不扫描
  return rel === 'index.html' || rel.startsWith(`js${sep}`) || rel.startsWith(`css${sep}`);
});

const findings = [];
for (const file of scanned) {
  const rel = relative(gameDir, file);
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        findings.push({ file: rel, line: index + 1, rule: rule.id, why: rule.why, text: line.trim().slice(0, 120) });
      }
    }
  });
}

console.log(`扫描 ${scanned.length} 个自有源码文件（排除官方 ${officialProtocol}）`);
const blockers = findings.filter((f) => !RULES.find((r) => r.id === f.rule)?.warnOnly);
const warnings = findings.filter((f) => RULES.find((r) => r.id === f.rule)?.warnOnly);

for (const finding of warnings) {
  console.log(`  [${finding.rule}] ${finding.file}:${finding.line} —— ${finding.why}`);
  console.log(`    ${finding.text}`);
}

if (blockers.length) {
  console.error(`\n阻断项 ${blockers.length} 个：不得发布。`);
  process.exit(1);
}
if (warnings.length) {
  console.log(`\n提醒 ${warnings.length} 个：不阻断发布，按无遗物路线验收；取得真实遗物 ID 后替换一次即可启用捷径。`);
}
console.log('\n自有源码扫描通过：无禁用 API、无绝对路径资源。');
