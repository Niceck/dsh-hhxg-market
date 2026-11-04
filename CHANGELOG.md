# Changelog

## 0.6.2 (2026-11-04)

文案跟进版：`hhxg_realtime view=screen` 的 `limit` 上限随服务端从 50 提到 100。工具、参数 schema、数量不变。

- 服务端（STOCK-REPORT 查询服务 `rt.screen` 与 EdgeOne `get_realtime`）2026-11-04 起 `limit` 1-100（原 1-50），仍无翻页——盘中帧每分钟变，跨帧翻页会把两帧数据拼在一起，所以用提高上限代替 cursor；命中超过 100 时加条件收窄或用 sort 取最关心的前 100。插件说明与参数描述同步改为 1-100；桌面端卡片的 `view=screen` 表格上限也从 50 行提到 100 行（其余视图仍 50 行，给模型的全文本来就不截）；`limit` 本来就是原样透传，旧版插件传 51-100 会被旧服务端拒绝，服务端先上、插件后上。
- 0.6.1 的「仍未解决」项（命中超过 50 只看不全）到此为止；超过 100 只仍需收窄条件。

## 0.6.1 (2026-11-04)

盘中 / 盘后分流版：交易时段问「最新价」不再被答成昨日收盘价。工具名、参数、数量（7 免费 + 6 VIP）不变，不改服务端、不改字段口径。

- **问题** 2026-11-04 11:57 实测：交易时段问「航天题材最新价大于 BBI 且大于 MA60」，模型先调盘后的 `hhxg_strategy_signals`，拿到 11-03 盘后快照并把「最新价」解释成收盘价；追问后才改调 `hhxg_realtime view=screen`，又把响应里的 `indicators.base_date`（历史基准日 T-1）读成「BBI / MA60 仍按 11-03 日线计算」。实际服务端盘中指标是把帧交易日当天按最新价算成一根未走完的 K 线再算的（响应 `note` 有写，但排在几十行表格之后）。
- **说明分流** `hhxg_strategy_signals` 开头写明数据是上一交易日收盘的盘后快照、不含今天盘中行情，交易日 9:30 之后问最新价 / 盘中 / 实时 / 今天要改用 `hhxg_realtime view=screen`（filters 写法相同，价格字段叫 最新价）；`hhxg_realtime` 写明交易时段的选股优先 `view=screen`、盘中指标按最新价把当天当未走完 K 线计算、`base_date` 只是历史基准日、`limit` 最多 50 且没有翻页。
- **结果首行提醒** 盘后筛选结果在「北京时间工作日 09:30 之后、且快照数据日期早于今天」时首行加【注意】：15:00 前说明不含今天行情、改用 `hhxg_realtime view=screen`；15:00 之后到快照重建前说明盘中工具可取当日收盘帧。提醒里写明 Max 专属、盘中没有财务 / 筹码 / 两融 / 派生布尔列（要改写成 MA 等字段比较）、盘中不可用就按本快照回答并注明数据日期。只按时钟判断、不联网查日历，措辞是「若今天是交易日」——法定节假日里仍会出现但不断言开过盘；数据日期未知、字段目录模式不提醒；时区格式化器惰性创建、提醒整体兜底，任何异常只让提醒失效；提醒行计入 64 KiB 预算。
- **盘中口径行** `hhxg_realtime view=screen / quotes` 在计数行之后加【口径】：价格是帧时刻的最新价（非收盘价），MA / BBI / MACD / KDJ 等指标按这个最新价把帧交易日当作一根未走完的 K 线计算、不是上一交易日收盘的指标，`indicators.base_date` 只是历史基准日；收盘帧 / 旧帧换措辞（已含该价格的 K 线）；只在响应带 `indicators` 且有帧时输出；`available=false` 时原因走白名单（「指标帧没有跟上最新行情」→ 服务端正在追赶，未知值写「原因未说明」，quotes 未带 include 的「未请求指标」不输出），并提醒含指标的条件筛不到股票。
- 仍未解决：`view=screen` 命中超过 50 只没有翻页（服务端上限），只能加条件收窄或用 sort 取前 50。

