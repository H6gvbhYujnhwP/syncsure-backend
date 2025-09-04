import fetch from "node-fetch";

const OWNER = process.env.GITHUB_OWNER || "H6gvbhYujnhwP";
const REPO  = process.env.GITHUB_REPO  || "Syncsure_Tool";
const PAT   = process.env.GITHUB_PAT   || "";

function ghHeaders() {
  return {
    Authorization: `Bearer ${PAT}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json"
  };
}

export async function triggerWorkflow(workflowFile = "build-and-release.yml", ref = "main", inputs = {}) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${workflowFile}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: ghHeaders(),
    body: JSON.stringify({ ref, inputs })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub dispatch failed: ${res.status} ${txt}`);
  }
  return true;
}

export async function latestReleaseByTag(tag) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub release fetch failed: ${res.status} ${txt}`);
  }
  return res.json();
}

