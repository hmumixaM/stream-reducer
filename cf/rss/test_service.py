import importlib.util
import pathlib
import socket
import pytest
import pymupdf
from fastapi import HTTPException

spec = importlib.util.spec_from_file_location("rss_service", pathlib.Path(__file__).with_name("service.py"))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


def substack_profile_api(path, cookie="", subdomain=""):
    if path == "user/profile/self":
        return {"id": 7, "email": "never-return@example.com"}
    raise AssertionError(path)


def test_substack_auth_discards_profile_and_restricts_cookie_names(monkeypatch):
    monkeypatch.setattr(s, "substack_json", substack_profile_api)
    assert s.substack_check(s.SubstackRequest(cookie="substack.sid=session")) == {"authenticated": True}
    assert s.substack_cookie("tracking=private; substack.sid=session; email=private; connect.sid=other") == "substack.sid=session; connect.sid=other"
    with pytest.raises(ValueError): s.substack_cookie("substack.sid=a\r\nInjected: header")
    with pytest.raises(ValueError): s.substack_cookie("email=private")


def test_substack_credentials_only_reach_fixed_origin(monkeypatch):
    calls = []
    def download(url, **kwargs):
        calls.append((url, kwargs.get("headers", {})))
        return b'{"id":7}', "application/json", url
    monkeypatch.setattr(s, "download", download)
    s.substack_json("user/profile/self", "substack.sid=session")
    s.substack_json("archive?limit=50", subdomain="example")
    assert calls[0][0].startswith("https://substack.com/api/v1/")
    assert calls[0][1]["Cookie"] == "substack.sid=session"
    assert "Cookie" not in calls[1][1]
    with pytest.raises(ValueError): s.substack_json("publication", "substack.sid=session", "evil.example")


def test_substack_subscription_directory_strips_account_and_private_feed_data(monkeypatch):
    def api(path, cookie="", subdomain=""):
        if path == "user/profile/self": return {"id": 7}
        assert path == "subscriptions/page_v2"
        return {"subscriptions": [{"publication_id": 42, "user_id": 7, "podcast_rss_token": "PRIVATE"}],
                "publications": [{"id": 42, "name": "News", "subdomain": "news", "owner_email": "PRIVATE"}, {"id": 99, "name": "Not subscribed", "subdomain": "other"}]}
    monkeypatch.setattr(s, "substack_json", api)
    result = s.substack_subscriptions(s.SubstackRequest(cookie="substack.sid=session"))
    assert len(result["sources"]) == 1
    assert result["sources"][0]["substack_publication_id"] == "42"
    assert "PRIVATE" not in str(result) and "user_id" not in str(result)


def test_substack_resolve_custom_domain_never_sends_cookies(monkeypatch):
    publication = {"id": 42, "name": "News", "subdomain": "news", "custom_domain": "news.example"}
    calls = []
    def download(url, **kwargs):
        calls.append(kwargs)
        return b'[{"id":123,"publication_id":42}]', "application/json", url
    monkeypatch.setattr(s, "download", download)
    def api(path, *args, **kwargs):
        if path == "user/profile/self": return {"id": 7}
        if path == "subscriptions/page_v2": return {"subscriptions": [], "publications": []}
        return {"publication": publication}
    monkeypatch.setattr(s, "substack_json", api)
    result = s.substack_resolve(s.SubstackRequest(cookie="substack.sid=secret", url="https://news.example/p/story"))
    assert result["substack_subdomain"] == "news"
    assert all("Cookie" not in call.get("headers", {}) for call in calls)


def test_substack_archive_paginates_posts_with_equal_dates_and_preserves_boundary(monkeypatch):
    calls = []
    def api(path, cookie="", subdomain=""):
        if path == "user/profile/self": return {"id": 7}
        calls.append((path, cookie))
        return [{"id": i+1, "publication_id": 42, "title": "Story", "canonical_url": f"https://news.substack.com/p/{i}", "post_date": "2026-10-01T00:00:00Z", "description": "Preview"} for i in range(50)]
    monkeypatch.setattr(s, "substack_json", api)
    req = s.SubstackRequest(cookie="substack.sid=session", subdomain="news", publication_id="42", cursor="50", since="2026-07-18")
    result = s.substack_poll(req)
    assert result["next_cursor"] == "100" and len(result["entries"]) == 50
    assert "offset=50" in calls[0][0] and not calls[0][1]
    assert not result["entries"][0]["content_is_full"]
    assert result["entries"][0]["substack_post_id"] == "1"
    req.since = "2026-10-02"
    result = s.substack_poll(req)
    assert result["next_cursor"] is None and result["coverage"] == "reached_since" and not result["entries"]


