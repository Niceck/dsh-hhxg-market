/**
 * dsh-hhxg-market — 历史库下载（hhxg_history_download → GET /api/data/hist）的参数预检、查询参数与纯文本渲染。
 *
 * 三种形态对应三种请求（服务端 web/functions/_lib/hist_download.js，字段见主仓库夹具 tests/fixtures/hist_export_contract.json）：
 *   不带参数 → 可下载的表清单 + 当天额度；table → 该表的字段对照与全部周期；table + period → 一条限时下载链接。
 * 本插件只把链接和一条 curl 命令交给模型，不下载、不写文件。
 *
 * 约定同 hist_text.js：进文本的服务端字段一律白名单 + 严格格式（表 id、周期、非负整数、8 位日期、64 位 sha256、
 * 带 +08:00 的重置时刻），标题走同一个 safeTitle；不合格就省略或明说，不把服务端的整句话提升到首行。
 * 链接只认站方下载主机（api.js 的 HIST_DOWNLOAD_HOST，端口可省）+ 与服务端 DL_PATH_RE 逐字一致的路径与查询串，
 * 不合规时链接与命令都不给；文件名还要与链接自洽（<表>_<文件>，同服务端 hist_export 的写法）才生成
 * `curl --fail -o "<文件名>" "<链接>"`（直链不重定向，所以不带 -L；--fail 不把错误页写成数据文件）。
 * 两者都只含 URL 安全字符 / 字母数字与 . _ -，放进双引号后命令里没有会被 shell 再解释的字符。
 * 业务答复用插件内置的固定说明，不带服务端原文；只有额度用完保留服务端文案（区分文件数上限与同一文件签发次数上限），限 120 字。
 * 链接有效期与每日文件数上限只用接口返回值（ttl_seconds / expires_at / quota / limits），插件里不另写一份。
 * 整段共用 RESULT_BUDGET（64 KiB），超出只列放得下的行并明说。
 */

import { HIST_DOWNLOAD_HOST, HIST_DOWNLOAD_PORT } from './api.js'
import { FOOTER, RESULT_BUDGET, bytes, clean, dicts } from './screen_text.js'
import { TABLE_ID_RE, date8, isDict, safeTitle, tableName } from './hist_text.js'

/** table / period 最长字符数（与服务端 hist_download.js 的 arg() 同值；超出服务端回 INVALID_ARG）。 */
const ARG_MAX = 64
const PERIOD_RE = /^(?:\d{4}|\d{6}|\d{8})$/
const FIELDS_PERIOD = 'fields'
/**
 * 下载链接的路径与查询串：与 web/functions/_lib/hist_download.js 的 DL_PATH_RE 逐字一致（主仓库里有测试对拍源码），
 * 后者又与查询服务 scripts/query_service/hist_download.py 的 PATH_RE + hist_export 写法对齐。
 */
const DL_PATH_RE = /^\/dl\/hist_[a-z0-9_]{1,60}\/(?:(?:\d{4}|\d{6}|\d{8})\.csv\.gz|fields\.csv)\?m=[\w-]{8,64}&e=[1-9]\d{0,11}&s=[0-9a-f]{64}$/
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 完整链接：https://<站方下载主机>[:<端口>] + DL_PATH_RE（去掉开头的 ^）。主机后紧跟 / 或 :端口，后缀混淆的主机过不了。 */
export const URL_RE = new RegExp(
  `^https://${escapeRe(HIST_DOWNLOAD_HOST)}(?::${escapeRe(HIST_DOWNLOAD_PORT)})?${DL_PATH_RE.source.slice(1)}`,
)
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const RESETS_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?\+08:00$/
// unix 秒的合理上界（3000 年）：再大 Date 会越界
const MAX_UNIX = 32503680000
const GRAIN = { year: '按年', month: '按月', day: '按日' }

const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null)
const countText = (v, unit) => (int(v) === null ? `— ${unit}` : `${v} ${unit}`)
const argError = (msg) => `参数有误：${msg}（INVALID_ARG）`
const linkCall = (table) => `hhxg_history_download(table="${table}", period="<周期>")`

