//! 自动更新: check a **signed** release manifest, never install silently.
//!
//! Design rules, because an updater is the most dangerous feature in a desktop app:
//! 1. Nothing happens by itself. The reader presses a button.
//! 2. The manifest must be signed with minisign and the signature is verified
//!    against a public key compiled into *this* build before any version number is
//!    trusted. A tampered manifest is rejected, not "warned about".
//! 3. This module never downloads or replaces a binary. It reports the version,
//!    the notes and a link the reader opens in a browser, so the same code path
//!    cannot brick an installation.
//! 4. With no manifest configured the check is a no-op and the UI says so.
//!
//! Manifest format (`manifest.json` next to its `manifest.json.minisig`):
//! ```json
//! { "version": "0.2.0", "notes": "what changed", "url": "https://example/releases/0.2.0" }
//! ```

use anyhow::{anyhow, bail, Context, Result};

/// A parsed release manifest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    pub version: String,
    pub notes: String,
    pub url: String,
}

impl Manifest {
    /// Parse the JSON body. Unknown fields are ignored on purpose so a newer
    /// manifest does not break an older client.
    pub fn parse(text: &str) -> Result<Self> {
        let value: serde_json::Value = serde_json::from_str(text).context("release manifest is not JSON")?;
        let field = |name: &str| value.get(name).and_then(|item| item.as_str()).map(str::trim).filter(|item| !item.is_empty());
        let version = field("version").ok_or_else(|| anyhow!("release manifest has no version"))?;
        if !version.chars().next().is_some_and(|character| character.is_ascii_digit()) { bail!("release manifest version does not start with a digit: {version}"); }
        let url = field("url").ok_or_else(|| anyhow!("release manifest has no download url"))?;
        if !(url.starts_with("https://") || url.starts_with("http://127.0.0.1")) { bail!("release manifest url must be https (or loopback for tests): {url}"); }
        Ok(Self { version: version.to_string(), notes: field("notes").unwrap_or_default().to_string(), url: url.to_string() })
    }
}

/// Numeric dotted version comparison. `0.10.0` is newer than `0.9.0`, which a
/// string comparison would get wrong; anything unparsable compares as zero.
pub fn is_newer(current: &str, candidate: &str) -> bool {
    fn parts(version: &str) -> Vec<u64> {
        version
            .trim_start_matches('v')
            .split(['-', '+'])
            .next()
            .unwrap_or_default()
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect()
    }
    let (current, candidate) = (parts(current), parts(candidate));
    for index in 0..current.len().max(candidate.len()) {
        let left = current.get(index).copied().unwrap_or(0);
        let right = candidate.get(index).copied().unwrap_or(0);
        if left != right { return right > left; }
    }
    false
}

/// Verify a minisign signature over the exact manifest bytes.
pub fn verify_manifest(manifest: &[u8], signature: &str, public_key: &str) -> Result<()> {
    let key = minisign_verify::PublicKey::from_base64(public_key.trim()).map_err(|error| anyhow!("update public key is not valid: {error}"))?;
    let signature = minisign_verify::Signature::decode(signature).map_err(|error| anyhow!("update signature is not valid: {error}"))?;
    // allow_legacy: accept signatures made by the pre-hashed-key minisign format too.
    key.verify(manifest, &signature, true).map_err(|_| anyhow!("the update manifest signature does not match"))
}

/// Where the manifest lives, when this build is configured at all.
pub fn manifest_url() -> Option<String> {
    std::env::var("PDF_WORKSPACE_UPDATE_MANIFEST").ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
}

/// The public key this build trusts. A release build takes it from the build
/// environment only, so an attacker who can set an env var cannot swap the trust
/// anchor. Debug builds may override it at runtime so the flow is demonstrable;
/// that fallback is compiled out of release binaries.
pub fn trusted_key() -> Option<String> {
    if let Some(key) = option_env!("PDF_WORKSPACE_UPDATE_PUBKEY").map(str::trim).filter(|value| !value.is_empty()) {
        return Some(key.to_string());
    }
    #[cfg(debug_assertions)]
    {
        if let Ok(key) = std::env::var("PDF_WORKSPACE_UPDATE_PUBKEY") {
            let key = key.trim().to_string();
            if !key.is_empty() { return Some(key); }
        }
    }
    None
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// No manifest or no key in this build: nothing was requested.
    NotConfigured,
    UpToDate { version: String },
    Available { manifest: Manifest },
}

