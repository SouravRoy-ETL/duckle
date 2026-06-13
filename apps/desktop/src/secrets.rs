//! Encryption at rest for saved connection secrets and the cached git PAT.
//!
//! Sensitive connection fields (passwords, tokens, keys) are encrypted with a
//! per-workspace AES-256-GCM key kept at `<workspace>/.duckle/keys/secret.key`
//! (owner-only on unix, excluded from version control). The connection JSON in
//! `<workspace>/connections/` therefore holds ciphertext for those fields, so
//! the folder is safe to commit or share as long as `.duckle/keys/` is not.
//! `${...}` placeholders are never encrypted - they resolve from the
//! environment at run time.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::Engine;
use std::path::{Path, PathBuf};

const ENC_PREFIX: &str = "enc:v1:";

/// Connection-payload fields (by name) that hold a secret and get encrypted.
const SENSITIVE_KEYS: &[&str] = &[
    "password",
    "secretKey",
    "accessKey",
    "accountKey",
    "sessionToken",
    "pat",
    "token",
    "apiKey",
    "passphrase",
    "secret",
];

fn key_path(workspace: &Path) -> PathBuf {
    workspace.join(".duckle").join("keys").join("secret.key")
}

/// Load the workspace key. With `create`, a fresh random 32-byte key is
/// generated and persisted on first use; without it, a missing key is an
/// error (so a workspace shared without the key decrypts to nothing rather
/// than minting a wrong key).
pub(crate) fn workspace_key(workspace: &Path, create: bool) -> Result<[u8; 32], String> {
    let path = key_path(workspace);
    if let Ok(bytes) = std::fs::read(&path) {
        if bytes.len() == 32 {
            let mut k = [0u8; 32];
            k.copy_from_slice(&bytes);
            return Ok(k);
        }
    }
    if !create {
        return Err("no workspace key".into());
    }
    let mut k = [0u8; 32];
    getrandom::getrandom(&mut k).map_err(|e| format!("key rng: {}", e))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create keys dir: {}", e))?;
    }
    // Create the key file owner-only from the start; writing first and
    // chmod'ing after left a brief world-readable window (TOCTOU).
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| format!("create key: {}", e))?;
        f.write_all(&k).map_err(|e| format!("write key: {}", e))?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, k).map_err(|e| format!("write key: {}", e))?;
    Ok(k)
}

pub(crate) fn is_encrypted(s: &str) -> bool {
    s.starts_with(ENC_PREFIX)
}

/// Encrypt plaintext into an `enc:v1:<base64(nonce || ciphertext)>` token.
pub(crate) fn encrypt_value(key: &[u8; 32], plaintext: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("cipher init: {}", e))?;
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).map_err(|e| format!("nonce rng: {}", e))?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
        .map_err(|e| format!("encrypt: {}", e))?;
    let mut payload = Vec::with_capacity(12 + ciphertext.len());
    payload.extend_from_slice(&nonce_bytes);
    payload.extend_from_slice(&ciphertext);
    Ok(format!(
        "{}{}",
        ENC_PREFIX,
        base64::engine::general_purpose::STANDARD.encode(payload)
    ))
}

/// Decrypt an `enc:v1:` token back to plaintext.
pub(crate) fn decrypt_value(key: &[u8; 32], blob: &str) -> Result<String, String> {
    let b64 = blob.strip_prefix(ENC_PREFIX).ok_or("not an encrypted value")?;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64: {}", e))?;
    if raw.len() < 12 {
        return Err("ciphertext too short".into());
    }
    let (nonce_bytes, ciphertext) = raw.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("cipher init: {}", e))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|e| format!("decrypt: {}", e))?;
    String::from_utf8(plain).map_err(|e| format!("utf8: {}", e))
}

/// Walk a JSON value, encrypting or decrypting the sensitive string fields in
/// place. Already-encrypted values and `${...}` placeholders are left alone.
fn transform(value: &mut serde_json::Value, key: &[u8; 32], encrypting: bool) -> Result<(), String> {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                if let Some(s) = v.as_str() {
                    if encrypting {
                        if SENSITIVE_KEYS.contains(&k.as_str())
                            && !s.is_empty()
                            && !is_encrypted(s)
                            && !s.starts_with("${")
                        {
                            // Propagate: never silently leave a secret in
                            // plaintext (the file is meant to hold ciphertext).
                            let enc = encrypt_value(key, s)?;
                            *v = serde_json::Value::String(enc);
                        }
                    } else if is_encrypted(s) {
                        // Decrypt stays lenient: a missing/legacy value loads
                        // unchanged rather than failing the read.
                        if let Ok(dec) = decrypt_value(key, s) {
                            *v = serde_json::Value::String(dec);
                        }
                    }
                } else {
                    transform(v, key, encrypting)?;
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr.iter_mut() {
                transform(v, key, encrypting)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Encrypt the sensitive fields of a connection payload JSON before it is
/// written to disk.
#[tauri::command]
pub fn connection_encrypt_payload(workspace: String, payload_json: String) -> Result<String, String> {
    let key = workspace_key(Path::new(&workspace), true)?;
    let mut v: serde_json::Value =
        serde_json::from_str(&payload_json).map_err(|e| format!("json: {}", e))?;
    transform(&mut v, &key, true)?;
    serde_json::to_string(&v).map_err(|e| format!("json: {}", e))
}

/// Decrypt the sensitive fields of a connection payload JSON after it is read
/// from disk. If the workspace key is missing, the payload is returned
/// unchanged so plaintext / legacy values still load.
#[tauri::command]
pub fn connection_decrypt_payload(workspace: String, payload_json: String) -> Result<String, String> {
    let key = match workspace_key(Path::new(&workspace), false) {
        Ok(k) => k,
        Err(_) => return Ok(payload_json),
    };
    let mut v: serde_json::Value =
        serde_json::from_str(&payload_json).map_err(|e| format!("json: {}", e))?;
    transform(&mut v, &key, false)?;
    serde_json::to_string(&v).map_err(|e| format!("json: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_encrypts_only_sensitive_fields() {
        let dir = std::env::temp_dir().join(format!("duckle_sec_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let ws = dir.to_string_lossy().to_string();

        let payload = r#"{"kind":"postgres","host":"db.local","username":"u","password":"s3cr3t","port":5432}"#;
        let enc = connection_encrypt_payload(ws.clone(), payload.to_string()).unwrap();
        // Non-secret fields stay readable; the password becomes ciphertext.
        assert!(enc.contains("\"host\":\"db.local\""), "host should be plaintext: {}", enc);
        assert!(enc.contains("\"username\":\"u\""), "username should be plaintext: {}", enc);
        assert!(enc.contains("enc:v1:"), "password should be encrypted: {}", enc);
        assert!(!enc.contains("s3cr3t"), "plaintext secret leaked: {}", enc);

        let dec = connection_decrypt_payload(ws, enc).unwrap();
        let v: serde_json::Value = serde_json::from_str(&dec).unwrap();
        assert_eq!(v["password"], "s3cr3t");
        assert_eq!(v["host"], "db.local");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn env_placeholders_are_not_encrypted() {
        let dir = std::env::temp_dir().join(format!("duckle_sec_env_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let ws = dir.to_string_lossy().to_string();
        let payload = r#"{"password":"${ENV:PGPASSWORD}"}"#;
        let enc = connection_encrypt_payload(ws, payload.to_string()).unwrap();
        assert!(enc.contains("${ENV:PGPASSWORD}"), "placeholder must survive: {}", enc);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
