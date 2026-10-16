import { z, type ZodTypeAny } from "zod";
import { Ajv, type ErrorObject, type Options } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Ajv2019 } from "ajv/dist/2019.js";
import addFormatsImport from "ajv-formats";
import type { Json } from "../types.js";

export interface SchemaConversion {
  schema: ZodTypeAny;
  /** Whether the schema is validated and advertised without dropping constraints. */
  lossless: boolean;
  notes: string[];
}

const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);
const SCHEMA_ARRAYS = new Set(["oneOf", "anyOf", "allOf", "prefixItems"]);
const SCHEMA_VALUES = new Set(["items", "additionalProperties", "additionalItems", "propertyNames", "contains", "not", "if", "then", "else", "unevaluatedItems", "unevaluatedProperties"]);
const options: Options = {
  allErrors: true, strictSchema: true, strictTypes: false, strictTuples: false,
  strictRequired: false, allowUnionTypes: true, ownProperties: true,
  // Validation must never coerce, strip, or fill arguments before native call-ID matching.
  coerceTypes: false, useDefaults: false, removeAdditional: false,
};
const adapters = new WeakMap<ZodTypeAny, { schema: Record<string, Json>; object: boolean }>();
const addFormats = addFormatsImport as unknown as (ajv: Ajv) => void;

/** The official MCP server needs a ZodObject, but Zod's JSON Schema converter
 * silently loses some constraints. Validate with JSON Schema itself and use a
 * non-transforming Zod adapter only for the public MCP registration API. */
export function jsonSchemaToZod(schema: Record<string, Json>): SchemaConversion {
  const notes: string[] = [];
  const prepare = (value: Json, path: string): Json => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const entries: Array<[string, Json]> = [];
    for (const [key, child] of Object.entries(value)) {
      if (key === "default") {
        notes.push(`${path}: default annotation is not applied to caller arguments`);
        continue;
      }
      // Extension keywords are annotations, not executable custom validators.
      if (key.startsWith("x-")) continue;
      if (SCHEMA_MAPS.has(key) && child && typeof child === "object" && !Array.isArray(child)) {
        entries.push([key, Object.fromEntries(Object.entries(child).map(([name, nested]) => [name, prepare(nested, `${path}/${key}/${name}`)]))]);
      } else if ((SCHEMA_ARRAYS.has(key) || key === "items") && Array.isArray(child)) {
        entries.push([key, child.map((nested, index) => prepare(nested, `${path}/${key}/${index}`))]);
      } else if (SCHEMA_VALUES.has(key)) entries.push([key, prepare(child, `${path}/${key}`)]);
      else entries.push([key, child]);
    }
    return Object.fromEntries(entries);
  };

  try {
    const prepared = prepare(schema, "$") as Record<string, Json>;
    if (declaresRootPrototype(prepared)) throw new Error("The official MCP transport cannot preserve a root __proto__ parameter");
    const dialect = typeof schema.$schema === "string" ? schema.$schema : "";
    const validator = dialect.includes("2020-12") || (!dialect && schema.$defs)
      ? new Ajv2020(options)
      : dialect.includes("2019-09") ? new Ajv2019(options) : new Ajv(options);
    addFormats(validator);
    const validate = validator.compile(prepared);
    if (prepared.$async) throw new Error("Asynchronous tool schemas are not supported");
    const verify = (value: unknown, context: z.RefinementCtx): void => {
      if (!validate(value)) for (const error of validate.errors ?? []) {
        context.addIssue({ code: "custom", message: validationMessage(error), path: pointerPath(error.instancePath) });
      }
    };
    const adapted = z.any().superRefine(verify).meta(prepared);
    // Keep the validator non-transforming, including JSON keys named __proto__.
    // Catalog listing uses public MCP ListToolsRequestSchema rather than the
    // high-level ZodObject advertiser, which cannot preserve every JSON value.
    adapters.set(adapted, { schema: prepared, object: requiresObject(prepared) });
    // Metadata is public Zod API and preserves refs, composition and constraints
    // in list_tools, rather than trying to reconstruct them from Zod checks.
    z.toJSONSchema(adapted, { target: "draft-7" });
    return { schema: adapted, lossless: true, notes };
  } catch (error) {
    notes.push(`$: ${error instanceof Error ? error.message : "schema conversion failed"}`);
    return { schema: z.never(), lossless: false, notes };
  }
}

function validationMessage(error: ErrorObject): string {
  return `${error.keyword}: ${error.message ?? "invalid tool argument"}`;
}
function pointerPath(pointer: string): string[] {
  return pointer ? pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~")) : [];
}
function declaresRootPrototype(schema: Record<string, Json>): boolean {
  const properties = schema.properties;
  if (properties && typeof properties === "object" && Object.hasOwn(properties, "__proto__")) return true;
  return [schema.allOf, schema.anyOf, schema.oneOf].some((branches) => Array.isArray(branches) && branches.some((branch) =>
    branch && typeof branch === "object" && !Array.isArray(branch) && declaresRootPrototype(branch)));
}
function requiresObject(schema: Record<string, Json>, root = schema, seen = new Set<string>()): boolean {
  if (schema.type === "object" || (Array.isArray(schema.type) && schema.type.length > 0 && schema.type.every((type) => type === "object"))) return true;
  const object = (value: Json): boolean => Boolean(value && typeof value === "object" && !Array.isArray(value) && requiresObject(value, root, new Set(seen)));
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#") && !seen.has(schema.$ref)) {
    seen.add(schema.$ref);
    let target: Json = root;
    const path = schema.$ref.slice(1);
    if (!path || path.startsWith("/")) {
      for (const key of path ? pointerPath(path) : []) {
        if (!target || typeof target !== "object" || !Object.hasOwn(target, key)) { target = null; break; }
        target = (target as Record<string, Json>)[key]!;
      }
      if (object(target)) return true;
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf.some(object)) return true;
  return [schema.oneOf, schema.anyOf].some((branches) => Array.isArray(branches) && branches.length > 0 && branches.every(object));
}

/** Only object input contracts may be registered as MCP tools. */
export function zodToolInputSchema(schema: ZodTypeAny): ZodTypeAny {
  if (!adapters.get(schema)?.object) throw new Error("Unsupported MCP tool input schema: expected an object input");
  return schema;
}

export function toolJsonSchema(schema: ZodTypeAny): Record<string, Json> {
  const adapter = adapters.get(zodToolInputSchema(schema))!;
  return structuredClone({ type: "object", ...adapter.schema });
}

/** @deprecated A raw shape loses JSON Schema constraints; register the complete validator. */
export function zodObjectShape(_schema: ZodTypeAny): Record<string, ZodTypeAny> {
  throw new Error("A raw Zod shape cannot preserve the tool JSON Schema; use the complete validator and toolJsonSchema");
}
