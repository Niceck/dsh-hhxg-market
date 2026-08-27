# Changelog

## 0.1.0 (2026-08-28)

首个版本。

- 6 个免费工具：`hhxg_snapshot` / `hhxg_news` / `hhxg_margin` / `hhxg_calendar` / `hhxg_sentiment` / `hhxg_themes`，直调 hhxg.top 公开端点，零配置可用。
- 5 个 VIP 工具：`hhxg_diagnose_stock` / `hhxg_strategy_signals` / `hhxg_predict_lianban` / `hhxg_stock_alerts` / `hhxg_query_dataset`，经 JSON-RPC 桥接 hhxg MCP server（`mcpToken` 配置解锁）。
- 未配置 Token 时 VIP 工具注册为引导占位；`enableVipTools: false` 可关闭。
- 纯 ESM JavaScript，免构建；`node --test` 测试套件（真实端点冒烟 + 纯逻辑单测）。
