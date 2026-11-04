/**
 * dsh-hhxg-market — 工具定义（纯数据，不依赖宿主 API）。
 *
 * 每个条目 = { name, description, parameters, run(args, signal, config) }。
 * index.js 负责把它们包成 defineTool 并 ctx.tools.register。
 *
 * 免费工具直调公开端点；VIP 工具经 mcpCall 桥接（config.mcpToken 必填），
 * 只调服务端的正式工具（mcpName；服务端的 8 个旧工具名 0.3.0 起降为别名，2026-10-27 起已下线）。
 * 输出统一为文本（markdown/JSON 字符串），由模型自行阅读。
 */

import { fetchPublic, mcpCall, UPGRADE_URL, TOKEN_URL } from './api.js'

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

/** 服务端 query_dataset 单个数据文件的解析上限（与服务端同值，仅用于目录里的提示，判定以服务端为准）。 */
const QUERY_MAX_BYTES = 300 * 1024

/**
 * 数据集目录的「可 query」一栏：✓ = JSON / CSV、有最新快照且不超过解析上限；
 * 「过大」= 清单标明超限；「—」= 格式不支持，或只有历史分片（本插件的查询工具不带日期参数）。
 */
function queryMark(it) {
  // 会员专属的全市场宽表（选股快照 / 量化信号池）不发布文件，只能经策略筛选取数
  if (it.access === 'member' && it.delivery === 'screen_stocks') return '筛选'
  const format = String(it.format ?? '').toLowerCase()
  if ((format !== 'json' && format !== 'csv') || !it.urls?.latest) return '—'
  return Number.isFinite(it.size_bytes) && it.size_bytes > QUERY_MAX_BYTES ? '过大' : '✓'
}

// ── 免费工具（7 个） ────────────────────────────────────────────

