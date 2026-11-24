"use strict";

const exitJunctions = {
  checkpoint: {x: 250, y: 340},
  west: {x: 370, y: 340},
  scanner: {x: 1250, y: 340},
  east: {x: 1480, y: 340},
  lowerWest: {x: 370, y: 590},
  inspection: {x: 1250, y: 590},
  lowerEast: {x: 1480, y: 590},
  exit: {x: 1700, y: 340}
};

// The arrows along both checkpoint corridors point east.
const exitRoads = {
  checkpoint: ["west"],
  west: ["scanner", "lowerWest"],
  scanner: ["east"],
  lowerWest: ["inspection"],
  inspection: ["lowerEast"],
  lowerEast: ["east"],
  east: ["exit"],
  exit: []
};

function planExitRoute(condition = "open") {
  if (!["open", "delayed", "closed"].includes(condition)) {
    throw new RangeError("Unknown road condition: " + condition);
  }

  const unitsPerMinute = 400;
  const distance = (from, to) => Math.hypot(
    exitJunctions[from].x - exitJunctions[to].x,
    exitJunctions[from].y - exitJunctions[to].y
  );
  // Straight-line time is a lower bound because all roads share the same
  // assumed speed, and temporary delays only add time.
  const heuristic = node => distance(node, "exit") / unitsPerMinute;
  const frontier = new Set(["checkpoint"]);
  const bestMinutes = new Map([["checkpoint", 0]]);
  const previous = new Map();
  let visited = 0;

  while (frontier.size) {
    let current;
    let bestEstimate = Infinity;
    for (const node of frontier) {
      const estimate = bestMinutes.get(node) + heuristic(node);
      if (estimate < bestEstimate) {
        current = node;
        bestEstimate = estimate;
      }
    }
    frontier.delete(current);
    visited++;

    if (current === "exit") {
      const points = [];
      for (let node = current; node !== undefined; node = previous.get(node)) {
        points.push({...exitJunctions[node]});
      }
      const blockedSegment = condition === "closed"
        ? [{...exitJunctions.west}, {...exitJunctions.scanner}]
        : null;
      return {points: points.reverse(), minutes: bestMinutes.get(current), visited, blockedSegment};
    }

    for (const next of exitRoads[current]) {
      const mainRoad = current === "west" && next === "scanner";
      if (mainRoad && condition === "closed") continue;

      const delay = mainRoad && condition === "delayed" ? 3 : 0;
      const minutes = bestMinutes.get(current) + distance(current, next) / unitsPerMinute + delay;
      if (minutes < (bestMinutes.get(next) ?? Infinity)) {
        bestMinutes.set(next, minutes);
        previous.set(next, current);
        frontier.add(next);
      }
    }
  }

  throw new Error("No route to the terminal exit.");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {planExitRoute};
}
