/**
 * Slack's Block Kit limits, checked on every surface @Datalayer builds
 * (Rendering, S-406): what Slack refuses or truncates,
 * and what a screen reader or a notification needs — a plain-text fallback
 * on every message and alt text on every image. Limits from the Block Kit
 * reference (blocks, composition objects, block elements).
 */

type Json = Record<string, unknown>;

export const BLOCK_KIT = {
  messageBlocks: 50,
  surfaceBlocks: 100,
  sectionText: 3_000,
  sectionFields: 10,
  fieldText: 2_000,
  headerText: 150,
  contextElements: 10,
  actionsElements: 25,
  buttonText: 75,
  buttonValue: 2_000,
  buttonUrl: 3_000,
  accessibilityLabel: 75,
  optionText: 75,
  optionValue: 150,
  selectOptions: 100,
  overflowOptions: 5,
  placeholder: 150,
  modalTitle: 24,
  modalButton: 24,
  privateMetadata: 3_000,
  actionId: 255,
  messageText: 40_000,
} as const;

const KNOWN_BLOCKS = new Set([
  "actions",
  "context",
  "divider",
  "header",
  "image",
  "input",
  "section",
]);

function textOf(value: unknown): string | undefined {
  const object = value as { text?: unknown } | undefined;
  return typeof object?.text === "string" ? object.text : undefined;
}

function problemsOfElement(element: Json, where: string): string[] {
  const problems: string[] = [];
  const type = element.type as string;
  if (
    typeof element.action_id === "string" &&
    element.action_id.length > BLOCK_KIT.actionId
  )
    problems.push(`${where}: action_id over ${BLOCK_KIT.actionId}`);
  if (type === "button") {
    const text = textOf(element.text) ?? "";
    if (!text.trim()) problems.push(`${where}: a button with no words`);
    if (text.length > BLOCK_KIT.buttonText)
      problems.push(`${where}: button text over ${BLOCK_KIT.buttonText}`);
    if (
      typeof element.value === "string" &&
      element.value.length > BLOCK_KIT.buttonValue
    )
      problems.push(`${where}: button value over ${BLOCK_KIT.buttonValue}`);
    if (typeof element.url === "string") {
      if (element.url.length > BLOCK_KIT.buttonUrl)
        problems.push(`${where}: button url over ${BLOCK_KIT.buttonUrl}`);
      if (!element.url.startsWith("https://"))
        problems.push(`${where}: a button url that is not https`);
    }
    if (
      typeof element.accessibility_label === "string" &&
      element.accessibility_label.length > BLOCK_KIT.accessibilityLabel
    )
      problems.push(
        `${where}: accessibility_label over ${BLOCK_KIT.accessibilityLabel}`,
      );
  } else if (type === "static_select" || type === "overflow") {
    const options = (element.options ?? []) as Json[];
    const most =
      type === "overflow" ? BLOCK_KIT.overflowOptions : BLOCK_KIT.selectOptions;
    if (options.length === 0) problems.push(`${where}: a menu with no option`);
    if (options.length > most)
      problems.push(`${where}: ${options.length} options, over ${most}`);
    for (const option of options) {
      const text = textOf(option.text) ?? "";
      if (!text.trim()) problems.push(`${where}: an option with no words`);
      if (text.length > BLOCK_KIT.optionText)
        problems.push(`${where}: option text over ${BLOCK_KIT.optionText}`);
      if (
        typeof option.value === "string" &&
        option.value.length > BLOCK_KIT.optionValue
      )
        problems.push(`${where}: option value over ${BLOCK_KIT.optionValue}`);
    }
    if (type === "static_select") {
      const placeholder = textOf(element.placeholder) ?? "";
      if (!placeholder.trim())
        problems.push(`${where}: a select without a placeholder`);
      if (placeholder.length > BLOCK_KIT.placeholder)
        problems.push(`${where}: placeholder over ${BLOCK_KIT.placeholder}`);
    }
  } else if (type === "image") {
    if (typeof element.alt_text !== "string" || !element.alt_text.trim())
      problems.push(`${where}: an image without alt text`);
  } else if (type === "plain_text_input") {
    // A label on its input block names it.
  } else if (type === "mrkdwn" || type === "plain_text") {
    const text = textOf(element) ?? "";
    if (!text.trim()) problems.push(`${where}: an empty text element`);
  } else problems.push(`${where}: an element Slack may not know (${type})`);
  return problems;
}

