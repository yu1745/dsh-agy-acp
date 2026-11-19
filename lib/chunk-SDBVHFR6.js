// src/google-acp-elicitation.ts
var isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
var CANCELLATION_CODES = /* @__PURE__ */ new Set([
  "ASK_CANCELLED",
  "ASK_ABORTED",
  "NO_PROVIDER"
]);
function isUserQuestionCancellation(error) {
  const code = error?.code;
  return typeof code === "string" && CANCELLATION_CODES.has(code);
}
function extractChoiceOptions(schema) {
  if (!isPlainObject(schema)) return null;
  const rawOptions = [];
  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : void 0;
  if (oneOf) {
    for (const item of oneOf) {
      if (!isPlainObject(item) || item.const === void 0) continue;
      const value = String(item.const);
      const rawTitle = typeof item.title === "string" && item.title ? item.title : value;
      const description = typeof item.description === "string" && item.description.trim() ? item.description : void 0;
      rawOptions.push({ value, rawTitle, description });
    }
  } else if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    for (let i = 0; i < schema.enum.length; i++) {
      const enumVal = schema.enum[i];
      if (enumVal === void 0 || enumVal === null) continue;
      const value = String(enumVal);
      const rawTitle = typeof names[i] === "string" && names[i] ? names[i] : value;
      rawOptions.push({ value, rawTitle });
    }
  }
  if (!rawOptions.length) return null;
  const counts = /* @__PURE__ */ new Map();
  for (const option of rawOptions)
    counts.set(option.rawTitle, (counts.get(option.rawTitle) ?? 0) + 1);
  const usedLabels = /* @__PURE__ */ new Set();
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
      ...option.description ? { description: option.description } : {}
    };
  });
}
function classifyChoiceField(prop) {
  if (prop.type === "array") {
    const options = extractChoiceOptions(prop.items);
    return options ? { kind: "multi", options } : null;
  }
  if (prop.type === "string" || prop.type === void 0) {
    const options = extractChoiceOptions(prop);
    return options ? { kind: "single", options } : null;
  }
  return null;
}
function isPlainStringField(prop) {
  return isPlainObject(prop) && prop.type === "string" && prop.oneOf === void 0 && prop.anyOf === void 0 && prop.enum === void 0;
}
function parseAcpElicitation(params) {
  if (params?.mode !== "form") return null;
  const schema = params.requestedSchema;
  if (!isPlainObject(schema) || schema.type !== "object") return null;
  const properties = schema.properties;
  if (!isPlainObject(properties)) return null;
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((k) => typeof k === "string") : []
  );
  const consumed = /* @__PURE__ */ new Set();
  const pairedOther = /* @__PURE__ */ new Map();
  for (const [key, prop] of Object.entries(properties)) {
    if (!isPlainObject(prop) || !classifyChoiceField(prop)) continue;
    const otherKey = `${key}_other`;
    if (Object.hasOwn(properties, otherKey) && !required.has(otherKey) && isPlainStringField(properties[otherKey])) {
      pairedOther.set(key, otherKey);
      consumed.add(otherKey);
    }
  }
  const questions = [];
  const fields = [];
  for (const [key, prop] of Object.entries(properties)) {
    if (consumed.has(key)) continue;
    if (!isPlainObject(prop)) {
      if (required.has(key)) return null;
      continue;
    }
    let plan;
    let itemOptions;
    const choice = classifyChoiceField(prop);
    if (choice) {
      const labelToValue = new Map(
        choice.options.map((option) => [option.label, option.value])
      );
      plan = {
        key,
        kind: choice.kind,
        ...pairedOther.has(key) ? { otherKey: pairedOther.get(key) } : {},
        options: choice.options,
        labelToValue
      };
      itemOptions = choice.options.map((option) => ({
        label: option.label,
        ...option.description ? { description: option.description } : {}
      }));
    } else if (prop.type === "boolean") {
      plan = { key, kind: "boolean" };
      itemOptions = [{ label: "\u662F" }, { label: "\u5426" }];
    } else if (isPlainStringField(prop)) {
      plan = { key, kind: "text" };
    } else if (prop.type === "number" || prop.type === "integer") {
      plan = { key, kind: prop.type };
    } else {
      if (required.has(key)) return null;
      continue;
    }
    const questionText = typeof prop.title === "string" && prop.title.trim() ? prop.title : key;
    const detail = typeof prop.description === "string" && prop.description.trim() ? prop.description : void 0;
    fields.push(plan);
    questions.push({
      id: key,
      header: "Antigravity",
      question: questionText,
      ...detail ? { detail } : {},
      ...itemOptions ? { options: itemOptions } : {},
      multiSelect: plan.kind === "multi"
    });
  }
  if (!questions.length) return null;
  return { questions, fields, required };
}
function matchChoiceOption(field, text) {
  const byLabel = field.labelToValue?.get(text);
  if (byLabel !== void 0) return byLabel;
  const options = field.options ?? [];
  const exact = options.find((o) => o.label === text || o.value === text);
  if (exact) return exact.value;
  const lower = text.toLowerCase();
  return options.find(
    (o) => o.label.toLowerCase() === lower || o.value.toLowerCase() === lower
  )?.value;
}
function buildAcpElicitationResponse(plan, answer) {
  const answers = new Map(
    Array.isArray(answer?.answers) ? answer.answers.filter((a) => a && typeof a.id === "string").map((a) => [a.id, a]) : []
  );
  const content = /* @__PURE__ */ Object.create(null);
  const fieldsByKey = new Map(plan.fields.map((field) => [field.key, field]));
  for (const field of plan.fields) {
    const item = answers.get(field.key);
    const selected = Array.isArray(item?.selected) ? item.selected.filter((s) => typeof s === "string") : [];
    const custom = typeof item?.custom === "string" ? item.custom.trim() : "";
    if (field.kind === "single") {
      const selectedValues = selected.map((label) => field.labelToValue?.get(label)).filter((v) => v !== void 0);
      if (custom) {
        if (field.otherKey) {
          content[field.otherKey] = custom;
        } else {
          const matched = matchChoiceOption(field, custom);
          if (matched !== void 0) content[field.key] = matched;
          else if (selectedValues.length >= 1)
            content[field.key] = selectedValues[0];
        }
      } else if (selectedValues.length >= 1) {
        content[field.key] = selectedValues[0];
      }
    } else if (field.kind === "multi") {
      const values = [];
      const seen = /* @__PURE__ */ new Set();
      for (const label of selected) {
        const value = field.labelToValue?.get(label);
        if (value !== void 0 && !seen.has(value)) {
          seen.add(value);
          values.push(value);
        }
      }
      if (custom) {
        if (field.otherKey) {
          content[field.otherKey] = custom;
        } else {
          const matched = matchChoiceOption(field, custom);
          if (matched !== void 0 && !seen.has(matched)) {
            seen.add(matched);
            values.push(matched);
          }
        }
      }
      if (values.length > 0) content[field.key] = values;
    } else if (field.kind === "boolean") {
      if (selected[0] === "\u662F") content[field.key] = true;
      else if (selected[0] === "\u5426") content[field.key] = false;
      else if (custom) {
        const lower = custom.toLowerCase();
        if (["true", "yes", "y", "1", "\u662F"].includes(lower))
          content[field.key] = true;
        else if (["false", "no", "n", "0", "\u5426"].includes(lower))
          content[field.key] = false;
      }
    } else if (field.kind === "text") {
      if (custom) content[field.key] = custom;
    } else if (field.kind === "number" || field.kind === "integer") {
      if (custom) {
        const n = Number(custom);
        if (Number.isFinite(n) && (field.kind !== "integer" || Number.isInteger(n)))
          content[field.key] = n;
      }
    }
  }
  for (const reqKey of plan.required) {
    const field = fieldsByKey.get(reqKey);
    const hasPrimary = content[reqKey] !== void 0;
    const hasOther = field?.otherKey !== void 0 && content[field.otherKey] !== void 0;
    if (!hasPrimary && !hasOther) return { action: "cancel" };
  }
  return { action: "accept", content };
}

export {
  isUserQuestionCancellation,
  parseAcpElicitation,
  buildAcpElicitationResponse
};
//# sourceMappingURL=chunk-SDBVHFR6.js.map
