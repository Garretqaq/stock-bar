//! WebDAV 备份 / 恢复，以及 WebDAV 密码的本地加密。
//!
//! 两件事都放在 Rust 侧：
//! - **联网**：WebDAV 服务器基本都不回 CORS 头，webview 里 fetch 要么被拦、要么预检不过，
//!   所以 PUT / GET / OPTIONS 都由这里发（与 MCP 本地桥、腾讯板块排行同一条路子）。
//!   前端只管文案与流程，见 src/backup.ts 与 src/prefs.ts。
//! - **密码加密**：密码密文存在 localStorage（跟着整份设置走），**明文不进 localStorage**。
//!   密钥是 app data 目录里的一个 32 字节随机文件（`secret.key`，Unix 上 0600），
//!   AES-256-GCM 加密（ring 的 AEAD，本来就在依赖树里 —— 换机器 / 拷贝设置目录才会解不开，
//!   那时界面提示「重新输入密码」，不会静默失败）。
//!
//! 远端只有两个固定坑位：`settings.json`（常规备份，每次直接覆盖）与 `restore-safety.json`
//! （只在恢复前写一份本地当前数据，不当恢复源 —— 恢复搞砸了还能手工取回来）。

use std::path::PathBuf;
use std::time::Duration;

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use tauri::{AppHandle, Manager};

/// 常规备份（恢复源）：每次备份覆盖这一份
const BACKUP_FILE: &str = "settings.json";
/// 恢复前的安全副本：只在「从备份恢复」时写入，不当恢复源
const SAFETY_FILE: &str = "restore-safety.json";
/// 密钥文件名（app data 目录下）
const KEY_FILE: &str = "secret.key";
/// 密文前缀：将来换算法时靠它认版本，别改
const CIPHER_PREFIX: &str = "v1:";
/// 单次请求超时：备份文件很小，卡住就是网络或地址不对
const TIMEOUT: Duration = Duration::from_secs(20);
/// 密码长度上限：本地加密不是给大文件用的
const MAX_SECRET: usize = 4096;

// ---------- 纯逻辑 ----------

/// slot → 远端文件名。参数来自 webview，只认这两个（别让任意字符串拼进 URL）
fn slot_file(slot: &str) -> Result<&'static str, String> {
    match slot {
        "backup" => Ok(BACKUP_FILE),
        "safety" => Ok(SAFETY_FILE),
        other => Err(format!("不认识的备份位置：{other}")),
    }
}

/// 用户填的目录地址：去掉首尾空白与末尾斜杠。空值由调用方先挡下来。
fn base_url(raw: &str) -> &str {
    raw.trim().trim_end_matches('/')
}

/// 校验目录地址，返回规整后的形式（空 = 空串）
fn check_base(raw: &str) -> Result<String, String> {
    let base = base_url(raw);
    if base.is_empty() {
        return Err("先填 WebDAV 地址".into());
    }
    let lower = base.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err("地址要以 http:// 或 https:// 开头".into());
    }
    Ok(base.to_string())
}

/// 目录地址 + 文件名。文件名是常量，但仍旧挡一次斜杠，免得拼出别处的路径
fn join_url(base: &str, file: &str) -> Result<String, String> {
    let base = check_base(base)?;
    if file.is_empty() || file.contains('/') || file.contains("..") {
        return Err(format!("备份文件名不合法：{file}"));
    }
    Ok(format!("{base}/{file}"))
}

/// 十六进制编码（避免为了 base64 再引一个依赖）
fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    out
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(text.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    Some(out)
}

fn aead_key(key: &[u8; 32]) -> Result<LessSafeKey, String> {
    let unbound = UnboundKey::new(&AES_256_GCM, key).map_err(|_| "加密密钥不可用".to_string())?;
    Ok(LessSafeKey::new(unbound))
}

/// 加密成 `v1:<nonce><密文+tag>`（十六进制）。同一明文每次给不同的密文（nonce 随机）。
fn seal(key: &[u8; 32], plain: &str) -> Result<String, String> {
    if plain.len() > MAX_SECRET {
        return Err("密码太长了".into());
    }
    let mut nonce_bytes = [0u8; 12];
    getrandom::fill(&mut nonce_bytes).map_err(|e| format!("取随机数失败：{e}"))?;
    let k = aead_key(key)?;
    let mut buf = plain.as_bytes().to_vec();
    k.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce_bytes),
        Aad::empty(),
        &mut buf,
    )
    .map_err(|_| "加密失败".to_string())?;
    Ok(format!("{CIPHER_PREFIX}{}{}", hex(&nonce_bytes), hex(&buf)))
}

