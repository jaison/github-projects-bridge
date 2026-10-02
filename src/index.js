import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createOAuth } from "./oauth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 80);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DEFAULT_OWNER = process.env.GITHUB_OWNER;

if (!GITHUB_TOKEN || !DEFAULT_OWNER) {
  throw new Error("Configure GITHUB_TOKEN and GITHUB_OWNER.");
}

const oauth = createOAuth();

function bearerToken(req) {
  const value = String(req.headers.authorization || "");
  return value.slice(0, 7).toLowerCase() === "bearer " ? value.slice(7).trim() : "";
}

async function graphql(query, variables = {}) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + GITHUB_TOKEN,
      "Content-Type": "application/json",
      "User-Agent": "github-projects-bridge"
    },
    body: JSON.stringify({ query, variables })
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(JSON.stringify(payload.errors || payload));
  }
  return payload.data;
}

function registerTool(server, authContext, name, description, schema, handler) {
  const scope = ["create_project_draft", "update_project_single_select", "delete_project_item"].includes(name)
    ? "projects:write"
    : "projects:read";
  server.registerTool(name, {
    description,
    inputSchema: z.object(schema),
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [scope] }] }
  }, async (args, context) => {
    const claims = authContext.claims;
    const allowed = claims && (claims.scopes.includes(scope) || (scope === "projects:read" && claims.scopes.includes("projects:write")));
    if (!allowed) {
      return {
        content: [{ type: "text", text: "OAuth scope required: " + scope }],
        isError: true,
        _meta: {
          "mcp/www_authenticate": 'Bearer resource_metadata="' + oauth.publicUrl + '/.well-known/oauth-protected-resource", scope="' + scope + '"'
        }
      };
    }
    return handler(args, context);
  });
}

function makeMcpServer(authContext) {
  const server = new McpServer({ name: "github-projects-bridge", version: "0.1.0" });

  registerTool(server,
    "list_projects",
    "List GitHub Projects V2 owned by a user or organization.",
    {
      owner: z.string().optional(),
      owner_type: z.enum(["user", "organization"]).default("user"),
      first: z.number().int().min(1).max(100).default(30)
    },
    async ({ owner = DEFAULT_OWNER, owner_type, first }) => {
      const query = owner_type === "organization"
        ? "query($login:String!,$first:Int!){organization(login:$login){projectsV2(first:$first){nodes{id number title shortDescription url closed}}}}"
        : "query($login:String!,$first:Int!){user(login:$login){projectsV2(first:$first){nodes{id number title shortDescription url closed}}}}";
      const key = owner_type === "organization" ? "organization" : "user";
      const data = await graphql(query, { login: owner, first });
      return { content: [{ type: "text", text: JSON.stringify(data[key]?.projectsV2?.nodes ?? [], null, 2) }] };
    }
  );

  registerTool(server,
    "get_project",
    "Get a GitHub Project V2, including its fields and options.",
    { project_id: z.string() },
    async ({ project_id }) => {
      const query = "query($id:ID!){node(id:$id){... on ProjectV2{id number title shortDescription url closed fields(first:50){nodes{... on ProjectV2FieldCommon{id name dataType} ... on ProjectV2SingleSelectField{id name dataType options{id name}}}}}}}";
      const data = await graphql(query, { id: project_id });
      return { content: [{ type: "text", text: JSON.stringify(data.node, null, 2) }] };
    }
  );

  registerTool(server,
    "list_project_items",
    "List cards/items in a GitHub Project V2.",
    {
      project_id: z.string(),
      first: z.number().int().min(1).max(100).default(50)
    },
    async ({ project_id, first }) => {
      const query = "query($id:ID!,$first:Int!){node(id:$id){... on ProjectV2{items(first:$first){nodes{id type content{... on Issue{title number url} ... on PullRequest{title number url} ... on DraftIssue{title body}} fieldValues(first:20){nodes{... on ProjectV2ItemFieldTextValue{text field{id name}} ... on ProjectV2ItemFieldNumberValue{number field{id name}} ... on ProjectV2ItemFieldDateValue{date field{id name}} ... on ProjectV2ItemFieldSingleSelectValue{name optionId field{id name}}}}}}}}}";
      const data = await graphql(query, { id: project_id, first });
      return { content: [{ type: "text", text: JSON.stringify(data.node?.items?.nodes ?? [], null, 2) }] };
    }
  );

  registerTool(server,
    "create_project_draft",
    "Create a draft card in a GitHub Project V2.",
    {
      project_id: z.string(),
      title: z.string(),
      body: z.string().optional()
    },
    async ({ project_id, title, body = "" }) => {
      const query = "mutation($input:AddProjectV2DraftIssueInput!){addProjectV2DraftIssue(input:$input){projectItem{id}}}";
      const data = await graphql(query, { input: { projectId: project_id, title, body } });
      return { content: [{ type: "text", text: JSON.stringify(data.addProjectV2DraftIssue, null, 2) }] };
    }
  );

  registerTool(server,
    "update_project_single_select",
    "Set a single-select field (for example Status or Priority) on a project item.",
    {
      project_id: z.string(),
      item_id: z.string(),
      field_id: z.string(),
      option_id: z.string()
    },
    async ({ project_id, item_id, field_id, option_id }) => {
      const query = "mutation($input:UpdateProjectV2ItemFieldValueInput!){updateProjectV2ItemFieldValue(input:$input){projectV2Item{id}}}";
      const data = await graphql(query, {
        input: {
          projectId: project_id,
          itemId: item_id,
          fieldId: field_id,
          value: { singleSelectOptionId: option_id }
        }
      });
      return { content: [{ type: "text", text: JSON.stringify(data.updateProjectV2ItemFieldValue, null, 2) }] };
    }
  );

  registerTool(server,
    "delete_project_item",
    "Remove an item/card from a GitHub Project V2.",
    { project_id: z.string(), item_id: z.string() },
    async ({ project_id, item_id }) => {
      const query = "mutation($projectId:ID!,$itemId:ID!){deleteProjectV2Item(input:{projectId:$projectId,itemId:$itemId}){deletedItemId}}";
      const data = await graphql(query, { projectId: project_id, itemId: item_id });
      return { content: [{ type: "text", text: JSON.stringify(data.deleteProjectV2Item, null, 2) }] };
    }
  );

  return server;
}

