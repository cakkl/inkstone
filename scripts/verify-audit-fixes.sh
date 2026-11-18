#!/usr/bin/env bash
# 代码审计修复的可复现验收脚本。
# 每个检查打印 PASS/FAIL，最后给出总数。任何 FAIL 都会让脚本以非零退出。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

pass=0
fail=0
declare -a failed_names=()

ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); failed_names+=("$1"); }
head_() { printf '\n=== %s ===\n' "$1"; }

# ── 1.5 lease.renew 的 json_valid 保护 ──────────────────────────────
head_ "1.5 lease.renew 容错（sqlite3 差分）"
if grep -q "json_valid(value) AND json_extract(value, '\$.token')" src/worker/lib/lease.ts; then
  ok "源码含 json_valid(value) 守卫"
else
  bad "源码缺少 json_valid(value) 守卫"
fi

db=$(mktemp -u /tmp/audit-lease-XXXX.db)
new_changes=$(sqlite3 "$db" "
CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO app_meta VALUES ('k', 'not-json');
UPDATE app_meta SET value = '{\"token\":\"T\"}' WHERE key='k'
  AND json_valid(value) AND json_extract(value,'\$.token')='T';
SELECT changes();" 2>&1)
rm -f "$db"
if [ "$new_changes" = "0" ]; then
  ok "修复后：非 JSON 值返回 0 changes 且无异常"
else
  bad "修复后：非 JSON 值结果异常（$new_changes）"
fi

db2=$(mktemp -u /tmp/audit-lease-old-XXXX.db)
old_out=$(sqlite3 "$db2" "
CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO app_meta VALUES ('k', 'not-json');
UPDATE app_meta SET value = '{\"token\":\"T\"}' WHERE key='k'
  AND json_extract(value,'\$.token')='T';" 2>&1)
rm -f "$db2"
if printf '%s' "$old_out" | grep -qi 'malformed JSON'; then
  ok "对照：修复前 SQL 确实抛 malformed JSON（证明修复必要）"
else
  bad "对照：修复前 SQL 未按预期抛错（$old_out）"
fi

# ── 1.6 标签/链接截断可观测 ────────────────────────────────────────
head_ "1.6 截断可观测"
if grep -q 'export function extractTagsResult' src/shared/markdown-utils.ts; then
  ok "存在 extractTagsResult"
else
  bad "缺少 extractTagsResult"
fi
if grep -q 'export function extractWikiLinksResult' src/shared/markdown-utils.ts; then
  ok "存在 extractWikiLinksResult"
else
  bad "缺少 extractWikiLinksResult"
fi
callers=$(grep -rn 'warnTruncatedDerived(' src/worker --include='*.ts' | grep -v 'db/writes.ts' | wc -l)
if [ "$callers" -ge 3 ]; then
  ok "截断告警有 $callers 处调用点（notes PATCH + MCP create/restore）"
else
  bad "截断告警调用点不足（$callers < 3）"
fi

# ── 1.7 跨 Tab 锁语义统一 ──────────────────────────────────────────
head_ "1.7 跨 Tab 锁语义统一"
uses=$(grep -c 'OUTBOX_LOCK_WAIT_MS' src/client/lib/db.ts)
if [ "$uses" -ge 3 ]; then
  ok "两条路径共用 OUTBOX_LOCK_WAIT_MS（$uses 处引用）"
else
  bad "未共用超时常量（$uses 处引用）"
fi
if grep -q 'AbortSignal.timeout(OUTBOX_LOCK_WAIT_MS)' src/client/lib/db.ts; then
  ok "Locks 路径已加超时"
else
  bad "Locks 路径缺少超时"
fi

# ── 1.8 / 1.9 live-preview ────────────────────────────────────────
head_ "1.8 / 1.9 live-preview"
if grep -q 'data-(?:task-line|line|code-start)' src/client/editor/live-preview.ts; then
  ok "行号位移正则覆盖 data-code-start"
else
  bad "正则仍漏 data-code-start"
fi
if grep -q 'block.startLine + 1 > tr.startState.doc.lines' src/client/editor/live-preview.ts; then
  ok "块映射有行号边界保护"
else
  bad "块映射缺少边界保护"
fi

# ── 1.1 / 1.2 索引修复（迁移 14）──────────────────────────────────
head_ "1.1 / 1.2 索引修复（迁移 14）"
if grep -q 'idx_versions_user_id ON note_versions(user_id, id)' src/worker/db/schema.ts; then
  ok "note_versions 有 (user_id, id) 索引"
else
  bad "缺少 idx_versions_user_id"
fi
if grep -q 'idx_sessions_expires_id ON sessions(expires_at, id)' src/worker/db/schema.ts; then
  ok "sessions 有 (expires_at, id) 索引"
else
  bad "缺少 idx_sessions_expires_id"
fi
if grep -q 'version: 14' src/worker/db/schema.ts; then
  ok "存在迁移 14（既有库可增量升级）"
else
  bad "缺少迁移 14"
fi
if grep -q "'idx_versions_user_id'" src/worker/db/schema.ts \
   && grep -q "'idx_sessions_expires_id'" src/worker/db/schema.ts; then
  ok "新索引已登记到 REQUIRED_INDEXES"
else
  bad "新索引未登记到 REQUIRED_INDEXES"
fi

# 实际建索引后，两条热点查询都应能走索引
dbm=$(mktemp -u /tmp/audit-idx-XXXX.db)
plan_sessions=$(sqlite3 "$dbm" "
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER NOT NULL, created_at INTEGER);
CREATE INDEX idx_sessions_expires_id ON sessions(expires_at, id);
EXPLAIN QUERY PLAN SELECT id FROM sessions WHERE expires_at <= 1 ORDER BY expires_at, id LIMIT 500;" 2>&1)
plan_versions=$(sqlite3 "$dbm" "
CREATE TABLE note_versions (id TEXT PRIMARY KEY, note_id TEXT, user_id TEXT, content TEXT);
CREATE INDEX idx_versions_user_id ON note_versions(user_id, id);
EXPLAIN QUERY PLAN SELECT id FROM note_versions WHERE user_id='u' AND id>'a' ORDER BY id LIMIT 10;" 2>&1)
rm -f "$dbm"
if printf '%s' "$plan_sessions" | grep -q 'COVERING INDEX idx_sessions_expires_id'; then
  ok "会话清理走覆盖索引（不再 SCAN sessions）"
else
  bad "会话清理计划未改善：$plan_sessions"
fi
if printf '%s' "$plan_versions" | grep -qE '(COVERING )?INDEX idx_versions_user_id'; then
  ok "版本键集分页走索引（不再 TEMP B-TREE）"
else
  bad "版本分页计划未改善：$plan_versions"
fi

# ── 1.3 标签计数聚合 ──────────────────────────────────────────────
head_ "1.3 标签计数改用聚合"
for f in src/worker/routes/sync.ts src/worker/routes/tags.ts; do
  if grep -q 'TAG_SOURCE' "$f" && grep -q 'GROUP BY nt.tag_id' "$f"; then
    ok "$(basename "$f") 使用 GROUP BY 聚合"
  else
    bad "$(basename "$f") 未改为聚合"
  fi
  if grep -q 'SELECT COUNT(\*) FROM note_tags nt JOIN notes n' "$f"; then
    bad "$(basename "$f") 仍残留相关子查询"
  else
    ok "$(basename "$f") 已无逐标签相关子查询"
  fi
done

# ── 1.10 KaTeX CSS 内联 ───────────────────────────────────────────
head_ "1.10 KaTeX CSS 内联"
if grep -rq 'cdn.jsdelivr\|unpkg.com\|cdnjs.cloudflare' src/ 2>/dev/null; then
  bad "源码仍含 CDN URL"
else
  ok "源码无 CDN URL"
fi
if grep -q "katex/dist/katex.min.css?inline" src/client/lib/export-note.ts; then
  ok "导出使用 ?inline 内联本地 CSS"
else
  bad "导出未使用 ?inline"
fi

# ── 1.3 MCP 属性查询分页早停 ──────────────────────────────────────
head_ "1.3 MCP 属性查询分页早停"
if grep -q 'PROPERTY_SCAN_PAGE' src/worker/mcp/library.ts \
   && grep -q 'PROPERTY_SCAN_MAX' src/worker/mcp/library.ts; then
  ok "存在分页常量 PROPERTY_SCAN_PAGE / PROPERTY_SCAN_MAX"
else
  bad "缺少分页常量"
fi
if grep -q 'ORDER BY updated_at DESC, id ASC LIMIT ?' src/worker/mcp/library.ts; then
  ok "使用稳定的 (updated_at, id) 键集游标"
else
  bad "未使用稳定游标"
fi
if grep -q 'LIMIT 500' src/worker/mcp/library.ts; then
  bad "仍残留写死的 LIMIT 500"
else
  ok "已移除写死的 LIMIT 500"
fi
if grep -q 'matches.length < limit' src/worker/mcp/library.ts; then
  ok "命中足够即以停止扫描（早停）"
else
  bad "缺少早停条件"
fi

# ── 门禁 ──────────────────────────────────────────────────────────
head_ "门禁"
if ./node_modules/.bin/tsc -b --force >/tmp/audit-tsc.log 2>&1; then
  ok "tsc -b --force"
else
  bad "tsc -b --force（见 /tmp/audit-tsc.log）"
fi

if node scripts/check-i18n.mjs >/tmp/audit-i18n.log 2>&1; then
  ok "check-i18n"
else
  bad "check-i18n（见 /tmp/audit-i18n.log）"
fi

if ./node_modules/.bin/vitest run --config vitest.config.ts >/tmp/audit-vitest.log 2>&1; then
  ok "vitest 全量"
else
  bad "vitest 全量（见 /tmp/audit-vitest.log）"
fi

if ./node_modules/.bin/vite build >/tmp/audit-build.log 2>&1; then
  ok "vite build"
  if grep -rqs 'jsdelivr' dist/client/assets/*.js; then
    bad "构建产物仍含 jsdelivr 引用"
  else
    ok "构建产物无 CDN 引用"
  fi
  katex_classes=$(grep -o '\.katex[a-z0-9-]*' dist/client/assets/katex.min-*.js 2>/dev/null | wc -l)
  if [ "$katex_classes" -gt 100 ]; then
    ok "产物内联 KaTeX CSS（$katex_classes 个类名）"
  else
    bad "产物未内联 KaTeX CSS（$katex_classes 个类名）"
  fi
else
  bad "vite build（见 /tmp/audit-build.log）"
fi

# ── 汇总 ──────────────────────────────────────────────────────────
printf '\n──────────────────────────────\n'
printf 'PASS %d   FAIL %d\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then
  printf '\n失败项：\n'
  printf '  - %s\n' "${failed_names[@]}"
  exit 1
fi
printf '全部检查通过。\n'