@pytest.mark.parametrize("state,expected", [("subscribed", "full"), ("free_signup", "partial"), (None, "partial")])
def test_substack_paid_content_requires_entitlement_signal_and_removes_private_markup(monkeypatch, state, expected):
    def api(path, cookie="", subdomain=""):
        if path == "user/profile/self": return {"id": 7}
        return {"post": {"id": 123, "audience": "only_paid", "is_published": True,
                "canonical_url": "https://news.example/p/story", "body_html": '<p>Complete original evidence and results are documented in this source article with detailed limitations.</p><p><a href="https://news.example/p/other?utm_source=email&amp;token=PRIVATE&amp;r=PRIVATE">Related article</a></p><script>PRIVATE</script><form>PRIVATE</form>'},
                "subscription": {"membership_state": state, "user_email": "PRIVATE", "podcast_rss_token": "PRIVATE"} if state else None}
    monkeypatch.setattr(s, "substack_json", api)
    result = s.substack_extract(s.SubstackRequest(cookie="substack.sid=session", post_id="123"))
    assert result["completeness"] == expected
    assert "PRIVATE" not in str(result) and "token=" not in result["text"]
    assert result["snapshot"] is None


def test_substack_invalid_session_is_not_misreported_as_empty_subscriptions(monkeypatch):
    monkeypatch.setattr(s, "substack_json", lambda *args, **kwargs: {"subscriptions": [], "publications": []})
    with pytest.raises(HTTPException) as caught:
        s.substack_subscriptions(s.SubstackRequest(cookie="substack.sid=expired"))
    assert caught.value.status_code == 401 and caught.value.detail == "SUBSTACK_AUTH"


def test_substack_403_is_not_automatically_session_expiration(monkeypatch):
    monkeypatch.setattr(s, "download", lambda *args, **kwargs: (_ for _ in ()).throw(s.UpstreamError(403)))
    with pytest.raises(HTTPException) as caught:
        s.substack_check(s.SubstackRequest(cookie="substack.sid=session"))
    assert caught.value.status_code == 422 and "SUBSTACK_AUTH" not in caught.value.detail


def test_substack_private_publication_uses_account_reader_and_keeps_opaque_cursor(monkeypatch):
    calls = []
    def api(path, cookie="", subdomain=""):
        calls.append((path, bool(cookie), subdomain))
        if path == "user/profile/self": return {"id": 7}
        if path.startswith("archive?"): raise ValueError("Substack 访问暂时失败（HTTP 403）")
        assert path.startswith("reader/posts?") and cookie and not subdomain
        return {"posts": [
            {"id": 123, "publication_id": 42, "canonical_url": "https://private.substack.com/p/story", "title": "Accessible post", "post_date": "2026-10-01T00:00:00Z"},
            {"id": 999, "publication_id": 99, "canonical_url": "https://other.substack.com/p/secret", "title": "OTHER PRIVATE SUBSCRIPTION", "post_date": "2026-09-01T00:00:00Z"}],
            "more": True, "cursor": {"lastPostDate": "2026-09-01T00:00:00Z", "lastPostId": 999}}
    monkeypatch.setattr(s, "substack_json", api)
    req = s.SubstackRequest(cookie="substack.sid=session", subdomain="private", publication_id="42", since="2026-07-18")
    first = s.substack_poll(req)
    assert first["next_cursor"].startswith("reader:") and len(first["entries"]) == 1
    assert "OTHER PRIVATE" not in str(first)
    req.cursor = first["next_cursor"]
    s.substack_poll(req)
    assert len([call for call in calls if call[0].startswith("archive?")]) == 1
    assert "cursor=" in calls[-1][0]


