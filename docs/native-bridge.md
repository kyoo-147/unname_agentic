# PDF Workspace native bridge

The optional Chrome companion sends an explicitly selected, authorized PDF to a local desktop inbox. The browser mirror works without the companion. Detection never starts a desktop transfer.

## Install the companion

1. Build the extension with the normal project build. Load `dist/extension` as an unpacked extension in `chrome://extensions`.
2. Copy the extension ID from Chrome. The ID must contain exactly 32 lowercase characters from `a` through `p`.
3. Build the standalone host from the repository root.

```powershell
cargo build --manifest-path desktop/Cargo.toml --release --bin pdf-workspace-host
```

4. Run the installer yourself. Replace the example ID with the actual ID from Chrome. Use the absolute path to the executable that you built.

```powershell
.\scripts\install-native-host.ps1 `
  -ExtensionId 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' `
  -HostPath 'D:\work\mirror_trans_pdf\desktop\target\release\pdf-workspace-host.exe' `
  -WhatIf

.\scripts\install-native-host.ps1 `
  -ExtensionId 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' `
  -HostPath 'D:\work\mirror_trans_pdf\desktop\target\release\pdf-workspace-host.exe'
```

The installer validates both arguments before writing. It rejects UNC paths, symlinks, and junctions in installation paths. It registers only this exact current-user key.

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pdfworkspace.bridge
```

The key points to `%LOCALAPPDATA%\PdfWorkspace\native-messaging\com.pdfworkspace.bridge.json`. Its `allowed_origins` contains only `chrome-extension://<your-extension-id>/`. There are no wildcard IDs or machine-wide registry writes. Installing again replaces this host's current-user registration and allowlist with the supplied ID and executable. Do not move or replace the executable with an untrusted program.

No installer runs during builds, tests, browser detection, or desktop startup. No PDFs are opened during installation.

## Send a PDF

1. Enable automatic mirrors in the extension popup.
2. Open an accessible PDF and wait for its bound browser mirror.
3. Keep either the original source tab or that bound mirror active.
4. Open the extension popup and choose **Open in desktop**.
5. Open PDF Workspace to consume its local inbox.

The popup sends only the PDF already allowed by the service worker's acquisition policy. It does not accept a caller-supplied URL or file path. A capture-only reader, an unbound reader, and an unrelated web tab cannot initiate a transfer. Existing authenticated acquisition, redirect rejection, PDF signature validation, and the 100 MiB browser acquisition limit remain unchanged. The native protocol separately caps each PDF at 256 MiB.

The native host does not launch a desktop window. Successful delivery means that the host published the PDF and session event to the inbox, not that the desktop imported or rendered the PDF. The native parser can still reject an unsupported or invalid PDF.

After delivery, the extension relays page changes from the same authorized source or mirror. **Stop desktop following**, source navigation, reader navigation, tab closure, or port disconnection ends following. Restarting a disconnected bridge requires another explicit **Open in desktop** command. Already imported local copies remain in the desktop library.

## Check an unavailable companion

The popup performs a `hello` handshake to query availability. A query never acquires a PDF, starts capture, or contacts a provider. If registration is absent, Chrome rejects the host, or the host cannot start, the popup says **Desktop companion unavailable** and leaves the browser reader usable.

Check the exact extension ID, the registered executable path, and the current-user manifest. Reopen the popup after installation. Reloading an unpacked extension from a different path can change its ID and requires a matching registration. A protocol mismatch requires rebuilding and registering the matching host.

The host accepts a canonical Chrome extension origin argument. Chrome enforces the installed manifest's exact extension allowlist. This is a Chrome boundary, not protection against a malicious program already running as the same Windows user.

## Protocol reference

The host is `com.pdfworkspace.bridge`. It uses only stdin and stdout for native messages. Stderr carries short errors without document contents. The standalone binary imports no application backend, capture, network, provider, or credential modules.

Each frame consists of an unsigned 32-bit little-endian byte length followed by one UTF-8 JSON object. Both request and response bodies must be nonempty and at most 1,048,576 bytes. Invalid framing, truncated input, invalid UTF-8, unknown message types, unknown fields, or invalid protocol state returns an error when possible and closes the host. Clean EOF removes an incomplete staging upload.

Each upload and page message carries this exact binding.

```json
{
  "session_id": "11111111-1111-4111-8111-111111111111",
  "source_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "request_nonce": "22222222-2222-4222-8222-222222222222",
  "generation": 1794114000000
}
```

`session_id` and `request_nonce` contain 16 to 64 ASCII alphanumeric or hyphen characters. `source_id` is a lowercase SHA-256 hex digest of the authorized browser source identity. It is not a URL. `generation` is a positive JavaScript-safe integer and must increase for every accepted begin on the same connection. The extension generates it as `max(Date.now(), previous + 1)`. A source can change only through a new explicit upload begin and successful commit. Page messages cannot change a source binding.

Page state uses zero-based PDF page indices, not a global screen scroll position.

```json
{"page":0,"page_count":null,"fraction":0.25,"zoom":1.5}
```

`page_count` is null when Chrome has not supplied a count. Known counts must be from 1 to 65,535. The host bounds `page` to 0 through 65,535 and to `page_count - 1` when known. The host clamps finite `fraction` to 0 through 1 within that page and finite `zoom` to 0.1 through 10. Nonfinite numbers are rejected. The extension converts its existing one-based reader page number at this boundary.

