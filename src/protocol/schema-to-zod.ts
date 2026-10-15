import { z, type ZodTypeAny } from "zod";
import type { Json } from "../types.js";

export interface SchemaConversion {
  schema: ZodTypeAny;
  lossless: boolean;
  notes: string[];
}

export function jsonSchemaToZod(schema: Record<string, Json>, refs: Map<string, Record<string, Json>> = new Map()): SchemaConversion {
  const notes: string[] = [];
  let lossless = true;

  const convert = (node: Record<string, Json>, path: string): ZodTypeAny => {
    if (typeof node.$ref === "string") {
      const ref = resolveLocalRef(node.$ref, schema, refs);
      if (!ref) {
        lossless = false;
        notes.push(`${path}: unresolved $ref ${node.$ref}`);
        return z.record(z.string(), z.any());
      }
      return convert(ref, path);
    }

    if (Array.isArray(node.enum) && node.enum.length > 0) {
      const values = node.enum.filter((item): item is string => typeof item === "string");
      if (values.length === node.enum.length && values.length > 0) {
        return z.enum(values as [string, ...string[]]);
      }
      return z.any();
    }

    if (Array.isArray(node.oneOf) || Array.isArray(node.anyOf)) {
      const variants = ((node.oneOf ?? node.anyOf) as Record<string, Json>[]).map((item, i) =>
        convert(item, `${path}/${node.oneOf ? "oneOf" : "anyOf"}/${i}`),
      );
      if (variants.length === 0) return z.any();
      if (variants.length === 1) return variants[0]!;
      return z.union(variants as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
    }

    const type = node.type;
    if (type === "string") return z.string();
    if (type === "number") return z.number();
    if (type === "integer") return z.number().int();
    if (type === "boolean") return z.boolean();
    if (type === "null") return z.null();
    if (type === "array") {
      const items = node.items && typeof node.items === "object" && !Array.isArray(node.items)
        ? convert(node.items as Record<string, Json>, `${path}/items`)
        : z.any();
      return z.array(items);
    }
    if (type === "object" || node.properties) {
      const properties = (node.properties ?? {}) as Record<string, Record<string, Json>>;
      const required = new Set(Array.isArray(node.required) ? node.required.filter((x): x is string => typeof x === "string") : []);
      const shape: Record<string, ZodTypeAny> = {};
      for (const [key, child] of Object.entries(properties)) {
        let field = convert(child, `${path}.${key}`);
        if (typeof child.description === "string") field = field.describe(child.description);
        shape[key] = required.has(key) ? field : field.optional();
      }
      let object = z.object(shape);
      if (node.additionalProperties === false) object = object.strict();
      return object;
    }

    if (Array.isArray(type)) {
      lossless = false;
      notes.push(`${path}: union type ${JSON.stringify(type)} approximated`);
      return z.any();
    }

    lossless = false;
    notes.push(`${path}: unsupported schema ${JSON.stringify(node)}`);
    return z.record(z.string(), z.any());
  };

  return { schema: convert(schema, "$"), lossless, notes };
}

export function zodObjectShape(schema: ZodTypeAny): Record<string, ZodTypeAny> {
  if (schema && typeof schema === "object" && "shape" in schema && schema.shape && typeof schema.shape === "object") {
    return schema.shape as Record<string, ZodTypeAny>;
  }
  return {};
}

function resolveLocalRef(
  ref: string,
  root: Record<string, Json>,
  cache: Map<string, Record<string, Json>>,
): Record<string, Json> | undefined {
  if (cache.has(ref)) return cache.get(ref);
  if (ref.startsWith("http://") || ref.startsWith("https://")) return undefined;
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref.slice(2).split("/");
  let current: Json = root;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = current[part] as Json;
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
  cache.set(ref, current);
  return current;
}