def test_substack_private_publication_resolves_from_account_directory(monkeypatch):
    def api(path, *args, **kwargs):
        if path == "user/profile/self": return {"id": 7}
        return {"subscriptions": [{"publication_id": 42}], "publications": [{"id": 42, "name": "Private", "subdomain": "private"}]}
    monkeypatch.setattr(s, "substack_json", api)
    monkeypatch.setattr(s, "download", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("private host must not be requested")))
    result = s.substack_resolve(s.SubstackRequest(cookie="substack.sid=session", url="https://private.substack.com"))
    assert result["substack_publication_id"] == "42"

@pytest.mark.parametrize("url", ["http://localhost/a", "http://example.local/x", "ftp://example.com", "https://user:pw@example.com", "https://example.com/?token=secret", "https://example.com:8080/feed"])
def test_reject_unsafe_urls(url):
    with pytest.raises(ValueError): s.public_url(url)

def test_redirect_and_dns_rebinding_are_checked(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(2,1,6,"",("127.0.0.1",80))])
    with pytest.raises(ValueError, match="非公开"): s.download("https://public.example/feed")

def test_rss_keeps_content_and_filters_audio_but_not_pdf():
    xml=b'''<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>News</title><item><title>Full</title><link>https://example.com/a?utm_source=x</link><description>Intro</description><content:encoded><![CDATA[<p>Full article text.</p>]]></content:encoded><enclosure url="https://example.com/r.pdf" type="application/pdf"/></item><item><title>Audio</title><link>https://example.com/b</link><enclosure url="https://example.com/a.mp3" type="audio/mpeg"/></item></channel></rss>'''
    feed=s.parse_feed(xml,"https://example.com/feed")
    assert len(feed["entries"])==1
    assert feed["entries"][0]["content_is_full"]
    assert feed["entries"][0]["url"]=="https://example.com/a"

def test_atom_relative_links_and_missing_date():
    feed=s.parse_feed(b'<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><title>A</title><link href="/a"/><content type="html">Full content</content></entry></feed>',"https://example.com/feed")
    assert feed["entries"][0]["url"]=="https://example.com/a"
    assert feed["entries"][0]["published_at"] is None

def test_multiple_feed_choices_not_silently_selected(monkeypatch):
    monkeypatch.setattr(s,"download",lambda *a,**k:(b'<html><link rel="alternate" type="application/rss+xml" href="/one"/><link rel="alternate" type="application/atom+xml" href="/two"/></html>',"text/html","https://example.com/"))
    assert len(s.resolve(s.SourceRequest(url="https://example.com"))["choices"])==2

def test_short_full_news_does_not_require_long_text(monkeypatch):
    monkeypatch.setattr(s,"download",lambda *a,**k: (_ for _ in ()).throw(ValueError("offline")))
    result=s.extract(s.ExtractRequest(url="https://example.com/a",content="<p>发布了三个新的功能，包括列表、搜索与收藏。</p>",content_is_full=True))
    assert result["completeness"]=="full"

def test_excerpt_is_never_promoted_when_both_providers_fail(monkeypatch):
    monkeypatch.setattr(s,"download",lambda *a,**k: (_ for _ in ()).throw(ValueError("HTTP 503")))
    result=s.extract(s.ExtractRequest(url="https://example.com/a",content="<p>This short article is an excerpt. Read the full article.</p>",content_is_full=True,folo_entry_id="123"))
    assert result["completeness"]=="partial"
    assert "Read the full" in result["text"]

def test_folo_readability_upgrades_excerpt(monkeypatch):
    monkeypatch.setattr(s,"folo_api",lambda *a,**k:{"content":"<p>Original evidence includes a new result. The measured rate was 32 percent and the report explains its limitations.</p>"})
    result=s.extract(s.ExtractRequest(url="https://example.com/a",content="Read the full article",folo_entry_id="123"))
    assert result["completeness"]=="full"
    assert result["method"]=="folo_readability"

def test_text_pdf_and_scanned_pdf():
    pdf=pymupdf.open();p=pdf.new_page();p.insert_text((30,40),"Public report evidence and methods. "*8)
    text,quality,kind=s.document(pdf.tobytes(),"application/pdf","https://example.com/r.pdf")
    assert kind=="pdf" and quality=="full" and "第 1 页" in text
    blank=pymupdf.open();blank.new_page()
    with pytest.raises(ValueError,match="扫描件"):s.document(blank.tobytes(),"application/pdf","https://example.com/r.pdf")