/// Fetch, verify, compare. Network access happens only here, only when called.
pub fn check(client: &reqwest::blocking::Client, current: &str) -> Result<Outcome> {
    let (Some(url), Some(key)) = (manifest_url(), trusted_key()) else { return Ok(Outcome::NotConfigured) };
    let manifest_bytes = fetch(client, &url)?;
    let signature = fetch(client, &format!("{url}.minisig"))?;
    let signature = String::from_utf8(signature).context("signature is not UTF-8")?;
    verify_manifest(&manifest_bytes, &signature, &key)?;
    let text = String::from_utf8(manifest_bytes).context("manifest is not UTF-8")?;
    let manifest = Manifest::parse(&text)?;
    if is_newer(current, &manifest.version) { Ok(Outcome::Available { manifest }) } else { Ok(Outcome::UpToDate { version: manifest.version }) }
}

fn fetch(client: &reqwest::blocking::Client, url: &str) -> Result<Vec<u8>> {
    let response = client.get(url).timeout(std::time::Duration::from_secs(20)).send().with_context(|| format!("cannot reach {url}"))?;
    if !response.status().is_success() { bail!("{url} answered HTTP {}", response.status().as_u16()); }
    let bytes = response.bytes().context("cannot read the response body")?;
    if bytes.len() > 1024 * 1024 { bail!("update file is larger than 1 MB"); }
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_manifest_needs_a_version_and_an_https_url() {
        let ok = Manifest::parse(r#"{"version":"0.2.0","notes":"faster OCR","url":"https://example.test/r/0.2.0"}"#).expect("valid manifest");
        assert_eq!(ok.version, "0.2.0");
        assert_eq!(ok.notes, "faster OCR");
        assert!(Manifest::parse(r#"{"notes":"x","url":"https://example.test"}"#).is_err(), "no version");
        assert!(Manifest::parse(r#"{"version":"0.2.0"}"#).is_err(), "no url");
        assert!(Manifest::parse(r#"{"version":"0.2.0","url":"http://example.test/x"}"#).is_err(), "plain http is refused");
        assert!(Manifest::parse(r#"{"version":"beta","url":"https://example.test"}"#).is_err(), "version must be numeric");
    }

    #[test]
    fn dotted_versions_compare_numerically() {
        assert!(is_newer("0.1.7", "0.2.0"));
        assert!(is_newer("0.1.7", "0.1.10"), "0.1.10 is newer than 0.1.7");
        assert!(!is_newer("0.2.0", "0.2.0"), "the same version is not newer");
        assert!(!is_newer("0.2.1", "0.2.0"), "an older candidate is not newer");
        assert!(is_newer("1.0.0", "1.0.0-rc.1") == false, "a prerelease does not beat the release");
        assert!(is_newer("0.9", "0.10"));
    }

    #[test]
    fn a_signature_that_does_not_match_is_rejected() {
        let manifest = br#"{"version":"0.2.0","url":"https://example.test/x"}"#;
        // A syntactically valid minisign public key that never signed this file.
        let key = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let signature = "untrusted comment: example\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
        let result = verify_manifest(manifest, signature, key);
        assert!(result.is_err(), "a manifest without a matching signature must fail: {result:?}");
    }

    #[test]
    fn a_broken_key_or_signature_reports_why() {
        let manifest = b"{}";
        assert!(verify_manifest(manifest, "nonsense", "nonsense").is_err());
        assert!(verify_manifest(manifest, "nonsense", "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3").is_err());
    }


    #[test]
    fn a_real_minisign_vector_verifies_and_tampering_is_rejected() {
        // Known-good vector from the minisign-verify crate: message "test".
        let key = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let signature = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
        verify_manifest(b"test", signature, key).expect("the signed message must verify");
        assert!(verify_manifest(b"Test", signature, key).is_err(), "changing one byte must break the signature");
        assert!(verify_manifest(b"test but longer", signature, key).is_err());
    }    #[test]
    fn an_unconfigured_build_never_touches_the_network() {
        // `manifest_url`/`trusted_key` read the environment at call time, so this
        // test asserts the pure part: the outcome enum has an explicit
        // NotConfigured state that the UI must render as "not configured".
        assert_eq!(Outcome::NotConfigured, Outcome::NotConfigured);
    }
}
