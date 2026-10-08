const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../..');
const DOCS = path.join(ROOT, 'docs/company');
const BASE = '106bb7cafde89c55cad062722445bb083a53cd19';
const PRIMARY = {
  'README.md': '开发文档索引.md',
  'architecture.md': '总体架构.md',
  'org-sync-design.md': '组织同步与身份状态.md',
  'permission-design.md': '权限判断与部门隔离.md',
  'database-design.md': '数据结构与事务.md',
  'roadmap.md': '阶段交付与待确认问题.md',
};

function markdownFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? markdownFiles(file) : file.endsWith('.md') ? [file] : [];
  }).sort();
}

function anchors(text) {
  const result = new Set();
  const counts = new Map();
  const plain = text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
  for (const match of plain.matchAll(/<a\s+id="([^"]+)"\s*><\/a>/g)) {
    assert.ok(!result.has(match[1]), `Duplicate anchor: ${match[1]}`);
    result.add(match[1]);
  }
  for (const match of plain.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const slug = match[1].toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s/g, '-');
    const n = counts.get(slug) || 0;
    counts.set(slug, n + 1);
    result.add(n ? `${slug}-${n}` : slug);
  }
  return result;
}

function metrics(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  return {
    lines: normalized.trimEnd().split('\n').length,
    characters: normalized.length,
    nonWhitespace: normalized.replace(/\s/g, '').length,
  };
}

function compression() {
  const totals = {
    before: { lines: 0, characters: 0, nonWhitespace: 0 },
    after: { lines: 0, characters: 0, nonWhitespace: 0 },
  };
  const files = [];
  for (const [oldName, name] of Object.entries(PRIMARY)) {
    const before = metrics(execFileSync('git', ['show', `${BASE}:docs/company/${oldName}`], {
      cwd: ROOT, encoding: 'utf8',
    }));
    const after = metrics(fs.readFileSync(path.join(DOCS, name), 'utf8'));
    files.push({ file: name, before, after });
    for (const field of Object.keys(before)) {
      totals.before[field] += before[field];
      totals.after[field] += after[field];
    }
  }
  return {
    baseline: BASE, files, ...totals,
    nonWhitespaceReductionPercent:
      Number((100 * (1 - totals.after.nonWhitespace / totals.before.nonWhitespace)).toFixed(2)),
  };
}

function validateDocuments() {
  const files = markdownFiles(DOCS);
  assert.equal(files.filter((file) => path.dirname(file) === DOCS).length, 6);
  for (const name of Object.values(PRIMARY)) assert.ok(fs.existsSync(path.join(DOCS, name)), name);
  let links = 0;
  let fences = 0;
  let tables = 0;
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    const text = bytes.toString('utf8');
    assert.equal(Buffer.from(text, 'utf8').equals(bytes), true, `${file}: invalid UTF-8`);
    assert.notEqual(text.charCodeAt(0), 0xfeff, `${file}: BOM`);
    let fenced = false;
    let table = [];
    const checkTable = () => {
      if (table.length > 1) {
        const columns = table[0].split('|').length;
        for (const row of table) assert.equal(row.split('|').length, columns, `${file}: table columns`);
        tables++;
      }
      table = [];
    };
    const visible = [];
    for (const line of text.split(/\r?\n/)) {
      if (/^```/.test(line)) {
        fenced = !fenced;
        fences++;
        checkTable();
      } else if (!fenced) {
        visible.push(line);
        if (/^\|/.test(line)) table.push(line);
        else checkTable();
      }
    }
    checkTable();
    assert.equal(fenced, false, `${file}: unclosed fence`);
    anchors(text);
    for (const match of visible.join('\n').matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const href = match[1];
      if (/^[a-z]+:/i.test(href)) continue;
      links++;
      const [relative, fragment] = href.split('#');
      const target = relative ? path.resolve(path.dirname(file), decodeURIComponent(relative)) : file;
      assert.ok(fs.existsSync(target), `${file}: missing ${href}`);
      if (fragment) {
        assert.ok(anchors(fs.readFileSync(target, 'utf8')).has(decodeURIComponent(fragment)),
          `${file}: missing anchor ${href}`);
      }
    }
    for (const oldName of Object.keys(PRIMARY)) {
      assert.ok(!visible.join('\n').includes(`./${oldName}`), `${file}: old link ${oldName}`);
    }
  }
  const permission = fs.readFileSync(path.join(DOCS, PRIMARY['permission-design.md']), 'utf8');
  const sync = fs.readFileSync(path.join(DOCS, PRIMARY['org-sync-design.md']), 'utf8');
  for (const phrase of [
    'resource_scope_pass', 'bounded_department_grants', 'department_grant_action_limit',
    'api_key_principal_dependency_pass', 'human_shared_agent', 'tenant_public',
    'download_original', 'Contributor 及 KB 写权限', '其他合法路径继续独立计算并取 OR',
  ]) assert.ok(permission.includes(phrase), phrase);
  for (const phrase of [
    'last_verified_fresh', '25 小时', 'stale_plan', 'expected_record_version',
    'expected_field_version', 'expected_last_change_id', 'plan_hash', 'snapshot_version',
    'ABA', 'revocation_pending',
  ]) assert.ok(sync.includes(phrase), phrase);
  assert.ok(!permission.includes('department_policy_ceiling'));
  return { primaryFiles: 6, markdownFiles: files.length, links, brokenLinks: 0, fences, tables };
}

if (require.main === module) {
  console.log(JSON.stringify({ documentChecks: validateDocuments(), primaryCompression: compression() }, null, 2));
}
module.exports = { validateDocuments, compression };