def test_explicit_pdf_report_in_full_feed_is_extracted(monkeypatch):
    pdf=pymupdf.open();p=pdf.new_page();p.insert_text((30,40),"Full report evidence and limitations. "*8)
    calls=[]
    def download(url,**kwargs): calls.append(url);return pdf.tobytes(),"application/pdf",url
    monkeypatch.setattr(s,"download",download)
    r=s.extract(s.ExtractRequest(url="https://example.com/post",content='<p>Overview.</p><a href="/full.pdf">English PDF version</a>',content_is_full=True))
    assert calls==["https://example.com/full.pdf"]
    assert r["method"]=="pdf"

def test_auth_failure_falls_back_with_reconnect_status(monkeypatch):
    monkeypatch.setattr(s,"folo_api",lambda *a,**k:(_ for _ in ()).throw(s.UpstreamError(401)))
    monkeypatch.setattr(s,"download",lambda *a,**k:(b'<rss version="2.0"><channel><title>A</title></channel></rss>',"application/xml","https://example.com/feed"))
    r=s.poll(s.PollRequest(feed_url="https://example.com/feed",folo_id="123",since="2026-07-18"))
    assert r["provider"]=="rss" and r["auth_error"]

def test_rate_limit_retry_after_survives_fallback(monkeypatch):
    monkeypatch.setattr(s,"folo_api",lambda *a,**k:(_ for _ in ()).throw(s.UpstreamError(429,"120")))
    monkeypatch.setattr(s,"download",lambda *a,**k:(b'<rss version="2.0"><channel><title>A</title></channel></rss>',"application/xml","https://example.com/feed"))
    assert s.poll(s.PollRequest(feed_url="https://example.com/feed",folo_id="123",since="2026-07-18"))["retry_after"]=="120"

def test_folo_history_boundary_and_description_not_full(monkeypatch):
    rows=[{"entries":{"id":str(i),"url":f"https://example.com/{i}","title":"A","publishedAt":"2026-07-01T00:00:00Z" if i==99 else "2026-08-01T00:00:00Z","content":"excerpt","description":"excerpt"}} for i in range(100)]
    monkeypatch.setattr(s,"folo_api",lambda *a,**k:rows)
    r=s.poll(s.PollRequest(folo_id="123",since="2026-07-18T00:00:00Z"))
    assert r["coverage"]=="reached_since" and r["next_before"] is None
    assert len(r["entries"])==99 and not r["entries"][0]["content_is_full"]

def test_opml_categories_and_private_urls():
    r=s.opml(s.OpmlRequest(text='<opml><body><outline text="AI"><outline text="News" xmlUrl="rsshub://news/a"/><outline text="Private" xmlUrl="https://example.com/feed?token=x"/></outline></body></opml>'))
    assert r["sources"][0]["category"]=="AI" and r["skipped"]==1
    with pytest.raises(HTTPException):s.opml(s.OpmlRequest(text='<!DOCTYPE x><opml/>'))

@pytest.mark.parametrize("url",["https://app.folo.is/timeline/articles/all/123","https://app.folo.is/timeline/articles/all/pending","https://app.folo.is/list/123"])
def test_folo_article_and_list_links_not_feed(url):
    with pytest.raises(ValueError):s.folo_id(url)

def test_unstructured_folo_content_is_verified_instead_of_assumed_full(monkeypatch):
    monkeypatch.setattr(s,"folo_api",lambda *a,**k:(_ for _ in ()).throw(s.UpstreamError(403)))
    monkeypatch.setattr(s,"download",lambda *a,**k:(_ for _ in ()).throw(s.UpstreamError(403)))
    r=s.extract(s.ExtractRequest(url="https://example.com/a",content="A polished teaser without truncation markers.",content_is_full=True,folo_entry_id="123"))
    assert r["completeness"]=="partial"

