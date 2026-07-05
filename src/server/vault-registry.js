import crypto from 'crypto';
import { readFileSync, mkdirSync, writeFileSync, renameSync, accessSync, statSync, constants } from 'fs';
import path from 'path';

export default class VaultRegistry {
  constructor(registryPath) {
    this.registryPath = registryPath;
    this.vaults = this.load();
  }

  load() {
    try {
      return JSON.parse(readFileSync(this.registryPath, 'utf8')) || {};
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      // Corrupt or unreadable file — start empty and log, don't crash the server.
      console.error('[vault-registry] corrupt registry, starting empty:', err.message);
      return {};
    }
  }

  save() {
    const dir = path.dirname(this.registryPath);
    mkdirSync(dir, { recursive: true });
    const tmp = this.registryPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.vaults, null, 2));
    renameSync(tmp, this.registryPath);
  }

  list() {
    return { ...this.vaults };
  }

  get(id) {
    return this.vaults[id] || null;
  }

  findIdByPath(vaultPath) {
    const resolved = path.resolve(vaultPath);
    for (const [id, vault] of Object.entries(this.vaults)) {
      if (path.resolve(vault.path) === resolved) return id;
    }
    return null;
  }

  open(vaultPath, create) {
    if (!vaultPath || typeof vaultPath !== 'string') {
      return { ok: false, error: 'folder not found' };
    }

    const resolved = path.resolve(vaultPath);
    if (create) {
      mkdirSync(resolved, { recursive: true });
    }

    let stats;
    try {
      stats = statSync(resolved);
    } catch (err) {
      return { ok: false, error: 'folder not found' };
    }

    if (!stats.isDirectory()) {
      return { ok: false, error: 'path is not a folder' };
    }

    try {
      accessSync(resolved, constants.R_OK | constants.W_OK);
    } catch (err) {
      return { ok: false, error: 'no permission to access folder' };
    }

    const existingId = this.findIdByPath(resolved);
    const id = existingId || crypto.randomBytes(8).toString('hex');
    this.vaults[id] = {
      path: resolved,
      ts: Date.now(),
      open: true,
    };
    this.save();
    return { ok: true, id };
  }

  remove(vaultPath) {
    const id = this.findIdByPath(vaultPath);
    if (!id) return false;
    delete this.vaults[id];
    this.save();
    return true;
  }

  move(oldPath, newPath) {
    if (!oldPath || typeof oldPath !== 'string') return { ok: false, notFound: true };
    const id = this.findIdByPath(oldPath);
    if (!id) return { ok: false, notFound: true };

    const resolvedNewPath = path.resolve(newPath);
    try {
      renameSync(this.vaults[id].path, resolvedNewPath);
    } catch (err) {
      return { ok: false, error: err.message, code: err.code };
    }

    this.vaults[id] = {
      ...this.vaults[id],
      path: resolvedNewPath,
      ts: Date.now(),
    };
    this.save();
    return { ok: true };
  }
}
