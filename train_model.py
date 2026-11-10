"""Reproduce the training and evaluation included with this MVP."""
from pathlib import Path
from model import Config, train, evaluate, save_json

if __name__ == "__main__":
    root = Path(__file__).resolve().parent / "data"
    config = Config()
    model = train(config, progress=lambda n, total: print(f"Training {n}/{total}", flush=True) if n % 100 == 0 else None)
    save_json(root / "model.json", model)
    report = evaluate(config, model)
    save_json(root / "benchmark.json", report)
    print("States:", model["states"])
    for policy, metrics in report["policies"].items():
        print(policy, metrics)
