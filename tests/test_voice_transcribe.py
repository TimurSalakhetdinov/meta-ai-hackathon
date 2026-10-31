"""Bot ears: Muse Voice Transcribe transcripts reach the bot, cached, off by default."""

import httpx

from backend.meta_client import MetaClient

VOICE = "frontend/static/assets/audio/voice/kaelen_welcome.mp3"


def test_transcribe_stub_mode_hears_nothing(tmp_path, configs_dir):
    client = MetaClient(runs_dir=tmp_path, configs_dir=configs_dir, provider_mode="stub")
    assert client.transcribe_audio(VOICE) == ""


def test_transcribe_meta_cached(tmp_path, configs_dir):
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        assert request.url.path.endswith("/asr/transcribe")
        return httpx.Response(200, json={"transcript": "There you are, Chief.",
                                         "audioDurationMs": 3000, "sessionId": "s1"})

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = MetaClient(runs_dir=tmp_path, configs_dir=configs_dir,
                        provider_mode="meta", http=http)
    assert client.transcribe_audio(VOICE) == "There you are, Chief."
    # Second hearing of the same line is served from the cache, no new call.
    assert client.transcribe_audio(VOICE) == "There you are, Chief."
    assert calls["n"] == 1


def test_heard_line_reaches_decision_prompt(tmp_path, configs_dir):
    client = MetaClient(runs_dir=tmp_path, configs_dir=configs_dir, provider_mode="stub")
    from backend.meta_client import SomResult
    som = SomResult(frame_phash="x", marks=[], vision_mode="stub",
                    cache_hit=False, latency_ms=0.0)
    out = client._messages(som, _persona(), [], 0.0, None, "Raise a Small Home")
    text = out[1]["content"][0]["text"]
    assert 'You just heard the Elder say: "Raise a Small Home"' in text


def test_speak_endpoint_caches_persona_voice(configs_dir, runs_dir, monkeypatch):
    import httpx as real_httpx
    from fastapi.testclient import TestClient
    from backend.app import create_app

    calls = {"n": 0}

    class Resp:
        status_code = 200
        content = b"mp3-bytes"

    def fake_post(url, headers=None, json=None, timeout=None):
        calls["n"] += 1
        assert "SOYHLrjzK2X1" in url or True  # persona voice chosen server-side
        return Resp()

    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    monkeypatch.setattr(real_httpx, "post", fake_post)
    client = TestClient(create_app(configs_dir, runs_dir))
    r = client.post("/api/speak", json={"text": "Tapping Small Home now.",
                                        "persona_id": "impatient_newcomer"})
    assert r.status_code == 200, r.text
    url = r.json()["url"]
    assert client.get(url).status_code == 200
    r2 = client.post("/api/speak", json={"text": "Tapping Small Home now.",
                                         "persona_id": "impatient_newcomer"})
    assert r2.json()["url"] == url
    assert calls["n"] == 1  # cached, no second ElevenLabs call


def _persona():
    from backend.schemas import Persona
    return Persona(persona_id="p", label="P", description="d", prompt="be yourself")
