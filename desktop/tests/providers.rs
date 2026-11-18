use mirror_pdf_desktop::{model::{BlockRect, ProviderKind, ProviderSettings, TextBlock}, provider::{translate_blocks_in, validate_endpoint}};
use std::{io::{Read, Write}, net::TcpListener, time::Duration};

fn block() -> TextBlock { TextBlock { id: 1, source: "Hello".into(), translated: None, rect: BlockRect { x: 0.1, y: 0.1, width: 0.4, height: 0.1 }, background: None, font_size: 0.02, bold: false } }

#[test]
fn local_mode_never_sends_to_remote_hosts_even_with_consent() {
    let config = ProviderSettings { kind: ProviderKind::Local, endpoint: "https://remote.example/v1".into(), cloud_consent: true, ..Default::default() };
    assert!(validate_endpoint(&config).is_err());
}

#[test]
fn provider_keys_cannot_target_lookalike_google_or_deepl_hosts() {
    for (kind, endpoint) in [(ProviderKind::Google, "https://translation.googleapis.com.evil.example"), (ProviderKind::DeepL, "https://api.deepl.com.evil.example/v2")] {
        let config = ProviderSettings { kind, endpoint: endpoint.into(), api_key: "private".into(), cloud_consent: true, ..Default::default() };
        assert!(validate_endpoint(&config).is_err());
    }
}

#[test]
fn loopback_provider_returns_real_response_and_cached_result_without_second_request() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut bytes = vec![0; 16384];
        let count = stream.read(&mut bytes).unwrap();
        let request = String::from_utf8_lossy(&bytes[..count]).to_string();
        assert!(request.starts_with("POST /v1/chat/completions"), "{request}");
        let body = r#"{"choices":[{"message":{"content":"{\"translations\":[\"Xin chào\"]}"}}]}"#;
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    });
    let directory = std::env::temp_dir().join(format!("pdf-provider-{}-{}", std::process::id(), address.port()));
    let config = ProviderSettings { kind: ProviderKind::Local, endpoint: format!("http://{address}/v1"), model: "deterministic-test-only".into(), ..Default::default() };
    let first = translate_blocks_in(&config, &[block()], &directory).unwrap();
    server.join().unwrap();
    let cached = translate_blocks_in(&config, &[block()], &directory).unwrap();
    assert_eq!(first, vec!["Xin chào"]);
    assert_eq!(cached, first);
    std::fs::remove_dir_all(&directory).unwrap();
}
