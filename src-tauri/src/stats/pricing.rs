// 模型 → $/token 价格表（精简版，离线 / 立即可用）。
//
// 数据来自 codeburn 0.9.10 的 LiteLLM 快照（src/data/litellm-snapshot.json），
// 我只挑了三个 CLI 实际会写进 JSONL 的常见模型：Claude Code（claude-*）、
// Codex（gpt-* / o*）、Gemini CLI（gemini-*）。表项格式：
//
//   (canonical_name, input_per_token, output_per_token,
//    cache_write_per_token_or_None, cache_read_per_token_or_None)
//
// 兜底：cache_write_per_token = input × 1.25；cache_read_per_token = input × 0.1
// （和 codeburn / LiteLLM 一致的 Anthropic 公式）。
//
// 名称归一（getCanonicalName）：
//   1. 去掉 `@xxx` pin 段（claude-sonnet-4-6@20250929 → claude-sonnet-4-6）
//   2. 去掉 `-YYYYMMDD` 日期段（claude-sonnet-4-20250514 → claude-sonnet-4）
//   3. 去掉 provider 前缀（anthropic/foo → foo）
//
// 查找逻辑（lookup）：
//   1. 优先用 `provider/foo` 形式整名查（有 `azure/gpt-5.4` 这类）
//   2. 走 alias 表（处理 `claude-4.6-opus` ↔ `claude-opus-4-6` 之类的别名）
//   3. 在 PRICING 里按 key 长度倒序前缀匹配 —— `gpt-5-mini` 不会塌成 `gpt-5`

use crate::types::UsageSummary;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModelCosts {
    /// $/token —— 不是 $/Mtok。和 LiteLLM 原始格式一致，乘法直接得 USD。
    pub input: f64,
    pub output: f64,
    pub cache_write: f64,
    pub cache_read: f64,
}

impl ModelCosts {
    /// 输入 None 时套用 Anthropic 默认公式：write = input × 1.25, read = input × 0.1。
    fn build(input: f64, output: f64, cache_write: Option<f64>, cache_read: Option<f64>) -> Self {
        ModelCosts {
            input,
            output,
            cache_write: cache_write.unwrap_or(input * 1.25),
            cache_read: cache_read.unwrap_or(input * 0.1),
        }
    }
}

