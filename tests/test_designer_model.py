"""Model choice: designer and menu-picked bot runs use Muse Wonder,
playtesters and the analyst stay on the default Muse Spark."""

from backend.meta_client import MetaClient, load_budget


def test_designer_and_bot_model_choice(tmp_path, configs_dir):
    budget = load_budget(configs_dir)
    assert budget.designer_model_id == "muse-wonder-1.0"
    assert budget.muse_model_id == "muse-spark-1.3-contributor"

    client = MetaClient(runs_dir=tmp_path, configs_dir=configs_dir, provider_mode="stub")
    assert client.muse_model_id == "muse-spark-1.3-contributor"
    assert client.designer_model_id == "muse-wonder-1.0"

    stub = {"diagnosis": "stub"}
    out = client.reason_json("s", "u", stub_result=stub, model_id=client.designer_model_id)
    assert out is stub

    client.use_model(client.designer_model_id)
    assert client.muse_model_id == "muse-wonder-1.0"
    assert client.muse_cost(1_000_000, 1_000_000, client.designer_model_id) >= 0
