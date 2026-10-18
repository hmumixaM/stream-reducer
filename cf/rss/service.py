"""RSS-only acquisition service. No media pipeline, cookies, or browser runtime."""
from __future__ import annotations

import ipaddress
import json
import os
import xml.etree.ElementTree as ET
import re
import socket
import urllib.request
import uuid
from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit, urlunsplit, parse_qsl, urlencode

import feedparser
import pymupdf
import trafilatura
import urllib3
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI()
MAX_BYTES = 20 * 1024 * 1024
MAX_TEXT = 1_000_000
FOLO = "https://api.folo.is"
RSSHUB = os.environ.get("RSSHUB_BASE_URL", "https://rsshub.app").rstrip("/")

class UpstreamError(ValueError):
    def __init__(self, status, retry_after=None):
        self.status = status
        self.retry_after = retry_after
        super().__init__(f"来源返回 HTTP {status}")


class BrandingRequest(BaseModel):
    url: str
    folo_id: str | None = None


@app.post("/branding")
def branding(req: BrandingRequest):
    """Use the publisher's declared site icons, never an article cover image."""
    address = public_url(req.url)
    parts = urlsplit(address)
    site = urlunsplit((parts.scheme, parts.netloc, "/", "", ""))
    candidates = []
    try:
        data, ctype, final = download(site if parts.path.lower().endswith(".pdf") else address)
        if "html" in ctype:
            soup = BeautifulSoup(data, "html.parser")
            for rel in ("apple-touch-icon", "icon"):
                for link in soup.find_all("link", href=True):
                    if rel in (link.get("rel") or []):
                        candidates.append(public_url(urljoin(final, link["href"])))
    except Exception:
        pass
    candidates.append(urljoin(site, "favicon.ico"))
    for candidate in list(dict.fromkeys(candidates))[:4]:
        try:
            data, ctype, final = download(candidate)
            if data and len(data) <= 1_000_000 and ctype.lower().startswith("image/"):
                return {"site_url": site, "image_url": final}
        except Exception:
            continue
    # Folo's public catalog may retain the site's declared logo when an origin
    # blocks server requests. Reading metadata never creates a subscription.
    if req.folo_id and re.fullmatch(r"\d+", req.folo_id):
        try:
            feed = folo_api("/feeds?" + urlencode({"id": req.folo_id, "entriesLimit": 0})).get("feed", {})
            image = feed.get("image")
            if image and not feed.get("isPrivate"):
                data, ctype, final = download(public_url(image))
                if data and len(data) <= 1_000_000 and ctype.lower().startswith("image/"):
                    return {"site_url": site, "image_url": final}
        except Exception:
            pass
    return {"site_url": site, "image_url": None}

def feed_address(raw):
    return RSSHUB + "/" + raw[len("rsshub://"):].lstrip("/") if raw.startswith("rsshub://") else raw



def public_url(raw: str) -> str:
    p = urlsplit(raw.strip())
    if p.scheme not in ("http", "https") or not p.hostname or p.username or p.password:
        raise ValueError("需要公开的 HTTP 或 HTTPS 链接")
    if p.port not in (None, 80, 443):
        raise ValueError("不支持此端口")
    host = p.hostname.lower().rstrip(".")
    if host == "localhost" or host.endswith((".local", ".internal", ".localhost")):
        raise ValueError("不支持内部网络地址")
    if any(re.search(r"(?:token|secret|password|api[_-]?key|auth|signature|access[_-]?key)", k, re.I) for k, _ in parse_qsl(p.query)):
        raise ValueError("暂不支持带访问凭据的来源链接")
    return urlunsplit((p.scheme, p.netloc, p.path or "/", p.query, ""))