const transports = new Map();
const transportSubjects = new Map();
const transportAuth = new Map();
const transportSubjects = new Map();
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url || "/", oauth.publicUrl);
  if (await oauth.handle(req, res, url)) return;

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "github-projects-bridge" }));
    return;
  }
  if (url.pathname !== "/mcp") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) {
      res.writeHead(413);
      res.end("Request body too large");
      return;
    }
  }
  let parsed;
  try {
    parsed = body ? JSON.parse(body) : undefined;
  } catch {
    res.writeHead(400);
    res.end("Invalid JSON");
    return;
  }

  const claims = oauth.verifyAccessToken(bearerToken(req));
  if (!claims) {
    const metadataUrl = oauth.publicUrl + "/.well-known/oauth-protected-resource";
    res.writeHead(401, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "WWW-Authenticate": 'Bearer resource_metadata="' + metadataUrl + '", scope="projects:read"'
    });
    res.end(JSON.stringify({ error: "unauthorized", error_description: "A valid OAuth access token is required." }));
    return;
  }

  const sessionId = req.headers["mcp-session-id"];
  let transport = sessionId ? transports.get(sessionId) : undefined;
  let authContext = sessionId ? transportAuth.get(sessionId) : undefined;
  if (transport && transportSubjects.get(sessionId) !== claims.sub) {
    res.writeHead(404);
    res.end("Unknown MCP session");
    return;
  }
  if (transport && authContext) authContext.claims = claims;
  if (!transport && req.method === "POST") {
    authContext = { claims };
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => {
        transports.set(id, transport);
        transportSubjects.set(id, claims.sub);
        transportAuth.set(id, authContext);
      }
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) {
        transports.delete(id);
        transportSubjects.delete(id);
        transportAuth.delete(id);
      }
    };
    const server = makeMcpServer(authContext);
    await server.connect(transport);
  }
  if (!transport) {
    res.writeHead(400);
    res.end("Bad Request: missing or invalid MCP session");
    return;
  }
  await transport.handleRequest(req, res, parsed);
});

httpServer.listen(PORT, "0.0.0.0", () => {
  process.stdout.write("GitHub Projects MCP bridge listening on port " + PORT + "\n");
});
