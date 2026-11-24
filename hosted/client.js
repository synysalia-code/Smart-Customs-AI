"use strict";

(() => {
  const workerUrl = new URL("./hosted/worker.mjs", document.baseURI);
  const connectionError = "Симулятормен байланыс үзілді. Бетті қайта жүктеңіз.";
  const pending = new Map();
  let worker;
  let failed = false;
  let nextRequest = 0;
  let latestState;

  function failConnection() {
    failed = true;
    for (const request of pending.values()) request.reject(new Error(connectionError));
    pending.clear();
  }

  function handleMessage({data: message}) {
    if (message.type === "job") {
      if (latestState) latestState = {...latestState, job: message.job};
      return;
    }
    if (message.type === "state") {
      latestState = message.state;
      return;
    }
    if (message.type !== "response") return;

    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(message.error));
      return;
    }
    if (message.result?.metrics && message.result?.job) latestState = message.result;
    request.resolve(message.result);
  }

  window.smartCustomsHostedApi = async (path, data) => {
    if (failed) throw new Error(connectionError);
    if (path === "/api/state" && ["training", "evaluating"].includes(latestState?.job.state)) {
      return latestState;
    }
    if (!worker) {
      worker = new Worker(workerUrl, {type: "module"});
      worker.addEventListener("message", handleMessage);
      worker.addEventListener("error", failConnection);
      worker.addEventListener("messageerror", failConnection);
    }
    const id = ++nextRequest;
    return new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject});
      try {
        worker.postMessage({id, path, data});
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  };
})();
