import React from "react";
import { api } from "../api";
import { useCoverBrowser } from "../coverBrowser";
import { icons, UiIcon } from "./UiIcon";

function platformLabel(value: string) {
  if (!value) return "—";
  if (value.startsWith("win32/")) {
    const arch = value.slice("win32/".length);
    if (arch === "x64") return "Windows 64 位";
    if (arch === "arm64" || arch === "aarch64") return "Windows ARM64";
    return `Windows ${arch}`;
  }
  return value;
}

export function AboutDialog({
  onClose,
  onCheckUpdates,
  onOpenLicenses,
}: {
  onClose: () => void;
  onCheckUpdates: () => void;
  onOpenLicenses: () => void;
}) {
  useCoverBrowser(true);
  const [version, setVersion] = React.useState("0.1.0");
  const [platform, setPlatform] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [info, diagnostics] = await Promise.all([
          api.app.info(),
          api.diagnostics.read().catch(() => null),
        ]);
        if (cancelled) return;
        if (info?.version) setVersion(String(info.version));
        if (diagnostics?.platform) setPlatform(String(diagnostics.platform));
      } catch {
        // 打不开诊断时仍显示名称和默认版本。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="new-project-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="new-project-modal about-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="new-project-modal-head">
          <h2 id="about-dialog-title">关于</h2>
          <button type="button" title="关闭" onClick={onClose}>
            <UiIcon icon={icons.close} />
          </button>
        </div>
        <div className="about-identity">
          <img src="/app-icon.png" alt="" width={72} height={72} />
          <div>
            <strong>Scorpio Agent</strong>
            <span>版本 {version}</span>
          </div>
        </div>
        <p className="about-lead">
          在这台电脑上对话、阅读和修改工作区、调用本地工具。项目、偏好和对话记录保存在本机，不会自动发到云端。
        </p>
        <dl className="about-facts">
          <div>
            <dt>版本</dt>
            <dd>{version}</dd>
          </div>
          <div>
            <dt>平台</dt>
            <dd>{platformLabel(platform)}</dd>
          </div>
          <div>
            <dt>标识</dt>
            <dd>com.wzd24.localcodex</dd>
          </div>
        </dl>
        <div className="new-project-modal-actions about-actions">
          <button type="button" className="new-project-cancel" onClick={onCheckUpdates}>
            检查更新
          </button>
          <button type="button" className="new-project-cancel" onClick={onOpenLicenses}>
            开源许可
          </button>
          <button type="button" className="new-project-submit" onClick={onClose}>
            关闭
          </button>
        </div>
      </section>
    </div>
  );
}