## 0.6.0 (2026-11-04)

两列比较版：条件里可以让两个指标互相比较。工具名、数量（7 免费 + 6 VIP）不变，旧调用照常可用。服务端随 STOCK-REPORT `904dcd6bdb`（2026-11-03）上线。

- **两列比较** `hhxg_strategy_signals` 与 `hhxg_realtime view=screen` 的条件新增 `{field, op, ref, scale}`，含义 field op ref × scale（scale 默认 1，范围 (0, 100]，op 只能 gt/gte/lt/lte，ref 与 value 二选一）。例：站上 20 日线 `{field:"收盘价", op:"gt", ref:"MA20"}`、高出 5% 加 `scale:1.05`、突破布林上轨 `ref:"BOLL上"`、MA5 上穿 MA10 写两条（`MA5 gt ref=MA10` 与 `MA5_prev lte ref=MA10_prev`）、盘中多头排列写三条。此前条件 schema 只允许 field / op / value，模型只能翻页取回再自己比（实测 552 行漏 5 只）。
- **说明改写** 工具说明要求能写成 filters 的条件一次交给服务端，不翻页自己比；写明 `oversold_rebound`、`macd_death_cross` 两个不可用预设的 filters 等价写法；可筛列更新为约 270 列（含题材概念、股票池、持股标签、游资席位、行业 / 地域 / 市场类型、上市天数、股东集中度、大宗）；提示 `企业类型` 是实控人性质（民营多记为 自然人）。
- **本地预检** 两列比较形状不对（ref 为空或和 field 相同、op 不是 gt/gte/lt/lte、同时写了 value、scale 越界、只写 scale）本地拒绝；多值列（题材概念 / 股票池 / 持股标签 / 游资席位）只放行 contains / not_null——服务端对 ne / eq / in 按整串比较，取反会静默命中几乎全市场（插件在这点上有意比服务端严：eq / in 按整串比较也基本筛不到东西，按名称请用 contains，精确名写 `|涨停池|`）。`hhxg_realtime view=screen` 现在也走同一套 filters 预检，op 列表补上 contains（盘后属性列要用）。
- **条件回显** 结果第二行把两列比较写成 `收盘价 gt MA60 × 1.05`；字段目录说明两列比较写法。
- 不改上限、不改字段口径；两列是否存在、是否数值列仍由服务端判。

## 0.5.1 (2026-11-02)

文案修补版，工具与参数不变。

- **Token 页地址更新** 未配置 Token 时的占位说明、Token 无效 / 过期的错误提示、`mcpToken` 配置项描述、`cordis.patch.yml` 注释与 README 里的 MCP Token 签发页统一改为 `https://hhxg.top/developer.html#mcp`（旧地址 `account/mcp.html` 只剩跳转壳）。
- **桌面端卡片徽标文案统一** `client.js` 在旧版 meta 没给 `label` 时的本地回退表改成与 host 首行同一套文案（`previous_session` → 「非实时·上一交易日」、`stale` → 「非实时·延迟」，原为「非今日 / 延迟」）；`present.js` 导出 `STATUS_LABEL`，测试逐状态锁定两表相同。
- README 增加公开实测文章链接（0.5.0 条件选股的 5 组对话与 5 套策略计数）。
- 不改服务端、不改字段口径、不改任何上限。

## 0.5.0 (2026-11-02)

条件选股可用版：`hhxg_strategy_signals` 从「只能选预设」升级为「字段发现 + 自定义条件 + 全市场计数」。工具名、数量（7 免费 + 6 VIP）不变，旧的 `strategy_id` + `limit` 调用照常可用。

