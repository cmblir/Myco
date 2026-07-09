//! YouTube transcript fetch (Feature 2 — multimodal ingest). Pulls a video's
//! existing caption track (human or auto-generated) as plain text so it can flow
//! through the normal ingest → cited-wiki pipeline. No API key; no audio model.
//!
//! Best-effort by nature: it scrapes the watch page for the caption-track URL,
//! which depends on YouTube's current page shape and can break or be blocked.
//! Videos without captions return a clear error (that's Whisper's job later).

const MAX_TRANSCRIPT_BYTES: usize = 400_000;

/// Extract the 11-char video id from the common YouTube URL shapes.
pub fn video_id(url: &str) -> Option<String> {
    let u = url.trim();
    // youtu.be/<id>, /embed/<id>, /shorts/<id>, /v/<id>
    for marker in ["youtu.be/", "/embed/", "/shorts/", "/v/"] {
        if let Some(i) = u.find(marker) {
            let rest = &u[i + marker.len()..];
            let id: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-').collect();
            if id.len() >= 10 {
                return Some(id);
            }
        }
    }
    // watch?v=<id>
    if let Some(i) = u.find("v=") {
        let rest = &u[i + 2..];
        let id: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-').collect();
        if id.len() >= 10 {
            return Some(id);
        }
    }
    None
}

/// True if the string looks like a YouTube link (used to auto-route pasted URLs).
pub fn is_youtube_url(s: &str) -> bool {
    let s = s.trim();
    (s.contains("youtube.com/") || s.contains("youtu.be/")) && video_id(s).is_some()
}

fn unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#160;", " ")
        .replace("\\u0026", "&")
        .replace("\\/", "/")
}

/// Grab the first `"baseUrl":"…"` inside the page's `captionTracks` array.
fn caption_url(html: &str) -> Option<String> {
    let ct = html.find("\"captionTracks\":")?;
    let after = &html[ct..];
    let bi = after.find("\"baseUrl\":\"")? + "\"baseUrl\":\"".len();
    let rest = &after[bi..];
    let end = rest.find('"')?;
    Some(unescape(&rest[..end]))
}

/// Fetch a video's transcript as newline-joined text. Async (reqwest).
pub async fn fetch_transcript(url: &str) -> Result<String, String> {
    let id = video_id(url).ok_or("not a recognizable YouTube URL")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36")
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let watch = format!("https://www.youtube.com/watch?v={id}&hl=en");
    let html = client
        .get(&watch)
        .send()
        .await
        .map_err(|e| format!("fetch watch page: {e}"))?
        .text()
        .await
        .map_err(|e| format!("read watch page: {e}"))?;
    let track = caption_url(&html)
        .ok_or("no captions found for this video (auto-transcription via Whisper is not yet available)")?;
    let xml = client
        .get(&track)
        .send()
        .await
        .map_err(|e| format!("fetch caption track: {e}"))?
        .text()
        .await
        .map_err(|e| format!("read caption track: {e}"))?;
    Ok(transcript_from_xml(&xml))
}

/// Turn the `<text start=…>…</text>` caption XML into newline-joined plain text.
pub fn transcript_from_xml(xml: &str) -> String {
    let mut out = String::new();
    let mut rest = xml;
    while let Some(i) = rest.find("<text") {
        rest = &rest[i + 5..];
        let Some(gt) = rest.find('>') else { break };
        rest = &rest[gt + 1..];
        let Some(end) = rest.find("</text>") else { break };
        let line = unescape(rest[..end].trim());
        if !line.is_empty() {
            out.push_str(&line);
            out.push('\n');
        }
        rest = &rest[end + "</text>".len()..];
        if out.len() > MAX_TRANSCRIPT_BYTES {
            out.push_str("\n…(truncated: transcript exceeds the ingest limit)…");
            break;
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_video_id_shapes() {
        assert_eq!(video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(video_id("https://youtu.be/dQw4w9WgXcQ?t=10").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(video_id("https://www.youtube.com/shorts/abc123XYZ_-").as_deref(), Some("abc123XYZ_-"));
        assert_eq!(video_id("https://example.com/watch?v=short"), None);
    }

    #[test]
    fn detects_youtube_urls() {
        assert!(is_youtube_url("https://youtu.be/dQw4w9WgXcQ"));
        assert!(!is_youtube_url("just some pasted note text"));
        assert!(!is_youtube_url("https://vimeo.com/12345"));
    }

    #[test]
    fn xml_to_transcript_unescapes_and_joins() {
        let xml = r#"<transcript><text start="0" dur="1">Hello &amp; welcome</text><text start="1" dur="1">it&#39;s here</text></transcript>"#;
        let t = transcript_from_xml(xml);
        assert_eq!(t, "Hello & welcome\nit's here");
    }

    #[test]
    fn caption_url_extracted_and_unescaped() {
        let html = r#"...,"captionTracks":[{"baseUrl":"https://youtube.com/api/timedtext?v=x&lang=en","languageCode":"en"}],..."#;
        assert_eq!(
            caption_url(html).as_deref(),
            Some("https://youtube.com/api/timedtext?v=x&lang=en")
        );
    }
}