def download(raw: str, *, headers=None, method="GET", payload=None):
    """Resolve and pin a public address on EVERY redirect, including HTTPS SNI."""
    url = public_url(raw)
    for _ in range(6):
        p = urlsplit(url)
        addresses = {x[4][0] for x in socket.getaddrinfo(p.hostname, p.port or (443 if p.scheme == "https" else 80), type=socket.SOCK_STREAM)}
        if not addresses or any(not ipaddress.ip_address(a).is_global for a in addresses):
            raise ValueError("来源指向非公开网络地址")
        ip = sorted(addresses)[0]
        kwargs = {"timeout": urllib3.Timeout(connect=10, read=30), "retries": False}
        pool = (urllib3.HTTPSConnectionPool(ip, port=p.port or 443, server_hostname=p.hostname,
                    assert_hostname=p.hostname, **kwargs) if p.scheme == "https"
                else urllib3.HTTPConnectionPool(ip, port=p.port or 80, **kwargs))
        request_headers = {"User-Agent": "StreamReducer-RSS/1.0", "Accept-Encoding": "identity", "Host": p.netloc}
        # Authentication never follows a redirect to another origin.
        if headers and urlsplit(raw).netloc == p.netloc:
            request_headers.update(headers)
        try:
            response = pool.urlopen(method, urlunsplit(("", "", p.path or "/", p.query, "")),
                                    headers=request_headers, body=payload, redirect=False, preload_content=False)
            if response.status in (301, 302, 303, 307, 308):
                location = response.headers.get("location")
                if not location:
                    raise ValueError("来源重定向缺少地址")
                url = public_url(urljoin(url, location))
                if response.status == 303:
                    method, payload = "GET", None
                continue
            if response.status >= 400:
                raise UpstreamError(response.status, response.headers.get("retry-after"))
            data = response.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise ValueError("原文超过 20 MB 抓取上限")
            return data, response.headers.get("content-type", ""), url
        finally:
            pool.close()
    raise ValueError("来源重定向次数过多")


def folo_api(path: str, token: str = "", body=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
        headers["Cookie"] = f"__Secure-better-auth.session_token={token}; better-auth.session_token={token}"
    try:
        data, _, _ = download(FOLO + path, headers=headers,
                              method="POST" if body is not None else "GET",
                              payload=json.dumps(body).encode() if body is not None else None)
    except UpstreamError as exc:
        if exc.status == 401:
            exc.args = ("Folo 需要重新连接（401）",)
        elif exc.status == 403:
            exc.args = ("Folo 拒绝此接口访问（403），改用公开 RSS 或原站",)
        raise
    parsed = json.loads(data)
    if "data" not in parsed:
        # No response dumps: they may contain private/account data.
        raise ValueError("Folo 暂时不可用或需要重新连接")
    return parsed["data"]


def clean_url(raw: str) -> str:
    p = urlsplit(public_url(raw))
    query = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True)
             if not k.lower().startswith("utm_") and k not in ("fbclid", "gclid")]
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path or "/", urlencode(query), ""))


def folo_id(raw: str):
    p = urlsplit(raw)
    if p.hostname not in ("app.folo.is", "folo.is", "app.follow.is", "follow.is"):
        return None
    match = re.search(r"/(?:feeds?|share/feeds?)/(\d+)(?:/|$)", p.path)
    if not match:
        match = re.fullmatch(r"/timeline/(?:articles|all)/(\d+)(?:/pending)?/?", p.path)
    if not match:
        raise ValueError("请复制 Folo 的来源链接，而不是单篇文章或全部时间线链接")
    return match[1]


