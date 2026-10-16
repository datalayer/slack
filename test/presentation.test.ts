import { describe, expect, it } from "vitest";

import {
  answerMrkdwn,
  OPEN_ACTION,
  openValueOf,
  safeSlackText,
  streamMarkdown,
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
  const OPEN = openValueOf("S1", "U1");

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
      "q3 &lt;draft&gt;.csv (text/csv): press *Open in Datalayer* to open it",
    );
    // No link made at turn start: the button mints one on each press.
    expect(blocks).not.toContain("hosts/open");
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
    expect(blocks).toContain(
      "8 more rows: press *Open in Datalayer* to see the whole table.",
    );
  });

  it("makes Open in Datalayer an action button carrying the session and its person, never a URL", () => {
    const presentation = new TurnPresentation();
    presentation.apply({ kind: "completion", text: "Done." });
    const actions = presentation
      .message(OPEN)
      .blocks?.find((block) => block.type === "actions") as
      | { elements: Array<Record<string, unknown>> }
      | undefined;
    const open = actions?.elements.find(
      (element) => element.action_id === OPEN_ACTION,
    );
    expect(open).toMatchObject({ type: "button", value: OPEN });
    expect(open).not.toHaveProperty("url");
    expect(JSON.parse(OPEN)).toEqual({ s: "S1", u: "U1" });
  });
});

describe("links written in the answer (S-306): HTTPS only, on both paths", () => {
  const answer =
    "See [the report](https://reports.example/q3), [plain](http://plain.example/x), " +
    "[run me](javascript:alert(1)), [creds](https://u:p@secret.example/), " +
    "http://bare.example/y and https://fine.example/z and mailto:a@b.example";

  it("keeps HTTPS links and makes no link of any other address when posted whole", () => {
    const mrkdwn = answerMrkdwn(answer);
    expect(mrkdwn).toContain("<https://reports.example/q3|the report>");
    expect(mrkdwn).toContain("plain `http://plain.example/x`");
    expect(mrkdwn).toContain("`javascript:alert(1`");
    expect(mrkdwn).toContain("creds `https://u:p@secret.example/`");
    expect(mrkdwn).toContain("`http://bare.example/y`");
    expect(mrkdwn).toContain("https://fine.example/z");
    expect(mrkdwn).toContain("`mailto:a@b.example`");
    expect(mrkdwn).not.toMatch(/<http:|<javascript:|<mailto:/);
  });

  it("holds the streamed markdown_text to the same rule", () => {
    const markdown = streamMarkdown(answer);
    expect(markdown).toContain("[the report](https://reports.example/q3)");
    expect(markdown).toContain("plain `http://plain.example/x`");
    expect(markdown).not.toContain("](http://");
    expect(markdown).not.toContain("](javascript:");
    expect(markdown).not.toContain("](https://u:p@");
    expect(markdown).toContain("`http://bare.example/y`");
    expect(markdown).toContain("`mailto:a@b.example`");
    expect(streamMarkdown("1 < 2 & 3 > 2")).toBe("1 &lt; 2 &amp; 3 &gt; 2");
  });
});