/** table / period 入参：字符串去首尾空白；非负整数转字符串（模型常把 2024 当数字传）；没给 → ''；其它类型 → null（本地拒绝）。 */
function argText(v) {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return String(v)
  return null
}

/** 本地预检：类型、长度、period 要配 table（其余格式交给服务端判，文案以服务端为准）。 */
export function downloadPrecheck(a) {
  const table = argText(a?.table)
  const period = argText(a?.period)
  if (table === null || period === null) return argError('table / period 须为字符串')
  if (table.length > ARG_MAX || period.length > ARG_MAX) return argError(`table / period 最长 ${ARG_MAX} 个字符`)
  if (period && !table) return argError('period 要和 table 一起用：先不带参数调用看可下载的表，再带 table 查它的周期')
  return null
}

/** GET /api/data/hist 的查询参数：只带给了的 table / period（没有 table 时 period 一律不带）。 */
export function downloadQuery(a) {
  const table = argText(a?.table) || ''
  const period = table ? argText(a?.period) || '' : ''
  return { ...(table && { table }), ...(period && { period }) }
}

/** 字节数 → 人读大小（1024 进制，KB 起保留 1 位小数）；不是非负整数写「大小未知」。 */
export function sizeText(n) {
  if (int(n) === null) return '大小未知'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(1)} ${units[i]}`
}

function periodText(v, allowFields = false) {
  if (typeof v !== 'string') return ''
  return PERIOD_RE.test(v) || (allowFields && v === FIELDS_PERIOD) ? v : ''
}

function rangeText(lo, hi) {
  const a = date8(lo)
  const b = date8(hi)
  return a && b ? `${a} 至 ${b}` : ''
}

const unixSeconds = (v) => (Number.isSafeInteger(v) && v > 0 && v < MAX_UNIX ? v : null)

/** unix 秒 → 北京时间 YYYY-MM-DD HH:MM（中国无夏令时，固定 UTC+8）。 */
function beijingText(sec) {
  return new Date((sec + 8 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

const durationText = (sec) => (sec >= 60 ? `${Math.round(sec / 60)} 分钟` : `${sec} 秒`)

/** 链接有效期（秒）：优先 ttl_seconds，其次 expires_at 距 now 的剩余秒数；都没有或已过期返回 null。 */
function ttlSeconds(b, now) {
  const ttl = int(b.ttl_seconds)
  if (ttl) return ttl
  const exp = unixSeconds(b.expires_at)
  const left = exp ? Math.round(exp - now / 1000) : 0
  return left > 0 ? left : null
}

/** 「链接 N 分钟内有效」：列表形态的 limits.ttl_seconds 有值才写，否则空串。 */
function ttlPhrase(limits) {
  const ttl = isDict(limits) ? int(limits.ttl_seconds) : null
  return ttl ? `链接 ${durationText(ttl)}内有效` : ''
}

/** 当天额度：quota 的 daily_max / used / remaining / resets_at；没有 quota 时退回 limits.daily_max；都没有返回空串。 */
function quotaText(q, limits) {
  const parts = []
  if (isDict(q)) {
    const max = int(q.daily_max)
    const used = int(q.used)
    if (max !== null && used !== null) parts.push(`今日已用 ${used} / ${max} 个不同文件（每个会员每天最多 ${max} 个）`)
    else if (max !== null) parts.push(`每个会员每天最多 ${max} 个不同文件`)
    if (int(q.remaining) !== null) parts.push(`还剩 ${q.remaining} 个`)
    const m = typeof q.resets_at === 'string' ? q.resets_at.match(RESETS_RE) : null
    if (m) parts.push(`北京时间 ${m[1]} ${m[2]} 重置`)
  }
  if (!parts.length && isDict(limits) && int(limits.daily_max) !== null) {
    parts.push(`每个会员每天最多 ${limits.daily_max} 个不同文件`)
  }
  return parts.length ? `额度：${parts.join('，')}。` : ''
}

/** 签发链接时额外的计数：本次是否计入额度、这个文件今天第几次取链接。 */
function issueText(q) {
  if (!isDict(q)) return ''
  const parts = []
  if (q.counted === true) parts.push('本次计入额度')
  else if (q.counted === false) parts.push('今天已签过这个文件，本次不另计额度')
  const n = int(q.file_issued)
  const cap = int(q.file_daily_max)
  if (n !== null && cap !== null) parts.push(`这个文件今天第 ${n} 次取链接（同一文件每天最多 ${cap} 次）`)
  return parts.length ? `${parts.join('；')}。` : ''
}

const shapeError = (what) => `返回形状异常：${what}，请稍后重试。\n${FOOTER}`

/** 头尾固定、中间逐行放，整段不超过 RESULT_BUDGET；放不下时只留前若干行并加 cutNote(实际保留数)。 */
function assemble(head, body, tail, cutNote) {
  const fixed = [...head, ...tail, cutNote(body.length)].filter(Boolean)
  let used = bytes(fixed.join('\n')) + 1
  let keep = 0
  while (keep < body.length && used + 1 + bytes(body[keep]) <= RESULT_BUDGET) {
    used += 1 + bytes(body[keep])
    keep += 1
  }
  const cut = keep < body.length ? [cutNote(keep)] : []
  return [...head, ...body.slice(0, keep), ...cut, ...tail].filter(Boolean).join('\n')
}

const badNote = (n) => (n > 0 ? `另有 ${n} 条格式异常已忽略。` : '')

function tableLine(t) {
  const lo = periodText(t.first_period)
  const hi = periodText(t.last_period)
  const span = lo && hi ? (lo === hi ? lo : `${lo} 至 ${hi}`) : '—'
  const grain = GRAIN[t.export_grain] ? `（${GRAIN[t.export_grain]}）` : ''
  return [t.table, safeTitle(t.title) || '（标题略）', span, `${countText(t.files, '个周期')}${grain}`, countText(t.rows, '行'), sizeText(t.bytes)].join('｜')
}

/** 不带参数：每张表一行（表名、标题、周期起止、周期数、行数、大小），末尾一行额度与下一步。 */
function tablesText(b) {
  if (!Array.isArray(b.tables)) return shapeError('没有表清单（tables）')
  const ok = dicts(b.tables).filter((t) => typeof t.table === 'string' && TABLE_ID_RE.test(t.table))
  const head = [`历史库下载｜可下载 ${ok.length} 张表｜每个文件是一张表一个周期的 .csv.gz（UTF-8 带 BOM、中文表头）`]
  const quota = quotaText(b.quota, b.limits)
  if (!ok.length) return [...head, '暂时没有可下载的表。', badNote(b.tables.length), quota, FOOTER].filter(Boolean).join('\n')
  head.push('表名｜标题｜周期起止｜周期数｜行数｜大小')
  const ttl = ttlPhrase(b.limits)
  const next =
    `下一步：hhxg_history_download(table="<表名>") 查看该表的全部周期与字段对照，再用 ${linkCall('<表名>')} 取一条限时下载链接` +
    `${ttl ? `（${ttl}）` : ''}；每次一个文件，批量下载逐个周期调用。`
  const tail = [badNote(b.tables.length - ok.length), quota + next, FOOTER]
  return assemble(head, ok.map(tableLine), tail, (keep) => `表太多：仅列出前 ${keep} 张（共 ${ok.length} 张）。`)
}

function fieldsLine(f) {
  const meta = isDict(f)
    ? [
        typeof f.file === 'string' && FILENAME_RE.test(f.file) ? f.file : '',
        int(f.rows) !== null ? `${f.rows} 行` : '',
        int(f.bytes) !== null ? sizeText(f.bytes) : '',
      ].filter(Boolean).join('，')
    : ''
  return `字段对照：period: "fields"${meta ? `（${meta}）` : ''}——列名、中文名与单位的对照表。`
}

/** 带 table：首行表名与总量，一行字段对照，再每个周期一行（周期、行数、大小、数据起止），末尾一行额度与下一步。 */
function periodsText(b) {
  if (typeof b.table !== 'string' || !TABLE_ID_RE.test(b.table) || !Array.isArray(b.periods)) {
    return shapeError('没有表名或周期列表（table / periods）')
  }
  const ok = dicts(b.periods).filter((p) => periodText(p.period))
  const span = ok.length ? (ok.length === 1 ? ok[0].period : `${ok[0].period} 至 ${ok.at(-1).period}`) : ''
  const grain = GRAIN[b.export_grain] ? `（${GRAIN[b.export_grain]}）` : ''
  const total = [int(b.rows) !== null ? `共 ${b.rows} 行` : '', int(b.bytes) !== null ? sizeText(b.bytes) : ''].filter(Boolean).join('、')
  const head = [
    [`历史库下载 ${tableName(b)}`, `${ok.length} 个周期文件${grain}`, span ? `周期 ${span}` : '', total].filter(Boolean).join('｜'),
    fieldsLine(b.fields),
  ]
  const quota = quotaText(b.quota, b.limits)
  if (!ok.length) return [...head, '这张表暂时没有可下载的周期文件。', badNote(b.periods.length), quota, FOOTER].filter(Boolean).join('\n')
  head.push('周期｜行数｜大小｜数据起止')
  const body = ok.map((p) => [p.period, countText(p.rows, '行'), sizeText(p.bytes), rangeText(p.min_date, p.max_date) || '—'].join('｜'))
  const ttl = ttlPhrase(b.limits)
  const next =
    `下一步：${linkCall(b.table)} 取一条限时下载链接（period 用上面列出的周期，字段对照用 period: "fields"` +
    `${ttl ? `；${ttl}` : ''}）；每次一个文件，批量下载逐个周期调用。`
  const tail = [badNote(b.periods.length - ok.length), quota + next, FOOTER]
  const cutNote = (keep) => `周期太多：仅列出前 ${keep} 个（共 ${ok.length} 个，周期 ${span}），其余周期按同样的格式直接传 period。`
  return assemble(head, body, tail, cutNote)
}

/**
 * 链接对应的文件名：<表>_<文件>（同服务端 hist_export 的 f"{table_id}_{entry.file}"，如 hist_fin_indicator_2024.csv.gz、
 * hist_margin_detail_fields.csv）。只对已过 URL_RE 的链接调用，路径必为 /dl/<表>/<文件>。
 */
function filenameFor(url) {
  const [table, file] = url.split('?')[0].split('/').slice(-2)
  return `${table}_${file}`
}

/** 带 table + period：链接、文件名、sha256、有效期、下载命令、校验命令、额度与说明。 */
function linkText(b, now) {
  const table = typeof b.table === 'string' && TABLE_ID_RE.test(b.table) ? b.table : ''
  const period = periodText(b.period, true)
  const url = typeof b.url === 'string' && URL_RE.test(b.url) ? b.url : ''
  // 文件名既要字符合规，又要与链接自洽；任一不满足就只给链接、不生成命令
  const filename = url && typeof b.filename === 'string' && FILENAME_RE.test(b.filename) && b.filename === filenameFor(url) ? b.filename : ''
  const sha = typeof b.sha256 === 'string' && SHA256_RE.test(b.sha256) ? b.sha256 : ''
  const what = table && period ? `${table} ${period === FIELDS_PERIOD ? '字段对照' : `周期 ${period}`}` : '（表名 / 周期格式异常）'
  const range = rangeText(b.min_date, b.max_date)
  const head = [
    '历史库下载链接',
    what,
    int(b.rows) !== null ? `${b.rows} 行` : '',
    int(b.bytes) !== null ? sizeText(b.bytes) : '',
    range ? `数据 ${range}` : '',
  ].filter(Boolean).join('｜')
  if (!url) {
    return [
      head,
      `服务端返回的下载链接不合规（须为站方下载地址 https://${HIST_DOWNLOAD_HOST}/dl/… 的固定格式），已不展示，也不生成下载命令；请稍后重新调用本工具。`,
      FOOTER,
    ].join('\n')
  }
  const ttl = ttlSeconds(b, now)
  const exp = unixSeconds(b.expires_at)
  const validity = [
    ttl ? `链接 ${durationText(ttl)}内有效` : '链接限时有效',
    exp ? `须在北京时间 ${beijingText(exp)} 前开始下载` : '',
    '过期后断点续传也要重新取链接',
  ].filter(Boolean).join('，')
  return [
    head,
    `链接：${url}`,
    filename ? `文件名：${filename}` : '',
    sha ? `sha256：${sha}` : '',
    `有效期：${validity}。`,
    filename
      ? `下载命令：curl --fail -o "${filename}" "${url}"`
      : '服务端返回的文件名不合规或与链接对不上（应为「表名_周期文件」，只含字母、数字、点、下划线、连字符），未生成下载命令：请只用上面的链接，自己指定一个文件名保存。',
    filename && sha ? `校验：sha256sum "${filename}"（macOS 用 shasum -a 256 "${filename}"），结果应等于上面的 sha256。` : '',
    quotaText(b.quota) + issueText(b.quota),
    '说明：链接即凭证、不绑 IP，不要转发；请单线程下载；当前目录下的同名文件会被覆盖。插件只给链接和命令，不下载、不写文件，要不要执行由用户决定；批量下载逐个周期调用本工具，每次一条链接。',
    FOOTER,
  ].filter(Boolean).join('\n')
}

