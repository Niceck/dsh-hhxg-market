/**
 * dsh-hhxg-market — 盘后条件选股（hhxg_strategy_signals → 服务端 screen_stocks）结果的纯文本渲染。
 *
 * 模型 / 桌面端看到的是这里生成的文本（DSH 桌面端只渲染纯文本，不渲染 markdown 表格）：
 *  - list_fields 目录：按名称规则分组列出全部字段，每个字段恰好一次、名称不截断（截断了模型就没法原样调用）；
 *  - 筛选结果：首行给全市场命中数 total、本页行数与数据日期，再按返回列逐行列出，末尾给翻页提示。
 * 只解析 execute 返回的成功信封；业务答复 / 占位说明 / 坏 JSON 原样返回，不抛错。
 * 不另造字段口径：分组只是排版，字段名、kind、total、next_cursor 全部来自服务端。
 */

const CATALOG_BUDGET = 24 * 1024
const RESULT_BUDGET = 64 * 1024
const CELL_LIMIT = 60
const FOOTER = '数据来自恢恢量化 hhxg.top，仅供研究参考，不构成投资建议。'

const ENC = new TextEncoder()
const bytes = (s) => ENC.encode(s).length

/**
 * 外部文本进纯文本前消毒：控制字符（含换行）变空格、不可见格式字符删除、压平空白、
 * 半角 / 全角竖线都换成斜杠（全角竖线是这里的列分隔符，值里出现会造成列歧义）、按码点限长（不切断代理对）。
 */
function clean(v, limit = CELL_LIMIT) {
  const s = String(v ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/[|｜]/g, '/')
    .trim()
  if (!limit) return s
  const chars = Array.from(s)
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : s
}

/** 字段名 / cursor 只清洗不截断（截断了模型就没法原样回传）。 */
const fieldName = (v) => clean(v, 0)

/** 单元格：数字原样（保留精度，0 不是缺失）、null / undefined 为「缺失」、布尔是 / 否、字符串清洗限长、对象 / 数组压成 JSON。 */
function cellText(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '缺失'
  if (v === null || v === undefined) return '缺失'
  if (typeof v === 'boolean') return v ? '是' : '否'
  if (typeof v === 'string') return clean(v)
  try {
    return clean(JSON.stringify(v))
  } catch {
    return '缺失'
  }
}

/** 条件回显里的 value：标量与标量数组原样清洗，其它形态只说「非法值」（服务端会拒，这里别渲染成 [object Object]）。 */
function valueText(v) {
  const scalar = (x) => typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean'
  if (scalar(v)) return clean(v, 40)
  if (Array.isArray(v) && v.every(scalar)) return clean(v.join(','), 40)
  return '（非法值）'
}

const dicts = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : [])