def test_canonical_requires_same_host_and_matching_saved_body(monkeypatch):
    html=b'<html><head><link rel="canonical" href="https://example.com/canonical"/></head><body><article><p>Original evidence and methods are documented with ten detailed factual observations.</p><p>The report explains the limits of these observations.</p></article></body></html>'
    monkeypatch.setattr(s,"download",lambda url,**k:(html,"text/html",url))
    r=s.extract(s.ExtractRequest(url="https://example.com/old"))
    assert r["canonical_url"]=="https://example.com/canonical"

def test_rsshub_403_recovers_cached_public_feed_without_subscribing(monkeypatch):
    monkeypatch.setattr(s,"download",lambda *a,**k:(_ for _ in ()).throw(s.UpstreamError(403)))
    calls=[]
    def catalog(path,token="",body=None):
        calls.append((path,body))
        return {"feed":{"type":"feed","id":"145342595547962368","title":"Anthropic Engineering","url":"rsshub://anthropic/engineering"}}
    monkeypatch.setattr(s,"folo_api",catalog)
    r=s.resolve(s.SourceRequest(url="rsshub://anthropic/engineering",token="free"))
    assert r["folo_id"]=="145342595547962368"
    assert r["feed_url"]=="https://rsshub.app/anthropic/engineering"
    assert all(path.startswith('/feeds?') and body is None for path,body in calls)

def test_full_rsshub_url_keeps_user_selected_instance_on_cached_fallback(monkeypatch):
    monkeypatch.setattr(s,"download",lambda *a,**k:(_ for _ in ()).throw(s.UpstreamError(403)))
    monkeypatch.setattr(s,"folo_api",lambda *a,**k:{"feed":{"type":"feed","id":"123","title":"A"}})
    r=s.resolve(s.SourceRequest(url="https://rsshub.example.com/anthropic/engineering"))
    assert r["feed_url"]=="https://rsshub.example.com/anthropic/engineering"

def test_history_uses_folo_older_page_cursor_despite_parameter_name(monkeypatch):
    calls=[]
    def api(path,token="",body=None):
        calls.append(body)
        return [{"entries":{"id":"1","url":"https://example.com/history","title":"Old","publishedAt":"2026-08-01T00:00:00Z","content":"A complete historical article."}}]
    monkeypatch.setattr(s,"folo_api",api)
    r=s.poll(s.PollRequest(folo_id="123",before="2026-09-02T12:00:00.381Z",since="2026-07-18T00:00:00Z"))
    assert calls[0]["publishedAfter"]=="2026-09-02T12:00:00.381Z"
    assert "publishedBefore" not in calls[0]
    assert r["entries"][0]["published_at"].startswith("2026-08-01")


def test_source_branding_uses_declared_site_icon_not_article_cover(monkeypatch):
    calls=[]
    def download(url, **kwargs):
        calls.append(url)
        if url.endswith('/story'):
            return b'<html><link rel="apple-touch-icon" href="/brand.png"><meta property="og:image" content="/cover.jpg"></html>', 'text/html', url
        return b'icon-bytes', 'image/png', url
    monkeypatch.setattr(s, 'download', download)
    result=s.branding(s.BrandingRequest(url='https://publisher.example/story'))
    assert result == {'site_url':'https://publisher.example/', 'image_url':'https://publisher.example/brand.png'}
    assert not any('cover' in url for url in calls)


def test_source_branding_falls_back_without_blocking_articles(monkeypatch):
    monkeypatch.setattr(s,'download',lambda *a,**k:(_ for _ in ()).throw(s.UpstreamError(404)))
    assert s.branding(s.BrandingRequest(url='https://publisher.example/story'))['image_url'] is None


def test_source_branding_recovers_public_catalog_logo_without_subscribing(monkeypatch):
    calls=[]
    def download(url, **kwargs):
        if url == 'https://publisher.example/logo.png': return b'logo', 'image/png', url
        raise s.UpstreamError(403)
    def catalog(path, token='', body=None):
        calls.append((path,token,body))
        return {'feed':{'image':'https://publisher.example/logo.png'}}
    monkeypatch.setattr(s,'download',download)
    monkeypatch.setattr(s,'folo_api',catalog)
    assert s.branding(s.BrandingRequest(url='https://publisher.example/story',folo_id='123'))['image_url'].endswith('/logo.png')
    assert all(path.startswith('/feeds?') and not token and body is None for path,token,body in calls)