The message sequence is fixed.

| Type | Additional fields | Result |
| --- | --- | --- |
| `hello` | None | `protocol: 1`, `status: "ready"`, and frame, PDF, and chunk limits. No inbox writes. |
| `begin` | `binding`, `total_bytes`, `sha256`, `page`, optional `title` | Starts one upload. Positive `total_bytes` is at most 268,435,456. Lowercase `sha256` covers the entire PDF. Title is display text only, stripped of control characters and capped at 200 Unicode characters. |
| `chunk` | `binding`, `index`, `data` | Index starts at zero and increases by one. Strict padded standard base64 decodes to 1 through 196,608 bytes. Bytes cannot exceed the declared total. Reply includes the next expected index. |
| `commit` | `binding` | Requires the complete byte count, matching SHA-256, and `%PDF-` within the first 1,024 bytes. Publishes only a complete upload. |
| `page` | `binding`, `page` | Requires the exact completed binding. Publishes a normalized page event. |
| `end` | `binding` | Requires the exact completed binding. Publishes `session_ended` and stops following. |

The host rejects overlapping begins, repeated chunks, out-of-order chunks, mismatched bindings, stale generations, invalid base64, oversized chunks, short uploads, and digest mismatches. There is no arbitrary file-read, host-path, URL-fetch, provider, translation, or screenshot operation.

A persistent `connectNative` port carries the upload and subsequent page events. `sendNativeMessage` is unsuitable because EOF ends following. There is one outstanding native request at a time. Each request has a 30-second extension timeout. Page updates coalesce while a previous page update is pending.

Responses contain `ok: true` on success. Upload responses repeat `binding`. Commit uses `status: "complete"`, page uses `status: "following"`, and end uses `status: "ended"`. Errors contain `ok: false` and a bounded human-readable `error`.

## Inbox reference

`PDF_WORKSPACE_INBOX` selects an absolute dedicated inbox path. Otherwise the host uses `%LOCALAPPDATA%\PdfWorkspace\inbox`. Both the host and desktop consumer must use the same location. The host does not fall back to the working directory, scan user folders, or read unrelated files.

During an upload, the host streams bytes into a fresh `.pending-<host-token>` directory. The token is host-generated and contains only digits and hyphens. The request never controls a filesystem path. Incomplete or rejected transfers remove only that pending directory. A crash can leave an unpublished pending directory, which the desktop must ignore.

On commit, the host syncs both files and atomically renames the staging directory to `ready-<host-token>`. Consumers see these files together.

```text
ready-<host-token>/
  document.pdf
  event.json
```

`event.json` is immutable.

```json
{
  "version": 1,
  "kind": "document_ready",
  "binding": {
    "session_id": "11111111-1111-4111-8111-111111111111",
    "source_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "request_nonce": "22222222-2222-4222-8222-222222222222",
    "generation": 1794114000000
  },
  "sequence": 0,
  "sha256": "<64 lowercase hex characters>",
  "total_bytes": 12345,
  "pdf_file": "document.pdf",
  "title": "Browser PDF",
  "page": {"page":0,"page_count":null,"fraction":0.25,"zoom":1.5}
}
```

Subsequent page and end events atomically replace `latest.json` in the same ready directory. This keeps the event-file count bounded. Sequence numbers strictly increase within a committed session. An event has `version`, `kind`, `binding`, and `sequence`. `page_changed` also contains `page`. `session_ended` contains `reason`, which is `user_stopped`, `source_changed`, or `disconnected`. EOF, native-port failure, and rejected messages end an existing completed session with `disconnected` when the filesystem remains writable.

The consumer must validate the event version, exact binding, digest, byte count, and monotonic generation and sequence. It must use the fixed local name `document.pdf`, not interpret `pdf_file` as an arbitrary path. Directory enumeration order is not event order. The consumer can read the original event and the latest event without replaying intermediate page changes.

The host does not remove a published ready directory or reread the PDF after commit. The consumer may retain its own verified library copy, write `acknowledged.json` with the imported document ID, and then remove the inbox PDF duplicate. Acknowledgment and cleanup policy belong to the desktop consumer. No document bytes, source URLs, API keys, provider configuration, or translated text appear in page or end events.

## Verification reference

[Native host tests](../desktop/tests/native_host.rs) exercise the built binary through isolated piped stdin and stdout. Tests use synthetic PDF bytes and unique temporary inboxes. They cover framing, atomic publication, digest and size validation, chunk order and binding, page normalization, stale events, generation replay, and incomplete-upload cleanup.

[Extension bridge tests](../tests/extension-native-bridge.test.ts) exercise a fake native port without network or Chrome registration. Existing extension tests continue to cover the service worker's source authorization and acquisition policy.

```powershell
cargo test --manifest-path desktop/Cargo.toml --test native_host
pnpm exec vitest run tests/extension.test.ts tests/extension-background.test.ts tests/extension-native-bridge.test.ts
pnpm run typecheck
```

These automated checks do not install a host, alter the registry, or prove Chrome's deployed native-host registration. A real Chrome handshake with a user-selected extension ID remains an explicit installation smoke test.