def plain(html: str) -> str:
    soup = BeautifulSoup(html or "", "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "form"]):
        tag.decompose()
    return soup.get_text("\n", strip=True)


def iso(value):
    try:
        if isinstance(value, str):
            date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        else:
            date = datetime(*value[:6], tzinfo=timezone.utc)
        if not date.tzinfo:
            date = date.replace(tzinfo=timezone.utc)
        return date.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except (ValueError, TypeError, AttributeError):
        return None


def parse_feed(data: bytes, base: str):
    parsed = feedparser.parse(data)
    if not parsed.version:
        raise ValueError("链接未返回有效 RSS / Atom，请检查 RSSHub 路由或复制订阅链接")
    entries = []
    for e in parsed.entries:
        link = e.get("link")
        if not link:
            continue
        enclosures = e.get("enclosures", [])
        if any(str(enc.get("type", "")).startswith(("audio/", "video/")) for enc in enclosures):
            continue
        content = next((c.get("value", "") for c in e.get("content", []) if c.get("value")), "")
        try:
            link = clean_url(urljoin(base, link))
        except ValueError:
            continue
        entries.append({"url": link, "external_id": e.get("id", link), "title": plain(e.get("title", "")) or link,
                        "published_at": iso(e.get("published_parsed") or e.get("updated_parsed")),
                        "author": e.get("author"), "content": content or e.get("summary", ""),
                        "description": e.get("summary", ""),
                        "content_is_full": bool(content and plain(content) != plain(e.get("summary", ""))), "folo_entry_id": None})
    return {"title": plain(parsed.feed.get("title", "")) or base, "entries": entries}


class SourceRequest(BaseModel):
    url: str = Field(max_length=4096)
    token: str = ""


@app.post("/resolve")
def resolve(req: SourceRequest):
    try:
        raw = req.url.strip()
        if raw.startswith("rsshub://"):
            raw = feed_address(raw)
        raw = public_url(raw)
        fid = folo_id(raw)
        if fid:
            data = folo_api("/feeds?" + urlencode({"id": fid, "entriesLimit": 0}), req.token)
            feed = data["feed"]
            if feed.get("isPrivate"):
                raise ValueError("暂不支持私有 Folo 来源")
            feed_url = feed.get("url")
            if feed_url:
                feed_url = public_url(feed_address(feed_url))
            return {"identity": "feed:" + clean_url(feed_url) if feed_url else "folo:" + fid,
                    "provider": "folo", "url": raw, "feed_url": feed_url, "folo_id": fid,
                    "title": feed.get("title") or feed_url or fid}
        try:
            data, ctype, final = download(raw)
        except Exception as original_error:
            # Folo's public catalog can supply a cached source even when an
            # RSSHub instance blocks datacenter requests. This is a GET only:
            # it never subscribes the account or spends a subscription slot.
            candidates = [req.url.strip(), raw]
            host = urlsplit(raw).hostname or ""
            if "rsshub" in host and not req.url.startswith("rsshub://"):
                parts = urlsplit(raw)
                candidates.append("rsshub://" + parts.path.lstrip("/") + ("?" + parts.query if parts.query else ""))
            for candidate in dict.fromkeys(candidates):
                try:
                    cached = folo_api("/feeds?" + urlencode({"url": candidate, "entriesLimit": 0}), req.token)
                    feed = cached.get("feed") or {}
                    if feed.get("type") != "feed" or feed.get("isPrivate"):
                        continue
                    address = public_url(raw)
                    return {"identity": "feed:" + clean_url(address),
                            "provider": "rsshub" if "rsshub" in host or req.url.startswith("rsshub://") else "rss",
                            "url": raw, "feed_url": address, "folo_id": str(feed["id"]),
                            "title": feed.get("title") or address}
                except Exception:
                    continue
            raise original_error
        if "html" in ctype or data.lstrip().lower().startswith(b"<!doctype html"):
            soup = BeautifulSoup(data, "html.parser")
            candidates = soup.select('link[rel="alternate"][type="application/rss+xml"], link[rel="alternate"][type="application/atom+xml"]')
            if not candidates:
                raise ValueError("此网页没有公开 RSS 地址，请复制 RSS 订阅链接")
            if len(candidates) > 1:
                return {"choices": [{"url": public_url(urljoin(final, c.get("href", ""))), "title": c.get("title") or c.get("href")} for c in candidates[:20]]}
            final = public_url(urljoin(final, candidates[0].get("href", "")))
            data, _, final = download(final)
        parsed = parse_feed(data, final)
        cached_id = None
        try:
            cached = folo_api("/feeds?" + urlencode({"url": final, "entriesLimit": 0}), req.token)
            if cached.get("feed", {}).get("type") == "feed":
                cached_id = str(cached["feed"]["id"])
        except Exception:
            pass
        return {"identity": "feed:" + clean_url(final), "provider": "rsshub" if "rsshub" in urlsplit(final).hostname.lower() or req.url.startswith("rsshub://") else "rss",
                "url": raw, "feed_url": final, "folo_id": cached_id, "title": parsed["title"]}
    except Exception as exc:
        raise HTTPException(422, str(exc)[:250]) from exc


class PollRequest(BaseModel):
    feed_url: str | None = None
    folo_id: str | None = None
    token: str = ""
    before: str | None = None
    since: str


@app.post("/poll")
def poll(req: PollRequest):
    warning = None
    if req.folo_id:
        try:
            query = {"feedId": req.folo_id, "limit": 100, "withContent": True,
                     "excludePrivate": True}
            if req.before:
                # Folo names the older-page cursor publishedAfter (as used by
                # its official CLI), despite the ordinary meaning of the name.
                query["publishedAfter"] = req.before
            rows = folo_api("/entries", req.token, query)
            entries = []
            for row in rows:
                e = row.get("entries", row)
                if not e.get("url"):
                    continue
                if any(str(a.get("mime_type", "")).startswith(("audio/", "video/")) for a in e.get("attachments") or []):
                    continue
                if (row.get("feeds") or {}).get("type") in ("inbox", "private"):
                    continue
                entries.append({"url": clean_url(e["url"]), "title": e.get("title") or e["url"],
                                "external_id": str(e["id"]), "folo_entry_id": str(e["id"]),
                                "published_at": iso(e.get("publishedAt")), "author": e.get("author"),
                                "content": e.get("content") or e.get("description") or "",
                                "description": e.get("description") or "",
                                "content_is_full": bool(e.get("content") and plain(e["content"]) != plain(e.get("description", "")))})
            dates = [e["published_at"] for e in entries if e["published_at"]]
            oldest = min(dates) if dates else None
            reached = bool(oldest and oldest <= req.since)
            entries = [e for e in entries if not e["published_at"] or e["published_at"] >= req.since]
            return {"entries": entries, "provider": "folo", "next_before": oldest if oldest and len(rows) >= 100 and not reached else None,
                    "coverage": "reached_since" if reached else "available", "warning": None,
                    "auth_error": False, "retry_after": None}
        except Exception as exc:
            warning = str(exc)[:200]
            auth_error = isinstance(exc, UpstreamError) and exc.status == 401
            retry_after = exc.retry_after if isinstance(exc, UpstreamError) else None
    if not req.feed_url:
        raise HTTPException(422, warning or "Folo 来源没有可回退的 RSS 地址")
    try:
        data, _, final = download(feed_address(req.feed_url))
        parsed = parse_feed(data, final)
        entries = [e for e in parsed["entries"] if not e["published_at"] or e["published_at"] >= req.since]
        return {"entries": entries, "provider": "rss", "next_before": None,
                "coverage": "feed_window", "warning": warning,
                "auth_error": locals().get("auth_error", False), "retry_after": locals().get("retry_after")}
    except Exception as exc:
        raise HTTPException(422, str(exc)[:250]) from exc


TRUNCATED = re.compile(r"(?:[.…]{3,}\s*$|…\s*$|continue reading|read (?:the )?full (?:article|story)|阅读全文|阅读原文|余下全文|订阅后阅读|subscribe to (?:continue|read)|sign in to (?:continue|read))", re.I)


def html_body(data: str, url: str):
    text = trafilatura.extract(data, url=url, include_links=True, include_tables=True,
                               include_comments=False, output_format="markdown") or plain(data)
    return text.strip()


def document(data: bytes, ctype: str, url: str):
    if "pdf" in ctype.lower() or data.startswith(b"%PDF-"):
        with pymupdf.open(stream=data, filetype="pdf") as pdf:
            if pdf.is_encrypted:
                raise ValueError("PDF 需要密码")
            if len(pdf) > 500:
                raise ValueError("PDF 超过 500 页处理上限")
            pages = [{"page": i + 1, "text": page.get_text(sort=True).strip()} for i, page in enumerate(pdf)]
        text = "\n\n".join(f"## 第 {p['page']} 页\n\n{p['text']}" for p in pages)
        missing = any(len(p["text"]) < 30 for p in pages)
        if sum(len(p["text"]) for p in pages) < 100:
            raise ValueError("PDF 没有可提取的文字，暂不支持扫描件 OCR")
        return text, "partial" if missing else "full", "pdf"
    # BeautifulSoup handles declared encodings, including GB18030 feeds/sites.
    html = str(BeautifulSoup(data, "html.parser"))
    text = trafilatura.extract(html, url=url, include_links=True, include_tables=True,
                               include_comments=False, output_format="markdown") or ""
    if re.search(r"(?:just a moment|verify (?:that )?you are human|checking your browser|access denied|enable javascript and cookies)", text[:1000], re.I):
        raise ValueError("原站需要浏览器验证，未获取到正文")
    if len(text) < 30:
        raise ValueError("网页未提供可提取的正文")
    return text, "partial" if TRUNCATED.search(text) else "full", "web"


class ExtractRequest(BaseModel):
    url: str
    content: str = Field(default="", max_length=MAX_TEXT)
    content_is_full: bool = False
    folo_entry_id: str | None = None
    token: str = ""


@app.post("/extract")
def extract(req: ExtractRequest):
    seed = html_body(req.content, req.url) if req.content else ""
    text, completeness, method = seed, "partial" if seed else "missing", "feed"
    errors = []
    # An explicit content field is a useful completeness signal unless it advertises
    # truncation. Short news can be complete; descriptions remain excerpts.
    if req.content_is_full and seed and BeautifulSoup(req.content, "html.parser").find(["p", "h1", "h2", "h3", "ul", "ol", "pre", "table", "article"]) and not TRUNCATED.search(seed):
        completeness = "full"
    # Try original pages for uncertain excerpts, including short descriptions.
    if req.folo_entry_id and completeness != "full":
        try:
            data = folo_api("/entries/readability?" + urlencode({"id": req.folo_entry_id}), req.token)
            candidate = html_body((data or {}).get("content", ""), req.url)
            if len(candidate) >= max(60, len(seed)) and not TRUNCATED.search(candidate):
                text, completeness, method = candidate, "full", "folo_readability"
        except Exception as exc:
            errors.append(str(exc)[:160])
    report_url = None
    if req.content:
        for a in BeautifulSoup(req.content, "html.parser").select("a[href]"):
            href = urljoin(req.url, a["href"])
            if urlsplit(href).path.lower().endswith(".pdf") and re.search(r"full report|download (?:the )?report|english pdf|全文报告|完整报告|报告全文|pdf version", a.get_text(" ", strip=True), re.I):
                report_url = href
                break
    if completeness != "full" or report_url or urlsplit(req.url).path.lower().endswith(".pdf"):
        try:
            raw, ctype, final = download(report_url or req.url)
            candidate, quality, kind = document(raw, ctype, final)
            if quality == "full" or len(candidate) > len(text):
                text, completeness, method = candidate, quality, kind
            # Explicit report link only, not every attachment on the page.
            if kind == "web":
                soup = BeautifulSoup(raw, "html.parser")
                for a in soup.select("a[href]"):
                    href = urljoin(final, a["href"])
                    if urlsplit(href).path.lower().endswith(".pdf") and re.search(r"full report|download (?:the )?report|english pdf|全文报告|完整报告|报告全文|pdf version", a.get_text(" ", strip=True), re.I):
                        try:
                            pdf, pct, purl = download(href)
                            body, quality, _ = document(pdf, pct, purl)
                            text, completeness, method = body, quality, "pdf"
                            final = purl
                        except Exception as exc:
                            errors.append(str(exc)[:160])
                            completeness = "partial"
                        break
        except Exception as exc:
            errors.append(str(exc)[:160])
            if report_url:
                completeness = "partial"
    canonical_url = req.url
    if "raw" in locals() and locals().get("kind") == "web" and completeness == "full":
        canonical_url = final
        tag = BeautifulSoup(raw, "html.parser").find("link", rel="canonical")
        if tag and tag.get("href"):
            try:
                candidate_url = clean_url(urljoin(final, tag["href"]))
                if urlsplit(candidate_url).hostname == urlsplit(final).hostname and candidate_url != clean_url(final):
                    check, ctype2, verified_url = download(candidate_url)
                    check_text, check_quality, _ = document(check, ctype2, verified_url)
                    normalize = lambda value: re.sub(r"\s+", " ", value).strip()
                    if check_quality == "full" and normalize(check_text) == normalize(text):
                        canonical_url = verified_url
            except Exception:
                pass
    if len(text) > MAX_TEXT:
        # Never summarize a silently truncated document as complete.
        text, completeness = text[:MAX_TEXT], "partial"
        errors.append("正文超过处理上限，仅保存可处理部分")
    words = len(re.findall(r"[\u3400-\u9fff]|\b[\w'-]+\b", text))
    # A webpage that extraction cannot identify is never silently promoted to full.
    paragraphs = [{"id": i + 1, "text": t.strip()} for i, t in enumerate(re.split(r"\n\s*\n", text)) if t.strip()]
    return {"text": text, "paragraphs": paragraphs, "completeness": completeness, "method": method,
            "word_count": words, "source_url": locals().get("final", req.url), "canonical_url": canonical_url,
            "warning": "; ".join(errors) or None,
            "snapshot": raw.decode("utf-8", errors="replace")[:MAX_TEXT] if "raw" in locals() and "pdf" not in locals().get("ctype", "") else None}


@app.get("/health")
def health():
    return {"status": "ok", "service": "rss"}


@app.post("/subscriptions")
def subscriptions(req: SourceRequest):
    try:
        data = folo_api("/subscriptions?view=0", req.token)
        rows = data.get("subscriptions", []) if isinstance(data, dict) else data
        sources, skipped = [], 0
        for row in rows:
            feed = row.get("feeds") or {}
            if row.get("view") != 0 or row.get("isPrivate") or feed.get("isPrivate") or feed.get("type") != "feed" or not feed.get("url"):
                skipped += 1
                continue
            try:
                address = public_url(feed_address(feed["url"]))
                sources.append({"identity": "feed:" + clean_url(address), "provider": "folo",
                                "url": "https://app.folo.is/feed/" + str(feed["id"]),
                                "feed_url": address, "folo_id": str(feed["id"]),
                                "title": row.get("title") or feed.get("title") or address,
                                "category": row.get("category") or ""})
            except ValueError:
                skipped += 1
        return {"sources": sources, "skipped": skipped}
    except Exception as exc:
        raise HTTPException(422, "Folo 需要重新连接或暂时不可用") from exc


class OpmlRequest(BaseModel):
    text: str = Field(max_length=2_000_000)

@app.post("/opml")
def opml(req: OpmlRequest):
    if "<!DOCTYPE" in req.text.upper() or "<!ENTITY" in req.text.upper():
        raise HTTPException(422, "OPML 不允许外部实体")
    try:
        root = ET.fromstring(req.text)
        sources, skipped = [], 0
        def visit(node, category=""):
            nonlocal skipped
            for child in node:
                raw = child.attrib.get("xmlUrl")
                title = child.attrib.get("title") or child.attrib.get("text") or raw or ""
                if raw:
                    try:
                        address = public_url(feed_address(raw))
                        sources.append({"identity": "feed:" + clean_url(address), "provider": "rsshub" if raw.startswith("rsshub://") else "rss",
                                        "url": address, "feed_url": address, "folo_id": None, "title": title, "category": category})
                    except ValueError:
                        skipped += 1
                visit(child, title if not raw and child.tag == "outline" else category)
        visit(root)
        return {"sources": sources[:1000], "skipped": skipped + max(0, len(sources)-1000)}
    except ET.ParseError as exc:
        raise HTTPException(422, "OPML 文件格式不正确") from exc


class SearchRequest(BaseModel):
    provider: str
    q: str = Field(min_length=1, max_length=100)
    token: str = ""


@app.post("/source-search")
def source_search(req: SearchRequest):
    """Bounded search fallback; no caller-supplied URL, headers or redirects."""
    urls = {
        "youtube": "https://www.youtube.com/results?" + urlencode({"search_query": req.q, "sp": "EgIQAg=="}),
        "bilibili": "https://api.bilibili.com/x/web-interface/search/type?" + urlencode({"search_type": "bili_user", "keyword": req.q, "page": 1}),
        "apple_podcast": "https://itunes.apple.com/search?" + urlencode({"term": req.q, "entity": "podcast", "limit": 10}),
        "folo": FOLO + "/discover",
    }
    if req.provider not in urls:
        raise HTTPException(400, "未知搜索平台")
    headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "Accept-Encoding": "identity"}
    if req.provider == "bilibili":
        headers.update({"Referer": "https://search.bilibili.com/", "Cookie": "buvid3=" + str(uuid.uuid4()).upper() + "infoc;"})
    method, payload = "GET", None
    if req.provider == "folo":
        if not req.token:
            raise HTTPException(503, "Folo 搜索尚未连接")
        headers.update({"Content-Type": "application/json", "Authorization": "Bearer " + req.token,
                        "Cookie": "__Secure-better-auth.session_token=" + req.token + "; better-auth.session_token=" + req.token})
        method, payload = "POST", json.dumps({"keyword": req.q, "target": "feeds"}).encode()
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    try:
        # One bounded request, no redirects and no upstream account cookies.
        opener = urllib.request.build_opener(NoRedirect())
        request = urllib.request.Request(urls[req.provider], data=payload, headers=headers, method=method)
        with opener.open(request, timeout=7) as response:
            if response.status != 200:
                raise ValueError("搜索平台暂时不可用")
            data = response.read(4_000_001)
            if len(data) > 4_000_000:
                raise ValueError("搜索结果超过上限")
            return {"body": data.decode("utf-8")}

    except Exception as exc:
        raise HTTPException(502, "搜索平台暂时不可用") from exc