def test_search_proxy_rejects_arbitrary_targets():
    with pytest.raises(HTTPException) as e:
        s.source_search(s.SearchRequest(provider="https://localhost", q="a"))
    assert e.value.status_code == 400


def test_source_inspect_routes_enclosure_feed_to_media(monkeypatch):
    monkeypatch.setattr(s, "resolve", lambda req: {"identity": "feed:https://example.com/podcast", "provider": "rss", "feed_url": "https://example.com/podcast"})
    monkeypatch.setattr(s, "download", lambda *a, **k: (b'<rss version="2.0"><channel><title>Podcast</title><item><enclosure url="https://example.com/audio.mp3" type="audio/mpeg"/></item></channel></rss>', "application/rss+xml", "https://example.com/podcast"))
    assert s.source_inspect(s.SourceRequest(url="https://example.com/podcast"))["kind"] == "media"


def test_source_inspect_will_not_promote_unverified_podcast_to_article(monkeypatch):
    monkeypatch.setattr(s, "resolve", lambda req: {"identity": "feed:https://example.com/podcast", "provider": "rss", "feed_url": "https://example.com/podcast"})
    monkeypatch.setattr(s, "download", lambda *a, **k: (_ for _ in ()).throw(ValueError("offline")))
    with pytest.raises(HTTPException): s.source_inspect(s.SourceRequest(url="https://example.com/podcast"))


def test_media_feed_rejects_private_cache(monkeypatch):
    monkeypatch.setattr(s, "folo_api", lambda *a, **k: {"feed": {"isPrivate": True}, "entries": []})
    with pytest.raises(HTTPException): s.media_feed(s.SourceRequest(url="https://example.com/podcast"))


def test_media_feed_recovers_rsshub_scheme_alias(monkeypatch):
    def cached(path, token=""):
        if "rsshub%3A%2F%2F" not in path:
            raise ValueError("not found")
        return {"feed": {"title": "Podcast"}, "entries": [{"entries": {"id": "1", "title": "Episode", "url": "https://www.xiaoyuzhoufm.com/episode/123456789012345678901234", "publishedAt": "2026-10-18T00:00:00Z"}}]}
    monkeypatch.setattr(s, "folo_api", cached)
    result = s.media_feed(s.SourceRequest(url="https://rsshub.app/xiaoyuzhou/podcast/123456789012345678901234"))
    assert len(result["entries"]) == 1
    assert result["entries"][0]["link"].startswith("https://www.xiaoyuzhoufm.com/episode/")


def test_media_feed_can_validate_by_folo_identity(monkeypatch):
    calls = []
    def cached(path, token=""):
        calls.append(path)
        return {"feed": {"title": "Podcast"}, "entries": [{"id": "1", "url": "https://example.com/episode", "media": [{"type": "audio", "url": "https://example.com/audio.mp3"}]}]}
    monkeypatch.setattr(s, "folo_api", cached)
    assert s.media_feed(s.SourceRequest(url="https://app.folo.is/feed/123"))["entries"][0]["audio"].endswith(".mp3")
    assert "id=123" in calls[0]


def test_media_feed_uses_public_catalog_page_limit_and_preserves_audio_duration(monkeypatch):
    def cached(path, token=""):
        assert "entriesLimit=10" in path
        return {"feed": {"title": "Podcast"}, "entries": [{"id": "1", "url": "https://example.com/episode", "attachments": [{"url": "https://example.com/audio.m4a", "mime_type": "audio/mpeg", "duration_in_seconds": 1200}]}]}
    monkeypatch.setattr(s, "folo_api", cached)
    result = s.media_feed(s.SourceRequest(url="https://app.folo.is/feed/123"))
    assert result["entries"][0]["audio"].endswith(".m4a")
    assert result["entries"][0]["duration_s"] == 1200


@pytest.mark.parametrize("publication,expected", [
    ({"payments_state": "disabled"}, "free"),
    ({"payments_state": "never_enabled"}, "free"),
    ({"payments_state": "enabled"}, "paid"),
    ({"payments_state": "disabled", "plans": [{"amount": 500}]}, "paid"),
    ({}, "unknown"),
])
def test_substack_payment_status(publication, expected):
    assert s.substack_source({"id": 42, "subdomain": "news", **publication})["access"] == expected
