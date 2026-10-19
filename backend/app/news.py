"""Fetch local news RSS feeds per city and detect potential 'big events'.

This is intentionally dependency-free: we parse RSS/Atom with the stdlib
`xml.etree.ElementTree` rather than pulling in feedparser. For each city we
scan recent headlines for keywords that typically correlate with elevated
urban noise (concerts, matches, protests, fireworks, roadworks, ...) and emit
a structured event with a rough dB-impact weight the ML model can use.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Dict, List
from xml.etree import ElementTree as ET

import httpx

from . import config

logger = logging.getLogger("noise.news")


def _strip_html(text: str) -> str:
    return re.sub(r"<[^>]+>", " ", text or "").strip()


def classify(title: str) -> tuple[str, float]:
    """Return (category, impact) for a headline, or ("", 0.0) if not an event.

    Keywords are matched on word boundaries (so "march" does not match
    "marché" and "game" does not match "endgame"). When several keywords
    match, the strongest (highest impact) wins.
    """
    low = (title or "").lower()
    best_cat, best_impact = "", 0.0
    for kw, impact in config.EVENT_KEYWORDS.items():
        # \b around the (possibly multi-word) keyword; escape regex chars.
        if re.search(r"\b" + re.escape(kw) + r"\b", low) and impact > best_impact:
            best_cat, best_impact = kw, impact
    return best_cat, best_impact


def _parse_feed(xml_text: str) -> List[Dict[str, str]]:
    """Parse RSS 2.0 or Atom into a list of {title, link} dicts."""
    items: List[Dict[str, str]] = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return items

    # RSS 2.0: channel/item/{title,link}
    for item in root.iter("item"):
        title = item.findtext("title") or ""
        link = item.findtext("link") or ""
        if title:
            items.append({"title": _strip_html(title), "link": link.strip()})

    # Atom: entry/{title, link href}
    if not items:
        ns = {"a": "http://www.w3.org/2005/Atom"}
        for entry in root.iter("{http://www.w3.org/2005/Atom}entry"):
            title = entry.findtext("a:title", default="", namespaces=ns) or ""
            link_el = entry.find("a:link", ns)
            link = link_el.get("href", "") if link_el is not None else ""
            if title:
                items.append({"title": _strip_html(title), "link": link.strip()})
    return items


async def fetch_city_events(city: str) -> List[Dict]:
    """Fetch all configured feeds for a city and return detected events."""
    feeds = config.CITY_NEWS_FEEDS.get(city, [])
    if not feeds:
        return []

    now = datetime.now(timezone.utc).isoformat()
    events: Dict[str, Dict] = {}
    headers = {"User-Agent": config.NEWS_USER_AGENT}

    async with httpx.AsyncClient(timeout=20, headers=headers, follow_redirects=True) as client:
        for url in feeds:
            try:
                resp = await client.get(url)
                resp.raise_for_status()
                parsed = _parse_feed(resp.text)
            except Exception as exc:  # noqa: BLE001 - a bad feed must not break the loop
                logger.debug("News feed failed (%s): %s", url, exc)
                continue

            source = re.sub(r"^https?://(www\.)?", "", url).split("/")[0]
            for row in parsed:
                title = row["title"]
                category, impact = classify(title)
                if impact <= 0:
                    continue
                # Dedup by title; keep the strongest impact.
                existing = events.get(title)
                if existing is None or impact > existing["impact"]:
                    events[title] = {
                        "city": city,
                        "ts": now,
                        "title": title,
                        "source": source,
                        "category": category,
                        "impact": impact,
                        "url": row.get("link", ""),
                    }

    return list(events.values())