/** 数据日期只认 YYYY-MM-DD / YYYYMMDD，不从当前时间补。 */
function asOfText(meta) {
  const v = typeof meta?.as_of === 'string' ? meta.as_of.trim() : ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  if (/^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}`
  return '未知'
}

const sourceText = (meta) => clean(meta?.source, 32) || '未知'

// 分组只按名称规则 + kind 排版（未知的归通用组），每个字段落且只落一组；派生列口径见 tools/core/screen_derived.py
const GROUPS = [
  {
    title: '派生布尔条件（numeric；1=满足，0=不满足，null=缺数据，不等于 0）',
    test: (n, k) => k !== 'text' && /(多头|金叉|站上放量高点|低于放量低点|突破放量高点)$/.test(n),
  },
  { title: '派生位置指标（numeric；0=波谷、100=波峰，可小于 0 或大于 100）', test: (n, k) => k !== 'text' && /波段位置%$/.test(n) },
  { title: '周线数值字段（numeric）', test: (n, k) => k !== 'text' && n.startsWith('周') },
  { title: '月线数值字段（numeric）', test: (n, k) => k !== 'text' && n.startsWith('月') },
  { title: '文本字段（text；op 用 eq / ne / in / contains）', test: (_n, k) => k === 'text' },
  { title: '日线及通用数值字段（numeric）', test: () => true },
]

function renderCatalog(data, meta) {
  const fields = dicts(data.fields)
    .map((f) => ({ name: fieldName(f.name), kind: typeof f.kind === 'string' ? clean(f.kind, 16) : '' }))
    .filter((f) => f.name)
  const buckets = GROUPS.map(() => [])
  for (const f of fields) buckets[GROUPS.findIndex((g) => g.test(f.name, f.kind))].push(f.name)
  const head = [
    `可筛字段共 ${fields.length} 项｜数据日期 ${asOfText(meta)}｜来源 ${sourceText(meta)}`,
    '字段名必须原样使用（含单位与 _prev 后缀）；数值字段 op 用 gt/gte/lt/lte/eq/ne/in，文本字段用 eq/ne/in/contains，not_null 不传 value，多条条件之间为 AND；' +
      '两列比较写 {field, op, ref, scale}，即 field op ref × scale（scale 默认 1，op 只能 gt/gte/lt/lte，两个都须为数值字段）。',
    '示例：日线均线多头排列 {field:"日均线多头", op:"eq", value:1}；周线 MACD 多头 {field:"周MACD多头", op:"eq", value:1}；' +
      '低位 {field:"日波段位置%", op:"lte", value:20} 需同时 {field:"日波段位置%", op:"gte", value:0}；' +
      '站上 20 日线 {field:"收盘价", op:"gt", ref:"MA20"}，高出 5% 再加 scale:1.05。',
  ]
  const sections = GROUPS.map((g, i) => (buckets[i].length ? `${g.title}：${buckets[i].join('、')}` : '')).filter(Boolean)
  // 预算：超出就整组截断并明说不完整，绝不删了字段还称「全部」
  let used = bytes(head.join('\n'))
  let keep = 0
  while (keep < sections.length && used + 1 + bytes(sections[keep]) <= CATALOG_BUDGET) {
    used += 1 + bytes(sections[keep])
    keep += 1
  }
  const body = sections.slice(0, keep)
  const note = keep < sections.length
    ? `（清单过长，已省略后面 ${sections.length - keep} 组，不完整；可直接按 filters 试字段名，未知字段服务端会报 UNKNOWN_FIELD）`
    : ''
  return [...head, '', ...body, note, hintLine(meta), FOOTER].filter(Boolean).join('\n')
}

/** 一条自定义条件的回显：两列比较写 field op ref（倍数不为 1 时加 × scale），否则 field op value。 */
function filterText(f) {
  const head = `${fieldName(f.field)} ${clean(f.op, 10)}`
  if (f.ref !== undefined && f.ref !== null) {
    const times = typeof f.scale === 'number' && Number.isFinite(f.scale) && f.scale !== 1 ? ` × ${clean(f.scale, 16)}` : ''
    return `${head} ${clean(f.ref, 64)}${times}`
  }
  return f.value === undefined ? head : `${head} ${valueText(f.value)}`
}

/** 条件回显：预设来自服务端 meta.preset（对象且有名字才算），自定义条件来自本次调用参数（都经清洗）。 */
function conditionLine(args, meta) {
  const parts = []
  const p = meta?.preset
  const presetName = p && typeof p === 'object' && !Array.isArray(p) ? clean(p.title, 30) || clean(p.id, 30) : ''
  if (presetName) parts.push(`预设 ${presetName}`)
  if (Array.isArray(args?.filters)) {
    const items = args.filters
      .filter((f) => f && typeof f === 'object')
      .map(filterText)
    // 有预设时空 filters 只是「没附加条件」，仍按预设筛，不能标成全市场
    parts.push(items.length ? items.join('；') : presetName ? '无附加条件' : '无附加条件（全市场）')
  }
  return parts.length ? `条件：${parts.join('｜')}` : ''
}

/** 返回列：代码 / 名称置前，其余按服务端 fields 顺序；fields 缺失或形态不对（混有非字符串）时按首行键。 */
function columnsOf(data, rows) {
  const f = data.fields
  const fromServer = Array.isArray(f) && f.length && f.every((x) => typeof x === 'string') ? f : []
  const base = fromServer.length ? fromServer : Object.keys(rows[0] || {})
  const lead = ['股票代码', '股票名称'].filter((c) => rows.some((r) => Object.hasOwn(r, c)))
  return [...lead, ...base.filter((c) => !lead.includes(c))]
}

/** 只读自有属性：列名来自服务端 / 行键，`__proto__`、`constructor` 这类名字不能顺着原型链取值。 */
const own = (r, c) => (Object.hasOwn(r, c) ? r[c] : undefined)

/** 服务端 meta.hint（静态降级 / 排序失效等说明）在每种结果分支都要透出。 */
const hintLine = (meta) => {
  const hint = clean(meta?.hint, 200)
  return hint ? `提示：${hint}` : ''
}

function renderResults(args, data, meta) {
  const rows = dicts(data.rows)
  const total = Number.isInteger(data.total) && data.total >= 0 ? data.total : null
  const lines = [
    `全市场共 ${total === null ? '（命中数未知）' : total} 只满足条件｜本页返回 ${rows.length} 只｜数据日期 ${asOfText(meta)}（盘后快照）`,
  ]
  const cond = conditionLine(args, meta)
  if (cond) lines.push(cond)
  const finish = (...tail) => [...lines, ...tail, hintLine(meta), FOOTER].filter(Boolean).join('\n')
  if (total === 0) return finish('没有股票满足条件。')
  if (!rows.length) return finish('本页没有行（cursor 可能超出范围）；total 仍是全市场命中数。')
  const cols = [...new Set(columnsOf(data, rows))]
  const header = cols.map(fieldName).join('｜')
  const body = rows.map((r) => cols.map((c) => cellText(own(r, c))).join('｜'))
  const rawCursor = data.next_cursor
  const cursor = typeof rawCursor === 'string' || Number.isInteger(rawCursor) ? fieldName(String(rawCursor)) : ''
  const pageHint = cursor
    ? `下一页：保持原 strategy_id / filters / sort / fields 不变，传 cursor="${cursor}"。total 是全部命中数，limit 只控制每页行数。`
    : ''
  const truncNote = (keep) =>
    `结果过大：仅显示前 ${keep} 行（本页共 ${rows.length} 行）；请减小 limit 或 fields 后重新查询，不要用 cursor 翻页。`
  // 体积预算（整段文本 ≤ RESULT_BUDGET，含首行、表头、尾部提示与落款）：按累计字节一次算出能放下的行数；
  // 超出时只保留前若干行并明说，且不给 next_cursor（否则下一页会跳过被删的行）。
  const tailMax = Math.max(bytes(pageHint), bytes(truncNote(body.length))) + bytes(hintLine(meta)) + bytes(FOOTER) + 3
  const fixed = bytes([...lines, header].join('\n')) + tailMax
  let used = fixed
  let keep = 0
  while (keep < body.length && used + 1 + bytes(body[keep]) <= RESULT_BUDGET) {
    used += 1 + bytes(body[keep])
    keep += 1
  }
  const truncated = keep < body.length
  return finish(header, ...body.slice(0, keep), truncated ? truncNote(keep) : pageHint)
}

/**
 * hhxg_strategy_signals 的文本渲染：args + execute 返回的文本 → 可读文本。
 * 成功信封按 rows / fields 形态分流；其余（业务答复 / 占位 / 坏 JSON）原样返回。
 */
export function renderScreenText(args, text) {
  try {
    if (typeof text !== 'string' || !text.startsWith('{')) return text
    const envelope = JSON.parse(text)
    const data = envelope?.data
    if (!data || typeof data !== 'object') return text
    const meta = envelope.meta && typeof envelope.meta === 'object' ? envelope.meta : {}
    if (Array.isArray(data.rows)) return renderResults(args, data, meta)
    if (!('rows' in data) && dicts(data.fields).length) return renderCatalog(data, meta)
    return text
  } catch {
    return text
  }
}