def is_media_entry(entry):
    for attachment in (entry.get("media") or []) + (entry.get("attachments") or []):
        if re.match(r"^(audio|video)(/|$)", attachment.get("type") or attachment.get("mime_type") or ""):
            return True
    return False


@app.post("/source-inspect")
def source_inspect(req: SourceRequest):
    """Public-feed classification on follow, never from client-supplied types."""
    resolved = resolve(req)
    if resolved.get("choices"):
        raise HTTPException(409, "请选择具体的公开 feed")
    address = resolved.get("feed_url")
    if not address:
        raise HTTPException(422, "来源没有公开 feed")
    try:
        data, _, final = download(address)
        parsed = feedparser.parse(data)
        if not parsed.version:
            raise ValueError("来源未返回有效 feed")
        media = any(any(str(enc.get("type", "")).startswith(("audio/", "video/"))
                        for enc in e.get("enclosures", [])) for e in parsed.entries)
        # Empty podcast feeds still declare the iTunes podcast namespace.
        media = media or any("itunes" in key for key in parsed.namespaces)
    except Exception:
        if not resolved.get("folo_id"):
            raise HTTPException(422, "无法验证公开 feed，请稍后重试")
        cached = folo_api("/feeds?" + urlencode({"id": resolved["folo_id"], "entriesLimit": 1}), req.token)
        media = any(is_media_entry(e.get("entries", e)) for e in cached.get("entries", []))
        # Named video/podcast routes must never fall into the article pipeline.
        media = media or bool(re.search(r"/(?:xiaoyuzhou/podcast|youtube/channel|bilibili/user)/", address))
        if media:
            # Verify the fallback actually provides pollable media entries.
            media_feed(SourceRequest(url="https://app.folo.is/feed/" + resolved["folo_id"], token=req.token))
    return {**resolved, "kind": "media" if media else "article"}