- **可筛字段可发现** `hhxg_strategy_signals(list_fields=true)` 返回服务端全部可筛字段（约 200 个，含名称与类型），按「派生布尔条件 / 派生位置指标 / 周线 / 月线 / 文本 / 日线及通用」分组列出，每个字段恰好一次、名称不截断，并附 op 用法与三个示例。
- **自定义条件筛选** 新增 `filters=[{field, op, value}]`（最多 8 条，op：gt/gte/lt/lte/eq/ne/in/contains/not_null）、`sort`、`fields`、`cursor` 参数，白名单透传给服务端 `screen_stocks`，插件不另造字段口径、不放宽上限；`strategy_id` 改为可选，与 `filters` 取交集；显式 `filters=[]` 表示不加条件看全市场。例：日线均线多头排列 `{field:"日均线多头", op:"eq", value:1}`。
- **全市场计数到首行** 结果文本首行为「全市场共 N 只满足条件｜本页显示 M 只｜数据日期 YYYY-MM-DD（盘后快照）」，N 取服务端 `total`（`limit` 只控制每页行数，只问数量可设 `limit=1`），随后按返回列逐行列出（代码 / 名称置前，`null` 显示「缺失」，0 不是缺失），末尾给 `next_cursor` 翻页提示；结果超过 64 KiB 只保留放得下的行并明说截断、不再给 cursor。桌面端纯文本可读，不再回显整段 JSON。
- **本地预检** 什么筛选方式都没给（或只给 cursor / sort / fields / limit）时在本地提示三种入口，不发请求；`filters` 形状非法（非数组、缺 field / op、op 不在列表、超过 8 条）按「参数有误：…（INVALID_ARG）」本地拒绝，不删条件继续查。
- **盘中 view=screen 的 total** `hhxg_realtime view=screen` 的文本在首行之后加一行「【筛选】全市场共 N 只满足条件｜本次显示 M 只（按当前有效行情统计…）」；工具描述（插件与服务端 `get_realtime` / `screen_stocks`）同步写明 `total` 是全市场命中数、`limit` 只限制返回行数。
- 数据集目录里「筛选」类数据集的指引改为本工具的三种用法；描述不再把用户支开到「MCP 客户端直接调 screen_stocks」。
- 盘中派生条件列（日 / 周 / 月均线、MACD、KDJ 多头）尚未进入实时帧：「此刻盘中有多少只多头排列」暂不支持，请用本工具按最近盘后快照回答并注明数据日期。

## 0.4.2 (2026-11-02)

结果可信度与兼容性修复版（外部评估 + Codex 审阅后的批次）。工具名、数量（7 免费 + 6 VIP）不变。

- **时效显式化** `hhxg_realtime` 的结果文本首行标出帧的状态与交易日（如「【非实时·上一交易日｜帧交易日 2026-10-30｜采集 2026-10-30 15:35】不是此刻的实时数据，引用时注明帧日期。」）；`status=live` 但 `is_live=false` 的矛盾帧按非实时处理，绝不显示成实时。web profile 结果卡的徽标改为显示同一段完整文案（host 投影统一生成）。
- **日 K 可比性语义** 服务端 `get_realtime view=kline` 响应 `schema_version` 升到 2：`live.comparable` 可为 `null`（无法判断：历史缓存落后于帧、个股最后收盘不在上一交易日、缺基准价或交易日历不可用，原因在 `live.reason`），`false` 改为「疑似除权 / 价格基准不一致」而非「确认除权」，新增响应级 `history`（缓存末日、按交易日历算的缺口）。插件文本在 `comparable !== true` 时追加提示行，卡片里帧那天的 K 不再一律标「今日·未收盘」。
- **本地预检** `view=kline` 的 `codes ≤ 5`、`bars` 1–260 整数、去重后 `codes × bars ≤ 1000`，以及 `view=quotes` 的 `codes ≤ 30`，越界在本地返回「参数有误：…（INVALID_ARG / RESULT_TOO_LARGE）」，不发请求。
- **Token 来源** 配置 `mcpToken` 留空时读环境变量 `HHXG_MCP_TOKEN`（显式配置非空时以配置为准；日志只记来源不记值）。
- **client 降级** 宿主未提供 React / jsx-runtime 或 slots 注册失败时，client 半不再抛错，只是不注册结果卡（宿主默认文本视图照常）。
- **peer 范围** `@deepseek-ai/dsh-tools` 放宽到 `>=0.1.1-rc.1 <0.3.0-0`（严格 semver 下另列出已知的 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.1-rc.5 / 0.2.2-alpha.2 预发布版本），cordis / schemastery 改为「不低于当前、不跨主版本」；契约测试新增两种预发布匹配模式的范围断言。
- npm 包 `@hhxg/dsh-hhxg-market` 自 0.4.1 起可用，README 安装段以 npm 为主。

