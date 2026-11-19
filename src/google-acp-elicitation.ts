import type { AskUserQuestionItem } from "@deepseek-ai/dsh-user-questions";

export type ElicitationOption = {
  value: string;
  label: string;
  description?: string;
};

export type ElicitationFieldPlan = {
  key: string;
  kind: "single" | "multi" | "text" | "boolean" | "number" | "integer";
  otherKey?: string;
  options?: ElicitationOption[];
  labelToValue?: Map<string, string>;
};

export type ParsedElicitation = {
  questions: AskUserQuestionItem[];
  fields: ElicitationFieldPlan[];
  required: Set<string>;
};

const isPlainObject = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const CANCELLATION_CODES = new Set([
  "ASK_CANCELLED",
  "ASK_ABORTED",
  "NO_PROVIDER",
]);

export function isUserQuestionCancellation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && CANCELLATION_CODES.has(code);
}

type RawOption = {
  value: string;
  rawTitle: string;
  description?: string;
};

function extractChoiceOptions(schema: unknown): ElicitationOption[] | null {
  if (!isPlainObject(schema)) return null;
  const rawOptions: RawOption[] = [];
  const oneOf = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (oneOf) {
    for (const item of oneOf) {
      if (!isPlainObject(item) || item.const === undefined) continue;
      const value = String(item.const);
      const rawTitle =
        typeof item.title === "string" && item.title ? item.title : value;
      const description =
        typeof item.description === "string" && item.description.trim()
          ? item.description
          : undefined;
      rawOptions.push({ value, rawTitle, description });
    }
  } else if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    for (let i = 0; i < schema.enum.length; i++) {
      const enumVal = schema.enum[i];
      if (enumVal === undefined || enumVal === null) continue;
      const value = String(enumVal);
      const rawTitle =
        typeof names[i] === "string" && names[i] ? names[i] : value;
      rawOptions.push({ value, rawTitle });
    }
  }
  if (!rawOptions.length) return null;

  const counts = new Map<string, number>();
  for (const option of rawOptions)
    counts.set(option.rawTitle, (counts.get(option.rawTitle) ?? 0) + 1);

  const usedLabels = new Set<string>();
  for (const option of rawOptions)
    if (counts.get(option.rawTitle) === 1) usedLabels.add(option.rawTitle);

  return rawOptions.map((option, index) => {
    let label = option.rawTitle;
    if ((counts.get(option.rawTitle) ?? 0) > 1) {
      label = `${option.rawTitle} (${index + 1})`;
      if (usedLabels.has(label)) label = `${option.rawTitle} #${index + 1}`;
      let suffix = 2;
      while (usedLabels.has(label))
        label = `${option.rawTitle} #${index + 1}-${suffix++}`;
    }
    usedLabels.add(label);
    return {
      value: option.value,
      label,
      ...(option.description ? { description: option.description } : {}),
    };
  });
}

function classifyChoiceField(
  prop: Record<string, any>,
): { kind: "single" | "multi"; options: ElicitationOption[] } | null {
  if (prop.type === "array") {
    const options = extractChoiceOptions(prop.items);
    return options ? { kind: "multi", options } : null;
  }
  if (prop.type === "string" || prop.type === undefined) {
    const options = extractChoiceOptions(prop);
    return options ? { kind: "single", options } : null;
  }
  return null;
}

function isPlainStringField(prop: unknown): boolean {
  return (
    isPlainObject(prop) &&
    prop.type === "string" &&
    prop.oneOf === undefined &&
    prop.anyOf === undefined &&
    prop.enum === undefined
  );
}

export function parseAcpElicitation(params: any): ParsedElicitation | null {
  if (params?.mode !== "form") return null;
  const schema = params.requestedSchema;
  if (!isPlainObject(schema) || schema.type !== "object") return null;
  const properties = schema.properties;
  if (!isPlainObject(properties)) return null;

  const required = new Set<string>(
    Array.isArray(schema.required)
      ? schema.required.filter((k: unknown) => typeof k === "string")
      : [],
  );

  const consumed = new Set<string>();
  const pairedOther = new Map<string, string>();
  for (const [key, prop] of Object.entries(properties)) {
    if (!isPlainObject(prop) || !classifyChoiceField(prop)) continue;
    const otherKey = `${key}_other`;
    if (
      Object.hasOwn(properties, otherKey) &&
      !required.has(otherKey) &&
      isPlainStringField(properties[otherKey])
    ) {
      pairedOther.set(key, otherKey);
      consumed.add(otherKey);
    }
  }

  const questions: AskUserQuestionItem[] = [];
  const fields: ElicitationFieldPlan[] = [];

  for (const [key, prop] of Object.entries(properties)) {
    if (consumed.has(key)) continue;
    if (!isPlainObject(prop)) {
      if (required.has(key)) return null;
      continue;
    }

    let plan: ElicitationFieldPlan | undefined;
    let itemOptions: AskUserQuestionItem["options"];

    const choice = classifyChoiceField(prop);
    if (choice) {
      const labelToValue = new Map(
        choice.options.map((option) => [option.label, option.value]),
      );
      plan = {
        key,
        kind: choice.kind,
        ...(pairedOther.has(key) ? { otherKey: pairedOther.get(key) } : {}),
        options: choice.options,
        labelToValue,
      };
      itemOptions = choice.options.map((option) => ({
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      }));
    } else if (prop.type === "boolean") {
      plan = { key, kind: "boolean" };
      itemOptions = [{ label: "是" }, { label: "否" }];
    } else if (isPlainStringField(prop)) {
      plan = { key, kind: "text" };
    } else if (prop.type === "number" || prop.type === "integer") {
      plan = { key, kind: prop.type };
    } else {
      if (required.has(key)) return null;
      continue;
    }

    const questionText =
      typeof prop.title === "string" && prop.title.trim() ? prop.title : key;
    const detail =
      typeof prop.description === "string" && prop.description.trim()
        ? prop.description
        : undefined;

    fields.push(plan);
    questions.push({
      id: key,
      header: "Antigravity",
      question: questionText,
      ...(detail ? { detail } : {}),
      ...(itemOptions ? { options: itemOptions } : {}),
      multiSelect: plan.kind === "multi",
    });
  }

  if (!questions.length) return null;
  return { questions, fields, required };
}

