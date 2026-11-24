"""Per-tab transport for the simulator running in a browser worker."""

from dataclasses import asdict
import json
import traceback
from urllib.parse import parse_qs, urlparse

from model import (
    Config,
    POLICIES,
    Terminal,
    alpha_beta_demo,
    choose_action,
    evaluate,
    train,
    utility_values,
)


TRAIN_EPISODES = 600
EVALUATION_EPISODES = 40

env = Terminal()
policy = "utility"
model = None
benchmark = None
job = dict(state="idle", progress=0, total=TRAIN_EPISODES)
pending_config = None


def initialize(model_json, benchmark_json):
    global env, policy, model, benchmark, job, pending_config
    env = Terminal()
    policy = "utility"
    model = json.loads(model_json)
    benchmark = json.loads(benchmark_json)
    job = dict(state="idle", progress=0, total=TRAIN_EPISODES)
    pending_config = None


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def _matching_q():
    if model and model.get("config") == asdict(env.config):
        return model["q"]
    return None


def _snapshot():
    state = env.public_state()
    obs = env.observe()
    q = _matching_q()
    action, source = (
        choose_action(obs, policy, env.config, q) if obs else (None, None)
    )
    state.update(
        policy=policy,
        recommendation=action,
        source=source,
        values=utility_values(obs, env.config) if obs else {},
        q_values=q.get(obs.key()) if q is not None and obs else None,
        job=dict(job),
        benchmark=benchmark,
        model=dict(
            available=q is not None,
            states=model["states"] if model else 0,
            episodes=model["episodes"] if model else 0,
            curve=model.get("learning_curve", []) if model else [],
        ),
    )
    return state


def browser_request(path, payload_json):
    """Apply an API action and return the JSON that the existing UI expects."""
    global env, policy, job, pending_config
    if payload_json is None:
        parsed = urlparse(path)
        if parsed.path == "/api/state":
            return _json(_snapshot())
        if parsed.path == "/api/export":
            return _json(
                dict(simulation=env.public_state(), policy=policy, benchmark=benchmark)
            )
        if parsed.path == "/api/strategy":
            risk = float(parse_qs(parsed.query).get("risk", [".324"])[0])
            if not 0 <= risk <= 1:
                raise ValueError("Тәуекел 0–1 аралығында болуы керек.")
            return _json(
                dict(pruned=alpha_beta_demo(risk), full=alpha_beta_demo(risk, False))
            )
        raise ValueError("Бет табылмады.")

    if len(payload_json.encode("utf-8")) > 4096:
        raise ValueError("Сұрау тым үлкен.")
    data = json.loads(payload_json)
    if not isinstance(data, dict):
        raise ValueError("JSON объектісі қажет.")

    if path == "/api/reset":
        new_policy = data.get("policy", "utility")
        if new_policy not in POLICIES:
            raise ValueError("Агент белгісіз.")
        config = Config(
            prior=float(data.get("prior", .04)),
            arrival_gap=float(data.get("arrival_gap", 4)),
            trucks=int(data.get("trucks", 80)),
        ).validate()
        seed = int(data.get("seed", 42))
        if not 0 <= seed <= 999999999:
            raise ValueError("Seed 0–999999999 аралығында болуы керек.")
        env = Terminal(config, seed)
        policy = new_policy
    elif path == "/api/step":
        if not env.done:
            action = data.get("action")
            if not action:
                action, _ = choose_action(env.observe(), policy, env.config, _matching_q())
            env.step(action)
    elif path == "/api/finish":
        q = _matching_q()
        while not env.done:
            action, _ = choose_action(env.observe(), policy, env.config, q)
            env.step(action)
    elif path == "/api/train":
        if job["state"] in ("training", "evaluating"):
            raise ValueError("Оқыту жүріп жатыр.")
        job = dict(state="training", progress=0, total=TRAIN_EPISODES)
        pending_config = env.config
    else:
        raise ValueError("Әрекет табылмады.")

    return _json(_snapshot())


def run_pending_training(emit_job):
    """Train the scheduled configuration and report progress to the main thread."""
    global model, benchmark, pending_config
    config = pending_config
    if config is None:
        return _json(_snapshot())
    pending_config = None

    def progress(done, total):
        job.update(progress=done, total=total)
        emit_job(_json(job))

    try:
        trained_model = train(config, episodes=TRAIN_EPISODES, progress=progress)
        job["state"] = "evaluating"
        emit_job(_json(job))
        evaluated_model = evaluate(config, trained_model, episodes=EVALUATION_EPISODES)
        model, benchmark = trained_model, evaluated_model
        job.update(state="complete", progress=TRAIN_EPISODES)
    except Exception:
        traceback.print_exc()
        job.update(state="failed", error="Оқыту аяқталмады. Қайта оқытып көріңіз.")
    return _json(_snapshot())
