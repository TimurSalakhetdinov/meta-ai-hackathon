"""SAM 3 Responses grammar: boxes parse out of the streamed output_text lane."""
from backend.meta_client import MetaClient


def test_boxes_from_sam_text_inclusive_corners_and_confidence():
    text = ("<0f>1<|box;x1=10;y1=20;x2=14;y2=24;w=100;h=80;c=0.75|><|mask;x=0;y=0;data=5,5,x|>,"
            "2<|box;x1=0;y1=0;x2=9;y2=9;w=100;h=80|><|mask;x=0;y=0;data=5,5,y|>")
    boxes = MetaClient._boxes_from_sam_text(text, ["btn_research", "card_shelter"])
    # The protocol reports each object under the id the request gave it.
    assert boxes == [{"bbox": [10, 20, 5, 5], "score": 0.75, "target_id": "btn_research"},
                     {"bbox": [0, 0, 10, 10], "score": 1.0, "target_id": "card_shelter"}]


def test_boxes_from_sam_text_empty_lane_is_no_boxes():
    assert MetaClient._boxes_from_sam_text("") == []
    assert MetaClient._boxes_from_sam_text("no tokens here") == []
