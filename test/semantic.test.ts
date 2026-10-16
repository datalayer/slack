import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { semanticOf, type AgUiEvent } from "../src/ag-ui.js";
import {
  answerParts,
  SEMANTIC_EVENTS_VERSION,
  SEMANTIC_KINDS,
  type SemanticEvent,
} from "../src/semantic.js";

type Fixture = {
  version: number;
  kinds: string[];
  producers: Record<string, string>;
  cases: Array<{ agui: AgUiEvent[]; semantic: SemanticEvent[] }>;
  answers: Array<{ answer: string; parts: unknown[] }>;
};

const fixture = JSON.parse(
  readFileSync(
    new URL("./contracts/semantic-events.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

describe("the semantic agent events contract (version 1)", () => {
  it("names the version and the eleven kinds the adapter renders", () => {
    expect(fixture.version).toBe(SEMANTIC_EVENTS_VERSION);
    expect(fixture.kinds).toEqual([...SEMANTIC_KINDS]);
    expect(Object.keys(fixture.producers).sort()).toEqual(
      [...SEMANTIC_KINDS].sort(),
    );
  });

  it.each(fixture.cases.map((one, index) => [index, one] as const))(
    "reduces case %i of the fixture",
    (_index, { agui, semantic }) => {
      const tools = new Map<string, string>();
      expect(agui.flatMap((event) => semanticOf(event, tools))).toEqual(
        semantic,
      );
    },
  );

  it("covers every kind an AG-UI event produces", () => {
    const produced = new Set(
      fixture.cases.flatMap((one) => one.semantic.map((event) => event.kind)),
    );
    const fromAnswers = new Set(
      fixture.answers.flatMap((one) =>
        (one.parts as Array<{ kind: string }>).map((part) => part.kind),
      ),
    );
    for (const kind of SEMANTIC_KINDS)
      if (kind !== "file")
        expect(produced.has(kind) || fromAnswers.has(kind), kind).toBe(true);
  });

  it.each(
    fixture.answers.map((one) => [one.answer.slice(0, 20), one] as const),
  )(
    "reads an answer's tables and HTTPS citations (%s…)",
    (_name, { answer, parts }) => {
      expect(answerParts(answer)).toEqual(parts);
    },
  );
});
