/**
 * dsh-hhxg-market — 工具定义（纯数据，不依赖宿主 API）。
 *
 * 每个条目 = { name, description, parameters, run(args, signal, config) }。
 * index.js 负责把它们包成 defineTool 并 ctx.tools.register。
 *
 * 免费工具直调公开端点；VIP 工具经 mcpCall 桥接（config.mcpToken 必填），
 * 只调服务端的正式工具（mcpName；服务端 0.3.0 起旧工具名只是保留到 2026-11-30 的别名）。
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
        '「筛选」是会员专属的全市场宽表，不提供下载，请用 hhxg_strategy_signals（策略预设）取数。',
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

/** screen_stocks 目前可用的 8 个策略预设（展示用；合法值以服务端为准）。 */
const STRATEGY_PRESETS =
  'limit_up 涨停 / volume_breakout 放量突破 / low_volume_consolidation 缩量整理 / nineturn_buy 九转买入 / ' +
  'nineturn_sell 九转卖出 / kdj_overbought KDJ 超买 / kdj_oversold KDJ 超卖 / crash_warning 暴跌预警'

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
}
const REALTIME_VIEWS = Object.keys(REALTIME_PARAMS_BY_VIEW)
const REALTIME_VIEW_HINT =
  '请提供 view：market（市场概况）/ quotes（指定个股，需 codes）/ screen（全市场筛选）/ fields（可用字段与示例）。'

/** codes 允许模型传成 "600519,000001" 这样的字符串：拆成数组再发，省一次参数错误往返。 */
function realtimeCodes(v) {
  if (typeof v === 'string') return v.split(/[\s,，、]+/).filter(Boolean)
  return v
}

function realtimeView(a) {
  const view = trimmed(a?.view)
  return Object.hasOwn(REALTIME_PARAMS_BY_VIEW, view) ? view : ''
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
      '【VIP】按量化策略预设筛选全市场股票，直接返回命中的个股（代码 / 名称 / 行业 / 收盘价 / 涨跌幅 / 换手率 / 量比 / 流通市值 / 市盈率 / 九转计数）。' +
      `strategy_id 可用 8 个预设：${STRATEGY_PRESETS}。` +
      '另 4 个（oversold_rebound / macd_golden_cross / macd_death_cross / distribution）需要列间比较或分位数，暂不能作为预设，会返回 PRESET_NOT_SUPPORTED；' +
      '全市场指标全表（quant_signal_pool）为会员数据，不提供下载地址；需要自定义条件时，可在 MCP 客户端直接调 screen_stocks(filters=...) 按「字段 对 常量」筛选后自行比较。' +
      'limit 为返回条数（1-100，默认 20）。站点查询服务离线时部分预设会报错（PRESET_UNAVAILABLE），稍后重试即可。',
    parameters: {
      strategy_id: { type: 'string', description: '策略预设标识（见工具描述）', required: true },
      limit: { type: 'number', description: '返回条数 1-100，默认 20' },
    },
    // 空 strategy_id 不能发出去：screen_stocks 把空 preset 当成「没传」，会返回未经筛选的全市场前 N 行
    precheck: (a) => (trimmed(a?.strategy_id) ? null : `请提供 strategy_id（策略预设）。可用：${STRATEGY_PRESETS}。`),
    buildArgs: (a) => {
      const out = { preset: trimmed(a?.strategy_id) }
      const limit = Math.trunc(Number(a?.limit))
      if (Number.isFinite(limit) && limit >= 1 && limit <= 100) out.limit = limit
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
      'view=market：市场宽度（涨跌家数、涨停 / 跌停 / 炸板家数、炸板率、成交额）+ 涨停池 / 炸板池 / 跌停池 + 连板晋级率；' +
      'view=quotes：codes（最多 30 只）的最新价、涨跌幅、量比、封单、成交额、开高低等，include 选 daily / weekly / monthly 指标' +
      '（MA / BBI / MACD / KDJ / RSI / BOLL / CCI / 九转等，按最新价把今天当未走完的 K 线计算，收盘前会变）；' +
      'view=screen：全市场按 filters [{field, op, value}] 筛选（最多 8 条，op：gt/gte/lt/lte/eq/ne/in/not_null），' +
      'sort 字段名前加 - 为降序，fields 选返回列（最多 12），limit 1-50，exclude_st 排除 ST；周 / 月指标字段名加前缀「周」「月」（如 周MACD_HIST）；' +
      'view=fields：全部可用字段、取值说明与示例，不确定字段名时先调它。' +
      '每个结果都带 frame.status（live 盘中 / lunch_break 午休 / closed 收盘帧 / previous_session 非今日 / stale 延迟），引用数据前先看它；' +
      '盘中价格是最新价不是收盘价。Pro 会员调用会返回「需要 Max」的说明。',
    parameters: {
      view: { type: 'string', enum: REALTIME_VIEWS, required: true, description: 'market 市场概况 / quotes 指定个股 / screen 全市场筛选 / fields 字段清单' },
      codes: { type: 'array', items: { type: 'string' }, description: 'view=quotes：6 位代码或 600519.SH 格式，最多 30 只' },
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
            op: { type: 'string', required: true, enum: ['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'in', 'not_null'] },
            value: {
              oneOf: [
                { type: 'number' },
                { type: 'string' },
                { type: 'array', items: { oneOf: [{ type: 'number' }, { type: 'string' }] } },
              ],
              description: '比较值：数字；op=in 时为数组；文本字段（涨停状态 / 跌停状态）为字符串；op=not_null 时省略',
            },
          },
        },
      },
      sort: { type: 'string', description: 'view=screen：排序字段，前缀 - 为降序，如 -涨跌幅' },
      fields: { type: 'array', items: { type: 'string' }, description: 'view=screen：返回列（最多 12），默认 最新价 / 涨跌幅 / 量比 / 成交额 / 涨停状态 / 连板高度' },
      limit: { type: 'integer', description: 'view=screen：返回行数 1-50，默认 20' },
      exclude_st: { type: 'boolean', description: 'view=screen：排除 ST / 退市股' },
      pool_limit: { type: 'integer', description: 'view=market：每个池最多返回几只 1-50，默认 20' },
    },
    precheck: (a) => {
      const view = realtimeView(a)
      if (!view) return REALTIME_VIEW_HINT
      const codes = realtimeCodes(a?.codes)
      if (view === 'quotes' && !(Array.isArray(codes) && codes.length)) {
        return 'view=quotes 需要 codes（6 位代码数组，最多 30 只，如 ["600519", "000001"]）。'
      }
      return null
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
    `3. 把 Token 填入本插件配置的 mcpToken 字段（设置 → 插件 → hhxg-market）\n\n` +
    `免费工具（hhxg_snapshot / hhxg_news / hhxg_margin / hhxg_calendar / hhxg_sentiment / ` +
    `hhxg_datasets / hhxg_themes）无需配置即可使用。`
  )
}
