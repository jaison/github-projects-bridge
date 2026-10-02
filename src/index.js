import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createOAuth } from "./oauth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { registerProjectManagementTools } from "./project-management.js";

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
  const operation = query.match(/^(?:query|mutation)(?:\([^)]*\))?\{([A-Za-z0-9_]+)/)?.[1] || "unknown";
  const startedAt = Date.now();

  let response;
  let payload;
  try {
    response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + GITHUB_TOKEN,
        "Content-Type": "application/json",
        "User-Agent": "github-projects-bridge"
      },
      body: JSON.stringify({ query, variables })
    });
    payload = await response.json();
  } catch (error) {
    console.error(
      "[GPB][GraphQL] op=%s transport_error=%s duration_ms=%d",
      operation,
      error?.message || String(error),
      Date.now() - startedAt
    );
    throw error;
  }

  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  console.log(
    "[GPB][GraphQL] op=%s http=%d errors=%d duration_ms=%d",
    operation,
    response.status,
    errors.length,
    Date.now() - startedAt
  );

  if (errors.length) {
    console.error("[GPB][GraphQL] op=%s errors=%s", operation, JSON.stringify(errors));
  }

  if (!response.ok || errors.length) {
    throw new Error(JSON.stringify(errors.length ? errors : payload));
  }

  if (!payload?.data) {
    console.error("[GPB][GraphQL] op=%s missing_data payload=%s", operation, JSON.stringify(payload));
    throw new Error("GitHub GraphQL returned no data.");
  }

  return payload.data;
}

