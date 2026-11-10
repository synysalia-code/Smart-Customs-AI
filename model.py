"""Smart Customs AI: local, reproducible educational simulator (standard library)."""
from __future__ import annotations
from dataclasses import dataclass, asdict
import heapq
import json
import math
import random
from pathlib import Path

PASS, SCAN, DEEP = "PASS", "SCAN", "DEEP"
ACTIONS = (PASS, SCAN, DEEP)
POLICIES = ("rule", "utility", "q", "all")
MODEL_VERSION = 1


@dataclass(frozen=True)
class Config:
    prior: float = .04
    arrival_gap: float = 4.0
    trucks: int = 80
    primary_tpr: float = .92
    primary_fpr: float = .08
    document_tpr: float = .55
    document_fpr: float = .12
    scan_tpr: float = .97
    scan_fpr: float = .04
    scan_time: float = 3.0
    deep_time: float = 7.0

    def validate(self):
        if not .001 <= self.prior <= .4:
            raise ValueError("Бастапқы тәуекел 0,1–40% аралығында болуы керек.")
        if not .5 <= self.arrival_gap <= 20 or not 10 <= self.trucks <= 500:
            raise ValueError("Ағын аралығы 0,5–20, көлік саны 10–500 болуы керек.")
        for name in ("primary_tpr", "primary_fpr", "document_tpr", "document_fpr", "scan_tpr", "scan_fpr"):
            if not 0 < getattr(self, name) < 1:
                raise ValueError("Сенсор ықтималдығы 0 мен 1 арасында болуы керек.")
        if self.scan_time <= 0 or self.deep_time <= 0:
            raise ValueError("Тексеру уақыты оң болуы керек.")
        return self


def bayes(prior, positive, sensitivity, false_positive):
    a = sensitivity if positive else 1 - sensitivity
    b = false_positive if positive else 1 - false_positive
    return prior * a / (prior * a + (1 - prior) * b)


@dataclass(frozen=True)
class Observation:
    truck_id: int
    primary: bool
    document: bool
    scan: bool | None
    posterior: float
    scan_wait: float
    deep_wait: float
    pressure: int

    def key(self):
        # Belief and load compression: an approximation, not a fully observed MDP.
        risk_edges = (.003, .01, .03, .06, .12, .25, .45, .7, .9)
        risk = sum(self.posterior >= x for x in risk_edges)
        bucket = lambda x: 0 if x < 1 else 1 if x < 10 else 2 if x < 30 else 3
        return f"{risk}:{int(self.scan is not None)}:{bucket(self.scan_wait)}:{bucket(self.deep_wait)}:{min(2, self.pressure // 4)}"

    def valid_actions(self):
        return (PASS, DEEP) if self.scan is not None else ACTIONS


