import pytest
from pydantic import ValidationError

from backend.config_service import ConfigService
from backend.schemas import GameConfig, GameConfigPatch


@pytest.fixture
def base(configs_dir) -> GameConfig:
    return ConfigService(configs_dir).base_config()


def test_omitted_keys_unchanged(base):
    merged = ConfigService.merge(base, {"starting_wood": 120})
    assert merged.starting_wood == 120
    for key, value in base.model_dump().items():
        if key != "starting_wood":
            assert getattr(merged, key) == value


def test_explicit_null_is_kept(base):
    locked = ConfigService.merge(base, {"lock_optional_builds_until_step": "onb_03_handoff"})
    assert locked.lock_optional_builds_until_step == "onb_03_handoff"
    unlocked = ConfigService.merge(locked, {"lock_optional_builds_until_step": None})
    assert unlocked.lock_optional_builds_until_step is None


def test_null_on_non_nullable_field_fails_merged_validation(base):
    with pytest.raises(ValidationError):
        ConfigService.merge(base, {"starting_wood": None})


def test_unknown_keys_rejected(base):
    with pytest.raises(ValidationError):
        GameConfigPatch.model_validate({"starting_gold": 10})
    with pytest.raises(ValidationError):
        ConfigService.merge(base, {"starting_gold": 10})


@pytest.mark.parametrize("patch", [
    {"starting_wood": -1},
    {"starting_wood": 501},
    {"idle_hint_delay_sec": 0.5},
    {"research_button_salience": "neon"},
    {"lock_optional_builds_until_step": "onb_99"},
    {"build_button_scale": 2.0},
])
def test_field_ranges_enforced(base, patch):
    with pytest.raises(ValidationError):
        ConfigService.merge(base, patch)


def test_base_config_has_planted_friction(base):
    assert base.lock_optional_builds_until_step is None
    assert base.research_button_salience == "low"
    # Shelter + forager + woodcutter leave less wood than Basic Toolmaking needs.
    left = base.starting_wood - base.shelter_wood_cost - base.forager_wood_cost - base.optional_woodcutter_cost
    assert left < base.research_toolmaking_wood_cost
    # Without the woodcutter, the handoff is affordable.
    assert base.starting_wood - base.shelter_wood_cost - base.forager_wood_cost >= base.research_toolmaking_wood_cost


def test_patch_001_is_valid_and_touches_the_four_levers(configs_dir):
    svc = ConfigService(configs_dir)
    record = svc.load_patch("patch_001")
    report = svc.validation_report(record)
    assert report["valid"]
    assert set(report["diff"]) == {"starting_wood", "lock_optional_builds_until_step",
                                   "research_button_salience", "idle_hint_delay_sec"}