async function githubRestJson(path) {
  const response = await fetch("https://api.github.com" + path, {
    headers: {
      Authorization: "Bearer " + GITHUB_TOKEN,
      Accept: "application/vnd.github+json",
      "User-Agent": "github-projects-bridge"
    }
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error("GitHub REST request failed (" + response.status + "): " + JSON.stringify(payload));
  }
  return payload;
}

async function resolveRepositoryId(repositoryIdOrFullName) {
  const value = String(repositoryIdOrFullName || "").trim();
  if (!value) throw new Error("repository_id must not be empty.");
  if (/^R_[A-Za-z0-9_-]+$/.test(value)) return value;

  if (/^\d+$/.test(value)) {
    const repository = await githubRestJson("/repositories/" + encodeURIComponent(value));
    if (!repository?.node_id) throw new Error("GitHub returned no node_id for repository " + value);
    return repository.node_id;
  }

  const normalized = value.replace(/^https:\/\/github\.com\//, "").replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/");
  if (parts.length === 2 && parts[0] && parts[1]) {
    const data = await graphql(
      "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id nameWithOwner}}",
      { owner: parts[0], name: parts[1] }
    );
    if (!data?.repository?.id) throw new Error("Repository not found: " + value);
    return data.repository.id;
  }

  return value;
}

async function readProject(projectId) {
  const query = "query($id:ID!){node(id:$id){... on ProjectV2{id number title shortDescription url closed}}}";
  const data = await graphql(query, { id: projectId });
  if (!data?.node) {
    throw new Error("Project not found after GitHub API call: " + projectId);
  }
  return data.node;
}

async function readProjectItems(projectId, first = 100) {
  const query = "query($id:ID!,$first:Int!){node(id:$id){... on ProjectV2{items(first:$first){nodes{id type content{... on Issue{title number url} ... on PullRequest{title number url} ... on DraftIssue{title body}} fieldValues(first:20){nodes{... on ProjectV2ItemFieldTextValue{text field{... on ProjectV2Field{id name} ... on ProjectV2IterationField{id name} ... on ProjectV2MultiSelectField{id name} ... on ProjectV2SingleSelectField{id name}}} ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2Field{id name} ... on ProjectV2IterationField{id name} ... on ProjectV2MultiSelectField{id name} ... on ProjectV2SingleSelectField{id name}}} ... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2Field{id name} ... on ProjectV2IterationField{id name} ... on ProjectV2MultiSelectField{id name} ... on ProjectV2SingleSelectField{id name}}} ... on ProjectV2ItemFieldIterationValue{iterationId field{... on ProjectV2IterationField{id name}}} ... on ProjectV2ItemFieldSingleSelectValue{name optionId field{... on ProjectV2Field{id name} ... on ProjectV2IterationField{id name} ... on ProjectV2MultiSelectField{id name} ... on ProjectV2SingleSelectField{id name}}}} ... on ProjectV2ItemFieldMultiSelectValue{value options{id name color description} field{... on ProjectV2MultiSelectField{id name}}}}}}}}}}";
  const data = await graphql(query, { id: projectId, first });
  const items = data?.node?.items?.nodes;
  if (!Array.isArray(items)) {
    throw new Error("Project items could not be read after GitHub API call: " + projectId);
  }
  return items;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function findProjectItemWithRetry(projectId, itemId, attempts = 5) {
  const delays = [0, 250, 500, 1000, 2000];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);

    const items = await readProjectItems(projectId);
    const item = findProjectItem(items, itemId);

    console.log(
      "[GPB][Verify] action=create_project_draft project=%s item=%s attempt=%d/%d found=%s",
      projectId,
      itemId,
      attempt + 1,
      attempts,
      item ? "yes" : "no"
    );

    if (item) return item;
  }

  return null;
}

function toolLogArgs(name, args) {
  const fields = ["project_id", "item_id", "field_id", "option_id", "title"];
  const parts = fields
    .filter(key => args?.[key] !== undefined)
    .map(key => key + "=" + JSON.stringify(String(args[key]).slice(0, 200)));
  if (args?.short_description !== undefined) parts.push("short_description=" + JSON.stringify(String(args.short_description).slice(0, 200)));
  if (args?.body !== undefined) parts.push("body_length=" + String(String(args.body).length));
  return parts.join(" ");
}

function verifyProjectUpdate(actual, expected) {
  if (expected.title !== undefined && actual.title !== expected.title) {
    throw new Error("Read-after-write verification failed for project title. Expected " + JSON.stringify(expected.title) + ", got " + JSON.stringify(actual.title));
  }
  if (expected.short_description !== undefined && actual.shortDescription !== expected.short_description) {
    throw new Error("Read-after-write verification failed for project description. Expected " + JSON.stringify(expected.short_description) + ", got " + JSON.stringify(actual.shortDescription));
  }
}

function findProjectItem(items, itemId) {
  return items.find(item => item?.id === itemId) || null;
}

async function resolveOwnerId(owner, ownerType) {
  const query = ownerType === "organization"
    ? "query($login:String!){organization(login:$login){id login}}"
    : "query($login:String!){user(login:$login){id login}}";
  const key = ownerType === "organization" ? "organization" : "user";
  const data = await graphql(query, { login: owner });
  const ownerNode = data?.[key];
  if (!ownerNode?.id) {
    throw new Error("GitHub " + ownerType + " not found: " + owner);
  }

  console.log(
    "[GPB][Owner] type=%s login=%s node_id=%s",
    ownerType,
    ownerNode.login,
    ownerNode.id
  );

  return ownerNode.id;
}

const REQUIRED_PROJECT_SCOPES = ["projects:read", "projects:write"];

function registerTool(server, authContext, name, description, schema, handler) {
  server.registerTool(name, {
    description,
    inputSchema: z.object(schema),
    _meta: {
      securitySchemes: [{
        type: "oauth2",
        scopes: REQUIRED_PROJECT_SCOPES
      }]
    }
  }, async (args, context) => {
    const claims = authContext.claims;
    const allowed = claims && REQUIRED_PROJECT_SCOPES.every(scope => claims.scopes.includes(scope));
    if (!allowed) {
      return {
        content: [{ type: "text", text: "OAuth scopes required: " + REQUIRED_PROJECT_SCOPES.join(", ") }],
        isError: true,
        _meta: {
          "mcp/www_authenticate":
            'Bearer resource_metadata="' + oauth.publicUrl +
            '/.well-known/oauth-protected-resource", scope="' +
            REQUIRED_PROJECT_SCOPES.join(" ") + '"'
        }
      };
    }
    const startedAt = Date.now();
    console.log("[GPB][Tool] START name=%s %s", name, toolLogArgs(name, args));
    try {
      const result = await handler(args, context);
      console.log("[GPB][Tool] END name=%s duration_ms=%d status=ok", name, Date.now() - startedAt);
      return result;
    } catch (error) {
      console.error(
        "[GPB][Tool] END name=%s duration_ms=%d status=error message=%s",
        name,
        Date.now() - startedAt,
        error?.message || String(error)
      );
      throw error;
    }
  });
}

function makeMcpServer(authContext) {
  const server = new McpServer({ name: "github-projects-bridge", version: "0.2.0" });

  registerTool(server, authContext,
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

  registerTool(server, authContext,
    "create_project",
    "Create a new GitHub Project V2 under a user or organization.",
    {
      owner: z.string().optional(),
      owner_type: z.enum(["user", "organization"]).default("user"),
      title: z.string().min(1),
      short_description: z.string().optional()
    },
    async ({ owner = DEFAULT_OWNER, owner_type, title, short_description }) => {
      const ownerId = await resolveOwnerId(owner, owner_type);

      const query = "mutation($input:CreateProjectV2Input!){createProjectV2(input:$input){projectV2{id number title shortDescription url closed}}}";
      const data = await graphql(query, {
        input: {
          ownerId,
          title
        }
      });

      const createdProject = data?.createProjectV2?.projectV2;
      if (!createdProject?.id) {
        throw new Error("GitHub returned no project for createProjectV2.");
      }

      if (short_description !== undefined) {
        const updateQuery = "mutation($input:UpdateProjectV2Input!){updateProjectV2(input:$input){projectV2{id title shortDescription url closed}}}";
        const updated = await graphql(updateQuery, {
          input: {
            projectId: createdProject.id,
            shortDescription: short_description
          }
        });
        if (!updated?.updateProjectV2?.projectV2?.id) {
          throw new Error("GitHub returned no project while setting the new project's description.");
        }
      }

      const verifiedProject = await readProject(createdProject.id);
      if (verifiedProject.title !== title) {
        throw new Error(
          "Read-after-write verification failed for new project title. Expected " +
          JSON.stringify(title) + ", got " + JSON.stringify(verifiedProject.title)
        );
      }
      if (short_description !== undefined && verifiedProject.shortDescription !== short_description) {
        throw new Error(
          "Read-after-write verification failed for new project description. Expected " +
          JSON.stringify(short_description) + ", got " + JSON.stringify(verifiedProject.shortDescription)
        );
      }

      console.log(
        "[GPB][Verify] action=create_project owner=%s owner_type=%s project=%s verification=ok title=%s short_description=%s",
        owner,
        owner_type,
        verifiedProject.id,
        JSON.stringify(verifiedProject.title),
        JSON.stringify(verifiedProject.shortDescription)
      );

      return { content: [{ type: "text", text: JSON.stringify(verifiedProject, null, 2) }] };
    }
  );

  registerTool(server, authContext,
    "get_project",
    "Get a GitHub Project V2, including its fields and options.",
    { project_id: z.string() },
    async ({ project_id }) => {
      const query = "query($id:ID!){node(id:$id){... on ProjectV2{id number title shortDescription url closed fields(first:50){nodes{... on ProjectV2FieldCommon{id name dataType} ... on ProjectV2SingleSelectField{id name dataType options{id name}}}}}}}";
      const data = await graphql(query, { id: project_id });
      return { content: [{ type: "text", text: JSON.stringify(data.node, null, 2) }] };
    }
  );

  registerTool(server, authContext,
    "list_project_items",
    "List cards/items in a GitHub Project V2.",
    {
      project_id: z.string(),
      first: z.number().int().min(1).max(100).default(50)
    },
    async ({ project_id, first }) => {
      const items = await readProjectItems(project_id, first);
      return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
    }
  );

  registerTool(server, authContext,
    "update_project",
    "Update the title and/or short description of a GitHub Projects V2 project.",
    {
      project_id: z.string(),
      title: z.string().optional(),
      short_description: z.string().optional()
    },
    async ({ project_id, title, short_description }) => {
      if (title === undefined && short_description === undefined) {
        throw new Error("Provide at least one of title or short_description.");
      }
      const input = { projectId: project_id };
      if (title !== undefined) input.title = title;
      if (short_description !== undefined) input.shortDescription = short_description;
      const query = "mutation($input:UpdateProjectV2Input!){updateProjectV2(input:$input){projectV2{id title shortDescription url}}}";
      const data = await graphql(query, { input });
      const updatedProject = data?.updateProjectV2?.projectV2;
      if (!updatedProject?.id) {
        throw new Error("GitHub returned no updated project for updateProjectV2.");
      }

      const verifiedProject = await readProject(project_id);
      verifyProjectUpdate(verifiedProject, { title, short_description });

      console.log(
        "[GPB][Verify] action=update_project project=%s verification=ok title=%s short_description=%s",
        project_id,
        JSON.stringify(verifiedProject.title),
        JSON.stringify(verifiedProject.shortDescription)
      );

      return { content: [{ type: "text", text: JSON.stringify(verifiedProject, null, 2) }] };
    }
  );

  registerTool(server, authContext,
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
      const createdItemId = data?.addProjectV2DraftIssue?.projectItem?.id;
      if (!createdItemId) {
        throw new Error("GitHub returned no project item for addProjectV2DraftIssue.");
      }

      const verifiedItem = await findProjectItemWithRetry(project_id, createdItemId);
      if (!verifiedItem) {
        throw new Error("Read-after-write verification failed: created draft item was not visible in the project after 5 attempts.");
      }

      const verifiedTitle = verifiedItem.content?.title;
      if (verifiedTitle !== title) {
        throw new Error("Read-after-write verification failed for draft title. Expected " + JSON.stringify(title) + ", got " + JSON.stringify(verifiedTitle));
      }

      console.log(
        "[GPB][Verify] action=create_project_draft project=%s item=%s verification=ok title=%s",
        project_id,
        createdItemId,
        JSON.stringify(verifiedTitle)
      );

      return { content: [{ type: "text", text: JSON.stringify({ projectItem: verifiedItem }, null, 2) }] };
    }
  );

  registerTool(server, authContext,
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

      const updatedItemId = data?.updateProjectV2ItemFieldValue?.projectV2Item?.id;
      if (!updatedItemId) {
        throw new Error("GitHub returned no project item for updateProjectV2ItemFieldValue.");
      }

      const items = await readProjectItems(project_id);
      const verifiedItem = findProjectItem(items, item_id);
      if (!verifiedItem) {
        throw new Error("Read-after-write verification failed: project item was not found.");
      }

      const fieldValue = (verifiedItem.fieldValues?.nodes || []).find(value =>
        value?.field?.id === field_id && Object.prototype.hasOwnProperty.call(value, "optionId")
      );
      if (!fieldValue) {
        throw new Error("Read-after-write verification failed: target single-select field was not found on the item.");
      }
      if (fieldValue.optionId !== option_id) {
        throw new Error(
          "Read-after-write verification failed for single-select option. Expected " +
          JSON.stringify(option_id) + ", got " + JSON.stringify(fieldValue.optionId)
        );
      }

      console.log(
        "[GPB][Verify] action=update_project_single_select project=%s item=%s field=%s option=%s verification=ok",
        project_id,
        item_id,
        field_id,
        option_id
      );

      return { content: [{ type: "text", text: JSON.stringify({ projectV2Item: verifiedItem }, null, 2) }] };
    }
  );

  registerTool(server, authContext,
    "delete_project_item",
    "Remove an item/card from a GitHub Project V2.",
    { project_id: z.string(), item_id: z.string() },
    async ({ project_id, item_id }) => {
      const query = "mutation($projectId:ID!,$itemId:ID!){deleteProjectV2Item(input:{projectId:$projectId,itemId:$itemId}){deletedItemId}}";
      const data = await graphql(query, { projectId: project_id, itemId: item_id });
      const deletedItemId = data?.deleteProjectV2Item?.deletedItemId;
      if (!deletedItemId) {
        throw new Error("GitHub returned no deletedItemId for deleteProjectV2Item.");
      }

      const items = await readProjectItems(project_id);
      if (findProjectItem(items, item_id)) {
        throw new Error("Read-after-write verification failed: deleted item is still present in the project.");
      }

      console.log(
        "[GPB][Verify] action=delete_project_item project=%s item=%s verification=ok",
        project_id,
        item_id
      );

      return { content: [{ type: "text", text: JSON.stringify({ deletedItemId, verified: true }, null, 2) }] };
    }
  );

  registerProjectManagementTools({ server, authContext, registerTool, graphql, resolveOwnerId, resolveRepositoryId, readProjectItems, findProjectItem });

  return server;
}