@app.post("/media-feed")
def media_feed(req: SourceRequest):
    """Read public cached podcast entries when an RSSHub origin is unavailable."""
    address = public_url(req.url)
    fid = folo_id(address)
    lookups = [{"id": fid}] if fid else [{"url": address}]
    parts = urlsplit(address)
    if not fid and ("rsshub" in (parts.hostname or "") or parts.netloc == urlsplit(RSSHUB).netloc):
        lookups.append({"url": "rsshub://" + parts.path.lstrip("/") + ("?" + parts.query if parts.query else "")})
    for lookup in lookups:
        try:
            data = folo_api("/feeds?" + urlencode({**lookup, "entriesLimit": 10}), req.token)
        except Exception:
            continue
        feed = data.get("feed") or {}
        if feed.get("isPrivate"):
            raise HTTPException(422, "不支持私有来源")
        rows = []
        for record in data.get("entries", []):
            e = record.get("entries", record)
            attachment = next((m for m in (e.get("media") or []) + (e.get("attachments") or [])
                               if re.match(r"^audio(/|$)", m.get("type") or m.get("mime_type") or "")), {})
            audio = attachment.get("url")
            link = e.get("url")
            if not audio and not (link and re.match(r"https://(?:www\.)?xiaoyuzhoufm.com/episode/[a-f0-9]+", link)):
                continue
            rows.append({"title": e.get("title"), "link": public_url(link) if link else None,
                         "guid": str(e.get("id", link)), "published": iso(e.get("publishedAt")),
                         "audio": public_url(audio) if audio else None, "duration_s": attachment.get("duration_in_seconds")})
        if rows:
            return {"title": feed.get("title"), "entries": rows}
    raise HTTPException(422, "来源没有可轮询的公开播客内容")
