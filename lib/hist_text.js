/**
 * dsh-hhxg-market — 历史库查询结果的纯文本渲染（hhxg_query_dataset → 服务端 query_dataset 的 format=hist
 * 条目 → 查询服务 hist.query）。DSH 桌面端只渲染纯文本，模型读到的也是这里生成的文本。
 *
 * 只认成功信封里形如历史库结果的 data（table 为 hist_xxx、rows 是数组的数组、fields 为列名数组，
 * columns 给每列中文名 / 单位）：渲染成「首行摘要 → 名称解析 / 没找到 / 异常说明 → 列名 → 表头 → 逐行」。
 * 其余（普通数据集结果、业务答复、坏 JSON）原样返回，不抛错——非历史库的现有呈现不变。
 *
 * 约定同 screen_text.js：整段（首行、说明、表头、行、落款）共用 64 KiB 预算，超出只留前若干行并明说、且不给
 * cursor（否则下一页会跳过被删的行）；表头最多 MAX_COLS 列，多出的列写明列名与「用 fields 选列」；
 * 取值里的半角 / 全角竖线换成斜杠（全角竖线是列分隔符）；对象只读自有属性；格式异常的行不静默丢弃。
 * 首行只放白名单 / 严格格式的服务端字段：表 id、8 位日期、整数行数、发布时间的日期与时分、按服务端游标结构
 * 校验过的 cursor、字符集受限的短标题——不合格就省略或改成说明，绝不把服务端的整句话提升到首行。
 */

import { FOOTER, RESULT_BUDGET, bytes, cellText, clean, dicts } from './screen_text.js'

