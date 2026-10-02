import assert from "node:assert/strict";
import fs from "node:fs";

const index = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const management = fs.readFileSync(new URL("../src/project-management.js", import.meta.url), "utf8");

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

console.log("GraphQL regression checks passed.");
