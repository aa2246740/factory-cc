import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const usage = `Usage: npm run control -- <command>

  approvals                       List pending native tool approvals
  sessions                        List bridge sessions
  approve <id> [--input <file>]    Allow once; optionally supply an updated JSON input object
  deny <id> [--message <text>]     Deny a pending request
  cancel <sessionId>              Cancel a bridge session

Set BRIDGE_ADMIN_TOKEN. BRIDGE_CONTROL_URL defaults to http://127.0.0.1:18787.
Only local HTTP(S) origins are accepted. The token is never accepted in arguments.`;

export function controlBaseUrl(value: string | undefined): string {
  let url: URL;
  try { url = new URL(value ?? "http://127.0.0.1:18787"); }
  catch { throw new Error("BRIDGE_CONTROL_URL must be a local HTTP(S) origin."); }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!local || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("BRIDGE_CONTROL_URL must be a local HTTP(S) origin without credentials, query, or path.");
  }
  return url.origin;
}

export async function runControl(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const [command, id, flag, value, ...rest] = args;
  if (command === "--help" || command === "-h" || !command) return usage;
  let path: string;
  let body: Record<string, unknown> | undefined;
  if (command === "approvals" || command === "sessions") {
    if (args.length !== 1) throw new Error(`Unexpected arguments for ${command}. Use --help.`);
    path = `/internal/${command}`;
  } else if (command === "approve" || command === "deny") {
    if (!id || id.startsWith("-") || rest.length || (flag && (flag !== (command === "approve" ? "--input" : "--message") || !value)) || (!flag && args.length !== 2)) {
      throw new Error(`Invalid arguments for ${command}. Use --help.`);
    }
    path = `/internal/approvals/${encodeURIComponent(id)}`;
    body = { decision: command === "approve" ? "allow" : "deny" };
    if (command === "approve" && flag) {
      let input: unknown;
      try { input = JSON.parse(readFileSync(value, "utf8")); }
      catch { throw new Error("Unable to read --input as JSON; no approval was sent."); }
      if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("--input must contain a JSON object; no approval was sent.");
      body.updatedInput = input;
    }
    if (command === "deny") body.message = value ?? "User denied this request through Relay Bridge CLI.";
  } else if (command === "cancel") {
    if (!id || id.startsWith("-") || args.length !== 2) throw new Error("cancel requires exactly one session ID. Use --help.");
    path = "/internal/cancel";
    body = { sessionId: id };
  } else {
    throw new Error("Unknown control command. Use --help.");
  }

  const baseUrl = controlBaseUrl(env.BRIDGE_CONTROL_URL);
  const token = env.BRIDGE_ADMIN_TOKEN?.trim();
  if (!token) throw new Error("BRIDGE_ADMIN_TOKEN is required.");
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Do not expose fetch causes, URLs, headers, or user-provided input in errors.
    // A failed response may follow a successful mutation: no implicit retries.
    throw new Error("Could not reach the local bridge. Check the URL and server, then list requests before retrying a decision.");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("Administrator authentication failed or admin access is disabled.");
    if (response.status === 404 || response.status === 409) throw new Error("The request or session is unknown, expired, or already handled. Refresh the list.");
    throw new Error(`Bridge control request failed (HTTP ${response.status}).`);
  }
  try { return await response.json(); }
  catch { throw new Error("Bridge returned invalid JSON; list requests before retrying a decision."); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runControl(process.argv.slice(2)).then((result) => {
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Bridge control failed.");
    process.exitCode = 1;
  });
}