## 0.4.1 (2026-11-01)

文案纠错 + 日 K 参数透传。工具名、数量（7 免费 + 6 VIP）与行为不变。

- **修正** 未配置 Token 时的占位文案与 `cordis.patch.yml` 头注释：dsh 目前不渲染第三方插件的配置项，**没有「设置 → 插件」界面可填**，正确做法是在 profile 的 `cordis.patch.yml` 里按 id `update` config 后重启 dsh（README 此前已是这个写法，占位文案与注释是错的）。
- **新增** `hhxg_realtime` 的 `view=kline`（日 K 序列，服务端 hhxg MCP `get_realtime` 同步新增，上线后可用）：`codes`（最多 5 只）、`period`（目前只支持 `day`）、`bars`（1-260，默认 120，`codes × bars ≤ 1000`）、`adj`（`qfq` 前复权 / `none`）、`include_live`（是否附今天这根未走完的 K，默认 true）。`rows` 只含已完成交易日（Tushare 不复权日线每晚同步，单位 元 / 股 / 元，缺值 null），`live` 单独给出今天的 bar 并带 `comparable`（今日除权时为 false，不要与前复权历史直接拼接）。分钟 K **不做**：每分钟快照差分还原不了区间高低，不伪造。
- **新增** `kline` 缺 `codes` 时本地给说明，不发请求（与 `quotes` 同）。

> **服务端变更（2026-10-28）**：`screen_stocks` 的 `macd_golden_cross` 改为可用预设（按派生列「日MACD金叉」筛，口径与原 pandas 表达式相同），可用预设 8 → 9 个，不支持的剩 3 个。插件行为不变（strategy_id 原样透传），`hhxg_strategy_signals` 的工具说明已同步，随下一版发布。

> **服务端变更（2026-10-27）**：hhxg MCP server 0.5.0 删除了 0.3.0 起保留的 8 个旧工具别名（原定 2026-11-30）。本插件 0.3.0 及以上不受影响；0.2.x 的 `hhxg_strategy_signals` / `hhxg_stock_alerts` 已失效，请升级。

## 0.4.0 (2026-10-27)

hhxg MCP server 0.4.0 新增 Max 会员专属的盘中实时工具 `get_realtime`，本版跟进。原有工具名、参数与行为不变。

- **新增** `hhxg_realtime`（VIP 工具 5 → 6 个）：盘中实时数据，交易日约 1 分钟一帧，盘后为当日收盘帧。
  - `view=market`：涨跌家数、涨停 / 跌停 / 炸板家数与炸板率、成交额，加涨停池 / 炸板池 / 跌停池与连板晋级率（`pool_limit` 1-50）。
  - `view=quotes`：`codes`（最多 30 只）的最新价、涨跌幅、量比、封单、开高低等，`include` 选 `daily` / `weekly` / `monthly` 指标（按最新价把今天当未走完的 K 线计算）。`codes` 传成 `"600519,000001"` 这样的字符串也会拆成数组。
  - `view=screen`：全市场按 `filters [{field, op, value}]` 筛选（最多 8 条），`sort` / `fields` / `limit`（1-50）/ `exclude_st`；周 / 月指标字段名加前缀「周」「月」。
  - `view=fields`：可用字段、取值说明与示例。
  - 每个结果带 `frame.status`（live 盘中 / lunch_break 午休 / closed 收盘帧 / previous_session 非今日 / stale 延迟）。
  - 只转发所选 view 的参数；`view` 缺失或非法、`quotes` 缺 `codes` 时在本地给说明，不发请求。
