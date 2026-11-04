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

/** 帧状态 → 人话；status=live 但 is_live=false 的矛盾帧按「非实时」处理，绝不显示成实时。client.js 的回退表须与此一致。 */
export const STATUS_LABEL = {
  live: '盘中实时',
  lunch_break: '午间休市',
  closed: '收盘帧',
  previous_session: '非实时·上一交易日',
  stale: '非实时·延迟',
}
const LIVE_STATUSES = new Set(['live', 'lunch_break'])

/** 进首行的服务端字段统一清洗：删控制 / 不可见字符、压平空白、限长——首行是模型最先读到的位置。 */
function safeText(v, limit) {
  if (typeof v !== 'string') return ''
  const s = v.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim()
  return s.length > limit ? s.slice(0, limit - 1) + '…' : s
}

/** 8 位交易日 → YYYY-MM-DD；格式不对返回空串（不回显来路不明的字符串）。 */
function ymd(v) {
  const s = typeof v === 'string' ? v : ''
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : ''
}

/**
 * 帧的有效状态：只有 status=live 却 is_live=false 这种矛盾才降为 stale（不能显示绿色）。
 * lunch_break 服务端本来就给 is_live=false（午休不是实时），不算矛盾。
 */
function effectiveStatus(f) {
  const status = typeof f?.status === 'string' ? f.status : ''
  if (status === 'live' && f?.is_live === false) return 'stale'
  return status
}

const UPDATED_AT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/

/**
 * 徽标正文（host 统一生成，client 只显示）：状态 + 帧交易日 + 采集时间，日期必须完整可见。
 * 进首行的服务端字段只走白名单 / 严格格式：状态不在表里显示「状态未知」，日期时间格式不对就省略，
 * 绝不把未知字符串原样提升到模型最先读到的位置。
 */
function frameLabel(f) {
  const status = effectiveStatus(f)
  const label = STATUS_LABEL[status] || '状态未知'
  const date = ymd(f?.trade_date)
  const at = typeof f?.updated_at === 'string' && UPDATED_AT_RE.test(f.updated_at) ? f.updated_at.slice(0, 16) : ''
  return [label, date ? `帧交易日 ${date}` : '', at ? `采集 ${at}` : ''].filter(Boolean).join('｜')
}

function frameOf(data) {
  const f = data?.frame
  if (!f || typeof f !== 'object') return null
  return {
    status: cell(f.status),
    status_text: cell(f.status_text),
    trade_date: cell(f.trade_date),
    updated_at: cell(f.updated_at),
    // 布尔原样保留（cell 会把它变成「是 / 否」）；缺失为 null
    is_live: typeof f.is_live === 'boolean' ? f.is_live : null,
    effective_status: cell(effectiveStatus(f)),
    // 徽标正文要完整可见（含日期与时间），不走 40 字的单元格截断；上限 80 字兜底
    label: frameLabel(f).slice(0, 80),
  }
}

/** live 段的可比性说明：只有 comparable===true 才能与 rows 拼接。 */
const REASON_TEXT = {
  history_gap: '历史缓存落后于实时帧（中间有交易日没同步）',
  last_close_not_previous_session: '该股最后一个收盘价不在上一交易日（停牌或缺数据）',
  missing_reference_price: '缺少昨收 / 最后收盘价',
  calendar_unavailable_or_incomplete: '交易日历不可用，无法判断缓存是否滞后',
  reference_price_mismatch: '帧昨收与缓存最后收盘偏差 >0.5%，疑似除权或价格基准不一致',
}

function comparabilityNote(live) {
  if (!live || typeof live !== 'object' || live.comparable === true) return null
  // reason 走白名单：未知值不回显，只说「原因未说明」
  const why = REASON_TEXT[live.reason] || (live.reason ? '原因未说明' : '')
  const head = live.comparable === false ? '实时 K 与历史不可比' : '实时 K 与历史的可比性无法判断'
  return `${head}${why ? `：${why}` : ''}；不要把 live 直接拼到 rows 后面。`
}

/** 多只股票：每只有 live 且 comparable !== true 的都列出（代码走 safeText），最多列 5 只。 */
function comparabilityLines(items) {
  const out = []
  for (const it of items) {
    const note = comparabilityNote(it?.live)
    if (!note) continue
    const code = safeText(typeof it.股票代码 === 'string' ? it.股票代码 : '', 12) || '（未知代码）'
    out.push(`${code}：${note}`)
    if (out.length >= 5) {
      out.push('（其余见 JSON 的 live.reason）')
      break
    }
  }
  return out
}

/**
 * 工具文本首行：把帧的时效与日期放到模型 / 用户第一眼能看到的位置（原 JSON 原样跟在后面，
 * presentationMeta 仍从同一份原文解析）。非成功信封（业务答复 / 占位 / 报错）原样返回。
 */
