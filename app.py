"""Local-only Smart Customs AI application. No third-party packages required."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from dataclasses import asdict
import argparse
import json
import threading
import traceback
from urllib.parse import urlparse, parse_qs
from model import Config, Terminal, choose_action, utility_values, train, evaluate, alpha_beta_demo, save_json

ROOT = Path(__file__).resolve().parent
LOCK = threading.RLock()


def read_saved(name):
    path = ROOT / "data" / name
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


ENV = Terminal()
POLICY = "utility"
MODEL = read_saved("model.json")
BENCHMARK = read_saved("benchmark.json")
JOB = dict(state="idle", progress=0, total=600)


def matching_model():
    return MODEL if MODEL and MODEL.get("config") == asdict(ENV.config) else None


def snapshot():
    s = ENV.public_state()
    trained = matching_model()
    obs = ENV.observe()
    action, source = choose_action(obs, POLICY, ENV.config, trained["q"] if trained else None) if obs else (None, None)
    s.update(policy=POLICY, recommendation=action, source=source,
             values=utility_values(obs, ENV.config) if obs else {},
             q_values=trained["q"].get(obs.key()) if trained and obs else None,
             job=dict(JOB), benchmark=BENCHMARK,
             model=dict(available=bool(trained), states=MODEL["states"] if MODEL else 0,
                        episodes=MODEL["episodes"] if MODEL else 0,
                        curve=MODEL.get("learning_curve", []) if MODEL else []))
    return s


def train_job(config):
    global MODEL, BENCHMARK
    try:
        def progress(done, total):
            with LOCK:
                JOB.update(progress=done, total=total)
        model = train(config, episodes=600, progress=progress)
        with LOCK:
            JOB["state"] = "evaluating"
        benchmark = evaluate(config, model, episodes=40)
        save_json(ROOT / "data" / "model.json", model)
        save_json(ROOT / "data" / "benchmark.json", benchmark)
        with LOCK:
            MODEL, BENCHMARK = model, benchmark
            JOB.update(state="complete", progress=600)
    except Exception:
        traceback.print_exc()
        with LOCK:
            JOB.update(state="failed", error="Оқыту аяқталмады. Сервер журналын қараңыз.")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, data, status=200, mime="application/json; charset=utf-8"):
        body = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8") if mime.startswith("application/json") else data
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            with LOCK:
                return self.send(snapshot())
        if parsed.path == "/api/strategy":
            try:
                risk = float(parse_qs(parsed.query).get("risk", [".324"])[0])
                if not 0 <= risk <= 1:
                    raise ValueError()
                return self.send(dict(pruned=alpha_beta_demo(risk), full=alpha_beta_demo(risk, False)))
            except ValueError:
                return self.send(dict(error="Тәуекел 0–1 аралығында болуы керек."), 400)
        if parsed.path == "/api/export":
            with LOCK:
                return self.send(dict(simulation=ENV.public_state(), policy=POLICY, benchmark=BENCHMARK))
        files = {"/": ("index.html", "text/html; charset=utf-8"),
                 "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                 "/style.css": ("style.css", "text/css; charset=utf-8")}
        if parsed.path in files:
            name, mime = files[parsed.path]
            return self.send((ROOT / "web" / name).read_bytes(), mime=mime)
        return self.send(dict(error="Бет табылмады."), 404)

    def do_POST(self):
        global ENV, POLICY, JOB
        # JSON-only same-origin mutations; listen on loopback, never the LAN.
        origin = self.headers.get("Origin")
        if origin and origin != f"http://{self.headers.get('Host')}":
            return self.send(dict(error="Басқа беттен сұрау қабылданбайды."), 403)
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            return self.send(dict(error="JSON қажет."), 415)
        try:
            length = int(self.headers.get("Content-Length", 0))
            if not 0 <= length <= 4096:
                raise ValueError("Сұрау тым үлкен.")
            data = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(data, dict):
                raise ValueError("JSON объектісі қажет.")
            with LOCK:
                if self.path == "/api/reset":
                    if data.get("policy", "utility") not in ("rule", "utility", "q", "all"):
                        raise ValueError("Агент белгісіз.")
                    config = Config(prior=float(data.get("prior", .04)),
                                    arrival_gap=float(data.get("arrival_gap", 4)),
                                    trucks=int(data.get("trucks", 80))).validate()
                    seed = int(data.get("seed", 42))
                    if not 0 <= seed <= 999999999:
                        raise ValueError("Seed 0–999999999 аралығында болуы керек.")
                    ENV = Terminal(config, seed)
                    POLICY = data.get("policy", "utility")
                elif self.path == "/api/step":
                    if not ENV.done:
                        action = data.get("action")
                        if not action:
                            model = matching_model()
                            action, _ = choose_action(ENV.observe(), POLICY, ENV.config, model["q"] if model else None)
                        ENV.step(action)
                elif self.path == "/api/finish":
                    model = matching_model()
                    while not ENV.done:
                        action, _ = choose_action(ENV.observe(), POLICY, ENV.config, model["q"] if model else None)
                        ENV.step(action)
                elif self.path == "/api/train":
                    if JOB["state"] in ("training", "evaluating"):
                        return self.send(dict(error="Оқыту жүріп жатыр."), 409)
                    JOB = dict(state="training", progress=0, total=600)
                    threading.Thread(target=train_job, args=(ENV.config,), daemon=True).start()
                else:
                    return self.send(dict(error="Әрекет табылмады."), 404)
                return self.send(snapshot())
        except (ValueError, TypeError, OverflowError) as error:
            return self.send(dict(error=str(error) or "Параметрлер дұрыс емес."), 400)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    # Keep the video renderer responsive while using this small CPU-only model.
    try:
        import ctypes
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)
    except (AttributeError, OSError):
        pass
    print(f"Smart Customs AI: http://127.0.0.1:{args.port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
