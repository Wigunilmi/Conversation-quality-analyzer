"""Python facts must match the JS reference (lib/facts.mjs) on every fixture case."""
import json
from pathlib import Path

import pytest

from cqa.facts import extract_facts, facts_text

CASES = json.loads((Path(__file__).resolve().parents[2] / "test" / "fixtures" / "facts.json").read_text())


@pytest.mark.parametrize("i", range(len(CASES)))
def test_facts_parity(i):
    c = CASES[i]
    got = extract_facts(c["conv"])
    assert got == c["facts"], c["conv"]["conversation_id"]
    assert facts_text(got) == c["text"]
