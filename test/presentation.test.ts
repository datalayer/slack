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
    presentation.apply({ kind: "progress", label: "Reading" });
    presentation.apply({ kind: "text", text: "Hello " });
    presentation.apply({ kind: "text", text: "world" });
    presentation.apply({ kind: "completion" });
    expect(
      presentation.message("https://datalayer.ai/session/1").text,
    ).toContain("Hello world");
  });
});

describe("result links (S-306, decided by the user 16 October 2026)", () => {
  const OPEN = "https://datalayer.ai/hosts/open?code=dlho_x";

  it("names a file and opens it in the conversation through the handoff, never by its own address", () => {
    const presentation = new TurnPresentation();
    presentation.apply({
      kind: "file",
      mediaType: "text/csv",
      name: "q3 <draft>.csv",
      url: "https://files.example/q3.csv?signature=abc",
    });
    presentation.apply({ kind: "completion" });
    const blocks = JSON.stringify(presentation.message(OPEN).blocks);
    expect(blocks).toContain(
      "q3 &lt;draft&gt;.csv (text/csv): <https://datalayer.ai/hosts/open?code=dlho_x|open it in Datalayer>",
    );
    expect(blocks).not.toContain("files.example");
    const streamed = JSON.stringify(
      presentation.message(OPEN, { streamed: true }).blocks,
    );
    expect(streamed).not.toContain("files.example");
  });

  it("links nothing when no handoff was made", () => {
    const presentation = new TurnPresentation();
    presentation.apply({
      kind: "file",
      name: "q3.csv",
      url: "https://files.example/q3.csv",
    });
    presentation.apply({ kind: "completion" });
    const blocks = JSON.stringify(presentation.message("").blocks);
    expect(blocks).toContain("q3.csv: in the conversation in Datalayer");
    expect(blocks).not.toContain("https://");
  });

  it("previews a long table and sends the rest to the conversation", () => {
    const presentation = new TurnPresentation();
    presentation.apply({
      columns: ["n"],
      kind: "table",
      rows: Array.from({ length: 20 }, (_, index) => [String(index)]),
    });
    presentation.apply({ kind: "completion" });
    const blocks = JSON.stringify(presentation.message(OPEN).blocks);
    expect(blocks).toContain(`<${OPEN}|see the whole table in Datalayer>`);
  });
});