/// 解密 `v1:` 密文。格式不对、密钥不对（换过机器 / 密钥文件丢了）都报同一句人话。
fn open(key: &[u8; 32], stored: &str) -> Result<String, String> {
    let rest = stored
        .strip_prefix(CIPHER_PREFIX)
        .ok_or_else(|| "密文格式不认识，请重新输入密码".to_string())?;
    let raw = unhex(rest).ok_or_else(|| "密文格式不认识，请重新输入密码".to_string())?;
    // 12 字节 nonce + 至少一个 tag（16 字节）；空密码也就是这 28 字节
    if raw.len() < 28 {
        return Err("密文格式不认识，请重新输入密码".into());
    }
    let (nonce_bytes, ct) = raw.split_at(12);
    let nonce = Nonce::assume_unique_for_key(
        nonce_bytes
            .try_into()
            .map_err(|_| "密文格式不认识，请重新输入密码".to_string())?,
    );
    let k = aead_key(key)?;
    let mut buf = ct.to_vec();
    let plain = k
        .open_in_place(nonce, Aad::empty(), &mut buf)
        .map_err(|_| "密码在本机解不开（可能是别的机器上的密钥），请重新输入".to_string())?;
    String::from_utf8(plain.to_vec()).map_err(|_| "解出来的密码不是文本，请重新输入".into())
}

/// HTTP 状态码 → 人话。action 是「备份 / 恢复 / 测试连接」，拼进提示里
fn status_error(action: &str, status: u16) -> String {
    let why = match status {
        401 => "用户名或密码不对",
        403 => "没有权限（这个账号不能写这个目录）",
        404 => "地址不对：找不到这个目录",
        405 => "服务器不接受这个操作",
        409 => "目录不存在，自动建一次也没成功",
        507 => "云端空间不足",
        s if (500..600).contains(&s) => "服务器出错了",
        _ => "请求被服务器拒绝",
    };
    format!("{action}失败：{why}（HTTP {status}）")
}

// ---------- 密钥文件 ----------

fn key_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("找不到应用数据目录：{e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("建不了应用数据目录：{e}"))?;
    Ok(dir.join(KEY_FILE))
}

/// 建密钥文件：`create_new` 保证「已有的文件绝不截断」——
/// 覆盖一次就等于把已存的密文全变成解不开的，这种损失没有提示、也补不回来。
fn create_key_file(path: &std::path::Path) -> Result<std::fs::File, String> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            format!(
                "密钥文件已存在但读不出来（{}），备份它之后删掉，再重新输入一次 WebDAV 密码",
                path.display()
            )
        } else {
            format!("写不了密钥文件：{e}")
        }
    })
}

/// 取密钥：还没有就生成一份留着（32 字节随机，Unix 上 0600）。
/// 密钥换了 = 旧的密文解不开，所以「文件在但内容不对 / 读不了」一律报错，绝不覆盖。
fn load_key(app: &AppHandle) -> Result<[u8; 32], String> {
    let path = key_path(app)?;
    match std::fs::read(&path) {
        Ok(bytes) if bytes.len() == 32 => {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            Ok(key)
        }
        Ok(_) => Err(format!(
            "密钥文件内容不对（{}）。备份它之后删掉，再重新输入一次 WebDAV 密码",
            path.display()
        )),
        // 只有「还没有这个文件」才往下生成（第一次输入密码时）
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut key = [0u8; 32];
            getrandom::fill(&mut key).map_err(|e| format!("取随机数失败：{e}"))?;
            use std::io::Write;
            let mut file = create_key_file(&path)?;
            file.write_all(&key)
                .map_err(|e| format!("写不了密钥文件：{e}"))?;
            Ok(key)
        }
        Err(e) => Err(format!("读不了密钥文件：{e}")),
    }
}

// ---------- 命令用到的入口 ----------

/// 加密一个密码（命令 secret_encrypt）
pub fn encrypt(app: &AppHandle, plain: &str) -> Result<String, String> {
    let key = load_key(app)?;
    seal(&key, plain)
}

