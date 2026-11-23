// Minimal JSON-file store for the prototype. One file per project under DATA_DIR/projects.
// Swap for a database in a later step; the interface is deliberately small.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export class Store {
  constructor(dataDir) {
    this.dir = path.resolve(dataDir);
    this.projectsDir = path.join(this.dir, "projects");
  }

  async init() {
    await fs.mkdir(this.projectsDir, { recursive: true });
    return this;
  }

  projectDir(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Object.assign(new Error("Invalid project id"), { status: 400 });
    return path.join(this.projectsDir, id);
  }

  async createProject({ name, reference }) {
    const id = crypto.randomUUID();
    const project = {
      id,
      name: name || "Untitled project",
      reference: reference || null, // the discovered video that inspired this project, if any
      createdAt: new Date().toISOString(),
      sources: [],
      rights: [],
      cuts: [],
      original: null,
    };
    await fs.mkdir(path.join(this.projectDir(id), "sources"), { recursive: true });
    await fs.mkdir(path.join(this.projectDir(id), "renders"), { recursive: true });
    await this.save(project);
    return project;
  }

  async get(id) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.projectDir(id), "project.json"), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") throw Object.assign(new Error("Project not found"), { status: 404 });
      throw e;
    }
  }

  async save(project) {
    const file = path.join(this.projectDir(project.id), "project.json");
    await fs.writeFile(`${file}.tmp`, JSON.stringify(project, null, 2));
    await fs.rename(`${file}.tmp`, file);
    return project;
  }
}
