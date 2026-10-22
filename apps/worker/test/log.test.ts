// The worker's log on a terminal that went away.
import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { dropLinesWhenGone } from "../src/log.js";

it("drops a line to a terminal that hung up or a reader that closed, and throws any other error", () => {
  const stream = new EventEmitter();
  dropLinesWhenGone(stream);
  const error = (code: string) => Object.assign(new Error(`write ${code}`), { code });
  // Unheard, either would end the worker in the middle of its stop.
  expect(() => stream.emit("error", error("EIO"))).not.toThrow();
  expect(() => stream.emit("error", error("EPIPE"))).not.toThrow();
  expect(() => stream.emit("error", error("EBADF"))).toThrow("write EBADF");
});