/// 解密一个密码（命令 secret_decrypt）
pub fn decrypt(app: &AppHandle, stored: &str) -> Result<String, String> {
    let key = load_key(app)?;
    open(&key, stored)
}

/// 装一次 rustls 的加密后端：reqwest 用 rustls-no-provider，不装 provider 就建不出 Client
/// （与 qqrank.rs / tauri-plugin-updater 同一套）
fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

fn client() -> Result<reqwest::Client, String> {
    ensure_crypto_provider();
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("请求构造失败：{e}"))
}

/// 挂上 Basic Auth：账号密码都空就不挂（有些内网 WebDAV 不开认证）
fn with_auth(
    req: reqwest::RequestBuilder,
    user: &str,
    pass: &str,
) -> reqwest::RequestBuilder {
    if user.is_empty() && pass.is_empty() {
        req
    } else {
        req.basic_auth(user, Some(pass))
    }
}

fn net_error(action: &str, e: reqwest::Error) -> String {
    if e.is_timeout() {
        return format!("{action}失败：连接超时（地址对吗？服务器在线吗？）");
    }
    format!("{action}失败：连不上服务器（{e}）")
}

/// 测试连接：先 OPTIONS 目录，服务器不认（405 / 501）再退一步用 PROPFIND Depth: 0
pub async fn test(url: String, user: String, pass: String) -> Result<String, String> {
    let base = check_base(&url)?;
    let client = client()?;
    let mut res = with_auth(client.request(reqwest::Method::OPTIONS, &base), &user, &pass)
        .send()
        .await
        .map_err(|e| net_error("测试连接", e))?;
    if res.status() == 405 || res.status() == 501 {
        res = with_auth(client.request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &base), &user, &pass)
            .header("Depth", "0")
            .send()
            .await
            .map_err(|e| net_error("测试连接", e))?;
    }
    let status = res.status().as_u16();
    // 目录还不存在：账号与地址是通的，备份时会用 MKCOL 建一次 —— 别报成「连接失败」
    if status == 404 {
        return Ok(format!("账号与地址都通，但目录还不存在（HTTP 404）：备份时会自动建一次（{base}）"));
    }
    if !res.status().is_success() {
        return Err(status_error("测试连接", status));
    }
    Ok(format!("连接成功（HTTP {status}），备份会写到 {base}/{BACKUP_FILE}"))
}

/// 建一个集合（目录）。服务器回 201 是新建成，回 405 是「已经有了」—— 两者都算可以继续写。
/// MKCOL 只建一个空集合，不会动里面已有的东西。
async fn ensure_dir(base: &str, user: &str, pass: &str) -> Result<(), String> {
    let client = client()?;
    let res = with_auth(
        client.request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), base),
        user,
        pass,
    )
    .send()
    .await
    .map_err(|e| net_error("建目录", e))?;
    let status = res.status().as_u16();
    // 405 = 已经存在（有的服务器拿它回「重复 MKCOL」）；2xx = 建成了
    if (200..300).contains(&status) || status == 405 {
        return Ok(());
    }
    Err(format!("建不了目录（HTTP {status}）：{base}"))
}

/// PUT 一次，只回状态码（不把 4xx 变成错误：409 要拿来做「先建目录再重试」的判断）
async fn put_once(target: &str, user: &str, pass: &str, content: &str) -> Result<u16, String> {
    let client = client()?;
    let res = with_auth(
        client
            .put(target)
            .header(reqwest::header::CONTENT_TYPE, "application/json; charset=utf-8"),
        user,
        pass,
    )
    .body(content.to_string())
    .send()
    .await
    .map_err(|e| net_error("备份", e))?;
    Ok(res.status().as_u16())
}

/// 上传一份 JSON（slot = backup / safety）。
///
/// 目录不存在时服务器回 409 —— WebDAV 不会替用户建目录，所以这里补一步 MKCOL 再重试一次：
/// 用户填的地址就是「想存到哪儿」，让他先去别处手工建目录纯属折腾。建不成时把目标地址一起报出来。
pub async fn upload(
    url: String,
    user: String,
    pass: String,
    slot: String,
    content: String,
) -> Result<(), String> {
    let file = slot_file(&slot)?;
    let base = check_base(&url)?;
    let target = join_url(&base, file)?;
    let mut status = put_once(&target, &user, &pass, &content).await?;
    if status == 409 {
        ensure_dir(&base, &user, &pass).await?;
        status = put_once(&target, &user, &pass, &content).await?;
    }
    if !(200..300).contains(&status) {
        let why = status_error("备份", status);
        // 409 说明目录再怎么建也没成：把实际要写的地址报出来，用户一眼能看出地址填错在哪
        return Err(if status == 409 {
            format!("{why}；目标：{target}")
        } else {
            why
        });
    }
    Ok(())
}

