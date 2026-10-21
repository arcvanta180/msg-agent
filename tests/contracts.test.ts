import { describe, it, expect } from "vitest";
import {
  canTransition,
  resolveSteps,
  mergeMessages,
  Message,
  SequenceDefinition,
} from "../packages/contracts/src";
describe("领域契约", () => {
  it("原型链属性不能冒充已提供的模板变量", () => {
    const template: SequenceDefinition = {
      id: "p",
      name: "prototype",
      steps: [
        {
          index: 1,
          accountRole: "admin",
          text: "{constructor}",
          delaySeconds: 0,
        },
      ],
    };
    expect(() => resolveSteps(template, {}, {})).toThrowError(
      expect.objectContaining({
        code: "UNRESOLVED_PLACEHOLDER",
        key: "constructor",
      }),
    );
    template.steps[0].text = "{__proto__}";
    expect(
      resolveSteps(template, JSON.parse('{"__proto__":"自有值"}'), {})[0].text,
    ).toBe("自有值");
  });
  it("终态没有出边且禁止同状态转移", () => {
    expect(canTransition("suspended", "online")).toBe(false);
    expect(canTransition("online", "online")).toBe(false);
    expect(canTransition("rate_limited", "disconnected")).toBe(true);
  });
  const def: SequenceDefinition = {
    id: "s",
    name: "test",
    steps: [1, 2, 3].map((index) => ({
      index,
      accountRole: "admin",
      text: "{a} {b}",
      delaySeconds: 1,
    })),
  };
  it("变量继承、空串和来源", () => {
    const result = resolveSteps(
      def,
      { a: "甲", b: "乙" },
      { "2": { a: "丙", b: "" } },
    );
    expect(result.map((s) => s.text)).toEqual(["甲 乙", "丙 乙", "丙 乙"]);
    expect(result[2].varSources).toEqual({ a: "step:2", b: "default" });
  });
  it("预检准确定位缺失变量", () => {
    expect(() => resolveSteps(def, { a: "", b: "乙" }, {})).toThrowError(
      expect.objectContaining({
        code: "UNRESOLVED_PLACEHOLDER",
        stepIndex: 1,
        key: "a",
      }),
    );
  });
  it("旧分页不能覆盖更新版本", () => {
    const current = {
      id: "m",
      revision: 3,
      sentAt: "2026-10-20T00:00:01Z",
      deliveryStatus: "sent",
    } as Message;
    const old = {
      ...current,
      revision: 1,
      deliveryStatus: "queued",
    } as Message;
    expect(mergeMessages([current], [old, old])).toEqual([current]);
  });
});
