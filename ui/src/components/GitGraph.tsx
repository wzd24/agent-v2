import React from "react";
import { icons, UiIcon } from "./UiIcon";

export type GraphCommit = {
  id: string;
  shortId?: string;
  title?: string;
  authorName?: string;
  authoredDate?: string;
  createdAt?: string;
  parentIds?: string[];
  refs?: string[];
  webUrl?: string;
};

type GraphLink = { from: number; to: number; color: number };
type Lane = { sha: string; color: number };

type GraphRow = {
  commit: GraphCommit;
  column: number;
  color: number;
  up: GraphLink[];
  down: GraphLink[];
};

const LANE_COLORS = ["#e09a3e", "#4ecdc4", "#6cbf6c", "#d46bb5", "#5aa2e0", "#e06060", "#e6c14a", "#8b7ec8", "#7eb8ea", "#c4a35a", "#58d68d", "#e07a5f"];
const COL_W = 11;
const ROW_H = 36;
const MID_Y = 18;
const PAD_X = 6;

function findLane(lanes: Array<Lane | null>, sha: string) {
  return lanes.findIndex((lane) => lane?.sha === sha);
}

function takeSlot(lanes: Array<Lane | null>, sha: string, color: number) {
  const hole = lanes.findIndex((lane) => !lane);
  if (hole >= 0) {
    lanes[hole] = { sha, color };
    return hole;
  }
  lanes.push({ sha, color });
  return lanes.length - 1;
}

function trimTrailing(lanes: Array<Lane | null>) {
  while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
}

function layoutGitGraph(commits: GraphCommit[]): GraphRow[] {
  const drawn = new Set<string>();
  const rows: GraphRow[] = [];
  const active: Array<Lane | null> = [];
  let nextColor = 0;
  const allocColor = () => {
    const value = nextColor;
    nextColor += 1;
    return value;
  };

  for (const commit of commits) {
    const parents = (commit.parentIds || []).map((item) => String(item || "").trim()).filter((item) => item && !drawn.has(item));
    const incoming = active.map((lane) => (lane ? { ...lane } : null));
    const hits: number[] = [];
    for (let index = 0; index < incoming.length; index += 1) {
      if (incoming[index]?.sha === commit.id) hits.push(index);
    }

    const isNewTip = hits.length === 0;
    let column = hits[0];
    let color = isNewTip ? allocColor() : incoming[column]!.color;
    if (isNewTip) column = takeSlot(incoming, commit.id, color);

    const up: GraphLink[] = [];
    for (let index = 0; index < incoming.length; index += 1) {
      const lane = incoming[index];
      if (!lane) continue;
      if (isNewTip && index === column) continue;
      up.push(lane.sha === commit.id
        ? { from: index, to: column, color: lane.color }
        : { from: index, to: index, color: lane.color });
    }

    const next = incoming.map((lane) => (lane && lane.sha !== commit.id ? { ...lane } : null));
    const forks: GraphLink[] = [];
    const born = new Set<number>();

    if (parents[0]) {
      const existing = findLane(next, parents[0]);
      if (existing >= 0 && existing !== column) {
        forks.push({ from: column, to: existing, color: next[existing]!.color });
      } else {
        next[column] = { sha: parents[0], color };
        forks.push({ from: column, to: column, color });
      }
    }

    for (const parent of parents.slice(1)) {
      const existing = findLane(next, parent);
      if (existing >= 0) {
        forks.push({ from: column, to: existing, color: next[existing]!.color });
        continue;
      }
      const slot = takeSlot(next, parent, allocColor());
      born.add(slot);
      forks.push({ from: column, to: slot, color: next[slot]!.color });
    }

    const down: GraphLink[] = [];
    const seen = new Set<string>();
    const addDown = (link: GraphLink) => {
      const key = `${link.from}->${link.to}:${link.color}`;
      if (seen.has(key)) return;
      seen.add(key);
      down.push(link);
    };
    for (const link of forks) addDown(link);
    for (let index = 0; index < next.length; index += 1) {
      const lane = next[index];
      if (!lane || born.has(index)) continue;
      addDown({ from: index, to: index, color: lane.color });
    }

    trimTrailing(next);
    rows.push({ commit, column, color, up, down });
    drawn.add(commit.id);
    active.length = 0;
    active.push(...next);
  }
  return rows;
}

function laneX(column: number) {
  return column * COL_W + PAD_X;
}

function laneColor(index: number) {
  return LANE_COLORS[index % LANE_COLORS.length];
}

function curve(from: number, y1: number, to: number, y2: number) {
  const x1 = laneX(from);
  const x2 = laneX(to);
  if (from === to) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const mid = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
}

