/**
 * @authorbot/api/local — Node-only exports (uses `node:fs`). Import from here
 * in tests and local tooling; never from Worker code.
 */
export { LocalFsBookRepoReader, stripFrontmatter } from "./projection/local-fs.js";
export { createInlineMirror, type InlineMirror, type InlineMirrorOptions } from "./mirror.js";
export { createNodeDevApi, serveNodeDevApi, type NodeDevApi } from "./dev-server.js";
