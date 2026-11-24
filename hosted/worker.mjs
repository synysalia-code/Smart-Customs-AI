const pyodideDirectory = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
const loadFailure = "Симуляторды жүктеу мүмкін болмады. Бетті қайта жүктеңіз.";
const requestFailure = "Сұрау орындалмады.";
const trainingFailure = "Оқыту аяқталмады. Қайтадан жүктеп көріңіз.";
let initializing;

async function readProjectFile(path) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
  return response.text();
}

function initialize() {
  if (!initializing) {
    initializing = (async () => {
      try {
        const [{loadPyodide}, model, adapter, savedModel, benchmark] = await Promise.all([
          import(pyodideDirectory + "pyodide.mjs"),
          readProjectFile("../model.py"),
          readProjectFile("./browser_api.py"),
          readProjectFile("../data/model.json"),
          readProjectFile("../data/benchmark.json"),
        ]);
        const python = await loadPyodide({indexURL: pyodideDirectory});
        python.FS.mkdir("/smart_customs");
        python.FS.writeFile("/smart_customs/model.py", model);
        python.FS.writeFile("/smart_customs/browser_api.py", adapter);
        python.runPython("import sys\nsys.path.insert(0, '/smart_customs')");
        const api = python.pyimport("browser_api");
        api.initialize(savedModel, benchmark);
        return api;
      } catch (error) {
        console.error("Could not initialize the simulation", error);
        throw new Error(loadFailure);
      }
    })();
  }
  return initializing;
}

function readableError(error) {
  if (error?.message === loadFailure) return loadFailure;
  const lastLine = String(error?.message || "").trim().split("\n").at(-1);
  const validationMessage = /^(ValueError|TypeError|OverflowError|RuntimeError):\s*(.+)$/.exec(lastLine);
  return validationMessage ? validationMessage[2] : requestFailure;
}

function finishTraining(api) {
  try {
    const result = api.run_pending_training(job => {
      self.postMessage({type: "job", job: JSON.parse(job)});
    });
    self.postMessage({type: "state", state: JSON.parse(result)});
  } catch (error) {
    console.error("Could not complete training", error);
    self.postMessage({type: "job", job: {state: "failed", error: trainingFailure, progress: 0, total: 600}});
  }
}

self.addEventListener("message", async ({data: request}) => {
  const {id, path, data} = request;
  try {
    const api = await initialize();
    const rawResult = api.browser_request(path, data === undefined ? null : JSON.stringify(data));
    const result = JSON.parse(rawResult);
    self.postMessage({type: "response", id, result});
    if (path === "/api/train" && result.job?.state === "training") finishTraining(api);
  } catch (error) {
    console.error("Simulation request failed", error);
    self.postMessage({type: "response", id, error: readableError(error)});
  }
});
