"""Resolve the real mp3 behind the organizers' audio_url.

audio_url opens an HTML player page; the actual file is a short-lived (≈1 h) signed link in <source src>.
Expose as GET /api/conversations/{id}/audio → {"src": ..., "page": audio_url}; the UI fetches it on demand.
"""
import html
import re
import urllib.request


def resolve_audio(audio_url: str) -> str:
    with urllib.request.urlopen(audio_url, timeout=30) as r:
        page = r.read().decode("utf-8", "replace")
    m = re.search(r'<source[^>]+src="([^"]+)"', page, re.I) or re.search(r'<audio[^>]+src="([^"]+)"', page, re.I)
    if not m:
        raise ValueError("audio source not found")
    return html.unescape(m.group(1))
