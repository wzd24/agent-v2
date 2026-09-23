'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function samePath(a, b) {
  return path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();
}

function projectRoots(project) {
  const listed = Array.isArray(project?.rootPaths) ? project.rootPaths : [];
  const roots = listed.length ? listed : (project?.path ? [project.path] : []);
  const resolved = [];
  for (const root of roots) {
    const value = path.resolve(String(root || ''));
    if (value && !resolved.some((item) => samePath(item, value))) resolved.push(value);
  }
  return resolved;
}

function findLocalProject(projects, projectPath) {
  const values = Array.isArray(projects) ? projects : Object.values(projects || {});
  return values.find((project) => projectRoots(project).some((root) => samePath(root, projectPath))) || null;
}

function addRootToProject(project, extraPath) {
  const extra = path.resolve(String(extraPath || ''));
  if (!extra) throw new Error('源文件夹不存在');
  const roots = projectRoots(project);
  if (roots.some((root) => samePath(root, extra))) return { ...project, path: roots[0], rootPaths: roots };
  const next = [...roots, extra];
  return { ...project, path: next[0], rootPaths: next };
}

function setProjectRoots(project, nextRoots) {
  const roots = [];
  for (const root of Array.isArray(nextRoots) ? nextRoots : []) {
    const value = path.resolve(String(root || ''));
    if (value && !roots.some((item) => samePath(item, value))) roots.push(value);
  }
  if (!roots.length) throw new Error('至少需要一个源文件夹');
  return { ...project, path: roots[0], rootPaths: roots };
}

function allProjectRoots(projects) {
  return (Array.isArray(projects) ? projects : []).flatMap((project) => projectRoots(project));
}

function appRoot() {
  if (process.env.LOCAL_CODEX_HOME && String(process.env.LOCAL_CODEX_HOME).trim()) {
    return path.resolve(String(process.env.LOCAL_CODEX_HOME).trim());
  }
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(roaming, 'local-codex');
}

function engineHome() {
  const modern = path.join(appRoot(), 'engine');
  const legacy = path.join(appRoot(), 'codex-home');
  if (fs.existsSync(modern) || !fs.existsSync(legacy)) return modern;
  return legacy;
}

function listStoredProjects(home) {
  const dest = path.join(appRoot(), 'projects.json');
  try {
    if (fs.existsSync(dest)) {
      const data = JSON.parse(fs.readFileSync(dest, 'utf8'));
      const projects = Array.isArray(data.projects) ? data.projects : [];
      return projects.map((project) => {
        const roots = projectRoots(project);
        if (!roots[0]) return null;
        return { id: String(project.id || ''), path: roots[0], rootPaths: roots, name: String(project.name || path.basename(roots[0]) || roots[0]) };
      }).filter(Boolean);
    }
  } catch { /* fall through to engine-home legacy files */ }
  const root = path.resolve(String(home || engineHome()));
  const globalFile = path.join(root, '.codex-global-state.json');
  try {
    const state = JSON.parse(fs.readFileSync(globalFile, 'utf8'));
    const persisted = state?.['electron-persisted-atom-state'] || {};
    const localProjects = state['local-projects'] || persisted['local-projects'];
    if (localProjects && typeof localProjects === 'object') {
      return Object.values(localProjects).map((project) => {
        const roots = projectRoots(project);
        if (!roots[0]) return null;
        return { id: String(project.id || ''), path: roots[0], rootPaths: roots, name: String(project.name || path.basename(roots[0]) || roots[0]) };
      }).filter(Boolean);
    }
  } catch { /* older Codex installations may not have global state yet */ }
  const configPath = path.join(root, 'config.toml');
  if (!fs.existsSync(configPath)) return [];
  const source = fs.readFileSync(configPath, 'utf8');
  const projects = [];
  const sectionPattern = /^\[projects\.(?:"((?:\\.|[^"])*)"|'([^']*)')\]\s*$/gm;
  let match;
  while ((match = sectionPattern.exec(source))) {
    const projectPath = (match[1] ? match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : match[2]).trim();
    projects.push({ path: projectPath, rootPaths: [projectPath], name: path.basename(projectPath) || projectPath });
  }
  return projects;
}

module.exports = {
  samePath,
  projectRoots,
  findLocalProject,
  addRootToProject,
  setProjectRoots,
  allProjectRoots,
  listStoredProjects,
  appRoot,
  engineHome,
};
