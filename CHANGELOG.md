# Changelog

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