function refMeta(name: string) {
  const raw = String(name || "");
  const isTag = raw.startsWith("tag:");
  const isRemote = /^origin\//.test(raw);
  const value = raw.replace(/^tag:/, "").replace(/^origin\//, "");
  let kind = "branch";
  if (isTag) kind = "tag";
  else if (/^(feature|feat)\//i.test(value)) kind = "feature";
  else if (/^fix\//i.test(value)) kind = "fix";
  else if (/^release\//i.test(value)) kind = "release";
  else if (/^(develop|main|master)$/i.test(value)) kind = "trunk";
  return { kind, value, isTag, isRemote, raw };
}

function formatGraphDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const month = date.toLocaleString("en-GB", { month: "short" });
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${date.getDate()} ${month} ${date.getFullYear()} ${hours}:${minutes}`;
}

function shortSha(value?: string) {
  return String(value || "").slice(0, 8);
}

export function GitGraph({
  commits,
  filter = "",
  onOpenCommit,
  onOpenFiles,
}: {
  commits: GraphCommit[];
  filter?: string;
  onOpenCommit: (sha: string, item: GraphCommit) => void;
  onOpenFiles: (sha: string) => void;
  onOpenRemote?: (event: React.MouseEvent, url?: string) => void;
}) {
  const rows = React.useMemo(() => layoutGitGraph(commits), [commits]);
  const needle = filter.trim().toLowerCase();
  const matchRow = (row: GraphRow) => !needle || `${row.commit.title} ${row.commit.shortId} ${row.commit.authorName} ${(row.commit.refs || []).join(" ")}`.toLowerCase().includes(needle);
  const lanes = rows.reduce((max, row) => Math.max(max, row.column + 1, ...row.up.map((link) => Math.max(link.from, link.to) + 1), ...row.down.map((link) => Math.max(link.from, link.to) + 1)), 1);
  const graphWidth = Math.max(lanes * COL_W + PAD_X, 22);

  if (rows.length === 0) return null;
  return (
    <div className="git-graph" style={{ ["--graph-w" as string]: `${graphWidth}px` }}>
      <div className="git-graph-head">
        <span className="git-graph-col-graph" />
        <span className="git-graph-col-desc">说明</span>
        <span className="git-graph-col-date">日期</span>
        <span className="git-graph-col-author">作者</span>
        <span className="git-graph-col-sha">提交</span>
        <span className="git-graph-col-actions" />
      </div>
      <div className="git-graph-body">
        <svg className="git-graph-svg" width={graphWidth} height={rows.length * ROW_H} aria-hidden="true">
          {rows.map((row, index) => {
            const top = index * ROW_H;
            const mid = top + MID_Y;
            const bot = top + ROW_H;
            return (
              <g key={row.commit.id}>
                {row.up.map((link, linkIndex) => (
                  <path key={`u${linkIndex}`} d={curve(link.from, top, link.to, mid)} fill="none" stroke={laneColor(link.color)} strokeWidth="2" />
                ))}
                {row.down.map((link, linkIndex) => (
                  <path key={`d${linkIndex}`} d={curve(link.from, mid, link.to, bot)} fill="none" stroke={laneColor(link.color)} strokeWidth="2" />
                ))}
                <circle cx={laneX(row.column)} cy={mid} r="3.5" fill={laneColor(row.color)} stroke="var(--bg)" strokeWidth="1.25" />
              </g>
            );
          })}
        </svg>
        {rows.map((row) => (
          <div className={`git-graph-row${matchRow(row) ? "" : " is-dim"}`} key={row.commit.id}>
            <span className="git-graph-col-graph" />
            <button type="button" className="git-graph-desc" onClick={() => onOpenCommit(row.commit.id, row.commit)}>
              <span className="git-graph-refs">
                {(row.commit.refs || []).map((ref) => {
                  const meta = refMeta(ref);
                  return (
                    <em className={`git-graph-ref is-${meta.kind}`} key={ref}>
                      <UiIcon icon={meta.isTag ? icons.tag : icons.branch} />
                      {meta.isRemote && <span>origin</span>}
                      {meta.value}
                    </em>
                  );
                })}
              </span>
              <strong>{row.commit.title || shortSha(row.commit.shortId || row.commit.id)}</strong>
            </button>
            <span className="git-graph-date">{formatGraphDate(row.commit.authoredDate || row.commit.createdAt)}</span>
            <span className="git-graph-author" title={row.commit.authorName}>{row.commit.authorName || "未知作者"}</span>
            <button type="button" className="git-graph-sha" onClick={() => onOpenCommit(row.commit.id, row.commit)}>{shortSha(row.commit.shortId || row.commit.id)}</button>
            <span className="git-graph-actions">
              <button type="button" title="文件列表" onClick={() => onOpenFiles(row.commit.id)}><UiIcon icon={icons.folder} /></button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
