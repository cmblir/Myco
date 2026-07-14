// Lightweight inline SVG icons (Lucide-style, 1.5px stroke, monochrome).

import type { JSX } from "react";
// The real app logo (the user's mushroom character, background removed) —
// replaces the old pixel-art placeholder glyph everywhere MemexMark renders.
import logoUrl from "../assets/logo.png";

export type IconName =
  | "home"
  | "search"
  | "plus"
  | "inbox"
  | "sparkles"
  | "msg"
  | "graph"
  | "history"
  | "quote"
  | "settings"
  | "sun"
  | "moon"
  | "chevR"
  | "chevD"
  | "chevL"
  | "folder"
  | "page"
  | "file"
  | "bolt"
  | "upload"
  | "key"
  | "link"
  | "check"
  | "x"
  | "eye"
  | "download"
  | "revert"
  | "trash"
  | "edit"
  | "sidebar"
  | "cmd"
  | "globe"
  | "cloud"
  | "terminal"
  | "spark"
  | "info"
  | "arrowR"
  | "arrowL"
  | "dotMore"
  | "book"
  | "save"
  | "shield";

export function Icon({
  name,
  size = 16,
}: {
  name: IconName;
  size?: number;
}): JSX.Element | null {
  const props = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const paths: Record<IconName, JSX.Element> = {
    home: (
      <>
        <path d="M3 11l9-8 9 8" />
        <path d="M5 10v10h14V10" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    inbox: (
      <>
        <path d="M3 13h5l2 3h4l2-3h5" />
        <path d="M5 5h14v8H5z" />
      </>
    ),
    sparkles: (
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M5.6 18.4l2-2M16.4 7.6l2-2" />
    ),
    msg: <path d="M4 5h16v12H7l-3 3z" />,
    graph: (
      <>
        <circle cx="6" cy="6" r="2" />
        <circle cx="18" cy="6" r="2" />
        <circle cx="12" cy="18" r="2" />
        <path d="M7.4 7.4l3.2 9.2M16.6 7.4l-3.2 9.2M8 6h8" />
      </>
    ),
    history: (
      <>
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 4v5h5" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    quote: (
      <path d="M7 7h4v4H7zM7 11c0 3 2 4 4 4M13 7h4v4h-4zM13 11c0 3 2 4 4 4" />
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a8 8 0 0 0 0-6l1.5-1.5-2-3.4-2 1A8 8 0 0 0 12 3l-.5-2.2h-3L8 3a8 8 0 0 0-5 2.1l-2-1L-1 7l1.5 1.5a8 8 0 0 0 0 6L-1 16l2 3.4 2-1A8 8 0 0 0 8 21l.5 2.2h3L12 21a8 8 0 0 0 5-2.1l2 1 2-3.4z" />
      </>
    ),
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M5 19l1.4-1.4M17.6 6.4L19 5" />
      </>
    ),
    moon: <path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z" />,
    chevR: <path d="M9 6l6 6-6 6" />,
    chevD: <path d="M6 9l6 6 6-6" />,
    chevL: <path d="M15 6l-6 6 6 6" />,
    folder: <path d="M3 6h6l2 2h10v11H3z" />,
    page: (
      <>
        <path d="M6 3h9l4 4v14H6z" />
        <path d="M14 3v5h5" />
      </>
    ),
    file: (
      <>
        <path d="M6 3h12v18H6z" />
        <path d="M9 8h6M9 12h6M9 16h4" />
      </>
    ),
    bolt: <path d="M13 3L4 14h7l-1 7 9-11h-7z" />,
    upload: (
      <>
        <path d="M4 17v3h16v-3" />
        <path d="M12 4v12M7 9l5-5 5 5" />
      </>
    ),
    key: (
      <>
        <circle cx="9" cy="14" r="4" />
        <path d="M12 14l9-9M16 9l3 3" />
      </>
    ),
    link: (
      <>
        <path d="M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1 1" />
        <path d="M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1-1" />
      </>
    ),
    check: <path d="M5 13l4 4 10-10" />,
    x: <path d="M6 6l12 12M18 6L6 18" />,
    eye: (
      <>
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    download: (
      <>
        <path d="M4 17v3h16v-3" />
        <path d="M12 4v12M7 9l5 5 5-5" />
      </>
    ),
    revert: (
      <>
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 4v5h5" />
      </>
    ),
    trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
    edit: <path d="M14 4l6 6L9 21H3v-6z" />,
    sidebar: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16" />
      </>
    ),
    cmd: (
      <path d="M9 6V4a2 2 0 1 0-2 2zM9 18v2a2 2 0 1 1-2-2zM15 6V4a2 2 0 1 1 2 2zM15 18v2a2 2 0 1 0 2-2zM9 6h6v12H9z" />
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
      </>
    ),
    cloud: (
      <path d="M7 18a4 4 0 1 1 1.5-7.7A6 6 0 0 1 20 12a4 4 0 0 1-2 7.5z" />
    ),
    terminal: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M7 9l3 3-3 3M13 15h4" />
      </>
    ),
    spark: <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />,
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v0M12 11v6" />
      </>
    ),
    arrowR: <path d="M5 12h14M13 5l7 7-7 7" />,
    arrowL: <path d="M19 12H5M11 5l-7 7 7 7" />,
    dotMore: (
      <>
        <circle cx="6" cy="12" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="18" cy="12" r="1" />
      </>
    ),
    book: (
      <>
        <path d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4z" />
        <path d="M4 4v12a4 4 0 0 1 4-4h12" />
      </>
    ),
    save: (
      <>
        <path d="M5 3h13l3 3v15H5z" />
        <path d="M8 3v6h8V3M8 21v-7h8v7" />
      </>
    ),
    shield: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />,
  };
  return <svg {...props}>{paths[name] ?? null}</svg>;
}

