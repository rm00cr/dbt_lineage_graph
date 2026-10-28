"""Fuzzy scoring helpers (feature 1.5 / 2.2).

rapidfuzz is a declared dependency; the difflib fallback keeps the module importable in a
bare interpreter (e.g. when someone runs the loader without installing the extras).
Scores are normalised to 0.0 … 1.0.
"""

from __future__ import annotations

try:  # pragma: no cover - exercised implicitly by whichever branch is installed
    from rapidfuzz import fuzz

    def _ratio(a: str, b: str) -> float:
        return fuzz.ratio(a, b) / 100.0

    def _partial(a: str, b: str) -> float:
        return fuzz.partial_ratio(a, b) / 100.0

    BACKEND = "rapidfuzz"
except ModuleNotFoundError:  # pragma: no cover
    from difflib import SequenceMatcher

    def _ratio(a: str, b: str) -> float:
        return SequenceMatcher(None, a, b).ratio()

    def _partial(a: str, b: str) -> float:
        if not a or not b:
            return 0.0
        window = len(a)
        if window >= len(b):
            return _ratio(a, b)
        return max(_ratio(a, b[i : i + window]) for i in range(len(b) - window + 1))

    BACKEND = "difflib"


def score_name(query: str, candidate: str) -> float:
    """Typo-tolerant score of `query` against a short identifier."""
    if not query or not candidate:
        return 0.0

    q = query.strip().lower()
    c = candidate.strip().lower()

    if q == c:
        return 1.0
    if c.startswith(q):
        return 0.97
    if q in c:
        # the shorter the remainder, the better the hit
        return 0.90 - min(0.15, (len(c) - len(q)) / max(len(c), 1) * 0.15)

    # fuzzy: full-string similarity, plus partial for queries shorter than the candidate
    best = max(_ratio(q, c), _partial(q, c) * 0.95)

    # reward matches on word boundaries: int_mfp_contracts -> "contracts"
    parts = [p for p in c.replace(".", "_").split("_") if p]
    for part in parts:
        if part.startswith(q):
            best = max(best, 0.88)
        else:
            best = max(best, _ratio(q, part) * 0.85)

    return min(best, 0.96)


def score_substring(query: str, haystack: str) -> float:
    """Score for longer free text (descriptions)."""
    if not query or not haystack:
        return 0.0
    q = query.strip().lower()
    h = haystack.strip().lower()
    if q in h:
        return 0.85
    return _partial(q, h) * 0.8
