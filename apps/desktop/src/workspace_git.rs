//! In-app Git integration for the user's workspace folder.
//!
//! Connect a workspace to a remote (GitHub / GitLab),
//! commit + push + pull from inside Duckle, manage branches, see CI
//! build status. Wraps the system `git` CLI rather than embedding
//! libgit2 - same pattern as `src.git` in the engine. Trade-off:
//! requires `git` on PATH, but no FFI / no large dep, and the user
//! sees errors in `git`'s own wording.
//!
//! Auth strategy follows the user's preference:
//!   1. Try without explicit credentials first (lets the system
//!      credential helper / GitHub CLI / etc. handle it).
//!   2. On 401 / 403 from the remote, prompt the frontend for a
//!      Personal Access Token, retry by injecting the token into
//!      the remote URL: `https://x-token-auth:TOKEN@github.com/...`.
//!   3. Cache the PAT at `<workspace>/.duckle/secrets/git.json`.
//!      Auto-write a `.duckle/.gitignore` so the secret file never
//!      ends up committed.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// One file's status in the working tree.
#[derive(Debug, Clone, Serialize)]
pub struct ChangedFile {
    pub path: String,
    /// One of: "staged", "modified", "untracked", "conflicted",
    /// "deleted", "renamed".
    pub status: String,
}

/// Git remote configured for the workspace.
#[derive(Debug, Clone, Serialize)]
pub struct GitRemote {
    pub name: String,
    pub url: String,
    /// Detected from the URL host: "github", "gitlab", "bitbucket",
    /// or "other".
    pub provider: String,
}

/// Full snapshot the frontend renders.
#[derive(Debug, Clone, Serialize)]
pub struct GitStatus {
    pub initialized: bool,
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub remote: Option<GitRemote>,
    pub files: Vec<ChangedFile>,
    pub has_pat: bool,
}

/// Errors are flattened to strings for the Tauri channel.
type GitResult<T> = Result<T, String>;

fn detect_provider(url: &str) -> String {
    let lower = url.to_lowercase();
    if lower.contains("github.com") {
        "github".into()
    } else if lower.contains("gitlab.com") || lower.contains("gitlab.") {
        "gitlab".into()
    } else if lower.contains("bitbucket") {
        "bitbucket".into()
    } else {
        "other".into()
    }
}