- **新增** 实时相关的业务性答复渲染成可读文本，不当作工具故障：
  - `REALTIME_MAX_REQUIRED` 显示为「需要 Max：…」并附升级地址。存量 Pro 持有效 Token 调 `hhxg_realtime` 会遇到它（接口保护期不含实时数据）。
  - `RT_SYNCING` / `RT_INDICATORS_STALE` / `RT_INDICATORS_UNAVAILABLE` / `RT_NAMES_UNAVAILABLE` 显示为「暂未就绪：…」，`RT_SYNCING` 附「约 N 秒后可重试」。
  - `RESULT_TOO_LARGE` 归入「参数有误：…」（请减少 codes / fields / limit）。
  - 实时采集离线的 `RT_UNAVAILABLE` 仍按故障抛出。
- **修正** 开通指引：2026-10-27 起 MCP Token 只签给 Max 会员（月付 ¥99 / 年付 ¥999），此前开通的 Pro 在原到期日前仍可用；Token 有效期跟随会员到期（不再是固定 30 天）。

## 0.3.1 (2026-10-24)

hhxg.top 2026-10-23 起选股数据会员独享：全市场指标全表（`quant_signal_pool`）与筛选快照（`screen_snapshot`）不再发布文件，`datasets.json` 里这两条不再给 urls，标 `access: "member"`、`delivery: "screen_stocks"`。本版只改文案与目录标注，工具名、参数与调用的服务端工具不变。

- **修正** `hhxg_strategy_signals` 描述：不再指引用 `hhxg_query_dataset(dataset_id="quant_signal_pool")` 取全表下载地址（该地址已停止发布）；不能作为预设的 4 个策略改为提示在 MCP 客户端用 `screen_stocks(filters=...)` 自行筛选比较。
- **修正** `hhxg_datasets`：会员专属的全市场宽表在「可 query」一栏标「筛选」（只能经策略筛选取数），表尾说明不再写「需直接下载」。

## 0.3.0 (2026-10-13)

hhxg MCP server 0.3.0 把工具从 15 个收敛到 7 个，本版跟进：VIP 工具只调用服务端的正式工具。工具名与原有参数不变。

- **改道** `hhxg_strategy_signals`：由 `get_strategy_signals` 改调 `screen_stocks`（`strategy_id` 作为策略预设 `preset` 传入）。行为差异：
  - 以前返回全市场指标全表的 CSV 直链和 pandas 过滤建议，要自己下载再筛；现在直接返回命中的个股（默认 20 条，新增可选参数 `limit` 1-100）。
  - 12 个策略标识里 8 个可用：`limit_up` / `volume_breakout` / `low_volume_consolidation` / `nineturn_buy` / `nineturn_sell` / `kdj_overbought` / `kdj_oversold` / `crash_warning`。
  - 另 4 个（`oversold_rebound` / `macd_golden_cross` / `macd_death_cross` / `distribution`）需要列间比较或分位数，返回说明文字（`PRESET_NOT_SUPPORTED`）。全表仍可取：`hhxg_query_dataset(dataset_id="quant_signal_pool")` 会给出下载地址（2026-10-23 起该地址停止发布，见 0.3.1）。
  - 未知的 `strategy_id` 以前只返回数据集地址，现在返回参数错误说明；`strategy_id` 为空时在本地提示可用预设，不发请求。
  - 站点查询服务离线时，部分预设会报错（`PRESET_UNAVAILABLE`），稍后重试即可。
