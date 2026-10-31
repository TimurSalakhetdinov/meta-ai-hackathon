"""A Muse reply with no content must become a wait, not a crash."""
from backend.meta_client import parse_decision_json


def test_empty_reply_waits():
    assert parse_decision_json(None)["action"] == "wait"
    assert parse_decision_json("")["action"] == "wait"


def test_json_reply_parses():
    out = parse_decision_json('prose {"action": "click_mark", "mark_id": 2} tail')
    assert out["action"] == "click_mark"
    assert out["mark_id"] == 2
