/**
 * dsh-hhxg-market — 工具结果的结构化投影（host 半 presentationMeta 用，client 半只渲染）。
 *
 * 模型看到的仍是 execute 返回的文本（MCP 信封 JSON / markdown）；这里从**同一份文本**解析出
 * 桌面端卡片要的最小结构：状态徽标 + 一张表。解析不动原文、不发请求、不抛错——任何意外
 * 都返回 undefined，宿主就按默认文本卡显示（Codex 评审：组件异常不得影响工具执行）。
 *
 * meta 形态（schema 锁死，client 半只认 schema === 1 && kind === 'hhxg.realtime'）：
 *   { schema: 1, kind: 'hhxg.realtime', view, frame: {status, status_text, trade_date, updated_at} | null,
 *     title, columns: string[], rows: (string|number|null)[][], truncated: boolean, note: string | null }
 * 体积上限：最多 MAX_ROWS 行 × MAX_COLS 列，单元格文本截断——meta 会进会话日志与回放。
 */

export const PRESENTATION_SCHEMA = 1
export const REALTIME_KIND = 'hhxg.realtime'
const MAX_ROWS = 50
const MAX_COLS = 12
const MAX_CELL = 40

/** 单元格：数字原样（有限），字符串截断，其余归 null。 */
function cell(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') return v.length > MAX_CELL ? v.slice(0, MAX_CELL - 1) + '…' : v
  if (typeof v === 'boolean') return v ? '是' : '否'
  return null
}

function table(columns, rows) {
  const cols = columns.slice(0, MAX_COLS).map((c) => cell(String(c)) ?? '')
  return {
    columns: cols,
    rows: rows.slice(0, MAX_ROWS).map((r) => cols.map((_c, i) => cell(r[i]))),
    truncated: rows.length > MAX_ROWS || columns.length > MAX_COLS,
  }
}

function frameOf(data) {
  const f = data?.frame
  if (!f || typeof f !== 'object') return null
  return {
    status: cell(f.status),
    status_text: cell(f.status_text),
    trade_date: cell(f.trade_date),
    updated_at: cell(f.updated_at),
  }
}

const dicts = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : [])

function marketTable(data) {
  const breadth = data?.breadth && typeof data.breadth === 'object' ? data.breadth : {}
  const rows = Object.entries(breadth)
    .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
    .map(([k, v]) => [k, v])
  const pools = data?.limit_pool && typeof data.limit_pool === 'object' ? data.limit_pool : {}
  for (const [name, pool] of Object.entries(pools)) {
    if (pool && typeof pool === 'object' && typeof pool.total === 'number') rows.push([`${name}（只）`, pool.total])
  }
  return { title: '市场概况', ...table(['指标', '值'], rows) }
}

function quotesTable(data) {
  const items = dicts(data?.items)
  const fields = ['最新价', '涨跌幅', '量比', '成交额(千元)', '涨停状态', '连板高度']
  const rows = items.map((it) => {
    const q = it.quote && typeof it.quote === 'object' ? it.quote : {}
    return [it.股票代码, it.股票名称, ...fields.map((f) => q[f])]
  })
  return { title: '个股行情', ...table(['代码', '名称', ...fields], rows) }
}

function screenTable(data) {
  const fields = Array.isArray(data?.fields) ? data.fields.filter((f) => typeof f === 'string') : []
  const rows = dicts(data?.rows).map((r) => [r.股票代码, r.股票名称, ...fields.map((f) => r[f])])
  const total = typeof data?.total === 'number' ? `（命中 ${data.total}）` : ''
  return { title: `全市场筛选${total}`, ...table(['代码', '名称', ...fields], rows) }
}

function klineTable(data) {
  const items = dicts(data?.items)
  const first = items[0]
  const columns = Array.isArray(data?.columns) ? data.columns : []
  if (!first || !columns.length) return { title: '日 K', ...table(columns, []) }
  const rows = Array.isArray(first.rows) ? first.rows.filter(Array.isArray) : []
  const live = first.live && typeof first.live === 'object' && Array.isArray(first.live.bar) ? first.live.bar : null
  // 卡片只放最近的几十根 + 今天这根（标「今日·未收盘」），完整序列在模型侧文本里
  const tail = rows.slice(-(MAX_ROWS - (live ? 1 : 0)))
  const shown = live ? [...tail, [`${live[0]} 今日·未收盘`, ...live.slice(1)]] : tail
  const name = [first.股票代码, first.股票名称].filter(Boolean).join(' ')
  const more = items.length > 1 ? `（另 ${items.length - 1} 只见文本）` : ''
  return { title: `日 K ${name}${more}`, ...table(columns, shown), truncated: rows.length > tail.length || items.length > 1 }
}

function fieldsTable(data) {
  const groups = data?.groups && typeof data.groups === 'object' ? data.groups : {}
  const rows = Object.entries(groups).map(([g, list]) => [g, Array.isArray(list) ? list.length : 0, Array.isArray(list) ? list.slice(0, 6).join('、') : ''])
  return { title: '可用字段', ...table(['分组', '字段数', '示例'], rows) }
}

const VIEW_TABLES = { market: marketTable, quotes: quotesTable, screen: screenTable, kline: klineTable, fields: fieldsTable }

/**
 * hhxg_realtime 的 presentationMeta：args.view + execute 返回的文本 → meta 或 undefined。
 * 文本不是 MCP 成功信封（业务性答复 / 占位说明 / 报错文字）时返回 undefined，走默认文本卡。
 */
export function realtimePresentation(args, text) {
  try {
    const view = typeof args?.view === 'string' ? args.view.trim() : ''
    const build = VIEW_TABLES[view]
    if (!build || typeof text !== 'string' || !text.startsWith('{')) return undefined
    const envelope = JSON.parse(text)
    const data = envelope?.data
    if (!data || typeof data !== 'object') return undefined
    const { title, columns, rows, truncated } = build(data)
    return {
      schema: PRESENTATION_SCHEMA,
      kind: REALTIME_KIND,
      view,
      frame: frameOf(data),
      title,
      columns,
      rows,
      truncated,
      note: typeof data.note === 'string' ? cell(data.note.slice(0, 120)) : null,
    }
  } catch {
    return undefined
  }
}
