import assert from "node:assert/strict";
import fs from "node:fs";

const index = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const management = fs.readFileSync(new URL("../src/project-management.js", import.meta.url), "utf8");
const oauthSource = () => fs.readFileSync(new URL("../src/oauth.js", import.meta.url), "utf8");

function extractReadProjectItemsQuery(source) {
  const start = source.indexOf("async function readProjectItems");
  const qStart = source.indexOf('const query = "', start);
  const qEnd = source.indexOf('";', qStart);
  return source.slice(qStart + 'const query = "'.length, qEnd);
}

function balanced(query) {
  let depth = 0;
  for (const char of query) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    assert.ok(depth >= 0, "GraphQL query closed before it opened");
  }
  return depth === 0;
}

const readQuery = extractReadProjectItemsQuery(index);
assert.equal(balanced(readQuery), true, "readProjectItems GraphQL query must be balanced");
assert.match(
  management,
  /updateProjectV2DraftIssue\(input:\$input\)\{draftIssue\{id title body\}\}/,
  "draft issue mutation should use a minimal response selection"
);

assert.match(index, /oauth\.getGithubAccessToken\(authContext\.claims\)/, "GitHub API calls should use the authenticated user's OAuth credential");
assert.match(index, /githubGraphql\(query, variables, await currentGithubToken\(\)\)/, "GraphQL calls should resolve the current GitHub user token");
assert.match(index, /resolveOwnerIdForUser/, "Owner resolution should use the authenticated user's GitHub token");
assert.match(index, /resolveRepositoryIdForUser/, "Repository resolution should use the authenticated user's GitHub token");

assert.match(oauthSource(), /const GITHUB_SCOPES = \["read:user", "project", "repo", "read:org", "offline_access"\]/, "GitHub OAuth should request the required permission scopes");
assert.match(oauthSource(), /credential_id: credentialId/, "Issued MCP access tokens should identify the stored GitHub OAuth credential");
assert.match(oauthSource(), /createCipheriv\("aes-256-gcm"/, "GitHub OAuth credentials should be encrypted at rest");

assert.doesNotMatch(index, /GITHUB_TOKEN/, "GitHub API access should not fall back to a server-side PAT");

console.log("GraphQL regression checks passed.");
