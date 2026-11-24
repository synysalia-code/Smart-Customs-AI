"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {planExitRoute} = require("../web/routing.js");

const direct = [[250, 340], [370, 340], [1250, 340], [1480, 340], [1700, 340]];
const detour = [[250, 340], [370, 340], [370, 590], [1250, 590], [1480, 590], [1480, 340], [1700, 340]];
const coordinates = route => route.points.map(({x, y}) => [x, y]);

test("A* uses the shorter direct road when both routes are open", () => {
  const route = planExitRoute();
  assert.deepEqual(coordinates(route), direct);
  assert.equal(route.minutes, 3.625);
  assert.equal(route.visited, 5);
  assert.equal(route.blockedSegment, null);
});

test("a 3-minute delay makes the longer detour faster", () => {
  const route = planExitRoute("delayed");
  assert.deepEqual(coordinates(route), detour);
  assert.equal(route.minutes, 4.875);
  assert.equal(route.visited, 7);
  assert.equal(route.blockedSegment, null);
});

test("a closed road returns the detour and identifies the closed segment", () => {
  const route = planExitRoute("closed");
  assert.deepEqual(coordinates(route), detour);
  assert.equal(route.minutes, 4.875);
  assert.deepEqual(route.blockedSegment, [{x: 370, y: 340}, {x: 1250, y: 340}]);
  assert.throws(() => planExitRoute("invalid"), RangeError);
});