/// 下载一份 JSON（slot = backup / safety），原样回文本，怎么解析由前端说了算
pub async fn download(
    url: String,
    user: String,
    pass: String,
    slot: String,
) -> Result<String, String> {
    let file = slot_file(&slot)?;
    let target = join_url(&url, file)?;
    let client = client()?;
    let res = with_auth(client.get(&target), &user, &pass)
        .send()
        .await
        .map_err(|e| net_error("恢复", e))?;
    let status = res.status();
    if status.as_u16() == 404 {
        return Err("云端还没有备份：先点一次「立即备份」".into());
    }
    if !status.is_success() {
        return Err(status_error("恢复", status.as_u16()));
    }
    res.text().await.map_err(|e| format!("恢复失败：读不出内容（{e}）"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用固定密钥：真密钥由 load_key 随机生成，这里只验算法本身
    const KEY: [u8; 32] = [7u8; 32];

    #[test]
    fn 地址去掉末尾斜杠并只认_http() {
        assert_eq!(check_base("  https://dav.example.com/stockbar/  ").unwrap(), "https://dav.example.com/stockbar");
        assert_eq!(check_base("http://192.168.1.9:5005").unwrap(), "http://192.168.1.9:5005");
        // 空地址、别的协议一律拒掉
        assert!(check_base("   ").is_err());
        assert!(check_base("ftp://dav.example.com").is_err());
        assert!(check_base("dav.example.com/stockbar").is_err());
    }

    #[test]
    fn 拼出来的地址是一个文件() {
        assert_eq!(
            join_url("https://dav.example.com/stockbar/", BACKUP_FILE).unwrap(),
            "https://dav.example.com/stockbar/settings.json"
        );
        // 文件名是常量，但也不该允许拼出别的路径
        assert!(join_url("https://dav.example.com", "../etc/passwd").is_err());
        assert!(join_url("https://dav.example.com", "").is_err());
    }

    #[test]
    fn 只认两个坑位() {
        assert_eq!(slot_file("backup").unwrap(), "settings.json");
        assert_eq!(slot_file("safety").unwrap(), "restore-safety.json");
        assert!(slot_file("settings.json").is_err());
        assert!(slot_file("").is_err());
    }

    #[test]
    fn 加密再解密回原文() {
        let sealed = seal(&KEY, "app-password-123").unwrap();
        assert!(sealed.starts_with(CIPHER_PREFIX), "{sealed}");
        // 密码不能以明文出现在密文里
        assert!(!sealed.contains("app-password-123"));
        assert_eq!(open(&KEY, &sealed).unwrap(), "app-password-123");
        // 同一明文两次加密结果不同（nonce 随机）
        assert_ne!(sealed, seal(&KEY, "app-password-123").unwrap());
    }

    #[test]
    fn 换了密钥或密文被改都解不开() {
        let sealed = seal(&KEY, "hunter2").unwrap();
        assert!(open(&[8u8; 32], &sealed).is_err());
        // 改一个十六进制字符就过不了 tag 校验
        let mut broken: Vec<char> = sealed.chars().collect();
        let last = broken.len() - 1;
        broken[last] = if broken[last] == 'a' { 'b' } else { 'a' };
        assert!(open(&KEY, &broken.into_iter().collect::<String>()).is_err());
        // 不像密文的东西直接报「格式不认识」，别当成空密码放行
        assert!(open(&KEY, "hunter2").is_err());
        assert!(open(&KEY, "v1:zz").is_err());
    }

    #[test]
    fn 权限类错误说得清() {
        assert!(status_error("备份", 401).contains("用户名或密码"));
        assert!(status_error("备份", 409).contains("目录不存在"));
        assert!(status_error("恢复", 507).contains("空间不足"));
        assert!(status_error("备份", 502).contains("服务器出错"));
    }
}