export function MemexMark({ size = 22 }: { size?: number }): JSX.Element {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      alt="Memex"
      draggable={false}
      style={{ display: "block", objectFit: "contain" }}
    />
  );
}

export type ProviderId =
  | "anthropic-cli"
  | "gemini-cli"
  | "codex-cli"
  | "anthropic-api"
  | "openai-api"
  | "google-api"
  | "ollama"
  | "openrouter"
  | "memex-pro"
  | "builtin-local";

export function ProviderGlyph({
  id,
  size = 18,
}: {
  id: ProviderId;
  size?: number;
}): JSX.Element | null {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "currentColor" as const,
  };
  const stroke = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.6,
  };
  switch (id) {
    case "memex-pro":
      return (
        <svg {...common}>
          <path d="M12 2l2.6 6 6.4.5-4.9 4.2 1.5 6.3L12 15.8 6.4 19l1.5-6.3L3 8.5 9.4 8z" />
        </svg>
      );
    case "builtin-local":
      // Chip glyph — the model lives inside the app binary.
      return (
        <svg {...stroke}>
          <rect x="7" y="7" width="10" height="10" rx="1.5" />
          <path d="M10 7V4M14 7V4M10 20v-3M14 20v-3M7 10H4M7 14H4M20 10h-3M20 14h-3" />
        </svg>
      );
    case "anthropic-cli":
    case "anthropic-api":
      return (
        <svg {...common}>
          <path d="M5 19l4-14h2l4 14h-2l-1-3.6H8L7 19zm3.6-5.7h3.8L10.5 7z" />
          <circle cx="18" cy="19" r="1.5" />
        </svg>
      );
    case "openai-api":
      return (
        <svg {...stroke}>
          <path d="M12 3l8 5v8l-8 5-8-5V8z" />
          <path d="M12 8v8M4 8l8 5 8-5" />
        </svg>
      );
    case "google-api":
    case "gemini-cli":
      return (
        <svg {...stroke}>
          <path d="M12 4l4 8-4 8-4-8z" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
    case "codex-cli":
      return (
        <svg {...stroke}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M7 9l3 3-3 3M12 15h5" />
        </svg>
      );
    case "ollama":
      return (
        <svg {...stroke}>
          <rect x="4" y="6" width="16" height="14" rx="3" />
          <path d="M9 12v3M15 12v3M8 6V4M16 6V4" />
        </svg>
      );
    case "openrouter":
      return (
        <svg {...stroke}>
          <circle cx="6" cy="12" r="2" />
          <circle cx="18" cy="6" r="2" />
          <circle cx="18" cy="18" r="2" />
          <path d="M8 12h6M8 12l8-6M8 12l8 6" />
        </svg>
      );
    default:
      return null;
  }
}