export const FREE_TOOLS = [
  {
    name: 'hhxg_snapshot',
    description:
      'A股日报快照：市场情绪指数、涨停/炸板统计、连板天梯、热门题材资金、行业资金流向、游资龙虎榜、焦点财经新闻。每个交易日盘后约 20:00 更新；非交易日返回最近一个交易日。不带参数即返回全景概览。',
    parameters: {},
    async run(_args, signal) {
      const payload = await fetchPublic('/api/snapshot', signal)
      const d = payload?.data || {}
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
      // top_streak 线上为对象数组（{name,...}），也兼容字符串形态
      const topStreak = asDicts(ladder.top_streak).map((s) => inline(s.name)).filter(Boolean).join('、') ||
        (typeof ladder.top_streak === 'string' ? inline(ladder.top_streak) : '')
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
        const parts = Object.values(ai).filter((x) => typeof x === 'string' && x.trim())
        if (parts.length) lines.push('', '## AI 市场简评', parts.map((p) => `- ${inline(p, 200)}`).join('\n'))
      }
      return lines.join('\n') + DISCLAIMER
    },
  },
  {
    name: 'hhxg_news',
    description: '最新A股财经快讯（每小时滚动更新），含分类与多空情绪标签。limit 控制条数（1-50，默认 20）。',
    parameters: {
      limit: { type: 'number', description: '返回条数，1-50，默认 20' },
    },
    async run(args, signal) {
      const limit = Math.min(50, Math.max(1, Math.trunc(Number(args?.limit) || 20)))
      const payload = await fetchPublic(`/api/news?limit=${limit}`, signal)
      const items = asDicts(payload?.data?.items)
      if (!items.length) return '暂无快讯数据。' + DISCLAIMER
      const lines = [`# 财经快讯（最新 ${items.length} 条）`, '']
      for (const it of items) {
        const sent = it.sent && typeof it.sent === 'object'
          ? (it.sent.d === 'bull' ? ' 📈' : it.sent.d === 'bear' ? ' 📉' : '')
          : ''
        // ISO "2026-08-27T19:24:25" → "08-27 19:24"
        const ts = inline(it.t || '').replace('T', ' ').slice(5, 16)
        lines.push(`- ${ts || '—'} [${inline(it.cat || '')}]${sent} ${inline(it.title, 140)}`)
      }
      return lines.join('\n') + DISCLAIMER
    },
  },
  {
    name: 'hhxg_margin',
    description: '近 7 个交易日融资融券：全市场融资/融券/两融余额逐日走势 + 融资增减 TOP 个股（亿元）。',
    parameters: {},
    async run(_args, signal) {
      const payload = await fetchPublic('/api/margin', signal)
      const d = payload?.data || {}
      const days = asDicts(d.market?.daily_totals)
      if (!days.length) return '暂无两融数据。' + DISCLAIMER
      const lines = ['# 融资融券（近 7 交易日，单位亿元）', '', '| 日期 | 融资余额 | 融券余额 | 两融合计 |', '|---|---|---|---|']
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
        lines.push('', `## ${label}`, '| 股票 | 最新融资余额 | 7日增减 | 幅度 |', '|---|---|---|---|')
        for (const r of rows.slice(0, 5)) {
          lines.push(`| ${inline(r.name)}(${inline(r.code)}) | ${fmt(r.latest_rzye_yi, 1)} | ${fmt(r.delta_rzye_yi, 2)} | ${fmt(r.delta_pct, 2)}% |`)
        }
      }
      return lines.join('\n') + DISCLAIMER
    },
  },
  {
    name: 'hhxg_calendar',
    description:
      'A股日历：type=trading 全年交易日；delivery 期权期货交割日；earnings 财报披露（按月）；unlock 限售解禁（按月）。month 格式 YYYY-MM。',
    parameters: {
      type: { type: 'string', description: 'trading / delivery / earnings / unlock，默认 trading' },
      month: { type: 'string', description: '月份 YYYY-MM（earnings/unlock 用），默认当月' },
    },
    async run(args, signal) {
      const type = ['trading', 'delivery', 'earnings', 'unlock'].includes(args?.type) ? args.type : 'trading'
      const q = new URLSearchParams({ type })
      if (args?.month && /^\d{4}-\d{2}$/.test(args.month)) q.set('month', args.month)
      const payload = await fetchPublic(`/api/calendar?${q}`, signal)
      const head = `# A股日历（${type}${payload?.month ? ' · ' + inline(payload.month, 10) : ''}）`

      if (type === 'trading') {
        const dates = Array.isArray(payload?.data) ? payload.data.filter((x) => typeof x === 'string') : []
        if (!dates.length) return head + '\n\n暂无交易日数据。' + DISCLAIMER
        // 全年交易日太长，按月计数 + 最近窗口明细
        const byMonth = {}
        for (const d of dates) {
          const m = d.slice(0, 7)
          byMonth[m] = (byMonth[m] || 0) + 1
        }
        const lines = [head, '', `全年交易日共 ${dates.length} 天。各月天数:`, '']
        for (const [m, c] of Object.entries(byMonth)) lines.push(`- ${inline(m, 10)}: ${c} 天`)
        return lines.join('\n') + DISCLAIMER
      }

      const events = asDicts(payload?.data?.events)
      if (!events.length) return head + '\n\n该月暂无事件。' + DISCLAIMER
      const lines = [head, '', `事件共 ${events.length} 条:`, '']
      for (const ev of events.slice(0, 40)) {
        const extra = [
          ev.count != null ? `${fmt(ev.count)} 家` : '',
          ev.total_value != null ? `约 ${fmt(ev.total_value, 1)} 亿` : '',
        ].filter(Boolean).join(' · ')
        lines.push(`- ${inline(ev.date, 12)} 【${inline(ev.label, 20)}】${inline(ev.description, 100)}${extra ? `（${extra}）` : ''}`)
      }
      if (events.length > 40) lines.push(`…（共 ${events.length} 条，仅列前 40）`)
      return lines.join('\n') + DISCLAIMER
    },
  },
  {
    name: 'hhxg_sentiment',
    description: '近 7 个交易日市场情绪走势：逐日涨停家数、最高连板、连板分布、热门行业与热门概念。',
    parameters: {},
    async run(_args, signal) {
      const payload = await fetchPublic('/static/data/assistant/recent_sentiment_7d.json', signal)
      const days = asDicts(payload?.days)
      if (!days.length) return '暂无情绪数据。' + DISCLAIMER
      const lines = ['# 市场情绪（近 7 交易日）', '', '| 日期 | 涨停家数 | 最高连板 | 热门行业 | 热门概念 |', '|---|---|---|---|---|']
      for (const d of days) {
        const inds = asDicts(d.top_industries).slice(0, 3).map((x) => inline(x.name)).join('、')
        const cons = asDicts(d.top_concepts).slice(0, 3).map((x) => inline(x.name)).join('、')
        lines.push(`| ${inline(d.date)} | ${fmt(d.limit_up_count)} | ${fmt(d.max_lianban)} | ${inds} | ${cons} |`)
      }
      return lines.join('\n') + DISCLAIMER
    },
  },
  {
    name: 'hhxg_datasets',
    description:
      '列出 hhxg.top 全部开放数据集的 id / 分类 / 标题 / 格式 / 更新频率，并标出哪些能用 hhxg_query_dataset 查询。' +
      '调用 hhxg_query_dataset 前先用本工具查合法的 dataset_id。可用 category 过滤（如 ETF、选股、情绪）。',
    parameters: {
      category: { type: 'string', description: '按分类过滤（子串匹配，留空返回全部）' },
    },
    async run(args, signal) {
      const payload = await fetchPublic('/datasets.json', signal)
      let items = asDicts(payload?.datasets)
      if (!items.length) return '暂无数据集目录。' + DISCLAIMER
      const kw = String(args?.category ?? '').trim()
      if (kw) items = items.filter((it) => String(it.category ?? '').includes(kw) || String(it.title ?? '').includes(kw))
      if (!items.length) return `没有匹配「${inline(kw, 30)}」的数据集。可留空参数查看全部。` + DISCLAIMER
      const lines = [
        `# hhxg 开放数据集（${items.length}/${payload?.dataset_count ?? '?'} 个）`,
        '',
        '| id | 分类 | 标题 | 格式 | 更新 | 可 query |',
        '|---|---|---|---|---|---|',
      ]
      for (const it of items) {
        lines.push(
          `| ${inline(it.id, 40)} | ${inline(it.category, 20)} | ${inline(it.title, 40)} | ` +
          `${inline(it.format, 10)} | ${inline(it.update_sla?.frequency, 16)} | ${queryMark(it)} |`,
        )
      }
      lines.push(
        '',
        '「可 query」：✓ 可用 hhxg_query_dataset（VIP）过滤查询（JSON 与 300KB 以内的 CSV）；' +
        '「过大」是单个文件超过 300KB，服务端不解析（CSV 会返回下载地址）；「—」是只有历史分片或格式不支持；' +
        '「筛选」是会员专属的全市场宽表，不提供下载，请用 hhxg_strategy_signals：list_fields=true 查看字段，filters 自定义筛选，strategy_id 用策略预设。',
      )
      return lines.join('\n') + DISCLAIMER
    },
  },
  {
    name: 'hhxg_themes',
    description: '当日题材概念热度榜（TOP 30）：游资参与数、当日涨停数、涨停占比。判断市场主线方向用。',
    parameters: {},
    async run(_args, signal) {
      const payload = await fetchPublic('/static/data/assistant/recent_theme_latest.json', signal)
      // 上游榜单偶有同名重复行，按名去重保留首见（上游已按热度排序）
      const seen = new Set()
      const items = asDicts(payload?.items).filter((it) => {
        const key = String(it.name ?? '')
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (!items.length) return '暂无题材数据。' + DISCLAIMER
      const lines = [`# 题材热度榜（${inline(payload?.latest_date || '?')} · TOP ${Math.min(30, items.length)}）`, '', '| 排名 | 题材 | 游资参与 | 当日涨停 | 涨停占比 |', '|---|---|---|---|---|']
      items.slice(0, 30).forEach((it, i) => {
        lines.push(`| ${i + 1} | ${inline(it.name)} | ${fmt(it.yz)} | ${fmt(it.zt)} | ${pct(it.ratio)} |`)
      })
      return lines.join('\n') + DISCLAIMER
    },
  },
]

// ── VIP 工具（6 个，桥接 hhxg MCP server） ──────────────────────

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

export const VIP_TOOLS = [
  {
    name: 'hhxg_diagnose_stock',
    mcpName: 'diagnose_stock',
    description:
      '【VIP】个股综合诊断：日/周/月技术指标、异动评级、两融趋势、龙虎榜、涨停、大宗交易、公告、概念标签 + 全市场榜单命中 + 相关新闻。',
    parameters: { stock_code: { ...STOCK_CODE_PARAM, required: true } },
    buildArgs: (a) => ({ stock_code: String(a?.stock_code || '') }),
  },
  {
    name: 'hhxg_strategy_signals',
    mcpName: 'screen_stocks',
    description:
      '【VIP】A 股条件选股 / 指标筛选 / 全市场命中计数（最新盘后快照，约 270 列：行情、估值、财务、筹码、涨停连板、两融、日 / 周 / 月技术指标与派生条件列，' +
      '以及题材概念、股票池、持股标签、游资席位、行业 / 地域 / 市场类型、上市天数、股东集中度、大宗等基本信息）。' +
      '数据是最近一个交易日收盘后的盘后快照，不含今天盘中行情：交易日 9:30 之后用户问「最新价 / 现价 / 盘中 / 实时 / 现在 / 今天」或要按当前价格筛选时，改用 hhxg_realtime view=screen' +
      '（filters 写法相同，同样支持两列比较与题材概念 contains，价格字段叫 最新价；Max 专属，非 Max 会收到说明再回到本工具）；' +
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
    mcpName: 'predict_lianban_promotion',
    description: '【VIP】预测当日涨停连板股的次日晋级率（3 因子规则模型：题材热度/行业热度/板高强度）。仅对当日上榜涨停股有效。',
    parameters: { stock_code: { ...STOCK_CODE_PARAM, required: true } },
    buildArgs: (a) => ({ stock_code: String(a?.stock_code || '') }),
  },
  {
    name: 'hhxg_stock_alerts',
    mcpName: 'query_dataset',
    description: '【VIP】个股近 30 日异动历史（普通/临近严重/严重异动逐日记录，含涨跌幅与累计偏离）。days 为自然日窗口 1-30。',
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
    mcpName: 'query_dataset',
    description:
      '【VIP】对 hhxg 数据集（JSON 与 300KB 以内的 CSV）做过滤/排序/截断查询。先用免费工具 hhxg_datasets 查合法 dataset_id 与是否可查。filters 为字段→值精确匹配（值为数组时 OR），sort 前缀 - 表示降序，limit 最大 500。',
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
    mcpName: 'get_realtime',
    description:
      '【Max】盘中实时数据（Max 会员专属；交易日 9:30–15:00 约 1 分钟一帧，盘后返回当日收盘帧）。' +
      '交易时段的选股 / 筛选 / 计数问题优先用 view=screen，不要先用盘后的 hhxg_strategy_signals（那是上一交易日收盘的快照，会把「最新价」答成收盘价）；' +
      'view=market：市场宽度（涨跌家数、涨停 / 跌停 / 炸板家数、炸板率、成交额）+ 涨停池 / 炸板池 / 跌停池 + 连板晋级率；' +
      'view=quotes：codes（最多 30 只）的最新价、涨跌幅、量比、封单、成交额、开高低等，include 选 daily / weekly / monthly 指标' +
      '（MA / BBI / MACD / KDJ / RSI / BOLL / CCI / 九转等，按最新价把今天当未走完的 K 线计算，收盘前会变）；' +
      'view=screen：全市场按 filters [{field, op, value}] 筛选（最多 8 条，op：gt/gte/lt/lte/eq/ne/in/contains/not_null；' +
      '两列比较写 {field, op, ref, scale} 即 field op ref × scale，如 {field:"最新价", op:"gt", ref:"MA20"}，两个字段须同为实时字段或同为盘后属性列；' +
      '题材概念、股票池等盘后属性列用 contains），' +
      'sort 字段名前加 - 为降序，fields 选返回列（最多 12），limit 1-50 且没有翻页（命中超过 50 时加条件收窄或用 sort 取最关心的前 50），exclude_st 排除 ST；' +
      '响应 total 是当前有效行情范围内的全市场命中数，limit 只限制返回行数，只问数量可设 limit=1；周 / 月指标字段名加前缀「周」「月」（如 周MACD_HIST）；' +
      'view=fields：全部可用字段、取值说明与示例，不确定字段名时先调它；' +
      'view=kline：codes（最多 5 只）的日 K 序列——rows 为已完成交易日（period 只支持 day，bars 1-260 默认 120，codes × bars ≤ 1000，adj=qfq 前复权 / none 不复权，' +
      '单位 元 / 股 / 元，缺值 null），live 为实时帧那天未走完的 K（最新价当收盘价）；live.comparable 只有 true 才可与 rows 拼接，' +
      'false = 疑似除权 / 价格基准不一致，null = 无法判断（缓存滞后 / 个股停牌 / 日历不可用，原因见 live.reason，缓存状态见 history）。' +
      '结果文本首行会标出帧的时效与交易日；每个结果都带 frame.status（live 盘中 / lunch_break 午休 / closed 收盘帧 / previous_session 非今日 / stale 延迟），' +
      '不是 live 就不是此刻的数据，引用时注明帧日期；盘中价格是最新价不是收盘价；' +
      'MA / BBI / MACD / KDJ 等指标按最新价把帧交易日当天当作未走完的 K 线计算，不是上一交易日收盘的指标（indicators.base_date 只是历史基准日，结果的【口径】行已写明）。' +
      'Pro 会员调用会返回「需要 Max」的说明。',
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
      limit: { type: 'integer', description: 'view=screen：返回行数 1-50，默认 20；无翻页，命中多于 50 时加条件收窄' },
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
 * VIP 工具的统一执行器（index.js 组装时注入 token）。
 * spec.precheck 返回说明文字时直接把它当结果返回，不发请求（本地就能判定的缺参）。
 */
export async function runVipTool(spec, token, args, signal) {
  const refusal = spec.precheck?.(args)
  if (refusal) return refusal
  return mcpCall(token, spec.mcpName, spec.buildArgs(args), signal)
}

/** 未配置 token 时注册的占位说明（工具仍可见，引导开通）。 */
export function vipLockedMessage(toolName) {
  return (
    `工具 ${toolName} 需要恢恢量化会员的 MCP Token 才能使用。\n\n` +
    `开通步骤：\n` +
    `1. 到 ${UPGRADE_URL} 开通 Max 会员（月付 ¥99 / 年付 ¥999）。2026-10-27 起 MCP Token 只签给 Max；` +
    `此前开通的 Pro 在原到期日前仍可用（盘中实时 hhxg_realtime 除外，它只属于 Max）\n` +
    `2. 到 ${TOKEN_URL} 生成 MCP Token\n` +
    `3. 把 Token 写进你 dsh profile 的 cordis.patch.yml（dsh 暂不提供本插件的设置界面）：\n` +
    `   - update:\n` +
    `       - id: hhxg-market\n` +
    `         config:\n` +
    `           mcpToken: "<你的 MCP Token>"\n` +
    `   保存后重启 dsh 生效；从终端启动 dsh 的话也可以不改文件，设环境变量 HHXG_MCP_TOKEN=<你的 MCP Token>（配置留空时读取）\n\n` +
    `免费工具（hhxg_snapshot / hhxg_news / hhxg_margin / hhxg_calendar / hhxg_sentiment / ` +
    `hhxg_datasets / hhxg_themes）无需配置即可使用。`
  )
}