/** 额度用完时服务端文案的长度上限（字符）：只这一种业务答复带服务端原文。 */
const QUOTA_MSG_MAX = 120

/**
 * 业务答复（4xx）的固定说明：哪类问题 + 下一步怎么调。服务端原文不进模型上下文（它是自由文本），
 * 只有额度用完保留服务端文案——它区分「今天的不同文件数到上限」与「同一文件今天的签发次数到上限」。
 */
const BUSINESS_TEXT = {
  INVALID_ARG:
    '参数有误：table 或 period 的格式不对（INVALID_ARG）。table 用不带参数时列出的表名，period 用带 table 时列出的周期（如 2024 / 202601），字段对照用 period: "fields"。',
  NOT_FOUND:
    '无结果：没有这张表，或这张表没有这个周期的文件（NOT_FOUND）。不带参数调用 hhxg_history_download 看可下载的表，再用 hhxg_history_download(table="<表名>") 看它的全部周期。',
  NO_DATA: '暂无数据：下载文件清单或这个文件正在更新（NO_DATA），请稍后再试。',
  SCOPE_NOT_FOUND:
    '暂不支持：服务端还没有开放历史库下载（GET /api/data/hist 尚未上线），请稍后再试；在线查历史数据可用 hhxg_query_dataset。（SCOPE_NOT_FOUND）',
}

