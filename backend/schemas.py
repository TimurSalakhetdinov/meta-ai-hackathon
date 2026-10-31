"""Pydantic v2 schemas shared by the config service, telemetry sink and agents.

Field names are binding: they match docs/architecture.md and docs/video-script.md.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, create_model, field_validator

StepId = Literal["onb_01_shelter", "onb_02_forager", "onb_03_handoff", "free_play"]
Salience = Literal["low", "medium", "high_pulse"]
PatchStatus = Literal["proposed", "invalid", "validated", "approved", "rejected"]
ProviderMode = Literal["human", "stub", "open_weights", "meta"]

ONBOARDING_STEPS: tuple[str, ...] = ("onb_01_shelter", "onb_02_forager", "onb_03_handoff")
ALL_STEPS: tuple[str, ...] = (*ONBOARDING_STEPS, "free_play")


FEATURE_RESOURCES: tuple[str, ...] = ("wood", "food", "stone", "rp", "score")


class FeaturePlugin(BaseModel):
    """A new feature a PM proposes, carried by a config patch and rendered as one HUD action card."""

    model_config = ConfigDict(extra="forbid")

    feature_id: str = Field(pattern=r"^[a-z0-9_]{2,40}$")
    title: str = Field(min_length=1, max_length=60)
    icon: str = "\u2694\ufe0f"
    # Muse Image emblem under /static/assets/generated/; the emoji icon is the fallback.
    icon_url: Optional[str] = Field(None, pattern=r"^/static/assets/generated/[a-z0-9_]{2,40}\.png$")
    visual_prompt: str = ""
    description: str = ""
    unlock_at_step: StepId = "free_play"
    button_salience: Salience = "high_pulse"
    action_type: Literal["encounter_modal", "instant_trade", "festival_buff"] = "encounter_modal"
    costs: dict[str, int] = Field(default_factory=dict)
    rewards: dict[str, int] = Field(default_factory=dict)
    cooldown_sec: float = Field(12.0, ge=2.0, le=120.0)
    advisor_intro: str = ""

    @field_validator("costs", "rewards")
    @classmethod
    def _known_resources(cls, v: dict[str, int]) -> dict[str, int]:
        for res, amount in v.items():
            if res not in FEATURE_RESOURCES:
                raise ValueError(f"unknown resource {res!r}; use one of {FEATURE_RESOURCES}")
            if not 0 <= amount <= 500:
                raise ValueError(f"{res} amount {amount} is outside 0..500")
        return v


class GameConfig(BaseModel):
    """Full game config. The base config and every merged variant validate against this."""

    model_config = ConfigDict(extra="forbid")

    # 1. Economy
    starting_wood: int = Field(60, ge=0, le=500)
    starting_food: int = Field(40, ge=0, le=500)
    starting_stone: int = Field(0, ge=0, le=500)
    starting_workers: int = Field(2, ge=1, le=20)
    shelter_wood_cost: int = Field(20, ge=5, le=200)
    shelter_pop_gain: int = Field(2, ge=1, le=10)
    forager_wood_cost: int = Field(20, ge=5, le=200)
    forager_food_yield: int = Field(15, ge=5, le=100)
    optional_woodcutter_cost: int = Field(30, ge=5, le=200)
    optional_woodcutter_food_cost: int = Field(0, ge=0, le=200)
    woodcutter_wood_yield: int = Field(15, ge=5, le=100)
    quarry_wood_cost: int = Field(35, ge=5, le=200)
    quarry_food_cost: int = Field(20, ge=0, le=200)
    quarry_stone_yield: int = Field(15, ge=5, le=100)
    monument_wood_cost: int = Field(40, ge=5, le=300)
    monument_stone_cost: int = Field(25, ge=0, le=300)
    research_toolmaking_wood_cost: int = Field(30, ge=5, le=200)
    research_woodworking_food_cost: int = Field(25, ge=5, le=200)
    research_baskets_food_cost: int = Field(25, ge=5, le=200)
    research_masonry_wood_cost: int = Field(35, ge=5, le=200)
    research_stone_age_food_cost: int = Field(50, ge=10, le=300)
    research_stone_age_stone_cost: int = Field(20, ge=0, le=300)
    research_tier2_rp_cost: int = Field(5, ge=0, le=100)
    research_stone_age_rp_cost: int = Field(10, ge=0, le=200)
    research_tent_rp_per_min: float = Field(20.0, ge=0.0, le=120.0)
    worker_required_per_building: int = Field(1, ge=0, le=5)
    granary_wood_cost: int = Field(40, ge=5, le=300)
    granary_food_cost: int = Field(30, ge=0, le=300)
    smelter_wood_cost: int = Field(40, ge=5, le=300)
    smelter_stone_cost: int = Field(20, ge=0, le=300)
    smelter_stone_yield: int = Field(20, ge=5, le=100)
    research_irrigation_food_cost: int = Field(40, ge=5, le=300)
    research_irrigation_stone_cost: int = Field(15, ge=0, le=300)
    research_tier3_rp_cost: int = Field(15, ge=0, le=200)
    research_bronze_age_food_cost: int = Field(80, ge=10, le=500)
    research_bronze_age_wood_cost: int = Field(60, ge=0, le=500)
    research_bronze_age_stone_cost: int = Field(50, ge=0, le=500)
    research_bronze_age_rp_cost: int = Field(25, ge=0, le=300)
    # Each upgrade level costs the base build cost times multiplier ** current level.
    upgrade_cost_multiplier: float = Field(1.5, ge=1.0, le=5.0)
    # 2. Tutorial steps and locks
    # Optional builds (Woodcutter Hut) stay locked until this step is completed. null = no lock.
    lock_optional_builds_until_step: Optional[StepId] = None
    show_worker_warnings: bool = True
    auto_close_research_on_unlock: bool = False
    clear_selection_on_harvest: bool = True
    auto_claim_quest_rewards: bool = False
    # Expedition map unlocks when this step is entered. null = feature disabled.
    unlock_expedition_at_step: Optional[StepId] = "free_play"
    expedition_wood_cost: int = Field(0, ge=0, le=200)
    expedition_food_cost: int = Field(20, ge=0, le=200)
    # 3. UI salience
    research_button_salience: Salience = "low"
    build_button_scale: float = Field(1.0, ge=0.8, le=1.5)
    # 4. Pacing
    idle_hint_delay_sec: float = Field(15.0, ge=1.0, le=60.0)
    build_time_sec: float = Field(2.0, ge=0.5, le=15.0)
    forager_cycle_sec: float = Field(12.0, ge=1.0, le=30.0)
    woodcutter_cycle_sec: float = Field(20.0, ge=1.0, le=30.0)
    quarry_cycle_sec: float = Field(15.0, ge=1.0, le=30.0)
    smelter_cycle_sec: float = Field(20.0, ge=1.0, le=60.0)
    first_achievement_target_score: int = Field(100, ge=50, le=500)
    bronze_achievement_target_score: int = Field(220, ge=100, le=1000)
    bronze_unlock_min_sim_sec: float = Field(1200.0, ge=0, le=3600)
    hero_training_sec: float = Field(20.0, ge=1.0, le=300.0)
    # One PM feature from the feature studio. null = no feature.
    feature_plugin: Optional[FeaturePlugin] = None


def _make_patch_model() -> type[BaseModel]:
    fields: dict[str, Any] = {}
    for name, info in GameConfig.model_fields.items():
        # Same constraints, but every key is optional and defaults to "unset".
        fields[name] = (Optional[info.annotation], Field(None, **_constraints(info)))
    return create_model(
        "GameConfigPatch",
        __config__=ConfigDict(extra="forbid"),
        __doc__="Flat partial GameConfig. Omitted keys stay unchanged; explicit null is a real value.",
        **fields,
    )


def _constraints(info: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for meta in info.metadata:
        for attr in ("ge", "le", "gt", "lt"):
            value = getattr(meta, attr, None)
            if value is not None:
                out[attr] = value
    return out


GameConfigPatch = _make_patch_model()


class PatchRecord(BaseModel):
    """A patch file in configs/patches/: body plus lifecycle metadata."""

    model_config = ConfigDict(extra="forbid")

    patch_id: str = Field(pattern=r"^patch_[0-9]{3,}(?:_[a-z0-9]+)*$")
    status: PatchStatus = "proposed"
    created_by: Literal["designer_agent", "human"] = "designer_agent"
    created_at: str
    title: str = ""
    rationale: str = ""
    target_step: Optional[StepId] = None
    # Feature studio patches carry the approved patch whose levers they build on.
    baseline_patch_id: Optional[str] = None
    body: dict[str, Any]


class AuditEntry(BaseModel):
    timestamp_iso: str
    patch_id: str
    from_state: Optional[PatchStatus]
    to_state: PatchStatus
    actor: Literal["designer_agent", "validator", "human"]
    diff: dict[str, Any]
    base_config_sha256: str
    note: str = ""


class AnalysisConfig(BaseModel):
    """Fixed, versioned stuck rule. Not part of GameConfig, so patches cannot change measurement."""

    model_config = ConfigDict(extra="forbid")

    analysis_version: str = "v1"
    stuck_idle_sim_sec: float = Field(30.0, gt=0)
    stuck_rejected_streak: int = Field(3, ge=1)
    stuck_abort_per_step: int = Field(3, ge=1)


EventType = Literal[
    "session_start",
    "step_enter",
    "step_complete",
    "click",
    "action_rejected",
    "hint_shown",
    "achievement",
    "heartbeat",
    "session_end",
    "stuck",
    "quest_claimed",
    "battle_won",
    "battle_lost",
    "hero_unlocked",
    "hero_leveled",
    "territory_expanded",
]


class TelemetryEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    run_id: str = Field(pattern=r"^[A-Za-z0-9_\-]{1,120}$")
    variant_id: Literal["A", "B"] = "A"
    patch_id: Optional[str] = None
    persona_id: Optional[str] = None
    seed: int = 42
    time_scale: float = Field(1.0, ge=0.25, le=8.0)
    provider_mode: ProviderMode = "human"
    wall_ts_ms: int = 0
    sim_elapsed_sec: float = Field(0.0, ge=0)
    step_id: Optional[str] = None
    event_type: EventType
    bot_step_index: Optional[int] = None
    correlation_id: Optional[str] = None
    payload: dict[str, Any] = Field(default_factory=dict)


class BotStepRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    run_id: str = Field(pattern=r"^[A-Za-z0-9_\-]{1,120}$")
    bot_step_index: int = Field(ge=0)
    correlation_id: str
    sim_elapsed_sec: float = 0.0
    provider_mode: ProviderMode = "stub"
    model_id: Optional[str] = None
    model_mode: Optional[Literal["contributor", "standard"]] = None
    vision_mode: Optional[Literal["sam_3_1", "debug_fallback", "stub_targets"]] = None
    frame_phash: Optional[str] = None
    sam_cache_hit: Optional[bool] = None
    sam_marks_count: Optional[int] = None
    sam_latency_ms: Optional[float] = None
    muse_cache_hit: Optional[bool] = None
    muse_latency_ms: Optional[float] = None
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    estimated_cost_usd: Optional[float] = None
    bucket: Optional[str] = None
    persona_id: Optional[str] = None
    observation_summary: str = ""
    thought: str = ""
    chosen_mark_id: Optional[int] = None
    target_id: Optional[str] = None
    target_xy: Optional[tuple[float, float]] = None
    player_mood: Optional[Literal["engaged", "curious", "confused", "frustrated", "bored"]] = "engaged"


class BudgetConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    total_credits_usd: float = 150.0
    global_stop_usd: float = 140.0
    per_session_cap_usd: float = 2.0
    buckets_usd: dict[str, float]
    muse_model_id: str = "muse-spark-1.3-contributor"
    # The designer agent (feature ideas and reworks) uses the stronger model;
    # playtesters and the analyst stay on muse_model_id.
    designer_model_id: str = "muse-wonder-1.0"
    sam_model_id: str = "sam-3.1"
    worker_pool_size: int = Field(5, ge=1, le=8)
    muse_cache_in_experiments: bool = False
    prompt_version: str = "playtester_v1"
    # Pre-call estimate charged against the caps; the real token count settles it afterwards.
    muse_est_input_tokens: int = Field(2600, ge=1)
    muse_max_output_tokens: int = Field(800, ge=1)
    # Per model id: input_per_1m / output_per_1m (tokens) or per_image. null = price unknown.
    pricing_usd: dict[str, Any] = Field(default_factory=dict)


class ExperimentConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    seeds: list[int]
    personas: list[str]
    demo_seed: int = 42
    run_types: dict[str, dict[str, Any]]
    default_speed: float = Field(2.0, ge=1.0, le=4.0)


class Persona(BaseModel):
    model_config = ConfigDict(extra="forbid")

    persona_id: str
    label: str
    # Short archetype badge for the studio, e.g. "Rush-Clicker", with its emblem emoji.
    archetype: str = ""
    emblem: str = ""
    subtitle: str = ""
    # Player-type models the persona draws on (Bartle 1996, BrainHex 2014, Quantic Foundry 2015).
    grounding: list[str] = Field(default_factory=list)
    description: str
    prompt: str
    stub_policy: dict[str, Any] = Field(default_factory=dict)
    # ElevenLabs voice used when the bot speaks its think-aloud in the Studio.
    voice_id: str = ""
    voice_name: str = ""
