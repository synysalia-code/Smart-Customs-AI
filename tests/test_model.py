import sys
import unittest
from dataclasses import asdict, replace
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from model import Config, Terminal, PASS, SCAN, DEEP, bayes, choose_action, train, evaluate, alpha_beta_demo


class ModelTests(unittest.TestCase):
    def test_bayes_base_rate_and_complement(self):
        self.assertAlmostEqual(bayes(.04, True, .92, .08), .323943661971831, places=12)
        self.assertLess(bayes(.04, False, .92, .08), .04)
        self.assertAlmostEqual(bayes(.04, True, .5, .5), .04)

    def test_no_hidden_data_in_observation_or_live_api(self):
        env = Terminal(seed=12)
        allowed = {"truck_id", "primary", "document", "scan", "posterior", "scan_wait", "deep_wait", "pressure"}
        self.assertEqual(set(asdict(env.observe())), allowed)
        public = env.public_state()
        self.assertIsNone(public["metrics"]["missed"])
        self.assertIsNone(public["metrics"]["reward"])
        for t in public["trucks"]:
            self.assertNotIn("truth", t)
            self.assertIsNone(t["scan"])
        # Changing hidden truth after observations are sampled cannot change policy input.
        before = env.observe()
        for i in env._truth:
            env._truth[i] = not env._truth[i]
        self.assertEqual(before, env.observe())

    def test_scan_is_additional_evidence_and_cannot_repeat(self):
        env = Terminal(Config(trucks=10, arrival_gap=20), seed=5)
        first = env.current
        env.step(SCAN)
        while env.current != first and not env.done:
            env.step(PASS)
        self.assertEqual(env.current, first)
        obs = env.observe()
        self.assertIsInstance(obs.scan, bool)
        self.assertNotIn(SCAN, obs.valid_actions())
        with self.assertRaises(ValueError):
            env.step(SCAN)

    def test_all_inspection_conserves_traffic_and_serial_station(self):
        env = Terminal(Config(trucks=40, arrival_gap=.5), seed=91)
        prior_finish = 0
        while not env.done:
            i = env.current
            env.step(DEEP)
            t = env._trucks[i]
            self.assertGreaterEqual(t["start"], prior_finish)
            self.assertAlmostEqual(t["finish"]-t["start"], env.config.deep_time)
            prior_finish = t["finish"]
        r = env.report()
        self.assertEqual(r["completed"], 40)
        self.assertEqual(r["missed"], 0)
        self.assertEqual(r["detected"], sum(env._truth.values()))
        self.assertEqual(r["legal_deep"] + r["detected"], 40)
        self.assertGreater(r["avg_wait"], 0)

    def test_policies_receive_same_traffic_and_potential_signals(self):
        a, b = Terminal(seed=27), Terminal(seed=27)
        truth, scan = dict(a._truth), dict(a._scan_signals)
        arrivals = [t["arrival"] for t in a._trucks.values()]
        while not a.done:
            a.step(PASS)
        while not b.done:
            b.step(choose_action(b.observe(), "utility", b.config)[0])
        self.assertEqual(truth, b._truth)
        self.assertEqual(scan, b._scan_signals)
        self.assertEqual(arrivals, [t["arrival"] for t in b._trucks.values()])
        self.assertEqual(a.metrics["missed"], b.metrics["missed"]+b.metrics["detected"])

    def test_training_is_deterministic_and_heldout_comparison_is_reproducible(self):
        c = Config(trucks=10)
        a, b = train(c, episodes=4), train(c, episodes=4)
        self.assertEqual(a, b)
        self.assertGreater(a["states"], 0)
        report = evaluate(c, a, episodes=2)
        self.assertGreater(report["seeds"][0], a["seeds"][1])
        self.assertEqual(report, evaluate(c, a, episodes=2))
        totals = {r["detected"]+r["missed"] for r in report["policies"].values()}
        self.assertEqual(len(totals), 1)

    def test_alpha_beta_matches_exhaustive_minimax(self):
        for risk in (0, .04, .324, .7, 1):
            a, b = alpha_beta_demo(risk), alpha_beta_demo(risk, False)
            self.assertEqual(a["score"], b["score"])
            self.assertEqual(a["path"], b["path"])
            self.assertLessEqual(a["leaves"], b["leaves"])
            self.assertEqual(b["leaves"], 27)

    def test_invalid_config_rejected(self):
        for c in (Config(prior=float("nan")), Config(prior=1), Config(trucks=0), Config(arrival_gap=0)):
            with self.assertRaises(ValueError):
                Terminal(c)


if __name__ == "__main__":
    unittest.main()
