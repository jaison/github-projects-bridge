
import { z } from "zod";

const FIELD_FRAGMENT =
  "... on ProjectV2Field{id name dataType isIssueField createdAt updatedAt}" +
  " ... on ProjectV2SingleSelectField{id name dataType isIssueField createdAt updatedAt options{id name color description}}" +
  " ... on ProjectV2MultiSelectField{id name dataType isIssueField createdAt updatedAt multiSelectOptions{id name color description}}" +
  " ... on ProjectV2IterationField{id name dataType isIssueField createdAt updatedAt configuration{duration startDay iterations{id title startDate duration} completedIterations{id title startDate duration}}}";

const ITEM_FRAGMENT =
  "id type isArchived content{" +
  "... on Issue{id title number url}" +
  " ... on PullRequest{id title number url}" +
  " ... on DraftIssue{id title body assignees(first:100){nodes{... on User{id login}}}}" +
  "} " +
  "fieldValues(first:100){nodes{" +
  "... on ProjectV2ItemFieldTextValue{text field{... on ProjectV2Field{id name dataType}}}" +
  " ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2Field{id name dataType}}}" +
  " ... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2Field{id name dataType}}}" +
  " ... on ProjectV2ItemFieldIterationValue{iterationId field{... on ProjectV2IterationField{id name dataType}}}" +
  " ... on ProjectV2ItemFieldSingleSelectValue{name optionId field{... on ProjectV2SingleSelectField{id name dataType}}}" +
  "" +
  "}}";

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function optionInputSchema() {
  return z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    color: z.enum(["BLUE","GRAY","GREEN","ORANGE","PINK","PURPLE","RED","YELLOW"]),
    description: z.string().default("")
  });
}

async function getField(graphql, fieldId) {
  const query = "query($id:ID!){node(id:$id){" + FIELD_FRAGMENT + "}}";
  const data = await graphql(query, { id: fieldId });
  return data?.node ?? null;
}

async function resolveDraftIssueId(graphql, draftIssueIdOrItemId) {
  const query =
    "query($id:ID!){node(id:$id){__typename " +
    "... on DraftIssue{id} " +
    "... on ProjectV2Item{content{... on DraftIssue{id}}}" +
    "}}}";
  const data = await graphql(query, { id: draftIssueIdOrItemId });
  const node = data?.node;
  const draftIssueId = node?.__typename === "DraftIssue"
    ? node.id
    : node?.content?.id;
  if (!draftIssueId) {
    throw new Error("Draft issue not found for ID: " + draftIssueIdOrItemId);
  }
  return draftIssueId;
}

async function getProjectView(graphql, projectId, number) {
  const query =
    "query($id:ID!,$number:Int!){node(id:$id){... on ProjectV2{" +
    "view(number:$number){id number name layout filter createdAt updatedAt " +
    "fields(first:100){nodes{" +
    "... on ProjectV2Field{id name dataType}" +
    " ... on ProjectV2SingleSelectField{id name dataType options{id name color description}}" +
    " ... on ProjectV2MultiSelectField{id name dataType multiSelectOptions{id name color description}}" +
    " ... on ProjectV2IterationField{id name dataType}" +
    "}}" +
    "}}}}";
  const data = await graphql(query, { id: projectId, number });
  return data?.node?.view ?? null;
}