/// 精简价格表。新模型上线时直接在这里加一行。
/// `None` 占位让兜底公式接管；非 None 的覆盖兜底。
type Row = (&'static str, f64, f64, Option<f64>, Option<f64>);

const PRICING: &[Row] = &[
    // ---------- Claude 4.x (https://platform.claude.com/docs/zh-CN/about-claude/pricing) ----------
    ("claude-opus-4-8",      0.000005,  0.000025,   Some(0.00000625), Some(0.0000005)),
    ("claude-opus-4-7",      0.000005,  0.000025,   Some(0.00000625), Some(0.0000005)),
    ("claude-opus-4-6",      0.000005,  0.000025,   Some(0.00000625), Some(0.0000005)),
    ("claude-opus-4-5",      0.000005,  0.000025,   Some(0.00000625), Some(0.0000005)),
    ("claude-opus-4-1",      0.000015,  0.000075,   Some(0.00001875), Some(0.0000015)),
    ("claude-opus-4",        0.000015,  0.000075,   Some(0.00001875), Some(0.0000015)),
    ("claude-sonnet-4-6",    0.000003,  0.000015,   Some(0.00000375), Some(0.0000003)),
    ("claude-sonnet-4-5",    0.000003,  0.000015,   Some(0.00000375), Some(0.0000003)),
    ("claude-sonnet-4",      0.000003,  0.000015,   Some(0.00000375), Some(0.0000003)),
    ("claude-haiku-4-5",     0.000001,  0.000005,   Some(0.00000125), Some(0.0000001)),
    // ---------- Claude 3.x ----------
    ("claude-3-7-sonnet",    0.000003,  0.000015,   None,             None),
    ("claude-3-5-sonnet",    0.000003,  0.000015,   None,             None),
    ("claude-3-5-haiku",     0.0000008, 0.000004,   None,             None),
    ("claude-3-opus",        0.000015,  0.000075,   None,             None),
    ("claude-3-sonnet",      0.000003,  0.000015,   None,             None),
    ("claude-3-haiku",       0.00000025,0.00000125, None,             None),
    // ---------- OpenAI / Codex ----------
    // 价格核对自 developers.openai.com/api/docs/pricing（in / cached / out, $/MTok）。
    // Codex 系（CLI 实际写进 JSONL 的）：
    ("gpt-5.3-codex",        0.00000175,0.000014,   None,             Some(0.000000175)),
    ("gpt-5.2-codex",        0.00000175,0.000014,   None,             Some(0.000000175)),
    ("gpt-5.1-codex-max",    0.00000125,0.00001,    None,             Some(0.000000125)),
    ("gpt-5.1-codex-mini",   0.00000025,0.000002,   None,             Some(0.000000025)),
    ("gpt-5.1-codex",        0.00000125,0.00001,    None,             Some(0.000000125)),
    ("gpt-5-codex",          0.00000125,0.00001,    None,             Some(0.000000125)),
    ("codex-mini-latest",    0.0000015, 0.000006,   None,             Some(0.000000375)),
    // gpt-5 base 系：
    ("gpt-5.5-pro",          0.00003,   0.00018,    None,             None),
    ("gpt-5.4-pro",          0.00003,   0.00018,    None,             None),
    ("gpt-5.2-pro",          0.000021,  0.000168,   None,             None),
    ("gpt-5-pro",            0.000015,  0.00012,    None,             None),
    ("gpt-5.5",              0.000005,  0.00003,    None,             Some(0.0000005)),
    ("gpt-5.4",              0.0000025, 0.000015,   None,             Some(0.00000025)),
    ("gpt-5.3",              0.00000175,0.000014,   None,             Some(0.000000175)),
    ("gpt-5.2",              0.00000175,0.000014,   None,             Some(0.000000175)),
    ("gpt-5.1",              0.00000125,0.00001,    None,             Some(0.000000125)),
    ("gpt-5",                0.00000125,0.00001,    None,             Some(0.000000125)),
    ("gpt-4o-mini",          0.00000015,0.0000006,  None,             Some(0.000000075)),
    ("gpt-4o",               0.0000025, 0.00001,    None,             Some(0.00000125)),
    ("gpt-4.1-nano",         0.0000001, 0.0000004,  None,             Some(0.000000025)),
    ("gpt-4.1-mini",         0.0000004, 0.0000016,  None,             Some(0.0000001)),
    ("gpt-4.1",              0.000002,  0.000008,   None,             Some(0.0000005)),
    ("o4-mini",              0.0000011, 0.0000044,  None,             Some(0.000000275)),
    ("o3-mini",              0.0000011, 0.0000044,  None,             Some(0.00000055)),
    ("o3",                   0.000002,  0.000008,   None,             Some(0.0000005)),
    // ---------- Google / Gemini ----------
    // 价格核对自 ai.google.dev/gemini-api/docs/pricing（付费层，文本输入价, $/MTok）。
    // 注：2.5-pro / 3-pro 系为分档定价（>200k 提示翻倍），此处统一取低档（≤200k，多数 CLI 会话）。
    ("gemini-3.5-flash",         0.0000015, 0.000009,   None, Some(0.00000015)),
    ("gemini-3.1-flash-lite",    0.00000025,0.0000015,  None, Some(0.000000025)),
    ("gemini-3.1-pro-preview",   0.000002,  0.000012,   None, Some(0.0000002)),
    ("gemini-3-pro-preview",     0.000002,  0.000012,   None, Some(0.0000002)),
    ("gemini-3-flash-preview",   0.0000005, 0.000003,   None, Some(0.00000005)),
    ("gemini-2.5-pro",           0.00000125,0.00001,    None, Some(0.000000125)),
    ("gemini-2.5-flash-lite",    0.0000001, 0.0000004,  None, Some(0.00000001)),
    ("gemini-2.5-flash",         0.0000003, 0.0000025,  None, Some(0.00000003)),
    ("gemini-2.0-flash-lite",    0.000000075,0.0000003, None, Some(0.00000001875)),
    ("gemini-2.0-flash",         0.0000001, 0.0000004,  None, Some(0.000000025)),
];

/// 内置别名表 —— 把厂商 / IDE 多写的"花式名"映射到 PRICING 里的 canonical key。
/// 同义于 codeburn 的 BUILTIN_ALIASES；只挑了三个 CLI 实际可能出现的几条。
const ALIASES: &[(&str, &str)] = &[
    ("claude-opus-4.8",         "claude-opus-4-8"),
    ("claude-opus-4.7",         "claude-opus-4-7"),
    ("claude-opus-4.6",         "claude-opus-4-6"),
    ("claude-opus-4.5",         "claude-opus-4-5"),
    ("claude-sonnet-4.6",       "claude-sonnet-4-6"),
    ("claude-sonnet-4.5",       "claude-sonnet-4-5"),
    ("claude-haiku-4.5",        "claude-haiku-4-5"),
    ("gpt-5-fast",              "gpt-5"),
    ("gpt-5.2-low",             "gpt-5"),
];

/// 规范化：去掉 `@xxx` pin、`-YYYYMMDD` 日期、provider 前缀。
fn canonical(model: &str) -> String {
    let mut s = model.to_string();
    // 1) 去 @ 后缀
    if let Some(pos) = s.find('@') {
        s.truncate(pos);
    }
    // 2) 去末尾 8 位数字日期
    if let Some(stripped) = strip_trailing_yyyymmdd(&s) {
        s = stripped;
    }
    // 3) 去 provider/ 前缀（first slash）
    if let Some(pos) = s.find('/') {
        s = s[pos + 1..].to_string();
    }
    s
}

fn strip_trailing_yyyymmdd(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    if bytes.len() < 9 {
        return None;
    }
    let tail = &bytes[bytes.len() - 8..];
    if tail.iter().all(|b| b.is_ascii_digit()) && bytes[bytes.len() - 9] == b'-' {
        return Some(s[..bytes.len() - 9].to_string());
    }
    None
}

fn resolve_alias(name: &str) -> String {
    for (k, v) in ALIASES {
        if *k == name {
            return (*v).to_string();
        }
    }
    name.to_string()
}

/// 优先整名（保留 provider 前缀），再走 alias / 归一 / 前缀匹配。
/// 找不到任何匹配返回 None —— 调用方按 0 美元处理。
pub fn lookup(model: &str) -> Option<ModelCosts> {
    if model.is_empty() {
        return None;
    }
    // 1) 整名（剥 @ / 日期，不剥 provider）
    let mut with_prefix = model.to_string();
    if let Some(pos) = with_prefix.find('@') {
        with_prefix.truncate(pos);
    }
    if let Some(s) = strip_trailing_yyyymmdd(&with_prefix) {
        with_prefix = s;
    }
    if let Some(c) = direct_lookup(&with_prefix) {
        return Some(c);
    }
    // 2) canonical + alias
    let canon = resolve_alias(&canonical(model));
    if let Some(c) = direct_lookup(&canon) {
        return Some(c);
    }
    // 3) 前缀兜底：按 key 长度倒序找最长前缀 base。匹配到 base 后，若该 base 有
    //    「已知最新数字子版本」就改用它的价 —— 譬如未知的 claude-opus-4-9 命中 base
    //    claude-opus-4，但应套最新已知的 claude-opus-4-8 价，而不是初代 base 的旧贵价。
    let mut sorted: Vec<&Row> = PRICING.iter().collect();
    sorted.sort_by_key(|(k, _, _, _, _)| std::cmp::Reverse(k.len()));
    for row in sorted {
        let (k, i, o, w, r) = *row;
        if canon == k {
            return Some(ModelCosts::build(i, o, w, r));
        }
        if canon.starts_with(&format!("{k}-")) {
            if let Some((_, ci, co, cw, cr)) = newest_numeric_child(k) {
                return Some(ModelCosts::build(*ci, *co, *cw, *cr));
            }
            return Some(ModelCosts::build(i, o, w, r));
        }
    }
    None
}

/// 在 PRICING 里找 `{base}-{N}` 形式、N 为纯数字的子版本，返回 N 最大的那一行。
/// 用于「未知新版本回退到同系列最新已知版本」的价格猜测。
fn newest_numeric_child(base: &str) -> Option<&'static Row> {
    let prefix = format!("{base}-");
    let mut best: Option<(u64, &'static Row)> = None;
    for row in PRICING {
        let Some(tail) = row.0.strip_prefix(&prefix) else {
            continue;
        };
        if tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        if let Ok(n) = tail.parse::<u64>() {
            if best.map_or(true, |(bn, _)| n > bn) {
                best = Some((n, row));
            }
        }
    }
    best.map(|(_, r)| r)
}

fn direct_lookup(name: &str) -> Option<ModelCosts> {
    for (k, i, o, w, r) in PRICING {
        if *k == name {
            return Some(ModelCosts::build(*i, *o, *w, *r));
        }
    }
    None
}

/// 按 usage 算这次调用的美元成本。找不到模型按 $0 计 —— 跟 codeburn 一致。
pub fn cost_usd(model: &str, usage: &UsageSummary) -> f64 {
    let Some(c) = lookup(model) else {
        return 0.0;
    };
    let safe = |n: u64| n as f64;
    safe(usage.input_tokens) * c.input
        + safe(usage.output_tokens) * c.output
        + safe(usage.cache_creation_input_tokens) * c.cache_write
        + safe(usage.cache_read_input_tokens) * c.cache_read
}

/// 不规则显示名覆盖表 —— 只放 `derive_name` 推不出的：旧式 claude-3.x（家族在尾）、
/// o 系小写、以及 codex 独立名。规则命名的现代模型一律走 `derive_name`，新版本免改表。
const SHORT_OVERRIDE: &[(&str, &str)] = &[
    ("claude-3-7-sonnet", "Sonnet 3.7"),
    ("claude-3-5-sonnet", "Sonnet 3.5"),
    ("claude-3-5-haiku",  "Haiku 3.5"),
    ("claude-3-opus",     "Opus 3"),
    ("codex-mini-latest", "Codex Mini"),
    ("o4-mini",           "o4-mini"),
    ("o3-mini",           "o3-mini"),
    ("o3-pro",            "o3-pro"),
    ("o3",                "o3"),
    ("o1-mini",           "o1-mini"),
    ("o1-pro",            "o1-pro"),
    ("o1",                "o1"),
];

/// 模型友好显示名 —— "Opus 4.7" / "Sonnet 4.6" / "GPT-5.3 Codex" 等。前端 By Model 块用。
/// 顺序：通用推导（覆盖规则命名的现代模型，新版本零改动）→ 不规则覆盖表 → 原样 canonical。
pub fn short_name(model: &str) -> String {
    let canon = resolve_alias(&canonical(model));
    if let Some(name) = derive_name(&canon) {
        return name;
    }
    let mut sorted: Vec<&(&str, &str)> = SHORT_OVERRIDE.iter().collect();
    sorted.sort_by_key(|(k, _)| std::cmp::Reverse(k.len()));
    for (k, label) in sorted {
        if canon.starts_with(*k) {
            return (*label).to_string();
        }
    }
    canon
}

/// 从结构化模型 ID 推导显示名。只在能自信解析时返回 Some；不规则名返回 None 交给覆盖表。
///   claude-<family>-<major>[-<minor>...]  -> "Opus 4.8" / "Sonnet 4"
///   gpt-<ver>[-suffix...]                 -> "GPT-5.3 Codex" / "GPT-4o Mini"
///   gemini-<ver>[-variant...][-preview]   -> "Gemini 2.5 Flash"（剥尾部 preview / 日期段）
fn derive_name(canon: &str) -> Option<String> {
    if let Some(rest) = canon.strip_prefix("claude-") {
        let segs: Vec<&str> = rest.split('-').collect();
        let family = match *segs.first()? {
            "opus" => "Opus",
            "sonnet" => "Sonnet",
            "haiku" => "Haiku",
            _ => return None, // 旧式 claude-3-5-sonnet（家族在尾）交给覆盖表
        };
        let ver = &segs[1..];
        if ver.is_empty() || !ver.iter().all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())) {
            return None;
        }
        return Some(format!("{family} {}", ver.join(".")));
    }
    if let Some(rest) = canon.strip_prefix("gpt-") {
        let segs: Vec<&str> = rest.split('-').collect();
        let ver = segs.first()?;
        if ver.is_empty() {
            return None;
        }
        let mut out = format!("GPT-{ver}");
        for s in &segs[1..] {
            out.push(' ');
            out.push_str(&title_case(s));
        }
        return Some(out);
    }
    if let Some(rest) = canon.strip_prefix("gemini-") {
        let mut segs: Vec<&str> = rest.split('-').collect();
        // 剥尾部的 preview 标记和纯数字日期段（如 -preview-05-06），但保留版本段 segs[0]。
        while segs.len() > 1 {
            let last = *segs.last().unwrap();
            if last == "preview" || (!last.is_empty() && last.bytes().all(|b| b.is_ascii_digit())) {
                segs.pop();
            } else {
                break;
            }
        }
        let ver = segs.first()?;
        if ver.is_empty() {
            return None;
        }
        let mut out = format!("Gemini {ver}");
        for s in &segs[1..] {
            out.push(' ');
            out.push_str(&title_case(s));
        }
        return Some(out);
    }
    None
}

