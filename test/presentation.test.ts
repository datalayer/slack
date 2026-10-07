import { describe, expect, it } from "vitest";

import {
  safeSlackText,
  stripAppMention,
  TurnPresentation,
} from "../src/presentation.js";

describe("Slack presentation", () => {
  it("removes only the addressed app mention", () => {
    expect(
      stripAppMention("<@B123> compare <@U456> and option B", "B123"),
    ).toBe("compare <@U456> and option B");
  });

  it("escapes Slack control characters in model output", () => {
    expect(safeSlackText("<script> & result")).toBe(
      "&lt;script&gt; &amp; result",
    );
  });

  it("reduces streamed updates into one answer", () => {
    const presentation = new TurnPresentation();
    presentation.apply({ kind: "status", label: "Reading" });
    presentation.apply({ kind: "text", text: "Hello " });
    presentation.apply({ kind: "text", text: "world" });
    presentation.apply({ kind: "complete" });
    expect(
      presentation.message("https://datalayer.ai/session/1").text,
    ).toContain("Hello world");
  });
});