fn git_cmd(workspace: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(workspace);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: suppress console flash on Windows.
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

fn run_git(workspace: &Path, args: &[&str]) -> GitResult<String> {
    let out = git_cmd(workspace)
        .args(args)
        .output()
        .map_err(|e| format!("spawn git {:?}: {}", args, e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).into_owned();
        return Err(format!("git {:?} failed: {}", args, err.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Probe whether the workspace folder is a git repo.
fn is_repo(workspace: &Path) -> bool {
    git_cmd(workspace)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Parse `git status --porcelain=v1 -b` into a structured snapshot.
/// Format: the first line is "## branch...origin/branch [ahead N, behind M]";
/// subsequent lines are "XY path".
fn parse_status(text: &str) -> (Option<String>, u32, u32, Vec<ChangedFile>) {
    let mut branch: Option<String> = None;
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut files: Vec<ChangedFile> = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if i == 0 && line.starts_with("## ") {
            let rest = &line[3..];
            // "branch...origin/branch [ahead 1, behind 2]"
            // or "branch...origin/branch"
            // or "No commits yet on branch"
            // or "HEAD (no branch)"
            let head = rest.split("...").next().unwrap_or(rest);
            let head_clean = head.split_whitespace().next().unwrap_or("");
            if !head_clean.is_empty() && head_clean != "HEAD" {
                branch = Some(head_clean.to_string());
            } else if let Some(rest2) = rest.strip_prefix("No commits yet on ") {
                branch = Some(rest2.split_whitespace().next().unwrap_or("").to_string());
            }
            if let Some(rest_after_bracket) = rest.split_once('[') {
                let bracket = rest_after_bracket.1.trim_end_matches(']');
                for piece in bracket.split(',') {
                    let p = piece.trim();
                    if let Some(n) = p.strip_prefix("ahead ") {
                        ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = p.strip_prefix("behind ") {
                        behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        if line.len() < 3 {
            continue;
        }
        let (xy, rest) = line.split_at(2);
        let path = rest.trim().to_string();
        let status = match xy {
            "??" => "untracked",
            "UU" | "AA" | "DD" => "conflicted",
            " D" | "D " => "deleted",
            " M" => "modified",
            "M " | "MM" => "staged",
            "A " | "AM" => "staged",
            "R " => "renamed",
            _ if xy.starts_with(' ') => "modified",
            _ => "staged",
        };
        files.push(ChangedFile {
            path,
            status: status.into(),
        });
    }
    (branch, ahead, behind, files)
}

/// Build the full status snapshot the frontend renders.
pub fn status(workspace: &Path) -> GitResult<GitStatus> {
    if !workspace.exists() {
        return Err(format!("workspace {} doesn't exist", workspace.display()));
    }
    if !is_repo(workspace) {
        return Ok(GitStatus {
            initialized: false,
            branch: None,
            ahead: 0,
            behind: 0,
            remote: None,
            files: Vec::new(),
            has_pat: pat_path(workspace).exists(),
        });
    }
    let raw = run_git(workspace, &["status", "--porcelain=v1", "-b"])?;
    let (branch, ahead, behind, files) = parse_status(&raw);
    // Remote (origin only for v1).
    let remote = run_git(workspace, &["config", "--get", "remote.origin.url"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|url| GitRemote {
            name: "origin".into(),
            provider: detect_provider(&url),
            url,
        });
    Ok(GitStatus {
        initialized: true,
        branch,
        ahead,
        behind,
        remote,
        files,
        has_pat: pat_path(workspace).exists(),
    })
}

pub fn init(workspace: &Path) -> GitResult<()> {
    if !workspace.exists() {
        return Err(format!("workspace {} doesn't exist", workspace.display()));
    }
    run_git(workspace, &["init", "-b", "main"])?;
    write_gitignore_safety(workspace);
    Ok(())
}

#[allow(dead_code)] // Exposed for future "Clone repo into..." flow.
pub fn clone(parent: &Path, url: &str, folder_name: &str) -> GitResult<PathBuf> {
    if !parent.exists() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let dest = parent.join(folder_name);
    let out = git_cmd(parent)
        // `--` stops a url/folder starting with `-` being read as an option.
        .args(["clone", "--", url, folder_name])
        .output()
        .map_err(|e| format!("spawn git clone: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "clone failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    write_gitignore_safety(&dest);
    Ok(dest)
}

pub fn add_all(workspace: &Path) -> GitResult<()> {
    run_git(workspace, &["add", "-A"])?;
    Ok(())
}

pub fn commit(workspace: &Path, message: &str) -> GitResult<String> {
    // Configure author from git config if available; otherwise let
    // git complain - we don't auto-fabricate identities.
    let out = git_cmd(workspace)
        .args(["commit", "-m", message])
        .output()
        .map_err(|e| format!("spawn git commit: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "commit failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Push the current branch. On the first attempt, run `git push`
/// straight through - if the user has a credential helper / GitHub CLI
/// configured the push succeeds with no further prompt. On 401-style
/// failures, the frontend asks the user for a PAT and we retry with
/// the token injected into the URL.
pub fn push(workspace: &Path) -> GitResult<String> {
    let out = git_cmd(workspace)
        .args(["push"])
        .output()
        .map_err(|e| format!("spawn git push: {}", e))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    let err = String::from_utf8_lossy(&out.stderr).into_owned();
    // If we have a saved PAT, retry with it before surfacing the
    // auth-required signal to the user.
    if looks_like_auth_failure(&err) {
        if let Ok(token) = load_pat(workspace) {
            return push_with_pat(workspace, &token);
        }
        return Err(format!("AUTH_REQUIRED: {}", err.trim()));
    }
    Err(format!("push failed: {}", err.trim()))
}

/// Retry the push with the PAT injected into the remote URL for the
/// duration of the call. We don't permanently rewrite the remote so
/// the URL the user sees in `git remote -v` stays clean.
fn push_with_pat(workspace: &Path, token: &str) -> GitResult<String> {
    let url = run_git(workspace, &["config", "--get", "remote.origin.url"])?;
    let url = url.trim();
    let authed = inject_token(url, token).ok_or_else(|| {
        "PAT injection only supported for https:// remotes; switch your remote or push from a terminal".to_string()
    })?;
    // Push with an explicit URL: `git push <url> <branch>` - this
    // sends the token but doesn't write it to the config.
    let branch = run_git(workspace, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let branch = branch.trim();
    let out = git_cmd(workspace)
        .args(["push", &authed, branch])
        .output()
        .map_err(|e| format!("spawn git push (PAT): {}", e))?;
    // git can echo the push URL (with the embedded credential) into its
    // progress/error output; never surface the raw token to the user.
    let safe = String::from_utf8_lossy(&out.stderr).replace(token, "***");
    if !out.status.success() {
        return Err(format!("push (with PAT) failed: {}", safe.trim()));
    }
    Ok(safe)
}

pub fn pull(workspace: &Path) -> GitResult<String> {
    let out = git_cmd(workspace)
        .args(["pull", "--ff-only"])
        .output()
        .map_err(|e| format!("spawn git pull: {}", e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).into_owned();
        return Err(format!("pull failed: {}", err.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn branches(workspace: &Path) -> GitResult<Vec<String>> {
    let raw = run_git(workspace, &["branch", "--list", "--format=%(refname:short)"])?;
    Ok(raw
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

pub fn branch_create(workspace: &Path, name: &str) -> GitResult<()> {
    // `git checkout -b -- <name>` is invalid, so guard the name instead of
    // using `--`: a leading dash would otherwise be parsed as an option.
    if name.starts_with('-') {
        return Err(format!("invalid branch name: {}", name));
    }
    run_git(workspace, &["checkout", "-b", name])?;
    Ok(())
}

pub fn branch_checkout(workspace: &Path, name: &str) -> GitResult<()> {
    run_git(workspace, &["checkout", "--", name])?;
    Ok(())
}

pub fn remote_set(workspace: &Path, url: &str) -> GitResult<()> {
    // Add origin if missing, set-url otherwise.
    let exists = run_git(workspace, &["remote", "get-url", "origin"]).is_ok();
    if exists {
        run_git(workspace, &["remote", "set-url", "origin", url])?;
    } else {
        run_git(workspace, &["remote", "add", "origin", url])?;
    }
    Ok(())
}

// ---- PAT storage ---------------------------------------------------------

#[derive(Debug, Deserialize, Serialize)]
struct StoredPat {
    pat: String,
}

fn pat_path(workspace: &Path) -> PathBuf {
    workspace.join(".duckle").join("secrets").join("git.json")
}

/// Persist a PAT for later push retries. The token is encrypted with the
/// per-workspace key (the same key the connection secrets use), and a
/// `.duckle/.gitignore` excludes the secrets + keys dirs so neither enters
/// the user's repo.
pub fn save_pat(workspace: &Path, token: &str) -> GitResult<()> {
    let path = pat_path(workspace);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    // Encrypt before writing; do NOT silently fall back to plaintext on
    // failure - surface the error so the caller knows the token was not
    // stored rather than persisting a credential in the clear.
    let key = crate::secrets::workspace_key(workspace, true)?;
    let stored = crate::secrets::encrypt_value(&key, token)?;
    let body = serde_json::to_string_pretty(&StoredPat { pat: stored }).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("write {}: {}", path.display(), e))?;
    write_gitignore_safety(workspace);
    // Tighten file perms on Unix so other local users can't read it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn load_pat(workspace: &Path) -> GitResult<String> {
    let path = pat_path(workspace);
    let body = std::fs::read_to_string(&path).map_err(|e| format!("read PAT: {}", e))?;
    let parsed: StoredPat = serde_json::from_str(&body).map_err(|e| format!("parse PAT: {}", e))?;
    // Decrypt if it was stored encrypted; a legacy plaintext token loads as-is.
    if crate::secrets::is_encrypted(&parsed.pat) {
        let key = crate::secrets::workspace_key(workspace, false).map_err(|_| {
            "stored git token is encrypted but the workspace key is missing \
             (.duckle/keys/secret.key); re-enter the token to re-save it"
                .to_string()
        })?;
        return crate::secrets::decrypt_value(&key, &parsed.pat)
            .map_err(|e| format!("decrypt git token: {}", e));
    }
    Ok(parsed.pat)
}

pub fn clear_pat(workspace: &Path) -> GitResult<()> {
    let path = pat_path(workspace);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("remove PAT: {}", e))?;
    }
    Ok(())
}

/// Ensure `<workspace>/.duckle/.gitignore` excludes the `secrets/` dir (cached
/// PAT) and the `keys/` dir (the connection-secret encryption key). The
/// encrypted `connections/` files are safe to commit; the key is not.
/// Idempotent - only adds a line if it is missing.
fn write_gitignore_safety(workspace: &Path) {
    let dir = workspace.join(".duckle");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(".gitignore");
    let mut existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut changed = false;
    for need in ["secrets/", "keys/"] {
        if !existing.lines().any(|l| l.trim() == need) {
            if existing.is_empty() {
                existing = format!("{}\n", need);
            } else {
                existing = format!("{}\n{}\n", existing.trim_end(), need);
            }
            changed = true;
        }
    }
    if changed {
        let _ = std::fs::write(&path, existing);
    }
}

/// Inject a PAT into an HTTPS remote URL. Returns None for ssh:// or
/// git:// URLs - those use SSH key auth which we don't try to manage.
fn inject_token(url: &str, token: &str) -> Option<String> {
    let lower = url.to_lowercase();
    if !lower.starts_with("https://") {
        return None;
    }
    let rest = &url["https://".len()..];
    // Strip any existing user:pass that might already be there.
    let host_and_path = match rest.find('@') {
        Some(i) => &rest[i + 1..],
        None => rest,
    };
    // GitHub + GitLab both accept `x-token-auth:TOKEN` or just `TOKEN`
    // as the user. We use `x-token-auth` to be explicit.
    Some(format!("https://x-token-auth:{}@{}", token, host_and_path))
}

fn looks_like_auth_failure(stderr: &str) -> bool {
    let l = stderr.to_lowercase();
    l.contains("authentication failed")
        || l.contains("could not read username")
        || l.contains("403")
        || l.contains("401")
        || l.contains("permission denied")
        // GitHub's wording: "remote: Permission to org/repo.git denied to user."
        || l.contains("permission to ")
        || l.contains("invalid username or password")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_provider_works() {
        assert_eq!(detect_provider("https://github.com/foo/bar.git"), "github");
        assert_eq!(detect_provider("git@github.com:foo/bar.git"), "github");
        assert_eq!(detect_provider("https://gitlab.com/foo/bar"), "gitlab");
        assert_eq!(detect_provider("https://gitlab.internal/foo"), "gitlab");
        assert_eq!(detect_provider("https://bitbucket.org/foo"), "bitbucket");
        assert_eq!(detect_provider("https://example.com/repo.git"), "other");
    }

    #[test]
    fn parse_status_pulls_branch_and_files() {
        // Clean tree on main.
        let (branch, a, b, files) = parse_status("## main...origin/main\n");
        assert_eq!(branch.as_deref(), Some("main"));
        assert_eq!(a, 0);
        assert_eq!(b, 0);
        assert!(files.is_empty());
    }

    #[test]
    fn parse_status_with_ahead_behind() {
        let (branch, a, b, _) = parse_status("## main...origin/main [ahead 3, behind 1]\n");
        assert_eq!(branch.as_deref(), Some("main"));
        assert_eq!(a, 3);
        assert_eq!(b, 1);
    }

    #[test]
    fn parse_status_classifies_changes() {
        let raw = "## feature/x...origin/feature/x\n M src/lib.rs\nA  new.txt\n?? notes.md\nUU conflicted.txt\n";
        let (branch, _, _, files) = parse_status(raw);
        assert_eq!(branch.as_deref(), Some("feature/x"));
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[1].status, "staged");
        assert_eq!(files[2].status, "untracked");
        assert_eq!(files[3].status, "conflicted");
    }

    #[test]
    fn inject_token_only_wraps_https() {
        assert_eq!(
            inject_token("https://github.com/foo/bar.git", "ghp_xxx").as_deref(),
            Some("https://x-token-auth:ghp_xxx@github.com/foo/bar.git")
        );
        // SSH untouched
        assert_eq!(inject_token("git@github.com:foo/bar.git", "ghp_xxx"), None);
        // Existing creds get stripped
        assert_eq!(
            inject_token("https://oldtoken@gitlab.com/p.git", "newpat").as_deref(),
            Some("https://x-token-auth:newpat@gitlab.com/p.git")
        );
    }

    #[test]
    fn looks_like_auth_failure_catches_common_messages() {
        assert!(looks_like_auth_failure(
            "remote: Invalid username or password"
        ));
        assert!(looks_like_auth_failure(
            "fatal: Authentication failed for 'https://...'"
        ));
        assert!(looks_like_auth_failure(
            "remote: Permission to foo/bar denied"
        ));
        assert!(!looks_like_auth_failure(
            "fatal: refusing to merge unrelated histories"
        ));
    }
}
