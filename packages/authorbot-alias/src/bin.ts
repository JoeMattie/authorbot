#!/usr/bin/env node
/**
 * `authorbot` — the unscoped name, forwarding to `@authorbot/cli`.
 *
 * WHY THIS PACKAGE EXISTS. Everything user-facing says `npx authorbot
 * validate .`: the generated CI workflows, the wizard's error messages, the
 * documentation. Inside a book that instruction resolves to
 * `node_modules/.bin/authorbot`, which `@authorbot/cli` provides, so it has
 * always worked there. Outside one — or before `npm install` has run — npx
 * asks the registry for the bare name instead, and for a long time that was an
 * unmaintained 0.0.2 bearing no relation to the toolchain being documented.
 *
 * So this is not a convenience alias; it is the name our own instructions
 * hand to people. It ships from the same release as the CLI and depends on the
 * exact matching version, which is the property that makes those instructions
 * true rather than approximately true.
 *
 * It forwards in-process rather than spawning: argv, stdin, stdout, and the
 * exit code are already correct, and a child process would only add a layer to
 * get those wrong in.
 */
import "@authorbot/cli/bin";