class Terminal:
    """Discrete-event simulator. Only Observation is passed to a policy.

    Exogenous traffic and potential sensor signals are sampled before decisions,
    so policy choices cannot change the held-out traffic for the same seed.
    Ground truth is private simulator state; it is never included in observations.
    """
    def __init__(self, config=Config(), seed=42):
        self.config = config.validate()
        self.seed = int(seed)
        self.time = 0.0
        self.scan_until = self.deep_until = 0.0
        self._events = []
        self._serial = 0
        self._truth = {}
        self._scan_signals = {}
        self._trucks = {}
        self.current = None
        self.done = False
        self.reward = 0.0
        self.logs = []
        self.metrics = dict(completed=0, detected=0, missed=0, legal_deep=0,
                            scanned=0, inspected=0, total_time=0., total_wait=0.)
        rng = random.Random(self.seed)
        arrival = 0.
        cargo = ("Электроника", "Тоқыма", "Азық-түлік", "Қосалқы бөлшектер", "Жиһаз")
        for i in range(1, config.trucks + 1):
            arrival += rng.expovariate(1 / config.arrival_gap)
            truth = rng.random() < config.prior
            self._truth[i] = truth
            primary = rng.random() < (config.primary_tpr if truth else config.primary_fpr)
            doc = rng.random() < (config.document_tpr if truth else config.document_fpr)
            self._scan_signals[i] = rng.random() < (config.scan_tpr if truth else config.scan_fpr)
            self._trucks[i] = dict(id=i, cargo=cargo[(i - 1) % len(cargo)], arrival=arrival,
                                   primary=primary, document=doc, scan=None, status="upcoming",
                                   actions=[], wait=0., start=None, finish=None)
            self._push(arrival, "arrival", i)
        self._advance()

    def _push(self, time, kind, truck_id):
        self._serial += 1
        heapq.heappush(self._events, (time, self._serial, kind, truck_id))

    def _log(self, message, truck_id):
        self.logs.append(dict(time=round(self.time, 1), truck_id=truck_id, message=message))
        self.logs = self.logs[-80:]

    def _advance(self):
        self.current = None
        while self._events:
            self.time, _, kind, ident = heapq.heappop(self._events)
            truck = self._trucks[ident]
            if kind in ("arrival", "scan_done"):
                if kind == "scan_done":
                    truck["scan"] = self._scan_signals[ident]
                    self._log("Қосымша сканер нәтижесі: " + ("дабыл" if truck["scan"] else "қалыпты"), ident)
                else:
                    self._log("Көлік терминалға келді", ident)
                truck["status"] = "decision"
                self.current = ident
                return
            truth = self._truth[ident]
            deep = kind == "deep_done"
            truck["status"] = "detected" if deep and truth else "released"
            # A missed violation is visible only in the evaluator, never as a sensor.
            self.metrics["completed"] += 1
            self.metrics["detected"] += int(deep and truth)
            self.metrics["missed"] += int(not deep and truth)
            self.metrics["legal_deep"] += int(deep and not truth)
            self.metrics["total_time"] += self.time - truck["arrival"]
            self.metrics["total_wait"] += truck["wait"]
            self._log("Бұзушылық анықталды" if deep and truth else "Тексеру аяқталды, өткізуге рұқсат" if deep else "Көлік өткізілді", ident)
        self.done = True

    def observe(self):
        if self.current is None:
            return None
        c, t = self.config, self._trucks[self.current]
        p = bayes(c.prior, t["primary"], c.primary_tpr, c.primary_fpr)
        p = bayes(p, t["document"], c.document_tpr, c.document_fpr)
        if t["scan"] is not None:
            p = bayes(p, t["scan"], c.scan_tpr, c.scan_fpr)
        pressure = sum(t["status"] in ("scanning", "inspecting") and t["start"] > self.time for t in self._trucks.values())
        return Observation(t["id"], t["primary"], t["document"], t["scan"], p,
                           max(0., self.scan_until - self.time), max(0., self.deep_until - self.time), pressure)

    def step(self, action):
        obs = self.observe()
        if obs is None or action not in obs.valid_actions():
            raise ValueError("Бұл күйде әрекет қолжетімсіз.")
        t, c = self._trucks[self.current], self.config
        truth = self._truth[self.current]
        t["actions"].append(action)
        if action == SCAN:
            wait, duration = obs.scan_wait, c.scan_time
            finish = self.time + wait + duration
            self.scan_until = finish
            t["status"] = "scanning"
            self.metrics["scanned"] += 1
            reward = -2 * (wait + duration) - 3
            event = "scan_done"
        elif action == DEEP:
            wait, duration = obs.deep_wait, c.deep_time
            finish = self.time + wait + duration
            self.deep_until = finish
            t["status"] = "inspecting"
            self.metrics["inspected"] += 1
            reward = (120 if truth else 15 - 8) - 2 * (wait + duration)
            event = "deep_done"
        else:
            wait, duration = 0., 1.
            finish = self.time + duration
            t["status"] = "leaving"
            reward = (15 if not truth else -300) - 2 * duration
            event = "pass_done"
        t["start"], t["finish"] = self.time + wait, finish
        t["wait"] += wait
        self.reward += reward
        self._log({PASS: "Өткізу", SCAN: "Қосымша сканерге жіберу", DEEP: "Толық тексеруге жіберу"}[action], self.current)
        self._push(finish, event, self.current)
        self._advance()
        # The learning reward is simulator-only; the live API does not return it.
        return reward, self.observe(), self.done

    def report(self):
        m = dict(self.metrics)
        n = max(1, m["completed"])
        positives = m["detected"] + m["missed"]
        m.update(avg_time=round(m["total_time"] / n, 2), avg_wait=round(m["total_wait"] / n, 2),
                 recall=round(m["detected"] / positives, 4) if positives else None,
                 reward=round(self.reward, 2), elapsed=round(self.time, 2),
                 throughput=round(m["completed"] / max(self.time, 1) * 60, 2))
        return m

    def public_state(self):
        obs = self.observe()
        visible = []
        for t in self._trucks.values():
            if t["status"] == "upcoming":
                continue
            # No truth, pre-sampled scan results, or future traffic is serialized.
            visible.append({k: t[k] for k in ("id", "cargo", "arrival", "primary", "document", "scan", "status", "actions", "wait", "start", "finish")})
        m = self.report()
        # Evaluator-only numbers are withheld until the episode is complete.
        if not self.done:
            for key in ("missed", "recall", "reward"):
                m[key] = None
        return dict(time=round(self.time, 2), seed=self.seed, config=asdict(self.config), done=self.done,
                    current=asdict(obs) if obs else None, trucks=visible, metrics=m, logs=self.logs[-25:])


def utility_values(obs, config):
    p = obs.posterior
    def final_values(p, deep_wait):
        return {PASS: 15 - 315 * p - 2,
                DEEP: 7 + 113 * p - 2 * (deep_wait + config.deep_time)}
    values = final_values(p, obs.deep_wait)
    if obs.scan is None:
        delay = obs.scan_wait + config.scan_time
        prob_alarm = p * config.scan_tpr + (1 - p) * config.scan_fpr
        expected = 0.
        for positive, prob in ((True, prob_alarm), (False, 1 - prob_alarm)):
            posterior = bayes(p, positive, config.scan_tpr, config.scan_fpr)
            expected += prob * max(final_values(posterior, max(0., obs.deep_wait - delay)).values())
        # Future competing arrivals are omitted: this is a one-lookahead baseline.
        values[SCAN] = -2 * delay - 3 + expected
    return values


