import { z, type ZodTypeAny } from "zod";
import type { Json } from "../types.js";

export interface SchemaConversion {
  schema: ZodTypeAny;
  /** Whether validation and caller-supplied JSON values are preserved. */
  lossless: boolean;
  notes: string[];
}

const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const SCHEMA_ARRAYS = new Set(["oneOf", "anyOf", "allOf", "prefixItems"]);
const SCHEMA_VALUES = new Set(["items", "additionalProperties", "additionalItems", "propertyNames", "contains", "not", "if", "then", "else", "unevaluatedItems", "unevaluatedProperties"]);
const ANNOTATIONS = new Set(["$schema", "$id", "id", "$anchor", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly", "contentEncoding", "contentMediaType", "contentSchema"]);
const CONSTRAINTS = new Set([
  "type", "$ref", "enum", "const", "required", "minProperties", "maxProperties",
  "minItems", "maxItems", "uniqueItems", "minContains", "maxContains",
  "minLength", "maxLength", "pattern", "format", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "dependentRequired",
]);
const FORMATS = new Set(["email", "uri", "uuid", "guid", "date-time", "date", "time", "duration", "hostname", "ipv4", "ipv6"]);
const TYPED_CONSTRAINTS = new Set([
  "properties", "patternProperties", "required", "additionalProperties", "minProperties", "maxProperties", "propertyNames",
  "items", "prefixItems", "additionalItems", "minItems", "maxItems", "contains", "uniqueItems", "minContains", "maxContains",
  "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
]);

export function jsonSchemaToZod(schema: Record<string, Json>): SchemaConversion {
  const notes: string[] = [];
  let lossless = true;
  const lose = (path: string, message: string): void => {
    lossless = false;
    notes.push(`${path}: ${message}`);
  };

  // Use Zod's converter for nested records, local/recursive references and
  // composition. It preserves JSON Schema's additionalProperties=true default.
  // Traverse schema positions only: tool parameters may themselves contain
  // keys called "default", "properties", or "$ref" as ordinary instance data.
  const prepare = (value: Json, path: string): Json => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const out: Record<string, Json> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "default") {
        notes.push(`${path}: default annotation is not applied to caller arguments`);
        continue;
      }
      if (!ANNOTATIONS.has(key) && !CONSTRAINTS.has(key) && !SCHEMA_MAPS.has(key)
          && !SCHEMA_ARRAYS.has(key) && !SCHEMA_VALUES.has(key) && !key.startsWith("x-")) {
        lose(path, `unsupported keyword ${key}`);
      }
      if (key === "format" && (typeof child !== "string" || !FORMATS.has(child))) {
        lose(path, `format ${JSON.stringify(child)} is not faithfully validated`);
      }
      if (!value.type && !value.$ref && TYPED_CONSTRAINTS.has(key)) {
        lose(path, `${key} without an explicit type is not faithfully validated`);
      }
      if (SCHEMA_MAPS.has(key) && child && typeof child === "object" && !Array.isArray(child)) {
        out[key] = Object.fromEntries(Object.entries(child).map(([name, nested]) => [name, prepare(nested, `${path}/${key}/${name}`)]));
      } else if ((SCHEMA_ARRAYS.has(key) || key === "items") && Array.isArray(child)) {
        out[key] = child.map((nested, index) => prepare(nested, `${path}/${key}/${index}`));
      } else if (SCHEMA_VALUES.has(key)) {
        out[key] = prepare(child, `${path}/${key}`);
      } else {
        // Defining __proto__ as data must not mutate the schema object's prototype.
        Object.defineProperty(out, key, { value: child, enumerable: true, configurable: true, writable: true });
      }
    }
    if (Array.isArray(value.required)) {
      const properties = value.properties && typeof value.properties === "object" && !Array.isArray(value.properties) ? value.properties : {};
      if (value.required.some((name) => typeof name === "string" && !Object.hasOwn(properties, name))) {
        lose(path, "required keys without a declared property are not faithfully validated");
      }
    }
    // Zod's enum/const fast path does not intersect sibling type/constraints.
    if (value.enum !== undefined && value.const !== undefined) {
      lose(path, "combined enum and const constraints are not faithfully validated");
    }
    if ((value.enum !== undefined || value.const !== undefined)
        && Object.keys(value).some((key) => TYPED_CONSTRAINTS.has(key))) {
      lose(path, "constraints alongside enum/const are not faithfully validated");
    }
    const literals = Array.isArray(value.enum) ? value.enum : value.const !== undefined ? [value.const] : [];
    if (value.type && literals.some((literal) => !matchesType(literal, value.type))) {
      lose(path, "enum/const values conflicting with type are not faithfully validated");
    }
    return out;
  };

  try {
    const prepared = prepare(schema, "$") as Parameters<typeof z.fromJSONSchema>[0];
    const converted = z.fromJSONSchema(prepared, { defaultTarget: schema.$defs ? "draft-2020-12" : "draft-7" });
    // Catch schema forms the MCP advertiser cannot serialize before registration.
    z.toJSONSchema(converted, { target: "draft-7" });
    return { schema: converted, lossless, notes };
  } catch (error) {
    lose("$", error instanceof Error ? error.message : "schema conversion failed");
    // Fail closed. A permissive {} fallback could erase validation while
    // claiming that an unsupported tool's arguments were faithfully relayed.
    return { schema: z.never(), lossless: false, notes };
  }
}

function matchesType(value: Json, type: Json): boolean {
  if (Array.isArray(type)) return type.some((item) => matchesType(value, item));
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

/** MCP's list_tools path accepts complete object schemas. It cannot advertise
 * unions/intersections at the root and otherwise silently substitutes {}. */
export function zodToolInputSchema(schema: ZodTypeAny): z.ZodObject {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error("Unsupported MCP tool input schema: expected a complete ZodObject; root unions/intersections cannot be registered losslessly");
  }
  return schema;
}

/** @deprecated Register zodToolInputSchema(schema) instead so root strictness
 * and additionalProperties validation survive MCP registration. */
export function zodObjectShape(schema: ZodTypeAny): Record<string, ZodTypeAny> {
  return zodToolInputSchema(schema).shape;
}
