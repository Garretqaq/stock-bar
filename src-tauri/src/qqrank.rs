//! 腾讯板块排行（行业 / 概念 / 地域）：主面板「板块榜单」在腾讯这一侧的取数入口。
//!
//! 为什么由 Rust 侧取：这个接口**不返回 CORS 头**（实测只对自家站点回
//! `Access-Control-Allow-Origin`，对 `tauri://localhost` / `http://tauri.localhost` 都没有），
//! 也不支持 JSONP（`cb=` / `callback=` 都只回纯 JSON，和搜索接口不一样）——
//! 于是 webview 里 fetch 一定被拦，板块榜单只要落到腾讯就一定加载失败。
//! Rust 侧取不经过 webview，也就没有 CORS / CSP 这回事（与 MCP 本地桥、版本更新同一条路子）。
//! 东财那侧接口带 CORS 头，仍旧由前端 fetch（见 src/api.ts）。
//!
//! 原样回 JSON 文本：一行里有哪些字段、怎么换算成 Board，只由 src/api.ts 一处说了算。

use std::time::Duration;

/// 每页条数：腾讯这个接口最多给 200（再大就报参数错误），与前端 `TENCENT_PAGE` 一致
const PAGE: u32 = 200;
/// 单次请求超时：板块要翻好几页，某一页卡住就整体失败（前端会保留上一份完整榜单）
const TIMEOUT: Duration = Duration::from_secs(8);

/// 允许的口径：行业一级 / 行业二级 / 概念 / 地域。
/// 只认这四个 —— 这个命令的参数是从 webview 来的，别让任意字符串拼进 URL。
fn check_type(ftype: &str) -> Result<&str, String> {
    match ftype {
        "hy" | "hy2" | "gn" | "dy" => Ok(ftype),
        other => Err(format!("不认识的板块口径：{other}")),
    }
}

/// 一页的地址。`sort_type` 只认 `price`（别的值报参数错误）；顺序无所谓，榜单在前端按涨跌幅重排。
fn page_url(ftype: &str, offset: u32) -> String {
    format!(
        "https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type={ftype}\
&sort_type=price&direct=down&offset={offset}&count={PAGE}"
    )
}

/// 装一次 rustls 的加密后端：reqwest 用的是 rustls-no-provider，不装 provider 就建不出 Client。
/// 与 tauri-plugin-updater 同一套（ring）；已装过时 get_default() 有值，这里直接跳过。
fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// 取一页排行，原样回 JSON 文本
pub async fn page(ftype: String, offset: u32) -> Result<String, String> {
    let ftype = check_type(&ftype)?;
    // offset 只按整页走（前端就是按 PAGE 翻的）：不对齐就往回退到页首
    let offset = offset - offset % PAGE;
    ensure_crypto_provider(); // 建 Client 之前必须有一个 rustls provider
    let res = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("板块请求构造失败：{e}"))?
        .get(page_url(ftype, offset))
        .send()
        .await
        .map_err(|e| format!("板块接口连不上：{e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("板块接口读取失败：{e}"))?;
    if !status.is_success() {
        return Err(format!("板块接口返回 HTTP {status}"));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 口径只认四种() {
        for t in ["hy", "hy2", "gn", "dy"] {
            assert!(check_type(t).is_ok(), "{t} 应当放行");
        }
        // 这个字符串是从 webview 传进来的：陌生值一律拒掉，别拼进 URL
        assert!(check_type("hy&count=9999").is_err());
        assert!(check_type("bogus").is_err());
        assert!(check_type("").is_err());
    }

    #[test]
    fn 一页的地址带上口径与整页偏移() {
        let u = page_url("gn", 0);
        assert!(u.contains("board_type=gn"), "{u}");
        assert!(u.contains("sort_type=price"), "{u}");
        assert!(u.contains("offset=0"), "{u}");
        assert!(u.contains("count=200"), "{u}");
        assert!(page_url("dy", 400).contains("offset=400"));
    }

    /// 联网用例（默认不跑）：`cargo test -- --ignored` 时验证真接口还认这套参数
    #[test]
    #[ignore = "联网：手动跑 cargo test -- --ignored"]
    fn 真接口_行业一级有31个() {
        let text = tauri::async_runtime::block_on(page("hy".into(), 0)).expect("取一页");
        let json: serde_json::Value = serde_json::from_str(&text).expect("回的是 JSON");
        let rows = json["data"]["rank_list"].as_array().expect("rank_list 是数组");
        assert_eq!(rows.len(), 31, "一级行业应当是 31 个");
        let code = rows[0]["code"].as_str().unwrap_or_default();
        assert!(code.starts_with("pt"), "板块代码形如 pt01801120，实际 {code}");
    }
}