/** Every Block Kit limit a list of blocks breaks: none when it is sound. */
export function blockKitProblems(
  blocks: readonly unknown[],
  limit: number = BLOCK_KIT.messageBlocks,
): string[] {
  const problems: string[] = [];
  if (blocks.length > limit)
    problems.push(`${blocks.length} blocks, over ${limit}`);
  blocks.forEach((raw, index) => {
    const block = raw as Json;
    const where = `block ${index} (${String(block.type)})`;
    if (!KNOWN_BLOCKS.has(block.type as string))
      problems.push(`${where}: a block type Slack may not know`);
    const text = textOf(block.text);
    if (block.type === "section") {
      const fields = (block.fields ?? []) as Json[];
      if (text === undefined && fields.length === 0)
        problems.push(`${where}: a section with no words`);
      if (text !== undefined && !text.trim())
        problems.push(`${where}: an empty section`);
      if ((text?.length ?? 0) > BLOCK_KIT.sectionText)
        problems.push(`${where}: section text over ${BLOCK_KIT.sectionText}`);
      if (fields.length > BLOCK_KIT.sectionFields)
        problems.push(`${where}: over ${BLOCK_KIT.sectionFields} fields`);
      for (const field of fields)
        if ((textOf(field)?.length ?? 0) > BLOCK_KIT.fieldText)
          problems.push(`${where}: a field over ${BLOCK_KIT.fieldText}`);
      if (block.accessory)
        problems.push(...problemsOfElement(block.accessory as Json, where));
    }
    if (block.type === "header" && (text?.length ?? 0) > BLOCK_KIT.headerText)
      problems.push(`${where}: header over ${BLOCK_KIT.headerText}`);
    if (block.type === "context") {
      const elements = (block.elements ?? []) as Json[];
      if (elements.length === 0 || elements.length > BLOCK_KIT.contextElements)
        problems.push(`${where}: ${elements.length} context elements`);
      for (const element of elements)
        problems.push(...problemsOfElement(element, where));
    }
    if (block.type === "actions") {
      const elements = (block.elements ?? []) as Json[];
      if (elements.length === 0 || elements.length > BLOCK_KIT.actionsElements)
        problems.push(`${where}: ${elements.length} actions`);
      for (const element of elements)
        problems.push(...problemsOfElement(element, where));
    }
    if (block.type === "image")
      problems.push(...problemsOfElement(block, where));
    if (block.type === "input") {
      if (!textOf(block.label)?.trim())
        problems.push(`${where}: an input without a label`);
      problems.push(...problemsOfElement(block.element as Json, where));
    }
  });
  return problems;
}

/** A message's problems: its blocks, and a plain-text fallback for notifications and screen readers. */
export function messageProblems(message: {
  blocks?: readonly unknown[];
  text?: string;
}): string[] {
  const problems = blockKitProblems(message.blocks ?? []);
  if (!message.text?.trim())
    problems.push(
      "no plain-text fallback (text) for notifications and screen readers",
    );
  if ((message.text?.length ?? 0) > BLOCK_KIT.messageText)
    problems.push(`text over ${BLOCK_KIT.messageText}`);
  return problems;
}

/** A modal's or App Home's problems. */
export function surfaceProblems(view: {
  blocks: readonly unknown[];
  close?: unknown;
  private_metadata?: string;
  submit?: unknown;
  title?: unknown;
  type: string;
}): string[] {
  const problems = blockKitProblems(view.blocks, BLOCK_KIT.surfaceBlocks);
  if (view.type === "modal") {
    for (const [name, value] of [
      ["title", view.title],
      ["submit", view.submit],
      ["close", view.close],
    ] as const) {
      const text = textOf(value);
      if (name === "title" && !text?.trim())
        problems.push("a modal without a title");
      if (
        (text?.length ?? 0) >
        (name === "title" ? BLOCK_KIT.modalTitle : BLOCK_KIT.modalButton)
      )
        problems.push(`modal ${name} too long`);
    }
    if ((view.private_metadata?.length ?? 0) > BLOCK_KIT.privateMetadata)
      problems.push(`private_metadata over ${BLOCK_KIT.privateMetadata}`);
  }
  return problems;
}
