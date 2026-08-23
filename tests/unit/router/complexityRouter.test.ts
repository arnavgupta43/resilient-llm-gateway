import { chooseTier } from "../../../src/router/complexityRouter";
import type { GatewayCompletionRequest } from "../../../src/adapters/types";

function requestWith(content: string, taskType?: string): GatewayCompletionRequest {
  return { messages: [{ role: "user", content }], taskType };
}

describe("chooseTier", () => {
  describe("task_type lookup", () => {
    it.each([
      ["summarization", "simple"],
      ["classification", "simple"],
      ["code_generation", "complex"],
      ["debugging", "complex"],
    ] as const)("%s -> %s, regardless of message content", (taskType, expected) => {
      // message content deliberately contradicts the table entry, to prove
      // the lookup wins over the heuristics rather than just agreeing with them
      const content = expected === "simple" ? "```code```" : "hi";
      expect(chooseTier(requestWith(content, taskType))).toBe(expected);
    });

    it("unknown task_type falls through to heuristics", () => {
      expect(chooseTier(requestWith("hi", "some_made_up_type"))).toBe("simple");
      expect(chooseTier(requestWith("```code```", "some_made_up_type"))).toBe("complex");
    });

    it.each(["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"])(
      'task_type "%s" (an Object.prototype property name) falls through to heuristics instead of resolving to a built-in',
      (taskType) => {
        expect(chooseTier(requestWith("hi", taskType))).toBe("simple");
        expect(chooseTier(requestWith("```code```", taskType))).toBe("complex");
      },
    );
  });

  describe("length heuristic", () => {
    it("exactly at the boundary (600 chars) does not trigger complex", () => {
      expect(chooseTier(requestWith("a".repeat(600)))).toBe("simple");
    });

    it("one over the boundary (601 chars) triggers complex", () => {
      expect(chooseTier(requestWith("a".repeat(601)))).toBe("complex");
    });
  });

  describe("code block heuristic", () => {
    it("fenced code block triggers complex", () => {
      expect(chooseTier(requestWith("```\nconst x = 1;\n```"))).toBe("complex");
    });

    it("stray brace/semicolon without fencing does not trigger complex", () => {
      expect(chooseTier(requestWith("if (x) { y(); }"))).toBe("simple");
    });
  });

  describe("reasoning keyword heuristic", () => {
    it.each(["explain step by step", "prove", "debug", "walk me through", "why does"])(
      '"%s" triggers complex, case-insensitively',
      (keyword) => {
        expect(chooseTier(requestWith(`please ${keyword.toUpperCase()} this`))).toBe("complex");
      },
    );
  });

  it("multiple heuristics firing at once still resolves to complex (OR, not exclusive)", () => {
    expect(chooseTier(requestWith("```code```\n" + "please prove this".repeat(50)))).toBe("complex");
  });

  it("only scans the latest user message, not earlier history", () => {
    const request: GatewayCompletionRequest = {
      messages: [
        { role: "user", content: "```an earlier code block```" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "thanks" },
      ],
    };
    expect(chooseTier(request)).toBe("simple");
  });

  it("no user message at all falls through to simple rather than throwing", () => {
    const request: GatewayCompletionRequest = { messages: [{ role: "system", content: "you are a bot" }] };
    expect(chooseTier(request)).toBe("simple");
  });

  it("no task_type and no heuristic match defaults to simple", () => {
    expect(chooseTier(requestWith("hi"))).toBe("simple");
  });
});
