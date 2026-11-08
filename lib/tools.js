/**
 * dsh-hhxg-market — 工具定义（纯数据，不依赖宿主 API）。
 *
 * 每个条目 = { name, channel, description, parameters, … }。13 个工具全部经 hhxg MCP server 取数
 * （config.mcpToken 必填，Max 会员的 MCP Token），channel 决定走哪条通道：
 *  - "resource"：resources/read 读一份 hhxg:// 资源（uri 为字符串或 args → 字符串），render(payload, args) 把 JSON 渲染成文本；
 *  - "tool"：tools/call 调服务端正式工具（mcpName），precheck(args) 本地预检、buildArgs(args) 组参数，可选 render(text, args) 二次渲染。
 * index.js 负责把它们包成 defineTool 并 ctx.tools.register；执行统一走 runTool。
 * 输出统一为文本（markdown/JSON 字符串），由模型自行阅读。
 */

import { mcpCall, mcpReadResource, UPGRADE_URL, TOKEN_URL } from './api.js'

const DISCLAIMER = '\n\n---\n数据来自恢恢量化 hhxg.top，仅供研究参考，不构成投资建议。'

// 不可见/方向控制字符：零宽、BiDi override/isolate、Tag Block、BOM、蒙古元音分隔符。
// 这类字符可携带肉眼不可见的 prompt injection 载荷，一律删除。
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿᠎]|[\u{E0000}-\u{E007F}]/gu

/**
 * 外部文本进 markdown 前消毒：删不可见字符、压平控制字符与空白、
 * 转义表格/代码/HTML 结构字符、断开链接与图片语法（外链图片在渲染端
 * 自动发请求 = 数据外泄信道）。上游含第三方提交文本（新闻标题/题材名等）。
 */