/// 首字母大写，其余原样（codex -> Codex, mini -> Mini, 4o -> 4o 不受影响因首字符是数字）。
fn title_case(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(input: u64, output: u64, cw: u64, cr: u64) -> UsageSummary {
        UsageSummary {
            input_tokens: input,
            output_tokens: output,
            cache_creation_input_tokens: cw,
            cache_read_input_tokens: cr,
            reasoning_output_tokens: 0,
            total: input + output + cw + cr,
        }
    }

    #[test]
    fn canonical_strips_pin_date_and_provider_prefix() {
        assert_eq!(canonical("anthropic/claude-opus-4-6@20250929"), "claude-opus-4-6");
        assert_eq!(canonical("claude-sonnet-4-20250514"), "claude-sonnet-4");
        assert_eq!(canonical("openrouter/anthropic/claude-opus-4-6"), "anthropic/claude-opus-4-6");
        // 注意：canonical 只剥第一段 provider；本表会再用整名查一次（with_prefix）
    }

    #[test]
    fn lookup_direct_hit_for_known_model() {
        let c = lookup("claude-opus-4-7").expect("known");
        assert!((c.input - 0.000005).abs() < 1e-12);
        assert!((c.output - 0.000025).abs() < 1e-12);
    }

    #[test]
    fn lookup_resolves_alias_dot_form_to_dash_form() {
        let dot = lookup("claude-sonnet-4.6").expect("aliased");
        let dash = lookup("claude-sonnet-4-6").expect("direct");
        assert_eq!(dot, dash);
    }

    #[test]
    fn lookup_longest_prefix_wins() {
        // gpt-5-mini 不应该塌到 gpt-5（不同价位的兄弟）
        // 表里没 gpt-5-mini，前缀匹配会回 gpt-5；但要确保 gpt-5.3-codex 不会塌到 gpt-5
        let gpt5 = lookup("gpt-5").expect("known");
        let codex = lookup("gpt-5.3-codex").expect("known");
        assert!(codex.input > gpt5.input, "codex priced higher than base gpt-5");
    }

    #[test]
    fn lookup_strips_yyyymmdd_suffix() {
        let with_date = lookup("claude-sonnet-4-6-20251201").expect("date-stripped");
        let plain = lookup("claude-sonnet-4-6").expect("direct");
        assert_eq!(with_date, plain);
    }

    #[test]
    fn lookup_strips_at_pin() {
        let with_pin = lookup("claude-sonnet-4-6@20250929").expect("pin-stripped");
        let plain = lookup("claude-sonnet-4-6").expect("direct");
        assert_eq!(with_pin, plain);
    }

    #[test]
    fn lookup_returns_none_for_local_or_unknown() {
        assert!(lookup("llama3:8b-instruct").is_none());
        assert!(lookup("totally-made-up-model").is_none());
        assert!(lookup("").is_none());
    }

    #[test]
    fn cost_usd_for_known_model_uses_table() {
        // Opus 4.7: input=$5/Mtok, output=$25/Mtok
        // 1M in + 1M out = $30
        let one_million = u(1_000_000, 1_000_000, 0, 0);
        let c = cost_usd("claude-opus-4-7", &one_million);
        assert!((c - 30.0).abs() < 1e-6, "got {c}");
    }

    #[test]
    fn cost_usd_includes_cache_components() {
        // Sonnet 4.6: input=$3/Mtok, output=$15/Mtok, write=$3.75/Mtok, read=$0.3/Mtok
        // 1M cache_write + 1M cache_read = $3.75 + $0.30 = $4.05
        let usage = u(0, 0, 1_000_000, 1_000_000);
        let c = cost_usd("claude-sonnet-4-6", &usage);
        assert!((c - 4.05).abs() < 1e-6, "got {c}");
    }

    #[test]
    fn cost_usd_zero_for_unknown_model() {
        let big = u(1_000_000, 1_000_000, 1_000_000, 1_000_000);
        assert_eq!(cost_usd("ollama/llama-3", &big), 0.0);
    }

    #[test]
    fn short_name_picks_longest_prefix() {
        assert_eq!(short_name("claude-opus-4-8"), "Opus 4.8");
        assert_eq!(short_name("claude-opus-4-7"), "Opus 4.7");
        assert_eq!(short_name("gpt-5.3-codex"), "GPT-5.3 Codex");
        assert_eq!(short_name("gpt-5-fast"), "GPT-5"); // aliased
        assert_eq!(short_name("gemini-2.5-pro-preview-05-06"), "Gemini 2.5 Pro");
    }

    #[test]
    fn opus_4_8_does_not_collapse_to_base_opus_4() {
        // 回归：4-8 既要有独立显示名，也要走 4.x 价位而非贵 3 倍的 base opus-4
        assert_eq!(short_name("claude-opus-4-8"), "Opus 4.8");
        let v48 = lookup("claude-opus-4-8").expect("known");
        let v47 = lookup("claude-opus-4-7").expect("known");
        assert_eq!(v48, v47);
    }

    #[test]
    fn short_name_falls_back_to_canonical_for_unknown() {
        assert_eq!(short_name("totally-new-model-9"), "totally-new-model-9");
    }

    #[test]
    fn derive_name_handles_future_versions_without_table_edits() {
        // Claude：家族在前的 4.x+ 一律自动推导，没在任何表里也对
        assert_eq!(short_name("claude-opus-4-9"), "Opus 4.9");
        assert_eq!(short_name("claude-opus-5-0"), "Opus 5.0");
        assert_eq!(short_name("claude-sonnet-5"), "Sonnet 5");
        assert_eq!(short_name("claude-opus-4"), "Opus 4");
        // GPT：版本在中间、后缀任意层级
        assert_eq!(short_name("gpt-5.6-codex"), "GPT-5.6 Codex");
        assert_eq!(short_name("gpt-5.1-codex-max"), "GPT-5.1 Codex Max");
        assert_eq!(short_name("gpt-4.1-mini"), "GPT-4.1 Mini");
        assert_eq!(short_name("gpt-4o"), "GPT-4o");
        // Gemini：剥尾部 preview / 日期段
        assert_eq!(short_name("gemini-2.5-flash-lite"), "Gemini 2.5 Flash Lite");
        assert_eq!(short_name("gemini-3-pro-preview"), "Gemini 3 Pro");
    }

    #[test]
    fn short_name_override_keeps_irregular_names() {
        assert_eq!(short_name("claude-3-5-sonnet"), "Sonnet 3.5");
        assert_eq!(short_name("claude-3-7-sonnet"), "Sonnet 3.7");
        assert_eq!(short_name("o3"), "o3");
        assert_eq!(short_name("o4-mini"), "o4-mini");
        assert_eq!(short_name("codex-mini-latest"), "Codex Mini");
    }

    #[test]
    fn unknown_version_falls_back_to_newest_known_sibling() {
        // 表里没有 4-99 -> 应套最新已知子版本 4-8（$5/$25），而不是初代 base opus-4（$15/$75）
        let v = lookup("claude-opus-4-99").expect("sibling fallback");
        let newest = lookup("claude-opus-4-8").expect("known");
        assert_eq!(v, newest);
        assert!((v.input - 0.000005).abs() < 1e-12, "got {}", v.input);
        // 明确不是塌到 base 的旧贵价
        assert!((v.input - 0.000015).abs() > 1e-12);
    }

    #[test]
    fn codex_pricing_matches_official() {
        // gpt-5.1-codex-mini 修正后：input $0.25/MTok（曾错填 $0.50）
        let mini = lookup("gpt-5.1-codex-mini").expect("known");
        assert!((mini.input - 0.00000025).abs() < 1e-12, "got {}", mini.input);
        // 新增的真实 codex 模型
        let c52 = lookup("gpt-5.2-codex").expect("known");
        assert!((c52.output - 0.000014).abs() < 1e-12, "got {}", c52.output);
        let cmax = lookup("gpt-5.1-codex-max").expect("known");
        assert!((cmax.input - 0.00000125).abs() < 1e-12, "got {}", cmax.input);
        // base gpt-5.5 修正后：1M input = $5
        let c = cost_usd("gpt-5.5", &u(1_000_000, 0, 0, 0));
        assert!((c - 5.0).abs() < 1e-6, "got {c}");
    }

    #[test]
    fn gemini_pricing_matches_official() {
        // 3-pro 修正后：input $2/MTok、output $12/MTok、cache $0.20/MTok（曾错填 2.5-pro 的数）
        let pro = lookup("gemini-3.1-pro-preview").expect("known");
        assert!((pro.input - 0.000002).abs() < 1e-12, "got {}", pro.input);
        assert!((pro.output - 0.000012).abs() < 1e-12, "got {}", pro.output);
        // 3-flash-preview 修正后：$0.50 / $3
        let flash3 = lookup("gemini-3-flash-preview").expect("known");
        assert!((flash3.input - 0.0000005).abs() < 1e-12, "got {}", flash3.input);
        assert!((flash3.output - 0.000003).abs() < 1e-12, "got {}", flash3.output);
        // 2.5-flash-lite 缓存修正：$0.01（曾错填 $0.025）
        let lite = lookup("gemini-2.5-flash-lite").expect("known");
        assert!((lite.cache_read - 0.00000001).abs() < 1e-12, "got {}", lite.cache_read);
        // 新增模型不再算成 $0
        let f35 = cost_usd("gemini-3.5-flash", &u(1_000_000, 0, 0, 0));
        assert!((f35 - 1.5).abs() < 1e-6, "got {f35}");
        assert!(lookup("gemini-3.1-flash-lite").is_some());
        // 显示名走通用推导
        assert_eq!(short_name("gemini-3.5-flash"), "Gemini 3.5 Flash");
    }
}