- **改道** `hhxg_stock_alerts`：由 `get_stock_alerts_history` 改调 `query_dataset`（`dataset_id="stock_alerts_history"`，股票代码作为 `key`）。返回的数据字段不变（`stock_code` / `name` / `coverage` / `window_days` / `total` / `alerts` / `hint`）；`stock_code` 为空时在本地提示，不发请求。
- **修复**：更多业务性错误码渲染成可读文本而不是当作工具故障抛出，并按类别加前缀：参数类 `INVALID_ARG` / `INVALID_ARGS` / `UNKNOWN_FIELD` / `UNSUPPORTED_FILTER` 显示为「参数有误：…」，`PRESET_NOT_SUPPORTED` / `DATASET_TOO_LARGE` / `USE_SCREEN_STOCKS` 显示为「暂不支持：…」（服务端给了站内下载地址时一并附上），原有的无数据类仍是「无结果：…」。此前参数写错（服务端实际返回的是 `INVALID_ARG`，白名单里只有从未出现过的 `INVALID_ARGUMENT`）会被模型误判成工具坏了。权限类（`VIP_REQUIRED` / `TIER_INSUFFICIENT`）、限流与故障（含查询服务离线的 `PRESET_UNAVAILABLE`）仍按错误抛出。
- **修正** `hhxg_datasets` / `hhxg_query_dataset`：300KB 以内的 CSV 数据集现在可查（以前写「仅 JSON」）；目录的「可 query」一栏按格式与文件大小标 ✓ / 过大 / —；数据集数量不再写死。
- **兼容**：本版依赖服务端的 `screen_stocks(preset=...)` 与 `query_dataset(key=...)`，线上已具备。0.2.x 调用的两个旧工具名在服务端 0.3.0 起只是别名，保留到 **2026-11-30**，之后 0.2.x 的 `hhxg_strategy_signals` / `hhxg_stock_alerts` 会失效，请在此之前升级。
- **VIP 通道遇到站点瞬时 5xx（实测为边缘实例冷启动的 545）自动重试一次**，与免费通道一致；401 / 4xx / 业务错误不重试。VIP 工具都是只读查询，重试无副作用。

## 0.2.2 (2026-08-29)

- **修复**：MCP 上游返回 429/5xx 等非 2xx HTTP 状态时不再把空 JSON 误判成成功结果，统一返回带状态码且已脱敏的错误。
- **修复**：User-Agent 自动读取 package version，免费工具数量日志与未解锁提示统一为 7 个并补上 `hhxg_datasets`。
- **工程化**：新增 package lock、Node 18/20/22 确定性 CI、定时真实端点冒烟和 Dependabot。

## 0.1.0 (2026-08-28)

首个版本。

- 6 个免费工具：`hhxg_snapshot` / `hhxg_news` / `hhxg_margin` / `hhxg_calendar` / `hhxg_sentiment` / `hhxg_themes`，直调 hhxg.top 公开端点，零配置可用。
- 5 个 VIP 工具：`hhxg_diagnose_stock` / `hhxg_strategy_signals` / `hhxg_predict_lianban` / `hhxg_stock_alerts` / `hhxg_query_dataset`，经 JSON-RPC 桥接 hhxg MCP server（`mcpToken` 配置解锁）。
- 未配置 Token 时 VIP 工具注册为引导占位；`enableVipTools: false` 可关闭。
- 纯 ESM JavaScript，免构建；`node --test` 测试套件（真实端点冒烟 + 纯逻辑单测）。

## 0.2.0 (2026-08-28)

真机（dsh v0.1.1-rc.1 web profile）实测后的修复与增强。

- **修复**：MCP 业务性「无数据」响应（`NO_DATA` / `NOT_FOUND` / `UNSUPPORTED_FORMAT` / `UNSUPPORTED_ASSET` / `INVALID_ARGUMENT`）不再当作工具故障抛出，改为返回可读文本——此前"这只票今天没涨停"会被模型误判成工具坏了。
- **修复**：上游错误不再以裸 JSON 透给模型，统一渲染为「无结果：<原因>（<代码>）」。
- **新增** `hhxg_datasets`（免费）：列出全部 46 个开放数据集的 id / 分类 / 格式 / 更新频率，并标注哪些可用 `hhxg_query_dataset` 查询（仅 JSON 类，34 个）——补上了 `dataset_id` 此前缺失的发现路径。
- 免费工具 6 → 7 个。

## 0.2.1 (2026-08-28)

- **修复**：公开端点遇 5xx（真机实测 EdgeOne CDN 偶发 545 CPU 超限击杀）与网络抖动时自动重试一次（800ms 退避），此前一次抖动即整个工具调用失败。4xx 与用户取消不重试。