function matchChoiceOption(
  field: ElicitationFieldPlan,
  text: string,
): string | undefined {
  const byLabel = field.labelToValue?.get(text);
  if (byLabel !== undefined) return byLabel;
  const options = field.options ?? [];
  const exact = options.find((o) => o.label === text || o.value === text);
  if (exact) return exact.value;
  const lower = text.toLowerCase();
  return options.find(
    (o) => o.label.toLowerCase() === lower || o.value.toLowerCase() === lower,
  )?.value;
}

export function buildAcpElicitationResponse(
  plan: ParsedElicitation,
  answer: any,
): { action: "accept"; content: Record<string, unknown> } | { action: "cancel" } {
  const answers = new Map<string, any>(
    Array.isArray(answer?.answers)
      ? answer.answers
          .filter((a: any) => a && typeof a.id === "string")
          .map((a: any) => [a.id, a])
      : [],
  );

  const content: Record<string, unknown> = Object.create(null);
  const fieldsByKey = new Map(plan.fields.map((field) => [field.key, field]));

  for (const field of plan.fields) {
    const item = answers.get(field.key);
    const selected = Array.isArray(item?.selected)
      ? item.selected.filter((s: unknown) => typeof s === "string")
      : [];
    const custom = typeof item?.custom === "string" ? item.custom.trim() : "";

    if (field.kind === "single") {
      const selectedValues = selected
        .map((label: string) => field.labelToValue?.get(label))
        .filter((v: string | undefined): v is string => v !== undefined);
      if (custom) {
        if (field.otherKey) {
          content[field.otherKey] = custom;
        } else {
          const matched = matchChoiceOption(field, custom);
          if (matched !== undefined) content[field.key] = matched;
          else if (selectedValues.length >= 1)
            content[field.key] = selectedValues[0];
        }
      } else if (selectedValues.length >= 1) {
        content[field.key] = selectedValues[0];
      }
    } else if (field.kind === "multi") {
      const values: string[] = [];
      const seen = new Set<string>();
      for (const label of selected) {
        const value = field.labelToValue?.get(label);
        if (value !== undefined && !seen.has(value)) {
          seen.add(value);
          values.push(value);
        }
      }
      if (custom) {
        if (field.otherKey) {
          content[field.otherKey] = custom;
        } else {
          const matched = matchChoiceOption(field, custom);
          if (matched !== undefined && !seen.has(matched)) {
            seen.add(matched);
            values.push(matched);
          }
        }
      }
      if (values.length > 0) content[field.key] = values;
    } else if (field.kind === "boolean") {
      if (selected[0] === "是") content[field.key] = true;
      else if (selected[0] === "否") content[field.key] = false;
      else if (custom) {
        const lower = custom.toLowerCase();
        if (["true", "yes", "y", "1", "是"].includes(lower))
          content[field.key] = true;
        else if (["false", "no", "n", "0", "否"].includes(lower))
          content[field.key] = false;
      }
    } else if (field.kind === "text") {
      if (custom) content[field.key] = custom;
    } else if (field.kind === "number" || field.kind === "integer") {
      if (custom) {
        const n = Number(custom);
        if (
          Number.isFinite(n) &&
          (field.kind !== "integer" || Number.isInteger(n))
        )
          content[field.key] = n;
      }
    }
  }

  for (const reqKey of plan.required) {
    const field = fieldsByKey.get(reqKey);
    const hasPrimary = content[reqKey] !== undefined;
    const hasOther =
      field?.otherKey !== undefined && content[field.otherKey] !== undefined;
    if (!hasPrimary && !hasOther) return { action: "cancel" };
  }

  return { action: "accept", content };
}