function businessText(res) {
  const code = typeof res.code === 'string' ? res.code : ''
  if (Object.hasOwn(BUSINESS_TEXT, code)) return BUSINESS_TEXT[code]
  if (code === 'DOWNLOAD_QUOTA_EXCEEDED') {
    const msg = clean(res.message, QUOTA_MSG_MAX) || '今天的下载额度已用完，北京时间 0 点重置'
    return `下载额度已用完：${msg}（DOWNLOAD_QUOTA_EXCEEDED）`
  }
  // api.js 只会交来上面这几种码；兜底不回显任何服务端文字
  return `${clean(res.label, 12) || '无结果'}：服务端拒绝了这次请求${/^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? `（${code}）` : ''}，请检查参数后重试。`
}

/**
 * hhxg_history_download 的文本：dataApiGet 的结果（{ ok, body } 或业务答复）+ 入参 → 给模型读的纯文本。
 * 形态按入参判（与发出的请求一一对应）：table + period → 链接；只有 table → 周期列表；都没有 → 表清单。
 */
export function renderDownload(res, args, now = Date.now()) {
  if (!isDict(res)) return shapeError('响应为空')
  if (!res.ok) return businessText(res)
  const body = isDict(res.body) ? res.body : {}
  const q = downloadQuery(args)
  if (q.period) return linkText(body, now)
  if (q.table) return periodsText(body)
  return tablesText(body)
}