export function registerProjectManagementTools({
  server,
  authContext,
  registerTool,
  graphql,
  resolveOwnerId,
  readProjectItems,
  findProjectItem,
  resolveRepositoryId
}) {
  registerTool(server, authContext,
    "get_project_details",
    "Get a GitHub Project V2 with metadata, fields, repositories, views, status updates and workflows. Set include_teams=true when the GitHub token also has read:org/read:discussion.",
    { project_id: z.string(), first: z.number().int().min(1).max(100).default(100), include_teams: z.boolean().default(false) },
    async ({ project_id, first, include_teams }) => {
      const query =
        "query($id:ID!,$first:Int!){node(id:$id){... on ProjectV2{" +
        "id number title shortDescription readme public closed template url resourcePath createdAt updatedAt " +
        "viewerCanUpdate viewerCanClose viewerCanReopen " +
        "owner{... on User{id login} ... on Organization{id login}}" +
        "fields(first:$first){nodes{" + FIELD_FRAGMENT + "}}" +
        "repositories(first:$first){nodes{id name nameWithOwner url}}" +
        "views(first:$first){nodes{id number name layout filter createdAt updatedAt}}" +
        "statusUpdates(first:$first){nodes{id body status startDate targetDate createdAt updatedAt}}" +
        "workflows(first:$first){nodes{id number name enabled createdAt updatedAt}}" +
        "}}}";
      const data = await graphql(query, { id: project_id, first });
      if (!data?.node?.id) throw new Error("Project not found: " + project_id);

      const details = { ...data.node };
      if (include_teams) {
        const teamsQuery = "query($id:ID!,$first:Int!){node(id:$id){... on ProjectV2{teams(first:$first){nodes{id name slug}}}}}";
        try {
          const teamsData = await graphql(teamsQuery, { id: project_id, first });
          details.teams = teamsData?.node?.teams?.nodes ?? [];
        } catch (error) {
          const message = String(error?.message || error);
          if (/INSUFFICIENT_SCOPES|read:org|read:discussion/.test(message)) {
            details.teams = [];
            details.teams_unavailable_reason = "The GitHub token requires read:org or read:discussion to read Project V2 teams.";
          } else {
            throw error;
          }
        }
      }

      return result(details);
    }
  );

  registerTool(server, authContext,
    "create_project_advanced",
    "Create a GitHub Project V2 and optionally link it to a repository or team. repository_id accepts a GitHub global node ID, numeric repository database ID, owner/name or GitHub repository URL.",
    {
      owner: z.string().optional(),
      owner_type: z.enum(["user","organization"]).default("user"),
      title: z.string().min(1),
      short_description: z.string().optional(),
      repository_id: z.string().optional(),
      team_id: z.string().optional()
    },
    async ({ owner, owner_type, title, short_description, repository_id, team_id }) => {
      const resolvedOwner = owner || process.env.GITHUB_OWNER;
      if (!resolvedOwner) throw new Error("owner is required when GITHUB_OWNER is not configured.");
      const ownerId = await resolveOwnerId(resolvedOwner, owner_type);
      const normalizedRepositoryId = repository_id
        ? await resolveRepositoryId(repository_id)
        : undefined;
      const input = { ownerId, title };
      const query = "mutation($input:CreateProjectV2Input!){createProjectV2(input:$input){projectV2{id number title shortDescription readme public closed template url}}}";
      const data = await graphql(query, { input });
      let project = data?.createProjectV2?.projectV2;
      if (!project?.id) throw new Error("GitHub returned no project for createProjectV2.");

      const warnings = [];
      if (normalizedRepositoryId) {
        try {
          const linkQuery = "mutation($input:LinkProjectV2ToRepositoryInput!){linkProjectV2ToRepository(input:$input){repository{id name nameWithOwner url}}}";
          await graphql(linkQuery, { input: { projectId: project.id, repositoryId: normalizedRepositoryId } });
        } catch (error) {
          warnings.push("Repository was not linked: " + String(error?.message || error));
        }
      }
      if (team_id) {
        try {
          const linkTeamQuery = "mutation($input:LinkProjectV2ToTeamInput!){linkProjectV2ToTeam(input:$input){team{id name slug}}}";
          await graphql(linkTeamQuery, { input: { projectId: project.id, teamId: team_id } });
        } catch (error) {
          warnings.push("Team was not linked: " + String(error?.message || error));
        }
      }

      if (short_description !== undefined) {
        const updateQuery = "mutation($input:UpdateProjectV2Input!){updateProjectV2(input:$input){projectV2{id number title shortDescription readme public closed template url}}}";
        const updated = await graphql(updateQuery, { input: { projectId: project.id, shortDescription: short_description } });
        project = updated?.updateProjectV2?.projectV2 || project;
      }
      return result(warnings.length ? { ...project, warnings } : project);
    }
  );

  registerTool(server, authContext,
    "get_project_field",
    "Get a GitHub Project V2 field by ID, including select options or iteration configuration.",
    { field_id: z.string() },
    async ({ field_id }) => {
      const field = await getField(graphql, field_id);
      if (!field?.id) throw new Error("Project field not found: " + field_id);
      return result(field);
    }
  );

  registerTool(server, authContext,
    "list_project_fields",
    "List all fields configured on a GitHub Project V2.",
    { project_id: z.string(), first: z.number().int().min(1).max(100).default(100) },
    async ({ project_id, first }) => {
      const query = "query($id:ID!,$first:Int!){node(id:$id){... on ProjectV2{fields(first:$first){nodes{" + FIELD_FRAGMENT + "}}}}}";
      const data = await graphql(query, { id: project_id, first });
      return result(data?.node?.fields?.nodes ?? []);
    }
  );

  registerTool(server, authContext,
    "list_project_repositories",
    "List repositories linked to a GitHub Project V2.",
    { project_id: z.string(), first: z.number().int().min(1).max(100).default(100) },
    async ({ project_id, first }) => {
      const query = "query($id:ID!,$first:Int!){node(id:$id){... on ProjectV2{repositories(first:$first){nodes{id name nameWithOwner url}}}}}";
      const data = await graphql(query, { id: project_id, first });
      return result(data?.node?.repositories?.nodes ?? []);
    }
  );

  registerTool(server, authContext,
    "list_project_teams",
    "List teams linked to a GitHub Project V2.",
    { project_id: z.string(), first: z.number().int().min(1).max(100).default(100) },
    async ({ project_id, first }) => {
      const query = "query($id:ID!,$first:Int!){node(id:$id){... on ProjectV2{teams(first:$first){nodes{id name slug}}}}}";
      const data = await graphql(query, { id: project_id, first });
      return result(data?.node?.teams?.nodes ?? []);
    }
  );

  registerTool(server, authContext,
    "list_project_items_advanced",
    "List Project V2 items with pagination, search query, archived-state filtering and position ordering.",
    {
      project_id: z.string(),
      first: z.number().int().min(1).max(100).default(100),
      after: z.string().optional(),
      query: z.string().optional(),
      archived_states: z.array(z.enum(["ARCHIVED","NOT_ARCHIVED"])).default(["NOT_ARCHIVED"])
    },
    async ({ project_id, first, after, query: searchQuery, archived_states }) => {
      const gql =
        "query($id:ID!,$first:Int!,$after:String,$query:String,$archivedStates:[ProjectV2ItemArchivedState!]){" +
        "node(id:$id){... on ProjectV2{" +
        "items(first:$first,after:$after,query:$query,archivedStates:$archivedStates,orderBy:{field:POSITION,direction:ASC}){" +
        "nodes{" + ITEM_FRAGMENT + "} pageInfo{hasNextPage endCursor}" +
        "}}}}";
      const data = await graphql(gql, {
        id: project_id,
        first,
        after: after ?? null,
        query: searchQuery ?? null,
        archivedStates: archived_states
      });
      return result(data?.node?.items ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } });
    }
  );

  registerTool(server, authContext,
    "list_project_views",
    "List all views belonging to a GitHub Project V2.",
    { project_id: z.string(), first: z.number().int().min(1).max(100).default(100) },
    async ({ project_id, first }) => {
      const query =
        "query($id:ID!,$first:Int!){node(id:$id){... on ProjectV2{" +
        "views(first:$first){nodes{id number name layout filter createdAt updatedAt}}" +
        "}}}";
      const data = await graphql(query, { id: project_id, first });
      return result(data?.node?.views?.nodes ?? []);
    }
  );

  registerTool(server, authContext,
    "get_project_view",
    "Get a specific GitHub Project V2 view by project ID and view number.",
    { project_id: z.string(), number: z.number().int().min(1) },
    async ({ project_id, number }) => {
      const view = await getProjectView(graphql, project_id, number);
      if (!view?.id) throw new Error("Project view not found: " + number);
      return result(view);
    }
  );

  registerTool(server, authContext,
    "list_project_status_updates",
    "List status updates published in a GitHub Project V2.",
    { project_id: z.string(), first: z.number().int().min(1).max(100).default(100) },
    async ({ project_id, first }) => {
      const query = "query($id:ID!,$first:Int!){node(id:$id){... on ProjectV2{statusUpdates(first:$first){nodes{id body status startDate targetDate createdAt updatedAt}}}}}";
      const data = await graphql(query, { id: project_id, first });
      return result(data?.node?.statusUpdates?.nodes ?? []);
    }
  );

  registerTool(server, authContext,
    "get_project_status_update",
    "Get a Project V2 status update by node ID.",
    { status_update_id: z.string() },
    async ({ status_update_id }) => {
      const query = "query($id:ID!){node(id:$id){... on ProjectV2StatusUpdate{id body bodyHTML status startDate targetDate createdAt updatedAt creator{... on User{id login} ... on Bot{id login}}}}}";
      const data = await graphql(query, { id: status_update_id });
      if (!data?.node?.id) throw new Error("Project status update not found: " + status_update_id);
      return result(data.node);
    }
  );

  registerTool(server, authContext,
    "list_project_workflows",
    "List workflows configured for a GitHub Project V2. The current GraphQL Projects schema exposes deletion but not workflow creation or update mutations.",
    { project_id: z.string(), first: z.number().int().min(1).max(100).default(100) },
    async ({ project_id, first }) => {
      const query = "query($id:ID!,$first:Int!){node(id:$id){... on ProjectV2{workflows(first:$first){nodes{id number name enabled createdAt updatedAt}}}}}";
      const data = await graphql(query, { id: project_id, first });
      return result(data?.node?.workflows?.nodes ?? []);
    }
  );

  registerTool(server, authContext,
    "get_project_workflow",
    "Get a specific Project V2 workflow by project ID and workflow number.",
    { project_id: z.string(), number: z.number().int().min(1) },
    async ({ project_id, number }) => {
      const query = "query($id:ID!,$number:Int!){node(id:$id){... on ProjectV2{workflow(number:$number){id number name enabled createdAt updatedAt}}}}";
      const data = await graphql(query, { id: project_id, number });
      if (!data?.node?.workflow?.id) throw new Error("Project workflow not found: " + number);
      return result(data.node.workflow);
    }
  );

  registerTool(server, authContext,
    "create_project_field",
    "Create a custom Project V2 field. Supported types: DATE, ITERATION, MULTI_SELECT, NUMBER, SINGLE_SELECT and TEXT.",
    {
      project_id: z.string(),
      name: z.string().min(1),
      data_type: z.enum(["DATE","ITERATION","MULTI_SELECT","NUMBER","SINGLE_SELECT","TEXT"]),
      single_select_options: z.array(optionInputSchema()).optional(),
      multi_select_options: z.array(optionInputSchema()).optional(),
      iteration_configuration: z.object({
        duration: z.number().int().min(1),
        start_date: z.string().min(1),
        iterations: z.array(z.object({
          id: z.string().optional(),
          title: z.string().min(1),
          start_date: z.string().min(1),
          duration: z.number().int().min(1)
        })).default([])
      }).optional()
    },
    async ({ project_id, name, data_type, single_select_options, multi_select_options, iteration_configuration }) => {
      if (data_type === "SINGLE_SELECT" && !single_select_options?.length) {
        throw new Error("single_select_options is required for SINGLE_SELECT fields.");
      }
      if (data_type === "MULTI_SELECT" && !multi_select_options?.length) {
        throw new Error("multi_select_options is required for MULTI_SELECT fields.");
      }
      if (data_type === "ITERATION" && !iteration_configuration) {
        throw new Error("iteration_configuration is required for ITERATION fields.");
      }
      if (single_select_options && data_type !== "SINGLE_SELECT") {
        throw new Error("single_select_options can only be used with SINGLE_SELECT.");
      }
      if (multi_select_options && data_type !== "MULTI_SELECT") {
        throw new Error("multi_select_options can only be used with MULTI_SELECT.");
      }

      const input = { projectId: project_id, name, dataType: data_type };
      if (single_select_options) {
        input.singleSelectOptions = single_select_options.map(o => ({
          ...(o.id ? { id: o.id } : {}),
          name: o.name,
          color: o.color,
          description: o.description
        }));
      }
      if (multi_select_options) {
        input.multiSelectOptions = multi_select_options.map(o => ({
          ...(o.id ? { id: o.id } : {}),
          name: o.name,
          color: o.color,
          description: o.description
        }));
      }
      if (iteration_configuration) {
        input.iterationConfiguration = {
          duration: iteration_configuration.duration,
          startDate: iteration_configuration.start_date,
          iterations: iteration_configuration.iterations.map(i => ({
            ...(i.id ? { id: i.id } : {}),
            title: i.title,
            startDate: i.start_date,
            duration: i.duration
          }))
        };
      }

      const query =
        "mutation($input:CreateProjectV2FieldInput!){createProjectV2Field(input:$input){projectV2Field{" +
        FIELD_FRAGMENT + "}}}";
      const data = await graphql(query, { input });
      const field = data?.createProjectV2Field?.projectV2Field;
      if (!field?.id) throw new Error("GitHub returned no field for createProjectV2Field.");
      return result(field);
    }
  );

  registerTool(server, authContext,
    "create_project_issue_field",
    "Add an existing GitHub IssueField to a Project V2.",
    { project_id: z.string(), issue_field_id: z.string() },
    async ({ project_id, issue_field_id }) => {
      const query = "mutation($input:CreateProjectV2IssueFieldInput!){createProjectV2IssueField(input:$input){projectV2Field{" + FIELD_FRAGMENT + "}}}";
      const data = await graphql(query, { input: { projectId: project_id, issueFieldId: issue_field_id } });
      const field = data?.createProjectV2IssueField?.projectV2Field;
      if (!field?.id) throw new Error("GitHub returned no field for createProjectV2IssueField.");
      return result(field);
    }
  );

  registerTool(server, authContext,
    "update_project_field",
    "Update a Project V2 field name, select options or iteration configuration. Option/configuration arrays replace the existing configuration; preserve option/iteration IDs when retaining existing entries.",
    {
      field_id: z.string(),
      name: z.string().optional(),
      single_select_options: z.array(optionInputSchema()).optional(),
      multi_select_options: z.array(optionInputSchema()).optional(),
      iteration_configuration: z.object({
        duration: z.number().int().min(1),
        start_date: z.string().min(1),
        iterations: z.array(z.object({
          id: z.string().optional(),
          title: z.string().min(1),
          start_date: z.string().min(1),
          duration: z.number().int().min(1)
        }))
      }).optional()
    },
    async ({ field_id, name, single_select_options, multi_select_options, iteration_configuration }) => {
      if (single_select_options !== undefined && multi_select_options !== undefined) {
        throw new Error("Provide only one of single_select_options or multi_select_options.");
      }
      if (name === undefined && single_select_options === undefined && multi_select_options === undefined && iteration_configuration === undefined) {
        throw new Error("Provide at least one field property to update.");
      }
      const input = { fieldId: field_id };
      if (name !== undefined) input.name = name;
      if (single_select_options !== undefined) input.singleSelectOptions = single_select_options.map(o => ({
        ...(o.id ? { id: o.id } : {}),
        name: o.name,
        color: o.color,
        description: o.description
      }));
      if (multi_select_options !== undefined) input.multiSelectOptions = multi_select_options.map(o => ({
        ...(o.id ? { id: o.id } : {}),
        name: o.name,
        color: o.color,
        description: o.description
      }));
      if (iteration_configuration !== undefined) input.iterationConfiguration = {
        duration: iteration_configuration.duration,
        startDate: iteration_configuration.start_date,
        iterations: iteration_configuration.iterations.map(i => ({
          ...(i.id ? { id: i.id } : {}),
          title: i.title,
          startDate: i.start_date,
          duration: i.duration
        }))
      };

      const query = "mutation($input:UpdateProjectV2FieldInput!){updateProjectV2Field(input:$input){projectV2Field{" + FIELD_FRAGMENT + "}}}";
      const data = await graphql(query, { input });
      const field = data?.updateProjectV2Field?.projectV2Field;
      if (!field?.id) throw new Error("GitHub returned no field for updateProjectV2Field.");
      return result(field);
    }
  );

  registerTool(server, authContext,
    "add_project_field_option",
    "Add an option to an existing SINGLE_SELECT or MULTI_SELECT Project V2 field while preserving existing option IDs.",
    {
      field_id: z.string(),
      option: optionInputSchema()
    },
    async ({ field_id, option }) => {
      const field = await getField(graphql, field_id);
      if (!field?.id) throw new Error("Project field not found: " + field_id);
      if (field.dataType !== "SINGLE_SELECT" && field.dataType !== "MULTI_SELECT") {
        throw new Error("Field must be SINGLE_SELECT or MULTI_SELECT.");
      }
      const existing = field.dataType === "MULTI_SELECT"
        ? (Array.isArray(field.multiSelectOptions) ? field.multiSelectOptions : [])
        : (Array.isArray(field.options) ? field.options : []);
      if (existing.some(o => o.name === option.name)) {
        throw new Error("An option with this name already exists: " + option.name);
      }
      const options = existing.map(o => ({
        id: o.id,
        name: o.name,
        color: o.color,
        description: o.description || ""
      })).concat({
        ...(option.id ? { id: option.id } : {}),
        name: option.name,
        color: option.color,
        description: option.description
      });
      const input = field.dataType === "SINGLE_SELECT"
        ? { fieldId: field_id, singleSelectOptions: options }
        : { fieldId: field_id, multiSelectOptions: options };
      const query = "mutation($input:UpdateProjectV2FieldInput!){updateProjectV2Field(input:$input){projectV2Field{" + FIELD_FRAGMENT + "}}}";
      const data = await graphql(query, { input });
      return result(data?.updateProjectV2Field?.projectV2Field);
    }
  );

  registerTool(server, authContext,
    "update_project_field_option",
    "Update an option on a SINGLE_SELECT or MULTI_SELECT Project V2 field by option ID.",
    {
      field_id: z.string(),
      option_id: z.string(),
      name: z.string().optional(),
      color: z.enum(["BLUE","GRAY","GREEN","ORANGE","PINK","PURPLE","RED","YELLOW"]).optional(),
      description: z.string().optional()
    },
    async ({ field_id, option_id, name, color, description }) => {
      if (name === undefined && color === undefined && description === undefined) {
        throw new Error("Provide at least one option property to update.");
      }
      const field = await getField(graphql, field_id);
      if (!field?.id) throw new Error("Project field not found: " + field_id);
      if (field.dataType !== "SINGLE_SELECT" && field.dataType !== "MULTI_SELECT") {
        throw new Error("Field must be SINGLE_SELECT or MULTI_SELECT.");
      }
      const existing = field.dataType === "MULTI_SELECT"
        ? (Array.isArray(field.multiSelectOptions) ? field.multiSelectOptions : [])
        : (Array.isArray(field.options) ? field.options : []);
      const target = existing.find(o => o.id === option_id);
      if (!target) throw new Error("Field option not found: " + option_id);
      const options = existing.map(o => ({
        id: o.id,
        name: o.id === option_id && name !== undefined ? name : o.name,
        color: o.id === option_id && color !== undefined ? color : o.color,
        description: o.id === option_id && description !== undefined ? description : (o.description || "")
      }));
      const input = field.dataType === "SINGLE_SELECT"
        ? { fieldId: field_id, singleSelectOptions: options }
        : { fieldId: field_id, multiSelectOptions: options };
      const query = "mutation($input:UpdateProjectV2FieldInput!){updateProjectV2Field(input:$input){projectV2Field{" + FIELD_FRAGMENT + "}}}";
      const data = await graphql(query, { input });
      return result(data?.updateProjectV2Field?.projectV2Field);
    }
  );

  registerTool(server, authContext,
    "delete_project_field_option",
    "Delete an option from a SINGLE_SELECT or MULTI_SELECT Project V2 field while preserving the remaining option IDs.",
    { field_id: z.string(), option_id: z.string() },
    async ({ field_id, option_id }) => {
      const field = await getField(graphql, field_id);
      if (!field?.id) throw new Error("Project field not found: " + field_id);
      if (field.dataType !== "SINGLE_SELECT" && field.dataType !== "MULTI_SELECT") {
        throw new Error("Field must be SINGLE_SELECT or MULTI_SELECT.");
      }
      const existing = field.dataType === "MULTI_SELECT"
        ? (Array.isArray(field.multiSelectOptions) ? field.multiSelectOptions : [])
        : (Array.isArray(field.options) ? field.options : []);
      if (!existing.some(o => o.id === option_id)) throw new Error("Field option not found: " + option_id);
      if (existing.length <= 1) throw new Error("Refusing to remove the last option from a select field.");
      const options = existing.filter(o => o.id !== option_id).map(o => ({
        id: o.id,
        name: o.name,
        color: o.color,
        description: o.description || ""
      }));
      const input = field.dataType === "SINGLE_SELECT"
        ? { fieldId: field_id, singleSelectOptions: options }
        : { fieldId: field_id, multiSelectOptions: options };
      const query = "mutation($input:UpdateProjectV2FieldInput!){updateProjectV2Field(input:$input){projectV2Field{" + FIELD_FRAGMENT + "}}}";
      const data = await graphql(query, { input });
      return result(data?.updateProjectV2Field?.projectV2Field);
    }
  );

  registerTool(server, authContext,
    "delete_project_field",
    "Delete a Project V2 field by field ID.",
    { field_id: z.string() },
    async ({ field_id }) => {
      const query = "mutation($input:DeleteProjectV2FieldInput!){deleteProjectV2Field(input:$input){projectV2Field{" + FIELD_FRAGMENT + "}}}";
      const data = await graphql(query, { input: { fieldId: field_id } });
      const field = data?.deleteProjectV2Field?.projectV2Field;
      if (!field?.id) throw new Error("GitHub returned no deleted field for deleteProjectV2Field.");
      return result(field);
    }
  );

  registerTool(server, authContext,
    "update_project_settings",
    "Update Project V2 title, short description, README, public/private state or open/closed state.",
    {
      project_id: z.string(),
      title: z.string().optional(),
      short_description: z.string().optional(),
      readme: z.string().optional(),
      public: z.boolean().optional(),
      closed: z.boolean().optional()
    },
    async ({ project_id, title, short_description, readme, public: isPublic, closed }) => {
      if (title === undefined && short_description === undefined && readme === undefined && isPublic === undefined && closed === undefined) {
        throw new Error("Provide at least one project setting to update.");
      }
      const input = { projectId: project_id };
      if (title !== undefined) input.title = title;
      if (short_description !== undefined) input.shortDescription = short_description;
      if (readme !== undefined) input.readme = readme;
      if (isPublic !== undefined) input.public = isPublic;
      if (closed !== undefined) input.closed = closed;
      const query = "mutation($input:UpdateProjectV2Input!){updateProjectV2(input:$input){projectV2{id number title shortDescription readme public closed template url updatedAt}}}";
      const data = await graphql(query, { input });
      return result(data?.updateProjectV2?.projectV2);
    }
  );

  registerTool(server, authContext,
    "delete_project",
    "Delete a GitHub Project V2.",
    { project_id: z.string() },
    async ({ project_id }) => {
      const query = "mutation($input:DeleteProjectV2Input!){deleteProjectV2(input:$input){projectV2{id number title url}}}";
      const data = await graphql(query, { input: { projectId: project_id } });
      return result(data?.deleteProjectV2?.projectV2);
    }
  );

  registerTool(server, authContext,
    "copy_project",
    "Copy a GitHub Project V2 to a user or organization, optionally including draft issues.",
    {
      project_id: z.string(),
      owner: z.string().min(1),
      owner_type: z.enum(["user","organization"]).default("user"),
      title: z.string().min(1),
      include_draft_issues: z.boolean().default(false)
    },
    async ({ project_id, owner, owner_type, title, include_draft_issues }) => {
      const ownerId = await resolveOwnerId(owner, owner_type);
      const query = "mutation($input:CopyProjectV2Input!){copyProjectV2(input:$input){projectV2{id number title shortDescription readme public closed template url}}}";
      const data = await graphql(query, { input: {
        projectId: project_id,
        ownerId,
        title,
        includeDraftIssues: include_draft_issues
      }});
      return result(data?.copyProjectV2?.projectV2);
    }
  );

  registerTool(server, authContext,
    "add_project_item_by_id",
    "Add an existing GitHub Issue or Pull Request to a Project V2.",
    { project_id: z.string(), content_id: z.string() },
    async ({ project_id, content_id }) => {
      const query = "mutation($input:AddProjectV2ItemByIdInput!){addProjectV2ItemById(input:$input){item{id type isArchived}}}";
      const data = await graphql(query, { input: { projectId: project_id, contentId: content_id } });
      return result(data?.addProjectV2ItemById?.item);
    }
  );

  registerTool(server, authContext,
    "archive_project_item",
    "Archive an item in a GitHub Project V2.",
    { project_id: z.string(), item_id: z.string() },
    async ({ project_id, item_id }) => {
      const query = "mutation($input:ArchiveProjectV2ItemInput!){archiveProjectV2Item(input:$input){item{id type isArchived}}}";
      const data = await graphql(query, { input: { projectId: project_id, itemId: item_id } });
      return result(data?.archiveProjectV2Item?.item);
    }
  );

  registerTool(server, authContext,
    "unarchive_project_item",
    "Unarchive an item in a GitHub Project V2.",
    { project_id: z.string(), item_id: z.string() },
    async ({ project_id, item_id }) => {
      const query = "mutation($input:UnarchiveProjectV2ItemInput!){unarchiveProjectV2Item(input:$input){item{id type isArchived}}}";
      const data = await graphql(query, { input: { projectId: project_id, itemId: item_id } });
      return result(data?.unarchiveProjectV2Item?.item);
    }
  );

  registerTool(server, authContext,
    "clear_project_item_field",
    "Clear a field value on a Project V2 item.",
    { project_id: z.string(), item_id: z.string(), field_id: z.string() },
    async ({ project_id, item_id, field_id }) => {
      const query = "mutation($input:ClearProjectV2ItemFieldValueInput!){clearProjectV2ItemFieldValue(input:$input){projectV2Item{id type isArchived}}}";
      const data = await graphql(query, { input: { projectId: project_id, itemId: item_id, fieldId: field_id } });
      return result(data?.clearProjectV2ItemFieldValue?.projectV2Item);
    }
  );

  registerTool(server, authContext,
    "update_project_item_field_value",
    "Set exactly one supported custom field value on a Project V2 item: text, number, date, iteration, single-select or multi-select.",
    {
      project_id: z.string(),
      item_id: z.string(),
      field_id: z.string(),
      text: z.string().optional(),
      number: z.number().optional(),
      date: z.string().optional(),
      iteration_id: z.string().optional(),
      single_select_option_id: z.string().optional(),
      multi_select_option_ids: z.array(z.string()).optional()
    },
    async ({ project_id, item_id, field_id, text, number, date, iteration_id, single_select_option_id, multi_select_option_ids }) => {
      const values = [text !== undefined, number !== undefined, date !== undefined, iteration_id !== undefined, single_select_option_id !== undefined, multi_select_option_ids !== undefined];
      if (values.filter(Boolean).length !== 1) throw new Error("Exactly one field value must be provided.");
      const value = {};
      if (text !== undefined) value.text = text;
      if (number !== undefined) value.number = number;
      if (date !== undefined) value.date = date;
      if (iteration_id !== undefined) value.iterationId = iteration_id;
      if (single_select_option_id !== undefined) value.singleSelectOptionId = single_select_option_id;
      if (multi_select_option_ids !== undefined) value.multiSelectOptionIds = multi_select_option_ids;

      const query = "mutation($input:UpdateProjectV2ItemFieldValueInput!){updateProjectV2ItemFieldValue(input:$input){projectV2Item{id type isArchived}}}";
      const data = await graphql(query, { input: { projectId: project_id, itemId: item_id, fieldId: field_id, value } });
      const updated = data?.updateProjectV2ItemFieldValue?.projectV2Item;
      if (!updated?.id) throw new Error("GitHub returned no updated project item.");
      const items = await readProjectItems(project_id);
      const verified = findProjectItem(items, item_id);
      if (!verified) throw new Error("Read-after-write verification failed: project item was not found.");
      return result({ projectV2Item: verified });
    }
  );

  registerTool(server, authContext,
    "update_project_item_position",
    "Move a Project V2 item to a new position. Omit after_item_id to move it to the top.",
    { project_id: z.string(), item_id: z.string(), after_item_id: z.string().optional() },
    async ({ project_id, item_id, after_item_id }) => {
      const query = "mutation($input:UpdateProjectV2ItemPositionInput!){updateProjectV2ItemPosition(input:$input){items(first:100){nodes{id type isArchived}}}}";
      const data = await graphql(query, { input: { projectId: project_id, itemId: item_id, ...(after_item_id ? { afterId: after_item_id } : {}) } });
      return result({ success: true, items: data?.updateProjectV2ItemPosition?.items?.nodes ?? [] });
    }
  );

  registerTool(server, authContext,
    "update_project_draft_issue",
    "Update a Project V2 draft issue title, body and assignees. draft_issue_id may be either the DraftIssue node ID or the ProjectV2Item node ID returned by create_project_draft.",
    {
      draft_issue_id: z.string(),
      title: z.string().optional(),
      body: z.string().optional(),
      assignee_ids: z.array(z.string()).optional()
    },
    async ({ draft_issue_id, title, body, assignee_ids }) => {
      if (title === undefined && body === undefined && assignee_ids === undefined) {
        throw new Error("Provide at least one draft issue property to update.");
      }
      const resolvedDraftIssueId = await resolveDraftIssueId(graphql, draft_issue_id);
      const input = { draftIssueId: resolvedDraftIssueId };
      if (title !== undefined) input.title = title;
      if (body !== undefined) input.body = body;
      if (assignee_ids !== undefined) input.assigneeIds = assignee_ids;
      const query = "mutation($input:UpdateProjectV2DraftIssueInput!){updateProjectV2DraftIssue(input:$input){draftIssue{id title body}}}";
      const data = await graphql(query, { input });
      return result(data?.updateProjectV2DraftIssue?.draftIssue);
    }
  );

  registerTool(server, authContext,
    "convert_project_draft_to_issue",
    "Convert a Project V2 draft issue item into a real GitHub Issue in a repository. repository_id accepts a global node ID, numeric repository database ID, owner/name or GitHub repository URL.",
    { item_id: z.string(), repository_id: z.string() },
    async ({ item_id, repository_id }) => {
      const query = "mutation($input:ConvertProjectV2DraftIssueItemToIssueInput!){convertProjectV2DraftIssueItemToIssue(input:$input){item{id type content{... on Issue{id title number url}}}}}";
      const normalizedRepositoryId = await resolveRepositoryId(repository_id);
      try {
        const data = await graphql(query, { input: { itemId: item_id, repositoryId: normalizedRepositoryId } });
        return result(data?.convertProjectV2DraftIssueItemToIssue?.item);
      } catch (error) {
        const message = String(error?.message || error);
        if (/FORBIDDEN|does not have the correct permissions|access to this repository/i.test(message)) {
          throw new Error(
            "GitHub refused draft-to-issue conversion. The token must have access to create issues in the target repository; " +
            "a Projects-only token is insufficient. " + message
          );
        }
        throw error;
      }
    }
  );

  registerTool(server, authContext,
    "create_project_status_update",
    "Create a status update in a GitHub Project V2.",
    {
      project_id: z.string(),
      body: z.string().min(1),
      status: z.enum(["AT_RISK","COMPLETE","INACTIVE","OFF_TRACK","ON_TRACK"]).optional(),
      start_date: z.string().optional(),
      target_date: z.string().optional()
    },
    async ({ project_id, body, status, start_date, target_date }) => {
      const input = { projectId: project_id, body };
      if (status !== undefined) input.status = status;
      if (start_date !== undefined) input.startDate = start_date;
      if (target_date !== undefined) input.targetDate = target_date;
      const query = "mutation($input:CreateProjectV2StatusUpdateInput!){createProjectV2StatusUpdate(input:$input){statusUpdate{id body status startDate targetDate createdAt updatedAt}}}";
      const data = await graphql(query, { input });
      return result(data?.createProjectV2StatusUpdate?.statusUpdate);
    }
  );

  registerTool(server, authContext,
    "update_project_status_update",
    "Update an existing GitHub Project V2 status update.",
    {
      status_update_id: z.string(),
      body: z.string().optional(),
      status: z.enum(["AT_RISK","COMPLETE","INACTIVE","OFF_TRACK","ON_TRACK"]).optional(),
      start_date: z.string().optional(),
      target_date: z.string().optional()
    },
    async ({ status_update_id, body, status, start_date, target_date }) => {
      if (body === undefined && status === undefined && start_date === undefined && target_date === undefined) {
        throw new Error("Provide at least one status update property to update.");
      }
      const input = { statusUpdateId: status_update_id };
      if (body !== undefined) input.body = body;
      if (status !== undefined) input.status = status;
      if (start_date !== undefined) input.startDate = start_date;
      if (target_date !== undefined) input.targetDate = target_date;
      const query = "mutation($input:UpdateProjectV2StatusUpdateInput!){updateProjectV2StatusUpdate(input:$input){statusUpdate{id body status startDate targetDate createdAt updatedAt}}}";
      const data = await graphql(query, { input });
      return result(data?.updateProjectV2StatusUpdate?.statusUpdate);
    }
  );

  registerTool(server, authContext,
    "delete_project_status_update",
    "Delete a Project V2 status update.",
    { status_update_id: z.string() },
    async ({ status_update_id }) => {
      const query = "mutation($input:DeleteProjectV2StatusUpdateInput!){deleteProjectV2StatusUpdate(input:$input){deletedStatusUpdateId projectV2{id number title}}}";
      const data = await graphql(query, { input: { statusUpdateId: status_update_id } });
      return result(data?.deleteProjectV2StatusUpdate);
    }
  );

  registerTool(server, authContext,
    "create_project_view",
    "Create a Project V2 view with board, table or roadmap layout.",
    {
      project_id: z.string(),
      name: z.string().min(1),
      layout: z.enum(["BOARD_LAYOUT","ROADMAP_LAYOUT","TABLE_LAYOUT"]),
      visible_field_ids: z.array(z.string()).optional()
    },
    async ({ project_id, name, layout, visible_field_ids }) => {
      const input = { projectId: project_id, name, layout };
      if (visible_field_ids !== undefined) input.configuration = { visibleFieldIds: visible_field_ids };
      const query = "mutation($input:CreateProjectV2ViewInput!){createProjectV2View(input:$input){projectV2View{id number name layout filter createdAt updatedAt}}}";
      const data = await graphql(query, { input });
      return result(data?.createProjectV2View?.projectV2View);
    }
  );

  registerTool(server, authContext,
    "update_project_view",
    "Update a Project V2 view name, layout, filter and visible fields.",
    {
      view_id: z.string(),
      name: z.string().optional(),
      layout: z.enum(["BOARD_LAYOUT","ROADMAP_LAYOUT","TABLE_LAYOUT"]).optional(),
      filter: z.string().optional(),
      visible_field_ids: z.array(z.string()).optional()
    },
    async ({ view_id, name, layout, filter, visible_field_ids }) => {
      if (name === undefined && layout === undefined && filter === undefined && visible_field_ids === undefined) {
        throw new Error("Provide at least one view property to update.");
      }
      const input = { viewId: view_id };
      if (name !== undefined) input.name = name;
      if (layout !== undefined) input.layout = layout;
      if (filter !== undefined) input.filter = filter;
      if (visible_field_ids !== undefined) input.configuration = { visibleFieldIds: visible_field_ids };
      const query = "mutation($input:UpdateProjectV2ViewInput!){updateProjectV2View(input:$input){projectV2View{id number name layout filter createdAt updatedAt}}}";
      const data = await graphql(query, { input });
      return result(data?.updateProjectV2View?.projectV2View);
    }
  );

  registerTool(server, authContext,
    "delete_project_view",
    "Delete a Project V2 view.",
    { view_id: z.string() },
    async ({ view_id }) => {
      const query = "mutation($input:DeleteProjectV2ViewInput!){deleteProjectV2View(input:$input){projectV2View{id number name layout}}}";
      const data = await graphql(query, { input: { viewId: view_id } });
      return result(data?.deleteProjectV2View?.projectV2View);
    }
  );

  registerTool(server, authContext,
    "delete_project_workflow",
    "Delete a workflow from a GitHub Project V2. The current GraphQL schema exposes workflow deletion, but not create/update mutations.",
    { workflow_id: z.string() },
    async ({ workflow_id }) => {
      const query = "mutation($input:DeleteProjectV2WorkflowInput!){deleteProjectV2Workflow(input:$input){deletedWorkflowId projectV2{id number title}}}";
      const data = await graphql(query, { input: { workflowId: workflow_id } });
      return result(data?.deleteProjectV2Workflow);
    }
  );

  registerTool(server, authContext,
    "link_project_repository",
    "Link a GitHub repository to a Project V2. repository_id accepts a global node ID, numeric repository database ID, owner/name or GitHub repository URL.",
    { project_id: z.string(), repository_id: z.string() },
    async ({ project_id, repository_id }) => {
      const query = "mutation($input:LinkProjectV2ToRepositoryInput!){linkProjectV2ToRepository(input:$input){repository{id name nameWithOwner url}}}";
      const normalizedRepositoryId = await resolveRepositoryId(repository_id);
      try {
        const data = await graphql(query, { input: { projectId: project_id, repositoryId: normalizedRepositoryId } });
        return result(data?.linkProjectV2ToRepository?.repository);
      } catch (error) {
        const message = String(error?.message || error);
        if (/FORBIDDEN|correct permissions|permission/i.test(message)) {
          throw new Error(
            "GitHub refused linking the repository to the project. Verify that the authenticated token has permission to modify Project V2 repository links. " +
            message
          );
        }
        throw error;
      }
    }
  );

  registerTool(server, authContext,
    "unlink_project_repository",
    "Unlink a GitHub repository from a Project V2. repository_id accepts a global node ID, numeric repository database ID, owner/name or GitHub repository URL.",
    { project_id: z.string(), repository_id: z.string() },
    async ({ project_id, repository_id }) => {
      const query = "mutation($input:UnlinkProjectV2FromRepositoryInput!){unlinkProjectV2FromRepository(input:$input){repository{id name nameWithOwner url}}}";
      const normalizedRepositoryId = await resolveRepositoryId(repository_id);
      try {
        const data = await graphql(query, { input: { projectId: project_id, repositoryId: normalizedRepositoryId } });
        return result(data?.unlinkProjectV2FromRepository?.repository);
      } catch (error) {
        const message = String(error?.message || error);
        if (/FORBIDDEN|correct permissions|permission/i.test(message)) {
          throw new Error(
            "GitHub refused unlinking the repository from the project. Verify that the authenticated token has permission to modify Project V2 repository links. " +
            message
          );
        }
        throw error;
      }
    }
  );

  registerTool(server, authContext,
    "link_project_team",
    "Link a GitHub team to a Project V2.",
    { project_id: z.string(), team_id: z.string() },
    async ({ project_id, team_id }) => {
      const query = "mutation($input:LinkProjectV2ToTeamInput!){linkProjectV2ToTeam(input:$input){team{id name slug}}}";
      const data = await graphql(query, { input: { projectId: project_id, teamId: team_id } });
      return result(data?.linkProjectV2ToTeam?.team);
    }
  );

  registerTool(server, authContext,
    "unlink_project_team",
    "Unlink a team from a Project V2.",
    { project_id: z.string(), team_id: z.string() },
    async ({ project_id, team_id }) => {
      const query = "mutation($input:UnlinkProjectV2FromTeamInput!){unlinkProjectV2FromTeam(input:$input){team{id name slug}}}";
      const data = await graphql(query, { input: { projectId: project_id, teamId: team_id } });
      return result(data?.unlinkProjectV2FromTeam?.team);
    }
  );

  registerTool(server, authContext,
    "update_project_collaborators",
    "Replace direct Project V2 collaborators and their roles. Each collaborator must specify exactly one user_id or team_id.",
    {
      project_id: z.string(),
      collaborators: z.array(z.object({
        user_id: z.string().optional(),
        team_id: z.string().optional(),
        role: z.enum(["ADMIN","NONE","READER","WRITER"])
      }))
    },
    async ({ project_id, collaborators }) => {
      const mapped = collaborators.map(c => {
        const hasUser = c.user_id !== undefined;
        const hasTeam = c.team_id !== undefined;
        if (hasUser === hasTeam) throw new Error("Each collaborator must contain exactly one of user_id or team_id.");
        return {
          role: c.role,
          ...(hasUser ? { userId: c.user_id } : { teamId: c.team_id })
        };
      });
      const query = "mutation($input:UpdateProjectV2CollaboratorsInput!){updateProjectV2Collaborators(input:$input){collaborators(first:100){nodes{... on User{id login} ... on Team{id name slug}}}}}";
      const data = await graphql(query, { input: { projectId: project_id, collaborators: mapped } });
      return result(data?.updateProjectV2Collaborators?.collaborators?.nodes ?? []);
    }
  );

  registerTool(server, authContext,
    "mark_project_as_template",
    "Mark an organization-owned GitHub Project V2 as a template.",
    { project_id: z.string() },
    async ({ project_id }) => {
      const query = "mutation($input:MarkProjectV2AsTemplateInput!){markProjectV2AsTemplate(input:$input){projectV2{id number title template url}}}";
      const data = await graphql(query, { input: { projectId: project_id } });
      return result(data?.markProjectV2AsTemplate?.projectV2);
    }
  );

  registerTool(server, authContext,
    "unmark_project_as_template",
    "Remove the template flag from a GitHub Project V2.",
    { project_id: z.string() },
    async ({ project_id }) => {
      const query = "mutation($input:UnmarkProjectV2AsTemplateInput!){unmarkProjectV2AsTemplate(input:$input){projectV2{id number title template url}}}";
      const data = await graphql(query, { input: { projectId: project_id } });
      return result(data?.unmarkProjectV2AsTemplate?.projectV2);
    }
  );
}
