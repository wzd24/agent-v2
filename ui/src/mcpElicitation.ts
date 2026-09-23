export function mcpAllowTool(params: any): { server: string; tool: string } | null {
  const server = String(params?.serverName || "").trim();
  const message = String(params?.message || "");
  const meta =
    params?._meta && typeof params._meta === "object" ? params._meta : {};
  const fromMeta = String(
    meta.toolName || meta.tool || meta.tool_name || "",
  ).trim();
  const fromMessage = message.match(/tool[/:]([^\s?]+)/i)?.[1] || "";
  const tool = (fromMeta || fromMessage).replace(/[?.]+$/, "");
  if (!server && !tool) return null;
  return { server, tool };
}

export function isMcpAllowElicitation(params: any): boolean {
  if (!params || typeof params !== "object") return false;
  const mode = String(params.mode || "form");
  if (mode === "url" || mode === "openai/userVerification") return false;
  if (mcpAllowTool(params)) return true;
  if (/^allow\b/i.test(String(params.message || ""))) return true;
  const props = params.requestedSchema?.properties;
  if (props && typeof props === "object") {
    const keys = Object.keys(props);
    if (keys.length === 0) return true;
    return keys.every((key) => {
      const spec = props[key] || {};
      return spec.type === "boolean" || Array.isArray(spec.enum);
    });
  }
  return !params.requestedSchema;
}

export function mcpElicitationContent(
  params: any,
  approved: boolean,
  raw?: string,
): any {
  const text = String(raw || "").trim();
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  const props = params?.requestedSchema?.properties;
  if (!props || typeof props !== "object") return approved ? {} : null;
  const content: Record<string, any> = {};
  for (const [key, spec] of Object.entries(props as Record<string, any>)) {
    if (!spec || typeof spec !== "object") continue;
    if (approved && spec.default !== undefined) {
      content[key] = spec.default;
      continue;
    }
    if (spec.type === "boolean") {
      content[key] = approved;
      continue;
    }
    if (Array.isArray(spec.enum) && spec.enum.length > 0) {
      const enums = spec.enum.map(String);
      const preferred = approved
        ? enums.find((item) =>
            /^(allow|accept|yes|true|approve|approved)$/i.test(item),
          )
        : enums.find((item) =>
            /^(deny|decline|no|false|reject)$/i.test(item),
          );
      content[key] =
        preferred ?? (approved ? spec.enum[0] : spec.enum[spec.enum.length - 1]);
    }
  }
  return content;
}

export function mcpElicitationResponse(
  action: "accept" | "decline" | "cancel",
  params: any,
  raw?: string,
) {
  return {
    action,
    content: action === "accept" ? mcpElicitationContent(params, true, raw) : null,
    _meta: null,
  };
}

export function mcpRememberedTools(
  config: Record<string, any> | null | undefined,
): Record<string, string[] | "*"> {
  const value = config?.mcp_allowed_tools;
  return value && typeof value === "object" ? value : {};
}

export function mcpServerAlreadyGranted(
  server: string,
  config: Record<string, any> | null | undefined,
): boolean {
  const name = String(server || "").toLowerCase();
  return Boolean(name) && mcpRememberedTools(config)[name] === "*";
}

export function mcpToolAlreadyGranted(
  server: string,
  tool: string,
  config: Record<string, any> | null | undefined,
  sessionKeys: Set<string>,
): boolean {
  const name = String(server || "").toLowerCase();
  const key = `${name}:${tool}`;
  if (sessionKeys.has(`${name}:*`) || sessionKeys.has(key)) return true;
  const remembered = mcpRememberedTools(config);
  if (remembered[name] === "*") return true;
  return Array.isArray(remembered[name]) && remembered[name].includes(tool);
}
