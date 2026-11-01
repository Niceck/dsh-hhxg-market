/**
 * dsh-hhxg-market — 浏览器半（client half），最小可行版：只接管 `hhxg_realtime` 一张结果卡。
 *
 * 手写 `window.__ModuleLoader__` bundle、无构建步骤、无 JSX：React 与 jsx-runtime 由宿主 require 提供
 * （同 dsh-tokenledger 的做法）。宿主按 package.json 的 `dsh.client` + `exports["./client"]` 发现本文件，
 * 执行只是**登记** factory；真正的模块体在 factory 里跑（物化时）。
 *
 * 职责边界（Codex 评审定的 PoC 门槛）：
 *  - 只读 `block.meta`（host 半 presentationMeta 投影，schema 1 / kind hhxg.realtime）：状态徽标 + 一张表；
 *  - meta 缺失 / 版本不认 / 任何渲染异常 → 回退成工具原文文本，绝不让卡片把会话弄坏；
 *  - 不接设置页、不画 K 线图、不请求网络、不碰 token。
 *
 * 本文件可在 Node 里用假 `window.__ModuleLoader__` + 假 `require` 物化（test/client.test.js），
 * 这是没有构建链时唯一能持续验证的方式；真机效果仍须在 dsh web / 桌面端装一次看。
 */

console.info('[hhxg-market] client bundle executing')

