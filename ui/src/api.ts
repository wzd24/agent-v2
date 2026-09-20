import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Json = Record<string, unknown>;

export type EngineStatus = {
  state: string;
  message?: string | null;
  codexHome: string;
  binary?: string | null;
  attempt: number;
  model?: string | null;
  apiKeyConfigured?: boolean;
};

export type Settings = {
  model: string;
  modelProvider: string;
  baseUrl: string;
  envKey: string;
  apiKeyConfigured: boolean;
  codexHome: string;
  workspace?: string | null;
};

export type SettingsPatch = {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  workspace?: string;
};

export type TreeEntry = {
  name: string;
  path: string;
  kind: "directory" | "file" | string;
  children?: TreeEntry[] | null;
};

export type FileContent = {
  path: string;
  name: string;
  text: string;
  truncated: boolean;
};

export type RpcMessage = {
  method: string;
  params?: Json;
  id?: string | number;
};

export async function engineStatus() {
  return invoke<EngineStatus>("engine_status");
}

export async function engineRestart() {
  return invoke<EngineStatus>("engine_restart");
}

export async function rpcRequest<T = unknown>(method: string, params?: unknown) {
  return invoke<T>("rpc_request", { method, params: params ?? {} });
}

export async function rpcRespond(id: string | number, result: unknown) {
  return invoke<void>("rpc_respond", { id, result });
}

export async function pickWorkspace() {
  return invoke<string | null>("pick_workspace");
}

export async function listWorkspace(root: string, path?: string, depth = 0) {
  return invoke<TreeEntry[]>("list_workspace", { root, path: path || null, depth });
}

export async function readWorkspaceFile(root: string, path: string) {
  return invoke<FileContent>("read_workspace_file", { root, path });
}

export async function getSettings() {
  return invoke<Settings>("get_settings");
}

export async function saveSettings(patch: SettingsPatch, restart = true) {
  return invoke<Settings>("save_settings", {
    patch,
    model: patch.model,
    baseUrl: patch.baseUrl,
    apiKey: patch.apiKey,
    workspace: patch.workspace,
    restart,
  });
}

export async function onStatus(handler: (status: EngineStatus) => void): Promise<UnlistenFn> {
  return listen<EngineStatus>("appserver://status", (event) => handler(event.payload));
}

export async function onNotification(handler: (message: RpcMessage) => void): Promise<UnlistenFn> {
  return listen<RpcMessage>("appserver://notification", (event) => handler(event.payload));
}

export async function onRequest(handler: (message: RpcMessage) => void): Promise<UnlistenFn> {
  return listen<RpcMessage>("appserver://request", (event) => handler(event.payload));
}