function inline(v, limit = 0) {
  let text = String(v ?? '')
    .replace(INVISIBLE_RE, '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '｜')
    .replace(/`/g, "'")
    .replace(/</g, '＜')
    .replace(/>/g, '＞')
    .replace(/!\[/g, '! [')
    .replace(/\]\(/g, '] (')
  if (limit && text.length > limit) text = text.slice(0, limit - 1) + '…'
  return text
}

/**
 * 数值安全格式化：null/undefined/空串/布尔/数组 → "—"（Number('')=0、
 * Number([])=0 都是伪造数据，缺失必须渲染成缺失）；非数字字符串走
 * inline 消毒后截断透出（绝不裸 String()——那是消毒旁路）。
 */
function fmt(v, digits = 0) {
  if (v === null || v === undefined) return '—'
  if (typeof v !== 'number' && (typeof v !== 'string' || !v.trim())) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return inline(v, 24)
  return n.toFixed(digits)
}

/** 上游比率字段兼容：数字 0.3、字符串 "30%"、null 都归一为百分比文本。 */
function pct(v, digits = 1) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string' && v.trim().endsWith('%')) {
    const n = Number(v.trim().slice(0, -1))
    return Number.isFinite(n) ? n.toFixed(digits) + '%' : inline(v, 16)
  }
  const n = Number(v)
  return Number.isFinite(n) ? (n * 100).toFixed(digits) + '%' : inline(v, 16)
}

function asDicts(v) {
  return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : []
}

/** ISO 日期 YYYY-MM-DD → MM-DD；格式不对返回空串（不回显来路不明的字符串）。 */
function monthDay(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v.slice(5) : ''
}

/** 服务端 query_dataset 单个数据文件的解析上限（与服务端同值，仅用于目录里的提示，判定以服务端为准）。 */
const QUERY_MAX_BYTES = 300 * 1024

/**
 * 数据集格式：hhxg://datasets/index 的条目不带 format 字段，按 latest 地址的扩展名判；
 * 清单给了 format 就用清单的。
 */
function datasetFormat(it) {
  const given = String(it.format ?? '').trim().toLowerCase()
  if (given) return given
  const m = String(it.urls?.latest ?? '').match(/\.(json|csv)(?:[?#]|$)/i)
  return m ? m[1].toLowerCase() : ''
}

/**
 * 数据集目录的「可 query」一栏：✓ = JSON / CSV 且有最新快照；「过大」= 清单标明超过解析上限；
 * 「—」= 格式不支持，或只有历史分片（本插件的查询工具不带日期参数）；
 * 「筛选」= 会员专属的全市场宽表（选股快照 / 量化信号池）——不发布文件（清单标 delivery=screen_stocks，
 * 或根本没有任何文件地址），只能经 hhxg_strategy_signals 取数。
 */
function queryMark(it) {
  const urls = it.urls && typeof it.urls === 'object' ? it.urls : {}
  if ((it.access === 'member' && it.delivery === 'screen_stocks') || (!urls.latest && !urls.history_pattern)) return '筛选'
  const format = datasetFormat(it)
  if ((format !== 'json' && format !== 'csv') || !urls.latest) return '—'
  return Number.isFinite(it.size_bytes) && it.size_bytes > QUERY_MAX_BYTES ? '过大' : '✓'
}

/** 北京时间当月 YYYYMM（中国无夏令时，固定 UTC+8）。 */
export function currentMonthBeijing(now = Date.now()) {
  const bj = new Date(now + 8 * 3600 * 1000)
  return `${bj.getUTCFullYear()}${String(bj.getUTCMonth() + 1).padStart(2, '0')}`
}

/** hhxg_calendar 的 month 参数归一：YYYYMM 或 YYYY-MM → YYYYMM；缺省 / 空串为当月；其它形状返回 ''（本地拒绝）。 */
function calendarMonth(v) {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return currentMonthBeijing()
  const s = typeof v === 'string' ? v.trim().replace(/^(\d{4})-(\d{2})$/, '$1$2') : ''
  if (!/^\d{6}$/.test(s)) return ''
  const m = Number(s.slice(4))
  return m >= 1 && m <= 12 ? s : ''
}
/** 日历每个事件类型最多列几条（解禁一个月常有二三十条）。 */
const CALENDAR_GROUP_LIMIT = 25

/** search_documents 的 limit：1-50（与服务端上限同值），非数字 / 0 走默认 20。 */
function newsLimit(v) {
  return Math.min(50, Math.max(1, Math.trunc(Number(v) || 20)))
}

/** tools/call 的文本结果若是 JSON 信封则解析，否则 null（业务答复等可读文本原样透出）。 */
function parseEnvelope(text) {
  if (typeof text !== 'string' || !text.startsWith('{')) return null
  try {
    const obj = JSON.parse(text)
    return obj && typeof obj === 'object' ? obj : null
  } catch {
    return null
  }
}

// ── 服务端正式工具的参数预检 / 组装（tools/call 通道共用） ──────────────

const STOCK_CODE_PARAM = {
  type: 'string',
  description: '6 位股票代码（如 000001）或 ts_code 格式（如 000001.SZ）',
}

/** screen_stocks 目前可用的 9 个策略预设（展示用；合法值以服务端为准）。 */
const STRATEGY_PRESETS =
  'limit_up 涨停 / volume_breakout 放量突破 / low_volume_consolidation 缩量整理 / nineturn_buy 九转买入 / ' +
  'nineturn_sell 九转卖出 / kdj_overbought KDJ 超买 / kdj_oversold KDJ 超卖 / crash_warning 暴跌预警 / ' +
  'macd_golden_cross MACD 金叉'

/** 个股异动历史在通用取数 query_dataset 里的按键数据集 id。 */
const ALERTS_DATASET_ID = 'stock_alerts_history'

/** 字符串参数去首尾空白；非字符串一律当空。 */
function trimmed(v) {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * get_realtime 每个 view 转发的参数（与服务端 agent_tools/realtime.js 的 PARAMS_BY_VIEW 一致，其余忽略）；
 * 取值的权威校验在服务端，这里只挑参数、不改值。
 */
const REALTIME_PARAMS_BY_VIEW = {
  market: ['pool_limit'],
  quotes: ['codes', 'include'],
  screen: ['filters', 'sort', 'fields', 'limit', 'exclude_st'],
  fields: [],
  kline: ['codes', 'period', 'bars', 'adj', 'include_live'],
}
const REALTIME_VIEWS = Object.keys(REALTIME_PARAMS_BY_VIEW)
/** 需要 codes 的 view：缺了在本地提示，不发请求。 */
const REALTIME_VIEWS_WITH_CODES = new Set(['quotes', 'kline'])
const REALTIME_VIEW_HINT =
  '请提供 view：market（市场概况）/ quotes（指定个股，需 codes）/ screen（全市场筛选）/ fields（可用字段与示例）/ kline（日 K 序列，需 codes）。'

/** codes 允许模型传成 "600519,000001" 这样的字符串：拆成数组再发，省一次参数错误往返。 */
function realtimeCodes(v) {
  if (typeof v === 'string') return v.split(/[\s,，、]+/).filter(Boolean)
  return v
}

function realtimeView(a) {
  const view = trimmed(a?.view)
  return Object.hasOwn(REALTIME_PARAMS_BY_VIEW, view) ? view : ''
}

// 与服务端同值的硬上限（EdgeOne agent_tools/realtime.js + VPS realtime.py）：本地先拒明显越界的请求，
// 省一次往返与配额；权威校验仍在服务端。文案沿用业务答复格式「参数有误：…（CODE）」。
const REALTIME_MAX_CODES = { quotes: 30, kline: 5 }
const KLINE_BARS = { default: 120, min: 1, max: 260 }
const KLINE_MAX_TOTAL_BARS = 1000
const localArgError = (msg, code = 'INVALID_ARG') => `参数有误：${msg}（${code}）`

/** 本地边界预检（view 与缺 codes 之后）：越界返回说明文字，合法返回 null。 */
function realtimeBoundsRefusal(view, codes, a) {
  const cap = REALTIME_MAX_CODES[view]
  // 原始数组长度先判（服务端 _str_list 也是去重前查长度），全是重复项也照拒
  if (cap && Array.isArray(codes) && codes.length > cap) {
    return localArgError(`view=${view} 的 codes 最多 ${cap} 只（收到 ${codes.length} 只），请减少 codes`)
  }
  if (view !== 'kline') return null
  const bars = a?.bars === undefined || a?.bars === null ? KLINE_BARS.default : a.bars
  // 字符串 "60"、布尔、小数都不是合法整数：不替模型强转，让它改
  if (!Number.isInteger(bars) || bars < KLINE_BARS.min || bars > KLINE_BARS.max) {
    return localArgError(`bars 须为 ${KLINE_BARS.min}–${KLINE_BARS.max} 的整数（默认 ${KLINE_BARS.default}）`)
  }
  // 乘积按服务端 _codes 的去重规则算：trim + 转大写后去重（"600519" 与 "600519.SH" 仍是两个，不替它合并）
  const unique = new Set(codes.map((c) => String(c).trim().toUpperCase()).filter(Boolean)).size
  if (unique * bars > KLINE_MAX_TOTAL_BARS) {
    return localArgError(`codes × bars 不能超过 ${KLINE_MAX_TOTAL_BARS} 根，请减少 codes 或 bars`, 'RESULT_TOO_LARGE')
  }
  return null
}

// 盘后条件选股（screen_stocks）：op 与条数上限与服务端同值；字段名 / 取值语义 / 预设展开 / 档位仍由服务端判
const SCREEN_OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'in', 'contains', 'not_null']
const SCREEN_MAX_FILTERS = 8
// 两列比较 field op ref × scale：与服务端 stock_filters.ref_compare 同口径（只有大小关系，倍数 (0, 100]）
const SCREEN_REF_OPS = ['gt', 'gte', 'lt', 'lte']
const SCREEN_MAX_SCALE = 100
const given = (v) => v !== undefined && v !== null
// 多值列存成 |a|b|：服务端对 ne / eq / in 按整串比较，取反会静默命中几乎全市场，本地只放行 contains / not_null
const SCREEN_TAG_FIELDS = new Set(['题材概念', '股票池', '持股标签', '游资席位'])
const SCREEN_TAG_OPS = ['contains', 'not_null']
const SCREEN_HINT =
  '请提供筛选方式之一：list_fields=true（先看可筛字段与类型）；filters=[{field, op, value}]（条件筛选，如 {field:"日均线多头", op:"eq", value:1}；传 [] 看全市场）；' +
  `strategy_id（策略预设：${STRATEGY_PRESETS}）。`

/** value 按 schema 只能是数字 / 字符串 / 两者的数组（或省略）；对象、布尔是明显写错，不必发给服务端。 */
function screenValueOk(v) {
  if (v === undefined || v === null || typeof v === 'number' || typeof v === 'string') return true
  return Array.isArray(v) && v.every((x) => typeof x === 'number' || typeof x === 'string')
}

/** 两列比较的形状（写了 ref 才查）：不对返回说明文字。两列是否存在、是否数值列由服务端判。 */
function screenRefRefusal(f, op, i) {
  const at = `filters 第 ${i + 1} 条`
  if (!given(f.ref)) return given(f.scale) ? localArgError(`${at}的 scale 只和 ref 一起用（field op ref × scale）`) : null
  if (!trimmed(f.ref)) return localArgError(`${at}的 ref 须为另一个数值字段名`)
  if (trimmed(f.ref) === trimmed(f.field)) return localArgError(`${at}的 ref 不能和 field 是同一个字段`)
  if (!SCREEN_REF_OPS.includes(op)) return localArgError(`${at}是两列比较，op 只能用 ${SCREEN_REF_OPS.join('/')}`)
  if (given(f.value)) return localArgError(`${at}写了 ref 就不要写 value`)
  const s = f.scale
  if (given(s) && !(typeof s === 'number' && Number.isFinite(s) && s > 0 && s <= SCREEN_MAX_SCALE)) {
    return localArgError(`${at}的 scale 须为大于 0、不超过 ${SCREEN_MAX_SCALE} 的数字（默认 1）`)
  }
  return null
}

/**
 * filters 的形状预检：非法返回说明文字（不发请求），合法或未传返回 null。不删除非法条件后继续查。
 * op 只转小写不 trim（服务端 validateFilters 同样只 toLowerCase），本地放过的服务端也会放过。
 */
function screenFiltersRefusal(filters) {
  if (filters === undefined || filters === null) return null
  if (!Array.isArray(filters)) return localArgError('filters 须为 [{field, op, value}] 数组')
  if (filters.length > SCREEN_MAX_FILTERS) {
    return localArgError(`filters 最多 ${SCREEN_MAX_FILTERS} 条（收到 ${filters.length} 条）`)
  }
  for (const [i, f] of filters.entries()) {
    const op = typeof f?.op === 'string' ? f.op.toLowerCase() : ''
    if (!f || typeof f !== 'object' || Array.isArray(f) || !trimmed(f.field) || !SCREEN_OPS.includes(op)) {
      return localArgError(`filters 第 ${i + 1} 条须为 {field, op, value}，op 取 ${SCREEN_OPS.join('/')}`)
    }
    if (!screenValueOk(f.value)) {
      return localArgError(`filters 第 ${i + 1} 条的 value 须为数字、字符串或它们的数组（op=not_null 时省略）`)
    }
    const field = trimmed(f.field)
    if (SCREEN_TAG_FIELDS.has(field) && !SCREEN_TAG_OPS.includes(op)) {
      return localArgError(`filters 第 ${i + 1} 条的 ${field} 是多值列，只能用 contains（按名称）或 not_null，不支持取反（eq / in 按整串比较，ne 会命中几乎全市场）`)
    }
    const refBad = screenRefRefusal(f, op, i)
    if (refBad) return refBad
  }
  return null
}

/** 两个选股工具共用的 ref / scale 参数（defineTool 要求嵌套属性逐个声明）。 */
const SCREEN_REF_PARAMS = {
  ref: {
    type: 'string',
    description: '两列比较：和 field 比的另一个数值字段（写了 ref 就不写 value），条件是 field op ref × scale，op 只能 gt/gte/lt/lte',
  },
  scale: { type: 'number', description: '两列比较时 ref 的倍数，默认 1，范围 (0, 100]（例 1.05 = 高出 5%）' },
}

/** cursor 只认上一页返回的 next_cursor：字符串原样，整数转成字符串（模型常把 "20" 回传成 20），其它类型拒绝。 */
function screenCursor(v) {
  if (typeof v === 'string') return { cursor: v.trim() }
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return { cursor: String(v) }
  if (v === undefined || v === null) return { cursor: '' }
  return { error: localArgError('cursor 须为上一页返回的 next_cursor（字符串）') }
}

// ── 工具注册表（13 个；前 7 个读 KB / 日历 / 数据集索引资源或调 search_documents，后 6 个调服务端正式工具） ──

export const TOOLS = [
  {
    name: 'hhxg_snapshot',
    channel: 'resource',
    uri: 'hhxg://kb/snapshot',
    description:
      'A股日报快照：市场情绪指数、涨停/炸板统计、连板天梯、热门题材资金、行业资金流向、游资龙虎榜、焦点财经新闻。每个交易日盘后约 20:00 更新；非交易日返回最近一个交易日。不带参数即返回全景概览。',
    parameters: {},
    // KB scope=snapshot 即 skill_snapshot.json（schema_version 3）：数据在信封顶层
    render(d) {
      const m = d.market || {}
      const lines = [
        `# A股日报快照（${inline(d.date || '?', 20)}）`,
        '',
        `市场情绪指数: ${fmt(m.sentiment_index, 1)}（${inline(m.sentiment_label || '—')}）` +
          ` · 涨停 ${fmt(m.limit_up)} · 炸板 ${fmt(m.fried)} · 跌停 ${fmt(m.limit_down)}` +
          ` · 连板晋级率 ${pct(m.promotion_rate)}`,
        '',
      ]
      const ladder = d.ladder || {}
      // top_streak 线上为对象 {name, boards, industry}；也兼容对象数组与字符串形态
      const ts = ladder.top_streak
      const topStreak = Array.isArray(ts)
        ? asDicts(ts).map((s) => inline(s.name)).filter(Boolean).join('、')
        : ts && typeof ts === 'object'
          ? [inline(ts.name), ts.boards != null ? `${fmt(ts.boards)} 板` : ''].filter(Boolean).join(' ')
          : typeof ts === 'string' ? inline(ts) : ''
      lines.push(
        `连板天梯: 涨停共 ${fmt(ladder.total_limit_up)} 家，最高 ${fmt(ladder.max_streak)} 连板` +
          (topStreak ? `（${topStreak}）` : ''),
        '',
      )
      const themes = asDicts(d.hot_themes)
      if (themes.length) {
        lines.push('## 热门题材', '| 题材 | 涨停数 | 净流入(亿) | 代表股 |', '|---|---|---|---|')
        for (const t of themes.slice(0, 8)) {
          const tops = asDicts(t.top_stocks).map((s) => inline(s.name)).slice(0, 3).join('、')
          lines.push(`| ${inline(t.name)} | ${fmt(t.limitup_count)} | ${fmt(t.net_yi, 1)} | ${tops} |`)
        }
        lines.push('')
      }
      for (const grp of asDicts(d.sectors)) {
        const strong = asDicts(grp.strong)
        if (!strong.length) continue
        lines.push(`## ${inline(grp.label || '行业')}资金流入 TOP`, '| 名称 | 净流入(亿) | 龙头 |', '|---|---|---|')
        for (const s of strong.slice(0, 6)) {
          lines.push(`| ${inline(s.name)} | ${fmt(s.net_yi, 1)} | ${inline(s.leader || '—')} |`)
        }
        lines.push('')
      }
      const hm = d.hotmoney || {}
      // top_net_buy 才带席位级 net_yi；seats 的 net_yi 在个股层，需求和
      const seats = asDicts(hm.top_net_buy).length
        ? asDicts(hm.top_net_buy)
        : asDicts(hm.seats).map((s) => ({
            name: s.name,
            net_yi: asDicts(s.stocks).reduce((acc, st) => {
              const n = Number(st.net_yi)
              return Number.isFinite(n) ? acc + n : acc
            }, 0),
          }))
      if (seats.length) {
        lines.push(`## 龙虎榜净买 TOP（游资净买合计 ${fmt(hm.total_net_yi, 1)} 亿）`)
        for (const s of seats.slice(0, 5)) {
          lines.push(`- ${inline(s.name)}: 净买 ${fmt(s.net_yi, 2)} 亿`)
        }
        lines.push('')
      }
      const news = asDicts(d.focus_news).concat(asDicts(d.macro_news))
      if (news.length) {
        lines.push('## 焦点新闻')
        for (const n of news.slice(0, 8)) {
          lines.push(`- [${inline(n.cat || '')}] ${inline(n.title, 120)}`)
        }
      }
      const ai = d.ai_summary
      if (ai && typeof ai === 'object') {
        // cta 是站内导流句，不是市场简评
        const parts = Object.entries(ai).filter(([k, x]) => k !== 'cta' && typeof x === 'string' && x.trim()).map(([, x]) => x)
        if (parts.length) lines.push('', '## AI 市场简评', parts.map((p) => `- ${inline(p, 200)}`).join('\n'))
      }
      return lines.join('\n') + DISCLAIMER
    },
  },
  {
    name: 'hhxg_news',
    channel: 'tool',
    mcpName: 'search_documents',
    description: '最新A股财经快讯（每小时滚动更新），含频道与来源，按时间倒序。limit 控制条数（1-50，默认 20）。',
    parameters: {
      limit: { type: 'number', description: '返回条数，1-50，默认 20' },
    },
    buildArgs: (a) => ({ kind: 'news', limit: newsLimit(a?.limit) }),
    // search_documents 返回 { kind, window, total, returned, items, next_cursor }，items 是摘要级字段
    // { published_at, channel, title, source }
    render(text) {
      const env = parseEnvelope(text)
      if (!env) return text
      const d = env.data && typeof env.data === 'object' ? env.data : {}
      const items = asDicts(d.items)
      if (!items.length) return '暂无快讯数据。' + DISCLAIMER
      const win = d.window && typeof d.window === 'object' ? `${inline(d.window.from, 10)} ~ ${inline(d.window.to, 10)}` : ''
      const total = Number.isInteger(d.total) && d.total > items.length ? `，窗口内共 ${d.total} 条` : ''
      const lines = [`# 财经快讯（最新 ${items.length} 条${total}${win ? `，${win}` : ''}）`, '']
      for (const it of items) {
        // "2026-08-27T19:24:25" / "2026-08-27 19:24:25" → "08-27 19:24"
        const ts = inline(it.published_at || '').replace('T', ' ').slice(5, 16)
        const src = it.source ? `（${inline(it.source, 20)}）` : ''
        lines.push(`- ${ts || '—'} [${inline(it.channel || '')}] ${inline(it.title, 140)}${src}`)
      }
      return lines.join('\n') + DISCLAIMER
    },
  },
  {
    name: 'hhxg_margin',
    channel: 'resource',
    uri: 'hhxg://kb/margin',
    description: '近 7 个交易日融资融券：全市场融资/融券/两融余额逐日走势 + 融资增减 TOP 个股（亿元）。',
    parameters: {},
    // KB scope=margin（recent_margin_7d.json，schema_version 2）
    render(d) {
      const days = asDicts(d.market?.daily_totals)
      if (!days.length) return '暂无两融数据。' + DISCLAIMER
      const win = d.window && typeof d.window === 'object' && d.window.start && d.window.end
        ? `，${inline(d.window.start, 10)} ~ ${inline(d.window.end, 10)}`
        : ''
      const lines = [`# 融资融券（近 ${days.length} 交易日${win}，单位亿元）`, '', '| 日期 | 融资余额 | 融券余额 | 两融合计 |', '|---|---|---|---|']
      for (const row of days) {
        lines.push(`| ${inline(row.date)} | ${fmt(row.rzye_yi, 1)} | ${fmt(row.rqye_yi, 1)} | ${fmt(row.rzrqye_yi, 1)} |`)
      }
      const top = d.top || {}
      const buckets = [
        ['increase_rzye', '融资净增 TOP'],
        ['decrease_rzye', '融资净减 TOP'],
      ]
      for (const [key, label] of buckets) {
        const rows = asDicts(top[key])
        if (!rows.length) continue
        lines.push('', `## ${label}`, '| 股票 | 最新融资余额 | 窗口增减 | 幅度 |', '|---|---|---|---|')
        for (const r of rows.slice(0, 5)) {
          lines.push(`| ${inline(r.name)}(${inline(r.code)}) | ${fmt(r.latest_rzye_yi, 1)} | ${fmt(r.delta_rzye_yi, 2)} | ${fmt(r.delta_pct, 2)}% |`)
        }
      }
      return lines.join('\n') + DISCLAIMER
    },
  },
  {
    name: 'hhxg_calendar',
    channel: 'resource',
    uri: (a) => `hhxg://calendar/${calendarMonth(a?.month)}`,
    description:
      'A股月度投资者事件日历：限售解禁、分红除权、新股申购 / 上市、可转债上市、股指期货 / ETF 期权 / 富时 A50 交割、LPR 报价日、央行回笼、国债逆回购、MSCI 审议等，按事件类型分组。' +
      'month 为 YYYYMM（如 202611），默认当月（北京时间）。',
    parameters: {
      month: { type: 'string', description: '月份 YYYYMM（如 202611），默认当月（北京时间）' },
    },
    precheck: (a) => (calendarMonth(a?.month) ? null : localArgError('month 须为 YYYYMM（如 202611），默认当月')),
    // hhxg://calendar/{yyyymm} → { yyyymm, events: [{ date, type, label, description, items, metrics }] }
    render(d, a) {
      const head = `# A股投资者事件日历（${inline(d.yyyymm || calendarMonth(a?.month), 6)}）`
      const events = asDicts(d.events)
      if (!events.length) return head + '\n\n该月暂无事件。' + DISCLAIMER
      // 按事件类型分组（type 为键、label 为标题）：组按首个事件出现顺序，组内保持服务端的日期顺序
      const groups = new Map()
      for (const ev of events) {
        const key = String(ev.type ?? ev.label ?? '其他')
        if (!groups.has(key)) groups.set(key, { label: inline(ev.label || ev.type || '其他', 20), rows: [] })
        groups.get(key).rows.push(ev)
      }
      const lines = [head, '', `事件共 ${events.length} 条，按类型分组：`]
      for (const { label, rows } of groups.values()) {
        lines.push('', `## ${label}（${rows.length} 条）`)
        for (const ev of rows.slice(0, CALENDAR_GROUP_LIMIT)) {
          lines.push(`- ${monthDay(ev.date) || '—'} ${inline(ev.description || ev.label, 160)}`)
        }
        if (rows.length > CALENDAR_GROUP_LIMIT) lines.push(`…（共 ${rows.length} 条，仅列前 ${CALENDAR_GROUP_LIMIT}）`)
      }
      return lines.join('\n') + DISCLAIMER
    },
  },
  {
    name: 'hhxg_sentiment',
    channel: 'resource',
    uri: 'hhxg://kb/sentiment',
    description: '近 7 个交易日市场情绪走势：逐日涨停家数、最高连板、连板分布、热门行业与热门概念。',
    parameters: {},
    // KB scope=sentiment（recent_sentiment_7d.json）
    render(d) {
      const days = asDicts(d.days)
      if (!days.length) return '暂无情绪数据。' + DISCLAIMER
      const lines = ['# 市场情绪（近 7 交易日）', '', '| 日期 | 涨停家数 | 最高连板 | 热门行业 | 热门概念 |', '|---|---|---|---|---|']
      for (const day of days) {
        const inds = asDicts(day.top_industries).slice(0, 3).map((x) => inline(x.name)).join('、')
        const cons = asDicts(day.top_concepts).slice(0, 3).map((x) => inline(x.name)).join('、')
        lines.push(`| ${inline(day.date)} | ${fmt(day.limit_up_count)} | ${fmt(day.max_lianban)} | ${inds} | ${cons} |`)
      }
      return lines.join('\n') + DISCLAIMER
    },
  },
  {
    name: 'hhxg_datasets',
    channel: 'resource',
    uri: 'hhxg://datasets/index',
    description:
      '列出 hhxg.top 全部数据集的 id / 分类 / 标题 / 格式 / 更新频率，并标出哪些能用 hhxg_query_dataset 查询。' +
      '调用 hhxg_query_dataset 前先用本工具查合法的 dataset_id。可用 category 过滤（如 ETF、选股、情绪）。',
    parameters: {
      category: { type: 'string', description: '按分类过滤（子串匹配，留空返回全部）' },
    },
    // hhxg://datasets/index → { total, generated_at, datasets: [{ id, category, title, urls, schema_url, readme_url, update_sla, last_updated_at }] }
    render(d, a) {
      let items = asDicts(d.datasets)
      if (!items.length) return '暂无数据集目录。' + DISCLAIMER
      const kw = String(a?.category ?? '').trim()
      if (kw) items = items.filter((it) => String(it.category ?? '').includes(kw) || String(it.title ?? '').includes(kw))
      if (!items.length) return `没有匹配「${inline(kw, 30)}」的数据集。可留空参数查看全部。` + DISCLAIMER
      const total = Number.isInteger(d.total) ? d.total : Number.isInteger(d.dataset_count) ? d.dataset_count : '?'
      const lines = [
        `# hhxg 数据集目录（${items.length}/${total} 个）`,
        '',
        '| id | 分类 | 标题 | 格式 | 更新 | 可 query |',
        '|---|---|---|---|---|---|',
      ]
      for (const it of items) {
        lines.push(
          `| ${inline(it.id, 40)} | ${inline(it.category, 20)} | ${inline(it.title, 40)} | ` +
          `${inline(datasetFormat(it) || '—', 10)} | ${inline(it.update_sla?.frequency, 16) || '—'} | ${queryMark(it)} |`,
        )
      }
      lines.push(
        '',
        '「可 query」：✓ 可用 hhxg_query_dataset 过滤查询（JSON 与 300KB 以内的 CSV）；' +
        '「过大」是清单标明单个文件超过 300KB，服务端不解析（CSV 会返回下载地址）；「—」是只有历史分片或格式不支持；' +
        '「筛选」是会员专属的全市场宽表，不提供下载，请用 hhxg_strategy_signals：list_fields=true 查看字段，filters 自定义筛选，strategy_id 用策略预设。',
      )
      return lines.join('\n') + DISCLAIMER
    },
  },
  {
    name: 'hhxg_themes',
    channel: 'resource',
    uri: 'hhxg://kb/theme',
    description: '当日题材概念热度榜（TOP 30）：游资参与数、当日涨停数、涨停占比。判断市场主线方向用。',
    parameters: {},
    // KB scope=theme（recent_theme_latest.json）
    render(d) {
      // 上游榜单偶有同名重复行，按名去重保留首见（上游已按热度排序）
      const seen = new Set()
      const items = asDicts(d.items).filter((it) => {
        const key = String(it.name ?? '')
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (!items.length) return '暂无题材数据。' + DISCLAIMER
      const lines = [`# 题材热度榜（${inline(d.latest_date || '?')} · TOP ${Math.min(30, items.length)}）`, '', '| 排名 | 题材 | 游资参与 | 当日涨停 | 涨停占比 |', '|---|---|---|---|---|']
      items.slice(0, 30).forEach((it, i) => {
        lines.push(`| ${i + 1} | ${inline(it.name)} | ${fmt(it.yz)} | ${fmt(it.zt)} | ${pct(it.ratio)} |`)
      })
      return lines.join('\n') + DISCLAIMER
    },
  },
  {
    name: 'hhxg_diagnose_stock',
    channel: 'tool',
    mcpName: 'diagnose_stock',
    description:
      '个股综合诊断：日/周/月技术指标、异动评级、两融趋势、龙虎榜、涨停、大宗交易、公告、概念标签 + 全市场榜单命中 + 相关新闻。',
    parameters: { stock_code: { ...STOCK_CODE_PARAM, required: true } },
    buildArgs: (a) => ({ stock_code: String(a?.stock_code || '') }),
  },
  {
    name: 'hhxg_strategy_signals',
    channel: 'tool',
    mcpName: 'screen_stocks',
    description:
      'A 股条件选股 / 指标筛选 / 全市场命中计数（最新盘后快照，约 270 列：行情、估值、财务、筹码、涨停连板、两融、日 / 周 / 月技术指标与派生条件列，' +
      '以及题材概念、股票池、持股标签、游资席位、行业 / 地域 / 市场类型、上市天数、股东集中度、大宗等基本信息）。' +
      '数据是最近一个交易日收盘后的盘后快照，不含今天盘中行情：交易日 9:30 之后用户问「最新价 / 现价 / 盘中 / 实时 / 现在 / 今天」或要按当前价格筛选时，改用 hhxg_realtime view=screen' +
      '（filters 写法相同，同样支持两列比较与题材概念 contains，价格字段叫 最新价）；' +
      '本工具用于盘后复盘，以及条件里要用财务 / 筹码 / 两融 / 派生布尔列（日均线多头、日MACD金叉 等）这些盘中没有的列时。' +
      '不确定字段名先传 list_fields=true 查看可筛字段与类型；再用 filters 筛选（最多 8 条，全部满足才入选）。' +
      '和常量比写 {field, op, value}：如日线均线多头排列 {field:"日均线多头", op:"eq", value:1}（含义 MA5>MA10>MA20>MA60）、MACD 金叉 {field:"日MACD金叉", op:"eq", value:1}、' +
      '周线低位 {field:"周波段位置%", op:"gte", value:0} 加 {field:"周波段位置%", op:"lte", value:20}（波段位置 0=波谷、100=波峰，跌破波谷为负，找低位须带下界）。' +
      '两个数值字段互相比写 {field, op, ref, scale}，含义 field op ref × scale（scale 默认 1，op 只能 gt/gte/lt/lte）：' +
      '如站上 20 日线 {field:"收盘价", op:"gt", ref:"MA20"}、再高出 5% 加 scale:1.05、突破布林上轨 {field:"收盘价", op:"gt", ref:"BOLL上"}；' +
      'MA5 上穿 MA10 写两条 {field:"MA5", op:"gt", ref:"MA10"} 与 {field:"MA5_prev", op:"lte", ref:"MA10_prev"}。' +
      '题材概念、股票池、持股标签、游资席位是多值列，只能用 contains 按名称筛（如 {field:"题材概念", op:"contains", value:"算力"}）或 not_null，不支持取反；' +
      '文本列取值以 list_fields 的 values 为准（如 企业类型 是实控人性质，民营公司多数记为 自然人，按 民营企业 筛几乎没有）。' +
      '能写成 filters 的条件（包括两列比较）一次交给本工具筛完，不要翻页取回全部行再自己比较——自己比会漏、总数也对不上；' +
      '只有 OR、分位数这类写不出来的条件才需要取回后自行处理，并在回答里说明。' +
      '响应 total 是全市场满足条件的股票数，limit（1-100，默认 20）只控制返回行数——只问「有多少只」可设 limit=1；用 next_cursor 翻页。' +
      'sort 前缀 - 为降序，fields 选返回列（最多 12）；显式传 filters=[] 表示不加条件看全市场。' +
      `strategy_id 可选，为策略预设（与 filters 取交集，展开后合计最多 8 条）；可用 9 个预设：${STRATEGY_PRESETS}。` +
      '另 3 个（oversold_rebound / macd_death_cross / distribution）暂不能作为预设，会返回 PRESET_NOT_SUPPORTED；' +
      '前两个可直接写成 filters：超跌反弹 = 涨跌幅% gt 0、RSI6 lt 30、收盘价 gt ref=BOLL下；MACD 死叉 = MACD_DIF lt ref=MACD_DEA 且 MACD_DIF_prev gte ref=MACD_DEA_prev；' +
      'distribution 需要分位数，写不出来。' +
      '全市场指标全表（quant_signal_pool）为会员数据，不提供下载地址，自定义条件就用本工具的 filters。' +
      '站点查询服务离线时只剩约 24 列的静态快照：题材概念等基本信息列、MA60 / BOLL 这类列和部分预设会报错（UNKNOWN_FIELD / PRESET_UNAVAILABLE），稍后重试即可。',
    parameters: {
      list_fields: { type: 'boolean', description: '为 true 时只返回可筛字段清单（名称 + 类型），不做筛选；不确定字段名时先调它' },
      filters: {
        type: 'array',
        description: '筛选条件，最多 8 条，全部满足才入选；字段名原样取自 list_fields；显式传 [] 表示不加条件看全市场',
        items: {
          type: 'object',
          // defineTool 硬校验：嵌套 object 必须显式写 additionalProperties，否则整个插件装载失败
          additionalProperties: false,
          properties: {
            field: { type: 'string', required: true, description: '字段名（如 日均线多头、涨跌幅%、周MACD_HIST、行业）' },
            op: { type: 'string', required: true, enum: SCREEN_OPS },
            value: {
              oneOf: [
                { type: 'number' },
                { type: 'string' },
                { type: 'array', items: { oneOf: [{ type: 'number' }, { type: 'string' }] } },
              ],
              description: '比较值：数值字段用数字（派生布尔列 1 / 0）；文本字段用字符串（contains 为子串）；op=in 为数组（最多 20 个）；op=not_null 或写了 ref 时省略',
            },
            ...SCREEN_REF_PARAMS,
          },
        },
      },
      strategy_id: { type: 'string', description: '策略预设标识（可选，见工具描述）；与 filters 取交集' },
      sort: { type: 'string', description: '排序字段，前缀 - 为降序，如 -涨跌幅%' },
      fields: { type: 'array', items: { type: 'string' }, description: '返回列（最多 12），默认 代码 / 名称 / 行业 / 收盘价 / 涨跌幅 / 换手 / 量比 / 市值 / PE / 九转' },
      limit: { type: 'number', description: '每页返回条数 1-100，默认 20；只问数量可设 1' },
      cursor: { type: 'string', description: '上一页返回的 next_cursor（翻页时其余参数保持不变）' },
    },
    // 什么都没给（或只给了 cursor / sort / fields / limit）不能发出去：screen_stocks 会返回未经筛选的全市场前 N 行；
    // 显式 filters=[] 是有意看全市场，放行。filters 形状非法按参数错误处理，不当成「没传」。
    precheck: (a) => {
      if (a?.list_fields === true) return null
      const bad = screenFiltersRefusal(a?.filters) || screenCursor(a?.cursor).error
      if (bad) return bad
      if (trimmed(a?.strategy_id) || Array.isArray(a?.filters)) return null
      const stray = ['cursor', 'sort', 'fields', 'limit'].filter((k) => a?.[k] !== undefined && a?.[k] !== null)
      return (stray.length ? `只传了 ${stray.join(' / ')}，缺少筛选条件。` : '') + SCREEN_HINT
    },
    // 白名单透传，不改写条件值（value:0、in 数组、cursor 原样）；越界 limit 丢弃走服务端默认
    buildArgs: (a) => {
      const out = {}
      const preset = trimmed(a?.strategy_id)
      if (preset) out.preset = preset
      if (Array.isArray(a?.filters)) out.filters = a.filters
      const sort = trimmed(a?.sort)
      if (sort) out.sort = sort
      if (Array.isArray(a?.fields)) out.fields = a.fields.filter((f) => typeof f === 'string' && f.trim())
      const limit = Math.trunc(Number(a?.limit))
      if (Number.isFinite(limit) && limit >= 1 && limit <= 100) out.limit = limit
      const { cursor } = screenCursor(a?.cursor)
      if (cursor) out.cursor = cursor
      if (typeof a?.list_fields === 'boolean') out.list_fields = a.list_fields
      return out
    },
  },
  {
    name: 'hhxg_predict_lianban',
    channel: 'tool',
    mcpName: 'predict_lianban_promotion',
    description: '预测当日涨停连板股的次日晋级率（3 因子规则模型：题材热度/行业热度/板高强度）。仅对当日上榜涨停股有效。',
    parameters: { stock_code: { ...STOCK_CODE_PARAM, required: true } },
    buildArgs: (a) => ({ stock_code: String(a?.stock_code || '') }),
  },
  {
    name: 'hhxg_stock_alerts',
    channel: 'tool',
    mcpName: 'query_dataset',
    description: '个股近 30 日异动历史（普通/临近严重/严重异动逐日记录，含涨跌幅与累计偏离）。days 为自然日窗口 1-30。',
    parameters: {
      stock_code: { ...STOCK_CODE_PARAM, required: true },
      days: { type: 'number', description: '自然日窗口 1-30，默认 30' },
    },
    // 服务端的报错说的是 key（通用取数的参数名），缺参在本地用本工具的参数名提示
    precheck: (a) => (trimmed(a?.stock_code) ? null : '请提供 stock_code（6 位股票代码，如 600519 或 600519.SH）。'),
    buildArgs: (a) => {
      const out = { dataset_id: ALERTS_DATASET_ID, key: trimmed(a?.stock_code) }
      const days = Math.trunc(Number(a?.days))
      if (Number.isFinite(days) && days >= 1 && days <= 30) out.days = days
      return out
    },
  },
  {
    name: 'hhxg_query_dataset',
    channel: 'tool',
    mcpName: 'query_dataset',
    description:
      '对 hhxg 数据集（JSON 与 300KB 以内的 CSV）做过滤/排序/截断查询。先用 hhxg_datasets 查合法 dataset_id 与是否可查。filters 为字段→值精确匹配（值为数组时 OR），sort 前缀 - 表示降序，limit 最大 500。',
    parameters: {
      dataset_id: { type: 'string', description: '数据集 ID', required: true },
      filters: { type: 'object', description: '字段→值/值数组的精确匹配', additionalProperties: true },
      sort: { type: 'string', description: '排序字段，- 前缀降序' },
      limit: { type: 'number', description: '返回条数上限（1-500）' },
    },
    buildArgs: (a) => {
      const out = { dataset_id: String(a?.dataset_id || '') }
      if (a?.filters && typeof a.filters === 'object') out.filters = a.filters
      if (typeof a?.sort === 'string' && a.sort) out.sort = a.sort
      const limit = Math.trunc(Number(a?.limit))
      if (Number.isFinite(limit) && limit >= 1 && limit <= 500) out.limit = limit
      return out
    },
  },
  {
    name: 'hhxg_realtime',
    channel: 'tool',
    mcpName: 'get_realtime',
    description:
      '盘中实时数据（交易日 9:30–15:00 约 1 分钟一帧，盘后返回当日收盘帧）。' +
      '交易时段的选股 / 筛选 / 计数问题优先用 view=screen，不要先用盘后的 hhxg_strategy_signals（那是上一交易日收盘的快照，会把「最新价」答成收盘价）；' +
      'view=market：市场宽度（涨跌家数、涨停 / 跌停 / 炸板家数、炸板率、成交额）+ 涨停池 / 炸板池 / 跌停池 + 连板晋级率；' +
      'view=quotes：codes（最多 30 只）的最新价、涨跌幅、量比、封单、成交额、开高低等，include 选 daily / weekly / monthly 指标' +
      '（MA / BBI / MACD / KDJ / RSI / BOLL / CCI / 九转等，按最新价把今天当未走完的 K 线计算，收盘前会变）；' +
      'view=screen：全市场按 filters [{field, op, value}] 筛选（最多 8 条，op：gt/gte/lt/lte/eq/ne/in/contains/not_null；' +
      '两列比较写 {field, op, ref, scale} 即 field op ref × scale，如 {field:"最新价", op:"gt", ref:"MA20"}，两个字段须同为实时字段或同为盘后属性列；' +
      '题材概念、股票池等盘后属性列用 contains），' +
      'sort 字段名前加 - 为降序，fields 选返回列（最多 12），limit 1-100 且没有翻页（命中超过 100 时加条件收窄或用 sort 取最关心的前 100），exclude_st 排除 ST；' +
      '响应 total 是当前有效行情范围内的全市场命中数，limit 只限制返回行数，只问数量可设 limit=1；周 / 月指标字段名加前缀「周」「月」（如 周MACD_HIST）；' +
      'view=fields：全部可用字段、取值说明与示例，不确定字段名时先调它；' +
      'view=kline：codes（最多 5 只）的日 K 序列——rows 为已完成交易日（period 只支持 day，bars 1-260 默认 120，codes × bars ≤ 1000，adj=qfq 前复权 / none 不复权，' +
      '单位 元 / 股 / 元，缺值 null），live 为实时帧那天未走完的 K（最新价当收盘价）；live.comparable 只有 true 才可与 rows 拼接，' +
      'false = 疑似除权 / 价格基准不一致，null = 无法判断（缓存滞后 / 个股停牌 / 日历不可用，原因见 live.reason，缓存状态见 history）。' +
      '结果文本首行会标出帧的时效与交易日；每个结果都带 frame.status（live 盘中 / lunch_break 午休 / closed 收盘帧 / previous_session 非今日 / stale 延迟），' +
      '不是 live 就不是此刻的数据，引用时注明帧日期；盘中价格是最新价不是收盘价；' +
      'MA / BBI / MACD / KDJ 等指标按最新价把帧交易日当天当作未走完的 K 线计算，不是上一交易日收盘的指标（indicators.base_date 只是历史基准日，结果的【口径】行已写明）。',
    parameters: {
      view: { type: 'string', enum: REALTIME_VIEWS, required: true, description: 'market 市场概况 / quotes 指定个股 / screen 全市场筛选 / fields 字段清单 / kline 日 K 序列' },
      codes: { type: 'array', items: { type: 'string' }, description: 'view=quotes：6 位代码或 600519.SH 格式，最多 30 只；view=kline 最多 5 只' },
      period: { type: 'string', enum: ['day'], description: 'view=kline：K 线周期，目前只支持 day' },
      bars: { type: 'integer', description: 'view=kline：返回最近几个交易日 1-260，默认 120；codes × bars ≤ 1000' },
      adj: { type: 'string', enum: ['none', 'qfq'], description: 'view=kline：qfq 前复权（默认）/ none 不复权' },
      include_live: { type: 'boolean', description: 'view=kline：是否附今天这根未走完的 K，默认 true' },
      include: {
        type: 'array',
        items: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
        description: 'view=quotes：附带的指标组，默认 ["daily"]；传 [] 只要行情',
      },
      filters: {
        type: 'array',
        description: 'view=screen：筛选条件，最多 8 条，全部满足才入选',
        items: {
          type: 'object',
          // defineTool 硬校验：嵌套 object 必须显式写 additionalProperties，否则整个插件装载失败
          additionalProperties: false,
          properties: {
            field: { type: 'string', required: true, description: '字段名，见 view=fields（如 涨跌幅、量比、MACD_HIST、周RSI6）' },
            op: { type: 'string', required: true, enum: SCREEN_OPS },
            value: {
              oneOf: [
                { type: 'number' },
                { type: 'string' },
                { type: 'array', items: { oneOf: [{ type: 'number' }, { type: 'string' }] } },
              ],
              description: '比较值：数字；op=in 时为数组；文本字段（涨停状态 / 跌停状态）为字符串；op=contains 用于题材概念等盘后属性；op=not_null 或写了 ref 时省略',
            },
            ...SCREEN_REF_PARAMS,
          },
        },
      },
      sort: { type: 'string', description: 'view=screen：排序字段，前缀 - 为降序，如 -涨跌幅' },
      fields: { type: 'array', items: { type: 'string' }, description: 'view=screen：返回列（最多 12），默认 最新价 / 涨跌幅 / 量比 / 成交额 / 涨停状态 / 连板高度' },
      limit: { type: 'integer', description: 'view=screen：返回行数 1-100，默认 20；无翻页，命中多于 100 时加条件收窄' },
      exclude_st: { type: 'boolean', description: 'view=screen：排除 ST / 退市股' },
      pool_limit: { type: 'integer', description: 'view=market：每个池最多返回几只 1-50，默认 20' },
    },
    precheck: (a) => {
      const view = realtimeView(a)
      if (!view) return REALTIME_VIEW_HINT
      const codes = realtimeCodes(a?.codes)
      if (REALTIME_VIEWS_WITH_CODES.has(view) && !(Array.isArray(codes) && codes.length)) {
        const cap = REALTIME_MAX_CODES[view]
        return `view=${view} 需要 codes（6 位代码数组，最多 ${cap} 只，如 ["600519", "000001"]）。`
      }
      if (view === 'screen') {
        const bad = screenFiltersRefusal(a?.filters)
        if (bad) return bad
      }
      return realtimeBoundsRefusal(view, codes, a)
    },
    buildArgs: (a) => {
      const view = realtimeView(a)
      const out = { view }
      for (const key of REALTIME_PARAMS_BY_VIEW[view] || []) {
        if (a?.[key] !== undefined && a[key] !== null) out[key] = key === 'codes' ? realtimeCodes(a[key]) : a[key]
      }
      return out
    },
  },
]

/**
 * 统一执行器（index.js 的 execute 直接调用）：
 *  1. 没 token → 开通指引（不发请求）；
 *  2. spec.precheck 返回说明文字时直接把它当结果返回，不发请求（本地就能判定的缺参 / 越界）；
 *  3. 按 channel 走 resources/read（render(payload)）或 tools/call（可选 render(text)）。
 */
export async function runTool(spec, token, args, signal) {
  if (!token) return tokenRequiredMessage(spec.name)
  const refusal = spec.precheck?.(args)
  if (refusal) return refusal
  if (spec.channel === 'resource') {
    const uri = typeof spec.uri === 'function' ? spec.uri(args) : spec.uri
    const payload = await mcpReadResource(token, uri, signal)
    // 资源不存在时 mcpReadResource 返回「无结果：…」文本（正常答案），原样透出
    return typeof payload === 'string' ? payload : spec.render(payload, args)
  }
  const text = await mcpCall(token, spec.mcpName, spec.buildArgs(args), signal)
  return spec.render ? spec.render(text, args) : text
}

/** 未配置 token 时每个工具的返回（工具仍注册，引导开通）。 */
export function tokenRequiredMessage(toolName) {
  return (
    `工具 ${toolName} 需要 Max 会员的 MCP Token 才能使用：本插件 13 个工具都经 hhxg MCP server 取数，没有 Token 一个都不能用。\n\n` +
    `开通步骤：\n` +
    `1. 到 ${UPGRADE_URL} 开通 Max 会员（月付 ¥99 / 年付 ¥999）；MCP Token 只签给 Max\n` +
    `2. 到 ${TOKEN_URL} 生成 MCP Token\n` +
    `3. 把 Token 写进你 dsh profile 的 cordis.patch.yml（dsh 暂不提供本插件的设置界面）：\n` +
    `   - update:\n` +
    `       - id: hhxg-market\n` +
    `         config:\n` +
    `           mcpToken: "<你的 MCP Token>"\n` +
    `   保存后重启 dsh 生效；从终端启动 dsh 的话也可以不改文件，设环境变量 HHXG_MCP_TOKEN=<你的 MCP Token>（配置留空时读取）`
  )
}