export function renderRealtimeText(args, text) {
  try {
    if (typeof text !== 'string' || !text.startsWith('{')) return text
    const envelope = JSON.parse(text)
    const data = envelope?.data
    if (!data || typeof data !== 'object') return text
    const view = typeof args?.view === 'string' ? args.view.trim() : ''
    if (view === 'fields') return text // 字段清单本来就没有帧，不加时效行
    const lines = []
    if (data.frame && typeof data.frame === 'object') {
      // 盘中 / 午休帧不加告警（午休是上午最后一帧，仍是今天的实时口径）；其余都不是此刻的数据
      const warn = LIVE_STATUSES.has(effectiveStatus(data.frame)) ? '' : '不是此刻的实时数据，引用时注明帧日期。'
      lines.push(`【${frameLabel(data.frame)}】${warn}`)
    } else if (view === 'kline') {
      const last = ymd(data?.history?.last_date)
      lines.push(`【历史日 K${last ? `｜截至 ${last}` : ''}】未附实时帧。`)
    } else {
      lines.push('【时效未知】结果里没有帧信息。')
    }
    if (view === 'kline') {
      const notes = comparabilityLines(dicts(data.items))
      if (notes.length) lines.push(`【注意】${notes.join('；')}`)
    }
    if (view === 'screen') lines.push(screenCountLine(args, data))
    if (view === 'screen' || view === 'quotes') {
      const basis = indicatorBasisLine(data)
      if (basis) lines.push(basis)
    }
    return `${lines.map((l) => safeText(l, 600)).join('\n')}\n${text}`
  } catch {
    return text
  }
}

const dicts = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : [])

/** 服务端 indicators.reason 走白名单（原文含时间戳等自由文本，不回显）；未知值统一「原因未说明」。 */
const INDICATOR_ISSUE_TEXT = [[/^指标帧没有跟上最新行情/, '指标帧没有跟上最新行情（服务端正在追赶，稍后重试）']]

/**
 * view=screen / quotes 的指标口径行：服务端把帧交易日当天按最新价算成一根 K 线再算 MA / BBI / MACD 等，
 * 而 indicators.base_date 只是历史基准日（T-1）——模型见到它常答成「指标按昨日收盘计算」，所以写到首行附近。
 * 只在响应带 indicators 对象时输出；不可用时说原因（清洗后）并提醒含指标的条件不会命中。
 */
function indicatorBasisLine(data) {
  const ind = data?.indicators
  if (!ind || typeof ind !== 'object' || Array.isArray(ind)) return ''
  const f = data?.frame
  if (!f || typeof f !== 'object') return '' // 不知道帧状态就不下结论
  if (ind.available === false) {
    const raw = typeof ind.reason === 'string' ? ind.reason : ''
    if (/^未请求指标/.test(raw)) return '' // quotes 没带 include：没有指标可解释
    const hit = INDICATOR_ISSUE_TEXT.find(([re]) => re.test(raw))
    return `【口径】本帧指标不可用：${hit ? hit[1] : '原因未说明'}；含指标的条件筛不到股票（缺指标的股票不命中），价格类字段不受影响。`
  }
  if (ind.available !== true) return '' // 字段缺失不等于不可用
  const date = ymd(f?.trade_date)
  const at = typeof f?.updated_at === 'string' && UPDATED_AT_RE.test(f.updated_at) ? f.updated_at.slice(11, 16) : ''
  const when = [date, at].filter(Boolean).join(' ')
  const day = date || '帧交易日当天'
  const base = ymd(ind.base_date)
  const baseNote = base ? `；indicators.base_date（${base}）只是历史基准日，不是指标日期` : ''
  if (LIVE_STATUSES.has(effectiveStatus(f))) {
    return `【口径】价格是 ${when ? `${when} 的` : '帧内'}最新价（非收盘价）；MA / BBI / MACD / KDJ 等指标按这个最新价把 ${day} 当作一根未走完的 K 线计算，盘中随价格变化，不是上一交易日收盘的指标${baseNote}。`
  }
  return `【口径】价格是 ${when ? `${when} 帧的` : '帧内'}最新价；MA / BBI / MACD / KDJ 等指标把 ${day} 当作一根已含该价格的 K 线计算，不是上一交易日收盘的指标${baseNote}。`
}

/** view=screen：total 是全市场命中数、limit 只限制返回行数——写在首行之后，模型就不会拿本次行数当总数。 */
function screenCountLine(args, data) {
  const total = Number.isInteger(data?.total) && data.total >= 0 ? String(data.total) : '（命中数未知）'
  const shown = dicts(data?.rows).length
  const scope = `按当前有效行情统计，缺所需指标的股票不命中${args?.exclude_st === true ? '；已排除 ST' : ''}`
  return `【筛选】全市场共 ${total} 只满足条件｜本次显示 ${shown} 只（${scope}）；limit 只限制返回行数，只问数量可设 limit=1。`
}

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
  // 卡片只放最近的几十根 + 帧那天的 K：帧是盘中才叫「未收盘」，收盘帧 / 旧帧不能这么标
  const status = effectiveStatus(data?.frame)
  const liveTag = status === 'live' || status === 'lunch_break' ? '帧K·未收盘' : `帧K·${STATUS_LABEL[status] || '非实时'}`
  const tail = rows.slice(-(MAX_ROWS - (live ? 1 : 0)))
  const shown = live ? [...tail, [`${live[0]} ${liveTag}`, ...live.slice(1)]] : tail
  const name = [first.股票代码, first.股票名称].filter(Boolean).join(' ')
  const more = items.length > 1 ? `（另 ${items.length - 1} 只见文本）` : ''
  return {
    title: `日 K ${name}${more}`,
    ...table(columns, shown),
    truncated: rows.length > tail.length || items.length > 1,
    note: comparabilityNote(first.live),
  }
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
    const { title, columns, rows, truncated, note: builtNote } = build(data)
    // 表自带的说明（如日 K 的可比性）优先于服务端 note——它更要紧；note 不走 40 字的单元格截断
    const note = safeText(builtNote || (typeof data.note === 'string' ? data.note : ''), 160)
    return {
      schema: PRESENTATION_SCHEMA,
      kind: REALTIME_KIND,
      view,
      frame: frameOf(data),
      title,
      columns,
      rows,
      truncated,
      note: note || null,
    }
  } catch {
    return undefined
  }
}