def choose_action(obs, policy, config, qtable=None):
    values = utility_values(obs, config)
    if policy == "rule":
        return DEEP if obs.primary else PASS, "rule"
    if policy == "all":
        return DEEP, "all"
    if policy == "q" and qtable and obs.key() in qtable:
        q = qtable[obs.key()]
        return max(obs.valid_actions(), key=lambda a: q.get(a, -1e12)), "q"
    return max(obs.valid_actions(), key=lambda a: values[a]), "fallback" if policy == "q" else "utility"


def train(config=Config(), episodes=600, start_seed=10000, progress=None):
    rng, q, visits = random.Random(71821), {}, {}
    rewards = []
    for episode in range(episodes):
        env = Terminal(config, start_seed + episode)
        epsilon = .3 - .27 * episode / max(1, episodes - 1)
        while not env.done:
            obs = env.observe()
            key = obs.key()
            q.setdefault(key, {a: 0. for a in ACTIONS})
            actions = obs.valid_actions()
            action = rng.choice(actions) if rng.random() < epsilon else max(actions, key=lambda a: q[key][a])
            reward, nxt, done = env.step(action)
            count_key = key + ":" + action
            visits[count_key] = visits.get(count_key, 0) + 1
            alpha = max(.035, .45 / math.sqrt(1 + visits[count_key] / 15))
            future = max(q.get(nxt.key(), {}).get(a, 0.) for a in nxt.valid_actions()) if not done else 0.
            q[key][action] += alpha * (reward + .90 * future - q[key][action])
        rewards.append(env.reward / config.trucks)
        if progress and (episode + 1) % 20 == 0:
            progress(episode + 1, episodes)
    return dict(version=MODEL_VERSION, config=asdict(config), episodes=episodes,
                seeds=[start_seed, start_seed + episodes - 1], gamma=.90,
                q=q, states=len(q), learning_curve=[dict(episode=i + 20, reward=round(sum(rewards[i:i+20]) / len(rewards[i:i+20]), 3)) for i in range(0, episodes, 20)])


def evaluate(config, model, episodes=40, start_seed=900000):
    result = {}
    for policy in POLICIES:
        reports, fallbacks, decisions = [], 0, 0
        for seed in range(start_seed, start_seed + episodes):
            env = Terminal(config, seed)
            while not env.done:
                action, source = choose_action(env.observe(), policy, config, model.get("q", {}))
                fallbacks += source == "fallback"
                decisions += 1
                env.step(action)
            reports.append(env.report())
        completed = sum(r["completed"] for r in reports)
        detected = sum(r["detected"] for r in reports)
        missed = sum(r["missed"] for r in reports)
        rewards = [r["reward"] / config.trucks for r in reports]
        mean = sum(rewards) / episodes
        sd = math.sqrt(sum((x - mean) ** 2 for x in rewards) / max(1, episodes - 1))
        result[policy] = dict(completed=completed, detected=detected, missed=missed,
                              recall=detected / (detected + missed) if detected + missed else None,
                              legal_deep=sum(r["legal_deep"] for r in reports),
                              scanned=sum(r["scanned"] for r in reports),
                              avg_time=sum(r["total_time"] for r in reports) / completed,
                              avg_wait=sum(r["total_wait"] for r in reports) / completed,
                              reward_per_truck=mean, reward_ci95=1.96 * sd / math.sqrt(episodes),
                              q_coverage=1 - fallbacks / max(1, decisions))
    return dict(config=asdict(config), episodes=episodes, seeds=[start_seed, start_seed + episodes - 1],
                policies=result, note="Бірдей тәуелсіз ағындар. Сенімділік аралығы — эпизодтар бойынша жуық 95%. Нақты кеден деректері емес.")


def alpha_beta_demo(risk=.324, pruning=True):
    """Separate toy game: preparation MAX -> concealment MIN -> response MAX.
    Concealment is fixed before the final response; not a live inspection model.
    Matrix entries are illustrative, not measured detection probabilities.
    """
    matrix = ((.9, .35, .2), (.6, .95, .25), (.25, .4, .98))
    costs = (10, 18, 7)
    stats = dict(leaves=0, cutoffs=0)
    def search(path, alpha, beta):
        if len(path) == 3:
            stats["leaves"] += 1
            prep, conceal, response = path
            score = risk * 120 * (.3 * matrix[prep][conceal] + .7 * matrix[response][conceal]) - costs[prep] - .6 * costs[response]
            return score, []
        maximizing = len(path) != 1
        best, best_path = (-math.inf if maximizing else math.inf), []
        for move in range(3):
            value, tail = search(path + [move], alpha, beta)
            if (maximizing and value > best) or (not maximizing and value < best):
                best, best_path = value, [move] + tail
            if maximizing:
                alpha = max(alpha, best)
            else:
                beta = min(beta, best)
            if pruning and beta <= alpha:
                stats["cutoffs"] += 1
                break
        return best, best_path
    value, path = search([], -math.inf, math.inf)
    return dict(score=round(value, 5), path=path, risk=risk, matrix=matrix, costs=costs, **stats)


def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)
