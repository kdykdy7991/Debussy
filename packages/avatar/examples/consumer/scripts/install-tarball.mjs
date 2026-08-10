import { cp, access } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const input = process.argv[2];
if (!input || !input.endsWith(".tgz")) throw new Error("Usage: npm run install:tarball -- /absolute/path/to/avatar.tgz");
const source = resolve(input);
await access(source);
const destination = resolve(".avatar-tarball.tgz");
await cp(source, destination);
await run("npm", ["install", "--package-lock-only", "--ignore-scripts"], { stdio: "inherit" });
console.log(`Installed packed @skdy/avatar from ${basename(source)}`);