const transports = new Map();
const transportSubjects = new Map();
const transportClients = new Map();
const transportAuth = new Map();
const httpServer = createServer(async (req, res) => {
  console.log(
    "[GPB][HTTP] method=%s path=%s session=%s",
    req.method,
    req.url || "/",
    req.headers["mcp-session-id"] ? "yes" : "no"
  );
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

  const mcpMethod = parsed?.method || "unknown";
  const mcpTool = parsed?.params?.name || "-";
  console.log("[GPB][MCP] method=%s tool=%s", mcpMethod, mcpTool);

  const claims = oauth.verifyAccessToken(bearerToken(req));
  if (!claims) {
    console.warn("[GPB][Auth] rejected method=%s tool=%s reason=invalid_access_token", mcpMethod, mcpTool);
    const metadataUrl = oauth.publicUrl + "/.well-known/oauth-protected-resource";
    res.writeHead(401, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "WWW-Authenticate": 'Bearer resource_metadata="' + metadataUrl + '", scope="' + REQUIRED_PROJECT_SCOPES.join(" ") + '"'
    });
    res.end(JSON.stringify({ error: "unauthorized", error_description: "A valid OAuth access token is required." }));
    return;
  }

  const sessionId = req.headers["mcp-session-id"];
  let transport = sessionId ? transports.get(sessionId) : undefined;
  let authContext = sessionId ? transportAuth.get(sessionId) : undefined;
  if (transport && (transportSubjects.get(sessionId) !== claims.sub || transportClients.get(sessionId) !== claims.client_id)) {
    console.warn("[GPB][Session] rejected method=%s tool=%s reason=session_identity_mismatch", mcpMethod, mcpTool);
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
        console.log("[GPB][Session] initialized session=%s", id);
        transports.set(id, transport);
        transportSubjects.set(id, claims.sub);
        transportClients.set(id, claims.client_id);
        transportAuth.set(id, authContext);
      }
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) {
        transports.delete(id);
        transportSubjects.delete(id);
        transportClients.delete(id);
        transportAuth.delete(id);
      }
    };
    const server = makeMcpServer(authContext);
    await server.connect(transport);
  }
  if (!transport) {
    console.warn("[GPB][Session] rejected method=%s tool=%s reason=missing_or_invalid_session", mcpMethod, mcpTool);
    res.writeHead(400);
    res.end("Bad Request: missing or invalid MCP session");
    return;
  }
  await transport.handleRequest(req, res, parsed);
});

httpServer.listen(PORT, "0.0.0.0", () => {
  process.stdout.write("GitHub Projects MCP bridge listening on port " + PORT + "\n");
});