window.__ModuleLoader__.load({
  id: '@hhxg/dsh-hhxg-market',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    let react
    let jsx
    let jsxs
    try {
      react = require('react')
      ;({ jsx, jsxs } = require('react/jsx-runtime'))
    } catch (error) {
      console.error('[hhxg-market] client require failed; card cannot mount:', error)
      throw error
    }

    const TOOL = 'hhxg_realtime'
    const SCHEMA = 1
    const KIND = 'hhxg.realtime'
    const STATUS_LABEL = {
      live: '盘中实时',
      lunch_break: '午间休市',
      closed: '收盘帧',
      previous_session: '非今日',
      stale: '延迟',
    }

    // 样式只用 DSH 的设计 token（随主题走），前缀 hhxg_ 不与宿主冲突；一次注入
    const css = [
      '.hhxg_card{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);padding:6px 0}',
      '.hhxg_head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}',
      '.hhxg_title{font-weight:600}',
      '.hhxg_badge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid var(--dsw-alias-border-default, rgba(128,128,128,.35))}',
      '.hhxg_badge[data-status="live"]{color:#15803d;border-color:#15803d55}',
      '.hhxg_badge[data-status="stale"],.hhxg_badge[data-status="previous_session"]{color:#b45309;border-color:#b4530955}',
      '.hhxg_meta{opacity:.7;font-size:11px}',
      '.hhxg_wrap{overflow:auto;max-height:360px;border:1px solid var(--dsw-alias-border-default, rgba(128,128,128,.25));border-radius:8px}',
      '.hhxg_table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}',
      '.hhxg_table th,.hhxg_table td{padding:3px 8px;white-space:nowrap;text-align:right;border-bottom:1px solid var(--dsw-alias-border-default, rgba(128,128,128,.15))}',
      '.hhxg_table th:first-child,.hhxg_table td:first-child,.hhxg_table th:nth-child(2),.hhxg_table td:nth-child(2){text-align:left}',
      '.hhxg_table th{position:sticky;top:0;background:var(--dsw-alias-bg-layer-1, inherit);font-weight:600}',
      '.hhxg_note{opacity:.7;font-size:11px;margin-top:6px}',
      '.hhxg_fallback{white-space:pre-wrap;font-family:inherit;font-size:12px;margin:0}',
    ].join('\n')
    let styled = false
    function ensureStyle() {
      if (styled || typeof document === 'undefined') return
      const tag = document.createElement('style')
      tag.setAttribute('data-hhxg-market', '')
      tag.textContent = css
      document.head.appendChild(tag)
      styled = true
    }

    /** 工具原文：content 里全部 text 块拼起来（与宿主默认卡一致）。 */
    function textOf(block) {
      const content = Array.isArray(block?.content) ? block.content : []
      return content
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n')
    }

    function usableMeta(meta) {
      return (
        meta &&
        typeof meta === 'object' &&
        meta.schema === SCHEMA &&
        meta.kind === KIND &&
        Array.isArray(meta.columns) &&
        Array.isArray(meta.rows)
      )
    }

    /** 单元格文本：只认 number / string，其余一律「—」（对象 toString 可能抛，不给它机会）。 */
    function fmt(v) {
      if (typeof v === 'number') return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : '—'
      if (typeof v === 'string') return v
      return '—'
    }

    // 下面三个是普通函数而不是子组件：子组件由 React 延后渲染，父级 try/catch 兜不住；
    // 直接在 RealtimeCard 里把整棵树算完，任何异常都落在同一个 catch。
    function fallbackEl(text, isError) {
      return jsx('pre', { className: 'hhxg_fallback', 'data-error': isError ? '' : undefined, children: text || (isError ? '工具调用失败' : '（无输出）') })
    }

    function badgeEl(frame) {
      if (!frame || typeof frame !== 'object' || typeof frame.status !== 'string') return null
      const label = STATUS_LABEL[frame.status] || frame.status
      const at = typeof frame.updated_at === 'string' ? frame.updated_at.slice(5, 16) : ''
      return jsxs('span', {
        className: 'hhxg_badge',
        'data-status': frame.status,
        title: typeof frame.status_text === 'string' ? frame.status_text : '',
        children: [label, at ? jsx('span', { className: 'hhxg_meta', children: at }) : null],
      })
    }

    function tableEl(columns, rows) {
      const head = columns.map((c, i) => jsx('th', { children: fmt(c) }, i))
      const body = rows.map((r, i) =>
        jsx('tr', { children: columns.map((_c, j) => jsx('td', { children: fmt(Array.isArray(r) ? r[j] : null) }, j)) }, i),
      )
      return jsx('div', {
        className: 'hhxg_wrap',
        children: jsxs('table', {
          className: 'hhxg_table',
          children: [jsx('thead', { children: jsx('tr', { children: head }) }), jsx('tbody', { children: body })],
        }),
      })
    }

    /** 结果卡：meta 可用 → 徽标 + 表；否则回退原文。整棵树在 try 里算完，任何异常都回退，不往上抛。 */
    function RealtimeCard(props) {
      let text = ''
      let isError = false
      try {
        const block = props?.block
        text = textOf(block)
        isError = !!block?.isError
        const meta = block?.meta
        if (isError || !usableMeta(meta)) return fallbackEl(text, isError)
        ensureStyle()
        const frame = meta.frame && typeof meta.frame === 'object' ? meta.frame : null
        const body = meta.rows.length === 0 ? fallbackEl(text, false) : tableEl(meta.columns, meta.rows)
        return jsxs('div', {
          className: 'hhxg_card',
          'data-view': typeof meta.view === 'string' ? meta.view : '',
          children: [
            jsxs('div', {
              className: 'hhxg_head',
              children: [
                jsx('span', { className: 'hhxg_title', children: typeof meta.title === 'string' && meta.title ? meta.title : TOOL }),
                badgeEl(frame),
                frame && typeof frame.trade_date === 'string' ? jsx('span', { className: 'hhxg_meta', children: frame.trade_date }) : null,
              ],
            }),
            body,
            meta.truncated ? jsx('div', { className: 'hhxg_note', children: '表格只显示部分行，完整结果见模型回复。' }) : null,
            typeof meta.note === 'string' && meta.note ? jsx('div', { className: 'hhxg_note', children: meta.note }) : null,
          ],
        })
      } catch (error) {
        console.warn('[hhxg-market] card render failed; falling back to text:', error)
        return fallbackEl(text, isError)
      }
    }

    const inject = ['slots']

    function apply(ctx) {
      try {
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register({ name: 'tool.call.toolview', key: TOOL }, RealtimeCard),
        )
      } catch (error) {
        console.error('[hhxg-market] could not register the realtime card:', error)
        throw error
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.RealtimeCard = RealtimeCard
    exports.TOOL = TOOL
    exports.react = react
    return module.exports
  },
})