export const TABLE_ID_RE = /^hist_[a-z0-9_]{1,60}$/
// 标题：去掉半角空格后只允许中日韩文字、字母数字和固定几个标点（全 / 半角括号、顿号、斜杠、连字符，
// 以及登记表标题里用到的全角逗号与加号），最长 30 字；不合规只显示表 id
const TITLE_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}A-Za-z0-9（）()、/\-，+]{1,30}$/u
const DATE8_RE = /^\d{8}$/
const PUBLISHED_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/
// keyset 游标（scripts/query_service/hist_params.py 的 encode_cursor）：「8 位日期|实体[|其余主键]」共 2–4 段，
// 段内的 | 与 % 编码成 %7C / %25。插件侧：首段 8 位数字，其后 1–3 段，每段不含空白 / 控制 / 格式控制 / 分隔符类字符、
// 引号、反斜杠，% 只能出现在 %25 / %7C 里，每段至多 CURSOR_PART_MAX 个字符，整串至多 CURSOR_MAX_LEN
const CURSOR_PART_RE = /^(?:[^\s\p{Cc}\p{Cf}\p{Z}"'“”‘’`\\%|]|%(?:25|7C))+$/u
const CURSOR_PART_MAX = 80
const CURSOR_MAX_LEN = 256
const CODE_RE = /^[0-9A-Z]{1,10}\.[A-Z]{1,4}$/
/** 表头最多显示几列：三张财务报表全字段有一百多列，桌面端一行四十列已是可读上限。 */
export const MAX_COLS = 40
const HIDDEN_NAME_LIMIT = 60
const LIST_LIMIT = 20
const EMPTY_CELL = '（空）'
const TRUNC_CLAUSE = '本页过大，已截断显示（见末尾说明），不要用 cursor 翻页'
const SHAPE_CLAUSE = '返回形状异常，不要用 cursor 翻页'
const EMPTY_TEXT = '没有符合条件的行：这张表在给定的 key / date / date_range 范围内没有数据（全表覆盖范围见首行）。'
const NOT_FOUND_HINT = '这张表里没有这些代码 / 名称；名称须精确匹配，查不到可改用代码'
const FIELDS_HINT = '列名（fields 参数用这些名字，也认表头中文名）：'

export const isDict = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const iso = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`
/** 8 位日期 → YYYY-MM-DD；不合格返回空串。 */
export const date8 = (v) => (typeof v === 'string' && DATE8_RE.test(v) ? iso(v) : '')

/** 历史库结果的形状：表 id 合规、rows 为数组、fields 为非空字符串数组。 */
function isHistData(data) {
  return isDict(data) && typeof data.table === 'string' && TABLE_ID_RE.test(data.table)
    && Array.isArray(data.rows) && Array.isArray(data.fields) && data.fields.length > 0
    && data.fields.every((f) => typeof f === 'string')
}

/** 表标题：去掉半角空格后通过 TITLE_RE 才返回，否则空串（下载工具的表清单也用它）。 */
export function safeTitle(v) {
  const title = typeof v === 'string' ? v.replace(/ /g, '') : ''
  return TITLE_RE.test(title) ? title : ''
}

/** 「标题」（表 id）；标题不合规只写表 id。调用方须先确认 data.table 合规。 */
export function tableName(data) {
  const title = safeTitle(data.title)
  return title ? `「${title}」（${data.table}）` : data.table
}

function coverageText(cov) {
  if (!isDict(cov)) return ''
  const lo = date8(cov.min_date)
  const hi = date8(cov.max_date)
  if (!lo || !hi) return ''
  const rows = Number.isInteger(cov.rows) && cov.rows >= 0 ? `（共 ${cov.rows} 行）` : ''
  return `全表覆盖 ${lo} 至 ${hi}${rows}`
}

function publishedText(v) {
  const m = typeof v === 'string' ? v.match(PUBLISHED_RE) : null
  return m ? `库更新于 ${m[1]} ${m[2]}` : ''
}

/** 按服务端游标结构校验 next_cursor：合规原样返回（要原样回传），否则返回空串。 */
export function safeCursor(raw) {
  if (typeof raw !== 'string' || raw.length > CURSOR_MAX_LEN) return ''
  const parts = raw.split('|')
  if (parts.length < 2 || parts.length > 4 || !DATE8_RE.test(parts[0])) return ''
  const ok = parts.slice(1).every((p) => CURSOR_PART_RE.test(p) && Array.from(p).length <= CURSOR_PART_MAX)
  return ok ? raw : ''
}

/** 翻页说明：只有通过 safeCursor 的 next_cursor 才给出；服务端 truncated=true 表示本页因 160 KB 上限提前截断，cursor 仍可续取。 */
function pagingClause(data) {
  const raw = data.next_cursor
  if (raw === null || raw === undefined || raw === '') return '没有下一页'
  const cut = data.truncated === true ? '（本页按 160 KB 上限提前截断）' : ''
  const cursor = safeCursor(raw)
  if (cursor) return `还有下一页${cut}：其余参数不变，加 cursor="${cursor}" 再查`
  return `还有下一页${cut}，但游标含特殊字符未展示，请改用 date_range 缩小范围`
}

function summaryLine(data, shown, paging) {
  return [`历史库 ${tableName(data)}`, `本页 ${shown} 行`, coverageText(data.coverage), publishedText(data.published_at), paging]
    .filter(Boolean)
    .join('｜')
}

/** 名称解析：输入（清洗）→ 代码（严格格式）+ 名称 / 类型（清洗）；同名多个代码都列出。 */
function resolvedLine(resolved) {
  if (!isDict(resolved)) return ''
  const parts = []
  for (const [input, hits] of Object.entries(resolved).slice(0, LIST_LIMIT)) {
    const codes = dicts(hits)
      .filter((h) => typeof h.code === 'string' && CODE_RE.test(h.code))
      .slice(0, 5)
      .map((h) => {
        const desc = [clean(h.name, 20), clean(h.kind, 8)].filter(Boolean).join('，')
        return desc ? `${h.code}（${desc}）` : h.code
      })
    const name = clean(input, 20)
    if (name && codes.length) parts.push(`${name} → ${codes.join(' / ')}`)
  }
  return parts.length ? `名称解析：${parts.join('；')}` : ''
}

function notFoundLine(v) {
  const items = Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => clean(x, 30)).filter(Boolean) : []
  if (!items.length) return ''
  const more = items.length > LIST_LIMIT ? ` 等 ${items.length} 个` : ''
  return `没找到：${items.slice(0, LIST_LIMIT).join('、')}${more}（${NOT_FOUND_HINT}）`
}

/** 表头：按列名对上 columns 的中文名与单位（不按下标，防错位）；对不上就用列名。只出前 width 列。 */
function headerLine(data, fields, width) {
  const byName = new Map(dicts(data.columns).filter((c) => typeof c.name === 'string').map((c) => [c.name, c]))
  return data.fields
    .slice(0, width)
    .map((raw, i) => {
      const col = byName.get(raw)
      const head = (col && clean(col.label, 30)) || fields[i] || `列${i + 1}`
      const unit = col ? clean(col.unit, 8) : ''
      return unit ? `${head}（${unit}）` : head
    })
    .join('｜')
}

/** 超出列数上限时的说明：写明隐藏了几列与它们的列名（最多列 HIDDEN_NAME_LIMIT 个），提示用 fields 选列。 */
function hiddenColumnsLine(fields) {
  const hidden = fields.slice(MAX_COLS)
  if (!hidden.length) return ''
  const names = hidden.slice(0, HIDDEN_NAME_LIMIT).join('、')
  const more = hidden.length > HIDDEN_NAME_LIMIT ? ' 等' : ''
  return `其余 ${hidden.length} 列未显示（共 ${fields.length} 列，只显示前 ${MAX_COLS} 列）：${names}${more}；要看这些列用 fields 选列。`
}

/** 单元格：沿用 screen_text 的约定（null / 缺失写「缺失」，0 原样），空串另标「（空）」与缺失区分。 */
function histCell(v) {
  const text = cellText(v)
  return text === '' ? EMPTY_CELL : text
}

/** 行：列顺序同 fields；只读数组自有下标（缺的、多的都不顺原型链取）。 */
function bodyLines(rows, width) {
  return rows.map((r) => Array.from({ length: width }, (_v, j) => histCell(Object.hasOwn(r, j) ? r[j] : undefined)).join('｜'))
}

/** 按 64 KiB 预算算能放下几行：固定部分（含表头）取两种首行里较长的那个与截断说明，宁可少放一行也不超预算。 */
function fitRows(fixedParts, body) {
  let used = bytes(fixedParts.join('\n')) + 1
  let keep = 0
  while (keep < body.length && used + 1 + bytes(body[keep]) <= RESULT_BUDGET) {
    used += 1 + bytes(body[keep])
    keep += 1
  }
  return keep
}

/** rows 里有元素、但没有一个是数组：返回形状异常，明说而不是当成空结果。 */
function shapeErrorText(data, notes, bad) {
  const msg = `返回形状异常：本页 ${bad} 行都不是数组（应为列顺序同 fields 的数组），已全部忽略；请重试，或缩小 key / date_range 后再查。`
  return [summaryLine(data, 0, SHAPE_CLAUSE), ...notes, msg, FOOTER].join('\n')
}

function renderHist(data) {
  const fields = data.fields.map((f) => clean(f, 40))
  const rows = data.rows.filter(Array.isArray)
  const bad = data.rows.length - rows.length
  const notes = [resolvedLine(data.resolved), notFoundLine(data.not_found)].filter(Boolean)
  if (bad && !rows.length) return shapeErrorText(data, notes, bad)
  if (bad) notes.push(`另有 ${bad} 行格式异常已忽略（不是数组）。`)
  if (!rows.length) return [summaryLine(data, 0, pagingClause(data)), ...notes, EMPTY_TEXT, FOOTER].join('\n')
  const width = Math.min(fields.length, MAX_COLS)
  const table = [`${FIELDS_HINT}${fields.slice(0, width).join('、')}`, hiddenColumnsLine(fields), headerLine(data, fields, width)].filter(Boolean)
  const body = bodyLines(rows, width)
  const fullHead = summaryLine(data, rows.length, pagingClause(data))
  const cutNote = (keep) =>
    `结果过大：仅显示前 ${keep} 行（本页共 ${rows.length} 行）；请减少 fields 或 limit 后重新查询，不要用 cursor 翻页。`
  const longest = [fullHead, summaryLine(data, rows.length, TRUNC_CLAUSE)].sort((a, b) => bytes(b) - bytes(a))[0]
  const keep = fitRows([longest, ...notes, ...table, cutNote(rows.length), FOOTER], body)
  const truncated = keep < body.length
  const head = truncated ? summaryLine(data, rows.length, TRUNC_CLAUSE) : fullHead
  return [head, ...notes, ...table, ...body.slice(0, keep), truncated ? cutNote(keep) : '', FOOTER].filter(Boolean).join('\n')
}

/**
 * hhxg_query_dataset 的文本渲染：args + execute 返回的文本 → 可读文本。
 * 历史库结果渲染成纯文本表格；其余原样返回（普通数据集的 JSON、业务答复、占位说明、坏 JSON）。
 */
export function renderQueryText(_args, text) {
  try {
    if (typeof text !== 'string' || !text.startsWith('{')) return text
    const data = JSON.parse(text)?.data
    return isHistData(data) ? renderHist(data) : text
  } catch {
    return text
  }
}
