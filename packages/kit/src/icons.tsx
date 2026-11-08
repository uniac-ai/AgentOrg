/** The shell's icons, drawn with the text's color and hidden from assistive technology: the control they sit on carries the name. */
const svg = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  viewBox: "0 0 24 24",
} as const;

export const HomeIcon = () => (
  <svg width="16" height="16" aria-hidden="true" {...svg}>
    <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
  </svg>
);
export const PlusIcon = () => (
  <svg width="16" height="16" aria-hidden="true" {...svg}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const ChatGptIcon = () => (
  <svg width="16" height="16" aria-hidden="true" {...svg}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 12h7M12 8.5v7" />
  </svg>
);
export const MoonIcon = () => (
  <svg width="15" height="15" aria-hidden="true" {...svg}>
    <path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z" />
  </svg>
);
export const GearIcon = () => (
  <svg width="15" height="15" aria-hidden="true" {...svg}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);
export const MoreIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="19" cy="12" r="1.6" />
  </svg>
);
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;
export const UploadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M12 15V3M7 8l5-5 5 5M5 21h14" />
  </svg>
);
export const DownloadIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
  </svg>
);
export const SendIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} strokeWidth={2.4} aria-hidden="true">
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
export const StopIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="3" />
  </svg>
);
export const CopyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h8" />
  </svg>
);
export const RetryIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);
export const ToolIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z" />
  </svg>
);
export const ChevronIcon = ({ className }: { className?: string }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    {...stroke}
    className={className}
    aria-hidden="true"
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);
export const ArrowDownIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} strokeWidth={2.2} aria-hidden="true">
    <path d="M12 5v14M5 12l7 7 7-7" />
  </svg>
);
